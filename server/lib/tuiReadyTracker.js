/** Track raw PTY input readiness, startup selectors and their acknowledged answers. */
import { ERROR_CATEGORIES } from './aiToolkit/errorDetection.js';
import { SUBMIT_KEY } from './tuiPromptSubmission.js';

// PTY readiness — wait for the TUI banner to finish repainting (output-idle for
// READY_IDLE_THRESHOLD_MS) before pasting.
export const READY_POLL_INTERVAL_MS = 300;
export const READY_IDLE_THRESHOLD_MS = 1200;
export const PASTE_DEADLINE_MS = 10000;
// How long to wait for a positive input-ready signal (createInputReadyTracker) before giving up
// and surfacing a startup failure. Generous because a cold claude start can spend many seconds on
// banner + MCP-server + model init (well within the normal startup budget).
export const TUI_INPUT_READY_DEADLINE_MS = 45000;

// Codex's composer placeholder — the ONLY positive evidence its input box is live and will accept
// a paste. Codex is not on the requireInputReady path (that would fail a run hard the first time a
// wording change outran us), so this is a SOFT gate: the idle heuristic waits for it, and
// PASTE_DEADLINE_MS still backstops delivery if it never paints.
export const CODEX_COMPOSER_READY_PATTERN = /Ask\s*Codex/i;

// Positive "the launched program's input is ready to receive a bracketed paste" signal, derived
// from the terminal's bracketed-paste-mode toggles in the RAW (un-stripped) PTY stream. A program
// enables bracketed-paste mode (`ESC[?2004h`) exactly when its input prompt is live and ready to
// accept a paste — which is precisely the precondition for the `ESC[200~…ESC[201~` paste the
// spawner is about to send.
const BRACKETED_PASTE_MODE_PATTERN = /\x1b\[\?2004([hl])/g;

// First-run folder-trust gates. Claude Code's ("Is this a project you trust? → 1.
const TUI_TRUST_PROMPT_PATTERN =
  /trustthisfolder|isthisaprojectyou(?:created|trust)|doyoutrustthecontentsofthis(?:directory|project|folder)/i;

// Trust selectors have changed ordering across Claude Code releases. Older builds (and Codex/agy)
// highlight the affirmative choice first, while newer Claude Code builds can render "No, exit"
// first and highlight it.
const TUI_TRUST_ACCEPT_OPTION_PATTERN = /(?:yes,?itrustthisfolder|yes,?continue|trustandcontinue|\[a\]trustthisworkspace)/i;
const TUI_TRUST_DECLINE_OPTION_PATTERN = /no,?(?:exit|quit)|\d+\.quit/i;
const TUI_HIGHLIGHT_PATTERN_PREFIX = String.raw`(?:❯|›|>)\d*\.?`;
const TUI_TRUST_HIGHLIGHTED_ACCEPT_PATTERN = new RegExp(
  `${TUI_HIGHLIGHT_PATTERN_PREFIX}(?:yes,?itrustthisfolder|yes,?continue|trustandcontinue)`,
  'i',
);
const TUI_TRUST_HIGHLIGHTED_DECLINE_PATTERN = new RegExp(
  `${TUI_HIGHLIGHT_PATTERN_PREFIX}(?:no,?(?:exit|quit)|quit)`,
  'i',
);

// Claude Code 2.1.3xx resets its trust selector to the "No, exit" default shortly after first paint
// (its terminal-capability probe re-renders the dialog). An arrow sent inside that window is undone
// and the Enter bundled with it is lost, so every later paste lands in the selector (reproduced:
// Down at +50ms reverts, Down at +300ms sticks). Arrow navigation therefore waits for the dialog to
// age and settle, goes out ALONE, and Enter follows only once a repaint shows the affirmative choice
// highlighted and the screen has gone quiet again. A revert is re-navigated, within a bound.
const TUI_TRUST_NAVIGATION_MIN_AGE_MS = 1000;
const TUI_TRUST_SETTLE_MS = 400;
const TUI_TRUST_MAX_NAVIGATIONS = 4;
const TUI_TRUST_ARROW_KEYS = new Set(['\x1b[A', '\x1b[B']);
const TUI_TRUST_HIGHLIGHT_SCAN_PATTERN = new RegExp(
  `${TUI_HIGHLIGHT_PATTERN_PREFIX}(?:(yes,?itrustthisfolder|yes,?continue|trustandcontinue)|no,?(?:exit|quit)|quit)`,
  'gi',
);

/** Which trust option the LATEST highlight glyph in `text` sits on, or null when none painted. */
function latestTrustHighlight(text) {
  let latest = null;
  for (const m of text.matchAll(TUI_TRUST_HIGHLIGHT_SCAN_PATTERN)) latest = m[1] ? 'accept' : 'decline';
  return latest;
}

// The Claude Code offer to change the default permission mode can overlay a ready composer.
const TUI_AUTO_MODE_PROMPT_PATTERN =
  /automodeyourdefaultpermissionmode|setautomodeasmydefaultpermissionmode/i;

// Claude Code can discover a parent workspace's AGENTS.md (via CLAUDE.md) when PortOS places a
// managed-app worktree below its own data/cos/worktrees directory. If that file imports an
// instruction file outside the managed app's checkout, Claude stops on an "allow external imports"
// selector before its composer exists.
const TUI_EXTERNAL_IMPORTS_PROMPT_PATTERN =
  /claude\.mdimportsfilesoutsidethecurrentworkingdirectory|disableexternalimports/i;

// Codex can stop before its composer on a hook-review selector when a newly configured hook has
// not yet been trusted. `--dangerously-bypass-approvals-and- sandbox` deliberately does not answer
// this prompt: trusting a hook permits code outside the sandbox, so unattended PortOS runs must
// choose Codex's explicit "Continue without trusting" option instead.
const TUI_HOOK_REVIEW_PROMPT_PATTERN = /hooksneedreview/i;

// Antigravity (agy) needs a SECOND, positive readiness signal on top of paste mode. agy enables
// bracketed paste the moment it enters the alt screen — while it is still "Signing in…", before
// its folder-trust gate has painted and long before its composer exists. So `sawCommandRun &&
// pasteModeOn` goes true within ~200ms of launch and the paste fires into whatever screen happens
// to be up.
export const AGY_INPUT_READY_PATTERN = /\?forshortcuts/i;

// OpenCode emits terminal-capability queries and enables paste mode before its composer exists.
// Silence after those bytes is not input readiness.
export const OPENCODE_INPUT_READY_PATTERN = /askanything/i;
// The update offer overlays the composer and defaults to Confirm. Escape closes it without
// installing software or changing the operator's settings.
const OPENCODE_UPDATE_PROMPT_PATTERN = /updateavailable.*anewreleasev[\d.]+isavailable\./i;

// OpenCode rejects a model it cannot resolve with a startup toast, then paints its composer with a
// DIFFERENT model — so the composer-ready signal is not proof the task's model is the one that
// will answer. Matched against a tail with whitespace AND box/block glyphs removed, because the
// toast wraps across rows with the border between them.
const OPENCODE_MODEL_REJECTION_PATTERN = /Model([A-Za-z0-9][\w.-]*\/[\w.:@+/-]*?)isnotvalid/i;
const BOX_AND_BLOCK_GLYPHS = /[\s\u2500-\u259F]+/g;

/**
 * Error analysis for an OpenCode startup model rejection. `model-not-found` is a request-specific
 * category, so the cooldown policy leaves the provider's other models available (see
 * isRequestSpecificCategory).
 */
function describeOpencodeModelRejection(rejectedModel) {
  return {
    category: ERROR_CATEGORIES.MODEL_NOT_FOUND,
    actionable: true,
    origin: 'provider',
    message: `OpenCode rejected the selected model "${rejectedModel}" at startup, so no prompt was sent.`,
    suggestedFix: 'Choose a model that `opencode models` lists for this provider, or clear the model override to use the CLI default. PortOS did not change any model setting.',
    escalation: 'Pick a model OpenCode accepts (or clear the override to use the CLI default), then approve the retry.',
    affectedModel: rejectedModel,
  };
}

// Handshake markers are matched against a rolling window of whitespace-stripped output rather than
// a single chunk, so a marker split across two PTY reads (`? for short` | `cuts`) still matches.
// Sized to a few screens of chrome.
const OBSERVE_TAIL_MAX_LEN = 4000;

/**
 * Test whether a launch shape owns its own PTY process. 'runner' and 'direct' shapes own their
 * PTY; 'login-shell' is hosted in a shell.
 */
function shapeHasOwnPty(launchShape) {
  return launchShape === 'runner' || launchShape === 'direct';
}

/**
 * Test whether a launch shape has a login shell to fall back to. Only 'login-shell' has a
 * persistent shell; 'runner' and 'direct' do not.
 */
export function shapeHasLoginShell(launchShape) {
  return launchShape === 'login-shell';
}

function createPasteModeTracker(launchShape) {
  // A direct PTY starts inside the TUI. In a login shell, its own initial ON does not count until
  // the shell disables paste mode to run the command and the TUI enables it again.
  let sawCommandRun = shapeHasOwnPty(launchShape);
  let pasteModeOn = false;
  // node-pty can split `ESC[?2004h` across reads. Keep only the trailing prefix of that exact
  // toggle so the next chunk can complete it without treating unrelated escape traffic as a
  // readiness signal.
  let rawTail = '';
  return {
    get ready() { return sawCommandRun && pasteModeOn; },
    observe(rawText) {
      if (!rawText) return;
      const raw = rawTail + rawText;
      rawTail = '';
      for (const m of raw.matchAll(BRACKETED_PASTE_MODE_PATTERN)) {
        if (m[1] === 'l') { pasteModeOn = false; sawCommandRun = true; }
        else pasteModeOn = true;
      }
      const lastEscape = raw.lastIndexOf('\x1b');
      const possibleTogglePrefix = lastEscape === -1 ? '' : raw.slice(lastEscape);
      if (possibleTogglePrefix && '\x1b[?2004'.startsWith(possibleTogglePrefix)) {
        rawTail = possibleTogglePrefix;
      }
    },
  };
}

function createTrustTracker() {
  let needsTrust = false;
  let trustAnswered = false;
  let trustChoiceReady = false;
  let trustSelectionKey = '';
  // Highlight chrome (not option order) chose the arrow, so a repaint can confirm it landed.
  let trustKeyFromHighlight = false;
  let trustFirstSeenAt = 0;
  let trustLastOutputAt = 0;
  let trustNavigations = 0;
  // Output since the last arrow went out. The rolling tail still holds the pre-arrow screen, so
  // only this text can say where the highlight is NOW.
  let trustNavTail = '';
  return {
    get needsTrust() { return needsTrust; },
    get trustChoiceReady() { return trustChoiceReady; },
    get trustSelectionKey() { return trustSelectionKey; },
    get trustNavigationExhausted() { return trustNavigations >= TUI_TRUST_MAX_NAVIGATIONS; },
    /**
     * The trust-gate keystrokes due right now, or null to keep waiting. `final` means the write
     * submits a choice; otherwise it only moves the highlight and the dialog stays pending.
     * @param {number} [now]
     * @returns {{ keys: string, final: boolean } | null}
     */
    trustAnswer(now = Date.now()) {
      if (!needsTrust || !trustChoiceReady) return null;
      const settled = now - trustLastOutputAt >= TUI_TRUST_SETTLE_MS;
      if (trustNavigations > 0) {
        if (!settled) return null;
        const highlight = latestTrustHighlight(trustNavTail);
        if (highlight === 'accept') return { keys: SUBMIT_KEY, final: true };
        if (highlight === 'decline' && trustNavigations < TUI_TRUST_MAX_NAVIGATIONS) {
          return { keys: trustSelectionKey, final: false };
        }
        return null;
      }
      if (!TUI_TRUST_ARROW_KEYS.has(trustSelectionKey)) return { keys: `${trustSelectionKey}${SUBMIT_KEY}`, final: true };
      if (now - trustFirstSeenAt < TUI_TRUST_NAVIGATION_MIN_AGE_MS || !settled) return null;
      // Without highlight chrome no repaint can confirm the move, so keep the bundled answer.
      if (!trustKeyFromHighlight) return { keys: `${trustSelectionKey}${SUBMIT_KEY}`, final: true };
      return { keys: trustSelectionKey, final: false };
    },
    /** Spawner wrote `answer` (from trustAnswer) to the TUI. */
    ackTrustAnswer(answer) {
      if (answer.final) { needsTrust = false; trustAnswered = true; return; }
      trustNavigations += 1;
      trustNavTail = '';
    },
    /** Spawner selected the affirmative trust choice. */
    ackTrustChoice() { needsTrust = false; trustAnswered = true; },
    observe(tail, compact) {
      // Raw-only repaints also restart the settle delay during navigation.
      if (needsTrust) trustLastOutputAt = Date.now();
      if (compact === null) return;
      if (!needsTrust && !trustAnswered && TUI_TRUST_PROMPT_PATTERN.test(tail)) {
        needsTrust = true;
        trustFirstSeenAt = Date.now();
        trustLastOutputAt = trustFirstSeenAt;
      }
      if (needsTrust && trustNavigations > 0) trustNavTail = (trustNavTail + compact).slice(-OBSERVE_TAIL_MAX_LEN);
      if (needsTrust && !trustChoiceReady) {
        const acceptMatch = TUI_TRUST_ACCEPT_OPTION_PATTERN.exec(tail);
        const declineMatch = TUI_TRUST_DECLINE_OPTION_PATTERN.exec(tail);
        if (acceptMatch) {
          trustChoiceReady = true;
          if (acceptMatch[0].toLowerCase() === '[a]trustthisworkspace') {
            // Cursor exposes a direct accelerator, independent of highlight position (including
            // Linux terminals using the ▶ cursor glyph).
            trustSelectionKey = 'a';
          } else if (TUI_TRUST_HIGHLIGHTED_DECLINE_PATTERN.test(tail)) {
            trustSelectionKey = declineMatch && declineMatch.index < acceptMatch.index ? '\x1b[B' : '\x1b[A';
            trustKeyFromHighlight = true;
          } else if (TUI_TRUST_HIGHLIGHTED_ACCEPT_PATTERN.test(tail)) {
            trustSelectionKey = '';
          } else if (declineMatch) {
            // Ink highlights the first rendered option when its cursor glyph is unavailable in a
            // captured transcript. Use ordering only as that fallback; explicit highlight chrome
            // wins above.
            trustSelectionKey = declineMatch.index < acceptMatch.index ? '\x1b[B' : '';
          }
        }
      }
    },
  };
}

// Rolling screen text can retain a dismissed dialog. Acknowledgement is terminal for that dialog.
function createStartupChoice(pattern) {
  let pending = false;
  let answered = false;
  return {
    get pending() { return pending; },
    observe(tail) { if (!answered && !pending) pending = pattern.test(tail); },
    acknowledge() { answered = true; pending = false; },
  };
}

export function createInputReadyTracker({ readyTextPattern = null, launchShape = 'login-shell' } = {}) {
  const pasteMode = createPasteModeTracker(launchShape);
  const trust = createTrustTracker();
  const autoMode = createStartupChoice(TUI_AUTO_MODE_PROMPT_PATTERN);
  const externalImports = createStartupChoice(TUI_EXTERNAL_IMPORTS_PROMPT_PATTERN);
  const hookReview = createStartupChoice(TUI_HOOK_REVIEW_PROMPT_PATTERN);
  const opencodeUpdate = createStartupChoice(OPENCODE_UPDATE_PROMPT_PATTERN);
  let sawReadyText = false;
  let opencodeModelRejection = null;
  let opencodeRejectionTail = '';
  let tail = '';
  return {
    get ready() {
      return pasteMode.ready && !trust.needsTrust && !autoMode.pending && !externalImports.pending
        && !hookReview.pending && !opencodeUpdate.pending && (!readyTextPattern || sawReadyText);
    },
    get needsTrust() { return trust.needsTrust; },
    get trustChoiceReady() { return trust.trustChoiceReady; },
    get trustSelectionKey() { return trust.trustSelectionKey; },
    get trustNavigationExhausted() { return trust.trustNavigationExhausted; },
    trustAnswer: trust.trustAnswer,
    ackTrustAnswer: trust.ackTrustAnswer,
    ackTrustChoice: trust.ackTrustChoice,
    get needsAutoModeChoice() { return autoMode.pending; },
    get needsExternalImportsChoice() { return externalImports.pending; },
    get needsHookReview() { return hookReview.pending; },
    get needsOpencodeUpdate() { return opencodeUpdate.pending; },
    get opencodeModelRejection() { return opencodeModelRejection; },
    ackAutoModeChoice: autoMode.acknowledge,
    ackExternalImportsChoice: externalImports.acknowledge,
    ackHookReview: hookReview.acknowledge,
    ackOpencodeUpdate: opencodeUpdate.acknowledge,
    observe(rawText, strippedText) {
      pasteMode.observe(rawText);
      if (!strippedText) {
        if (rawText) trust.observe(tail, null);
        return;
      }
      const compact = strippedText.replace(/\s+/g, '');
      tail = (tail + compact).slice(-OBSERVE_TAIL_MAX_LEN);
      trust.observe(tail, compact);
      autoMode.observe(tail);
      externalImports.observe(tail);
      hookReview.observe(tail);
      opencodeUpdate.observe(tail);
      if (readyTextPattern && !sawReadyText && readyTextPattern.test(tail)) sawReadyText = true;
      if (!opencodeModelRejection) {
        opencodeRejectionTail = (opencodeRejectionTail + strippedText.replace(BOX_AND_BLOCK_GLYPHS, '')).slice(-OBSERVE_TAIL_MAX_LEN);
        const rejected = OPENCODE_MODEL_REJECTION_PATTERN.exec(opencodeRejectionTail);
        if (rejected) opencodeModelRejection = describeOpencodeModelRejection(rejected[1]);
      }
    },
  };
}

/**
 * Why a folder-trust gate was still up at the readiness deadline: its affirmative choice never
 * painted recognizably, or the selector would not hold it.
 * @returns {{ reason: string, error: string }}
 */
export function describeTrustGateFailure(inputReady, command) {
  if (!inputReady.trustChoiceReady) {
    return {
      reason: 'tui-trust-choice-unrecognized',
      error: `${command} presented a folder-trust prompt whose affirmative choice PortOS could not identify, so no prompt was sent.`,
    };
  }
  return {
    reason: 'tui-trust-choice-unconfirmed',
    error: `${command} folder-trust prompt never showed the trust choice selected${inputReady.trustNavigationExhausted ? ` after ${TUI_TRUST_MAX_NAVIGATIONS} attempts to move to it` : ''}, so no choice was submitted and no prompt was sent.`,
  };
}


// ─── Startup-dialog answers ───────────────────────────────────────────────

// One row per modal a TUI can paint before (or just after) its composer exists, in the exact order
// the spawner's poll must try them. Adding a provider's next dialog is a row here plus the
// `needs…`/`ack…` pair on createInputReadyTracker — not another boolean in the spawner's closure
// and another arm hundreds of lines away from it.
const STARTUP_DIALOGS = [
  {
    id: 'opencode-update',
    stage: 'before-composer',
    answered: 'opencodeUpdateSkipped',
    asks: (inputReady) => inputReady.needsOpencodeUpdate,
    keys: () => '\x1b',
    ack: (inputReady) => inputReady.ackOpencodeUpdate(),
    describe: (command) => `Skipped ${command} startup update offer`,
  },
  // Claude can discover PortOS's parent AGENTS.md (via CLAUDE.md) from a managed-app worktree
  // nested under data/cos/worktrees, then ask whether to allow that file's external AGENTS.md
  // import. Decline it: the parent repository's instructions must not leak into the target app,
  // and option 2 leaves the target's own instruction files intact.
  {
    id: 'external-imports',
    stage: 'before-composer',
    answered: 'externalImportsDeclined',
    asks: (inputReady) => inputReady.needsExternalImportsChoice,
    keys: () => '\x1b[B\r',
    ack: (inputReady) => inputReady.ackExternalImportsChoice(),
    describe: (command) => `Declined ${command} external instruction imports`,
  },
  // Codex can present a hook-review selector before its composer exists. Do not trust hooks from
  // an unattended run: option 3 keeps them disabled for this session and lets the agent continue
  // without executing code outside its sandbox.
  {
    id: 'hook-review',
    stage: 'before-composer',
    answered: 'hookReviewDeclined',
    asks: (inputReady) => inputReady.needsHookReview,
    keys: () => '\x1b[B\x1b[B\r',
    ack: (inputReady) => inputReady.ackHookReview(),
    describe: (command) => `Continued ${command} without trusting startup hooks`,
  },
  // Auto-confirm the first-run "trust this folder?" gate so agents can run in fresh worktrees.
  // Waits for the choices themselves to paint: Claude Code releases disagree about their ordering
  // and newer builds can highlight "No, exit" by default, so `trustSelectionKey` — derived from
  // the painted options — is what moves to the affirmative one before submitting.
  {
    id: 'folder-trust',
    stage: 'before-composer',
    answered: 'trustAccepted',
    asks: (inputReady) => Boolean(inputReady.needsTrust) && inputReady.trustAnswer() !== null,
    keys: (inputReady) => inputReady.trustAnswer().keys,
    // Navigation-only writes leave the gate pending; the row is answered once Enter goes out.
    ack: (inputReady) => {
      const answer = inputReady.trustAnswer();
      inputReady.ackTrustAnswer(answer);
      return answer.final;
    },
    describe: (command, final) => (final
      ? `Auto-confirmed ${command} folder-trust prompt`
      : `Moved ${command} folder-trust selection to the trust choice`),
  },
  // Decline claude's "make auto mode your default permission mode?" offer (v2.1.233+). Unlike the
  // trust gate this one paints AFTER the composer is live, so it swallows the paste and every
  // retry unless it is cleared first — see TUI_AUTO_MODE_PROMPT_PATTERN.
  {
    id: 'auto-mode',
    stage: 'after-composer',
    answered: 'autoModeDeclined',
    asks: (inputReady) => inputReady.needsAutoModeChoice,
    keys: () => '\x1b[B\r',
    ack: (inputReady) => inputReady.ackAutoModeChoice(),
    describe: (command) => `Declined ${command} auto-mode default offer`,
  },
];

/**
 * A fresh "which startup dialogs has this session already answered?" record — one value per
 * STARTUP_DIALOGS row, so a new row needs no caller edit. The tracker's own `needs…` getters go
 * false on ack, so they already stop a second answer on their own.
 */
export const createStartupDialogAnswers = () =>
  Object.fromEntries(STARTUP_DIALOGS.map((dialog) => [dialog.answered, false]));

/**
 * Answer at most ONE unanswered startup dialog for `stage`, in table order. One per call on
 * purpose: answering changes what the TUI is showing, so the caller returns to its poll and
 * re-reads the tracker before trying the next.
 * @param {object} args
 * @param {object} args.inputReady - createInputReadyTracker instance.
 * @param {object} args.answers - createStartupDialogAnswers() record.
 * @param {'before-composer'|'after-composer'} args.stage
 * @param {string} args.command - TUI command name, for the transcript line.
 * @param {(keys: string) => void} args.write - writes the answer to the PTY.
 * @returns {{ id: string, message: string } | null} the dialog answered and
 *   the transcript phrase for it, or null when there was nothing to answer.
 *   The caller owns the log line and the idle-clock rewind, which differ by
 *   stage.
 */
export function answerStartupDialogs({ inputReady, answers, stage, command, write }) {
  for (const dialog of STARTUP_DIALOGS) {
    if (dialog.stage !== stage) continue;
    if (answers[dialog.answered]) continue;
    if (!dialog.asks(inputReady)) continue;
    write(dialog.keys(inputReady));
    // An ack returning false is an intermediate step (trust navigation); the dialog is still up.
    const final = dialog.ack(inputReady) !== false;
    if (final) answers[dialog.answered] = true;
    return { id: dialog.id, message: dialog.describe(command, final) };
  }
  return null;
}
