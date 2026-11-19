/**
 * Shared TUI invocation + paste-handshake constants.
 */

import { inferTuiCommand, applyCommandDefaults, injectTuiModelAndEffort } from './provider/providerVendors.js';
import { detectTuiRetryBanner, describeTuiRetryStall, ERROR_CATEGORIES } from './aiToolkit/errorDetection.js';

// ─── Paste handshake constants ────────────────────────────────────────────

// PTY readiness — wait for the TUI banner to finish repainting (output-idle for
// READY_IDLE_THRESHOLD_MS) before pasting.
export const READY_POLL_INTERVAL_MS = 300;
export const READY_IDLE_THRESHOLD_MS = 1200;
export const PASTE_DEADLINE_MS = 10000;
// Give Claude Code time to switch into /low-priority mode before retrying a prompt rejected by its
// session limit. Shared by both TUI execution paths.
export const CLAUDE_LOW_PRIORITY_RESUBMIT_DELAY_MS = 1500;
// How long to wait for a positive input-ready signal (createInputReadyTracker) before giving up
// and surfacing a startup failure. Generous because a cold claude start can spend many seconds on
// banner + MCP-server + model init (well within the normal startup budget).
export const TUI_INPUT_READY_DEADLINE_MS = 45000;

// Claude Code emits `[Pasted text #N +M lines]`, Codex emits `[Pasted Content N chars]`, OpenCode
// emits `[Pasted ~N lines]`, Pi emits `[paste #N +M lines]` (note: "paste", not "Pasted" — hence
// the optional `d`), and Grok Build emits `[Pasted: 31 KB]` after committing a paste. Watch for
// any of these markers (or fall back after PASTE_TO_ENTER_FALLBACK_MS) before sending `\r` so
// Enter doesn't get swallowed mid-paste-commit.
export const PASTE_MARKER_POLL_MS = 150;

// Paste verification: after paste-commit (marker or fallback), verify the prompt text actually
// rendered in the buffer before submitting. If verification fails, retry the paste with backoff.
export const PASTE_VERIFY_POLL_MS = 200;
export const PASTE_VERIFY_WINDOW_MS = 2000; // max time to wait for verification after paste-commit
export const PASTE_RETRY_MAX_ATTEMPTS = 3;
export const PASTE_RETRY_BASE_DELAY_MS = 800;
// Minimum wall-clock budget for the swallow-recovery ladder. Three attempts with 0.8s/1.6s backoff
// exhaust in ~20s, which a slow-starting TUI (Claude painting its composer before it binds input)
// outlasts: all three pastes were swallowed and the run died `paste-not-rendered` with a healthy
// composer on screen.
export const PASTE_RETRY_MIN_WINDOW_MS = 60000;
export const PASTE_RETRY_WINDOW_DELAY_MS = 4000;
// Minimum prefix length for verification (shorter prompts verify whole-text)
const MIN_VERIFIABLE_PREFIX_LEN = 15;
export const PASTE_MARKER_PATTERN = /\[Pasted?\s*(?:text\s*#\d+[^\]]*|content\s*\d+\s*chars|~\s*\d+\s*lines?|#\d+\s*\+\d+\s*lines?|:\s*\d+(?:\.\d+)?\s*(?:B|KB|MB))\]/i;
export const PASTE_TO_ENTER_MIN_DELAY_MS = 200;
export const PASTE_TO_ENTER_FALLBACK_MS = 3500;

// Codex QUEUES a bracketed paste that arrives before its composer has finished initializing and
// commits it once the composer is live — it is not lost. On a cold Windows start (`cmd.exe /c
// codex.cmd` -> node -> the native binary) that commit was measured at ~11s for a paste written at
// 3.7s, far past the 3.5s marker wait + 2s verify window above.
export const PASTE_COMMIT_PATIENCE_MS = 45000;

// Codex's composer placeholder — the ONLY positive evidence its input box is live and will accept
// a paste. Codex is not on the requireInputReady path (that would fail a run hard the first time a
// wording change outran us), so this is a SOFT gate: the idle heuristic waits for it, and
// PASTE_DEADLINE_MS still backstops delivery if it never paints.
export const CODEX_COMPOSER_READY_PATTERN = /Ask\s*Codex/i;

/**
 * Extract a verifiable prefix from a prompt for paste verification. The prefix is a unique-enough
 * substring from the prompt's first "content" line (skipping leading whitespace/common prefixes)
 * that's unlikely to appear in TUI chrome.
 * @param {string} prompt — the full prompt text being pasted.
 * @returns {string|null} a verifiable prefix, or null if the prompt is too short.
 */
export function extractVerifiablePromptPrefix(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) return null;
  // Collapse whitespace and take the first content chunk. Skip leading boilerplate that might
  // match TUI chrome (e.g., "You are a..." is generic).
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  if (normalized.length < MIN_VERIFIABLE_PREFIX_LEN) {
    // Very short prompt: use the whole thing
    return normalized.length >= 5 ? normalized : null;
  }
  // For longer prompts, take a prefix from the middle portion to avoid common prefixes like "You
  // are" or "Please" that might appear elsewhere
  const startOffset = Math.min(10, Math.floor(normalized.length * 0.1));
  const prefixLen = Math.min(40, normalized.length - startOffset);
  return normalized.slice(startOffset, startOffset + prefixLen);
}

/**
 * True when the verifiable prompt prefix appears in the post-paste buffer. ANSI-stripped input;
 * internal whitespace differences are ignored (see below).
 * @param {string} strippedBuffer — ANSI-stripped post-paste output.
 * @param {string|null} prefix — the prefix from extractVerifiablePromptPrefix.
 * @returns {boolean}
 */
export function verifyPasteRendered(strippedBuffer, prefix) {
  if (!prefix) return true; // no verification possible
  if (typeof strippedBuffer !== 'string') return false;
  const collapseWhitespace = (s) => s.replace(/\s+/g, '');
  return collapseWhitespace(strippedBuffer).includes(collapseWhitespace(prefix));
}

const PASTE_MARKER_PATTERN_GLOBAL = new RegExp(PASTE_MARKER_PATTERN.source, 'gi');

/**
 * Count paste-commit markers from Claude Code, Codex, OpenCode, or Grok in `strippedText`. Callers
 * MUST pass ANSI-STRIPPED output (see PASTE_MARKER_PATTERN above for why the raw stream never
 * matches).
 * @param {string} strippedText — ANSI-stripped text (prompt or post-paste output).
 * @returns {number}
 */
export function countPasteMarkers(strippedText) {
  if (typeof strippedText !== 'string' || !strippedText) return 0;
  // `match` with a /g regex ignores and resets lastIndex, so one shared instance is safe and saves
  // recompiling it on every poll tick.
  const m = strippedText.match(PASTE_MARKER_PATTERN_GLOBAL);
  return m ? m.length : 0;
}

/**
 * True when `strippedText` contains at least one paste-commit marker. Thin presence wrapper over
 * `countPasteMarkers`.
 * @param {string} strippedText — ANSI-stripped post-paste output accumulator.
 * @returns {boolean}
 */
export function detectPasteMarker(strippedText) {
  return countPasteMarkers(strippedText) > 0;
}

// Claude Code's "this chip is a collapsed multi-line paste, click to see the body" affordance,
// rendered right next to the `[Pasted text #N]` chip whenever it folds a multi-line paste and
// HIDES the body. Matched against ANSI-stripped output; whitespace-tolerant for the same
// inter-glyph-cursor-move reason as PASTE_MARKER_PATTERN.
export const COLLAPSED_PASTE_CHIP_PATTERN = /paste\s*again\s*to\s*expand/i;

/**
 * True when `strippedText` shows Claude Code's COLLAPSED-paste chip shape: a paste-commit marker
 * present alongside the "paste again to expand" affordance the TUI renders when it folds a
 * multi-line paste and hides the body. Callers MUST pass an ANSI-STRIPPED buffer.
 * @param {string} strippedText — ANSI-stripped post-paste output accumulator.
 * @returns {boolean}
 */
export function isCollapsedPasteChip(strippedText) {
  if (typeof strippedText !== 'string' || !strippedText) return false;
  return countPasteMarkers(strippedText) >= 1 && COLLAPSED_PASTE_CHIP_PATTERN.test(strippedText);
}

/**
 * True when a post-paste buffer proves the TUI actually RECEIVED the prompt paste — the gate
 * before sending the submit Enter(s). Two independent signals, checked in priority order: 1.
 * @param {string} strippedBuffer — ANSI-stripped post-paste output accumulator.
 * @param {{ verifiablePrefix?: string|null, promptMarkerCount?: number }} [opts]
 * @returns {boolean}
 */
export function isPasteConfirmed(strippedBuffer, options = {}) {
  if (isPasteCommitted(strippedBuffer, options)) return true;
  return !options.verifiablePrefix; // nothing to verify against
}

/**
 * The POSITIVE half of isPasteConfirmed: true only when the buffer carries actual evidence the TUI
 * committed the paste (its own marker, Claude's collapsed chip, or the prompt text rendering).
 * Unlike isPasteConfirmed it does NOT return true just because there is nothing to verify against,
 * so a caller can use it to WAIT for a commit rather than to decide whether to declare one
 * swallowed.
 * @param {string} strippedBuffer - ANSI-stripped post-paste output accumulator.
 * @param {{ verifiablePrefix?: string|null, promptMarkerCount?: number }} [opts]
 * @returns {boolean}
 */
export function isPasteCommitted(strippedBuffer, { verifiablePrefix = null, promptMarkerCount = 0 } = {}) {
  // Counted once and reused for the chip check below — isCollapsedPasteChip would re-scan the
  // whole buffer, and this runs on the paste poll.
  const markers = countPasteMarkers(strippedBuffer);
  if (markers > promptMarkerCount) return true; // marker is authoritative
  // Collapsed chip is the TUI's own commit (#2228).
  if (markers >= 1 && COLLAPSED_PASTE_CHIP_PATTERN.test(strippedBuffer)) return true;
  return !!verifiablePrefix && verifyPasteRendered(strippedBuffer, verifiablePrefix);
}

// Positive "the launched program's input is ready to receive a bracketed paste" signal, derived
// from the terminal's bracketed-paste-mode toggles in the RAW (un-stripped) PTY stream. A program
// enables bracketed-paste mode (`ESC[?2004h`) exactly when its input prompt is live and ready to
// accept a paste — which is precisely the precondition for the `ESC[200~…ESC[201~` paste the
// spawner is about to send.
export const BRACKETED_PASTE_MODE_PATTERN = /\x1b\[\?2004([hl])/g;

// First-run folder-trust gates. Claude Code's ("Is this a project you trust? → 1.
export const TUI_TRUST_PROMPT_PATTERN =
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
export const TUI_TRUST_NAVIGATION_MIN_AGE_MS = 1000;
export const TUI_TRUST_SETTLE_MS = 400;
export const TUI_TRUST_MAX_NAVIGATIONS = 4;
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

// Claude Code's auto-mode opt-in offer ("Make auto mode your default permission mode? → 1. Yes,
// set auto mode as my default permission mode / 2.
export const TUI_AUTO_MODE_PROMPT_PATTERN =
  /automodeyourdefaultpermissionmode|setautomodeasmydefaultpermissionmode/i;

// Claude Code can discover a parent workspace's AGENTS.md (via CLAUDE.md) when PortOS places a
// managed-app worktree below its own data/cos/worktrees directory. If that file imports an
// instruction file outside the managed app's checkout, Claude stops on an "allow external imports"
// selector before its composer exists.
export const TUI_EXTERNAL_IMPORTS_PROMPT_PATTERN =
  /claude\.mdimportsfilesoutsidethecurrentworkingdirectory|disableexternalimports/i;

// Codex can stop before its composer on a hook-review selector when a newly configured hook has
// not yet been trusted. `--dangerously-bypass-approvals-and- sandbox` deliberately does not answer
// this prompt: trusting a hook permits code outside the sandbox, so unattended PortOS runs must
// choose Codex's explicit "Continue without trusting" option instead.
export const TUI_HOOK_REVIEW_PROMPT_PATTERN = /hooksneedreview/i;

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

// readyTextPattern: optional extra positive gate, tested against the stripped rolling tail. When
// supplied, `ready` also requires that marker to have been seen (see AGY_INPUT_READY_PATTERN).
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

// launchShape: which PTY shape this TUI runs in. 'runner' and 'direct' shapes own their PTY from
// byte zero and have no launch shell, so the shell's paste-mode OFF (`ESC[?2004l`) that normally
// proves "the command is now running" never occurs; the first `ESC[?2004h` in the stream comes
// from the TUI itself and IS the ready signal. Without this knowledge a runner/direct session can
// never become ready (the durable-runner regression: every runner-tui claude agent died
// `tui-not-ready` at the 45s deadline while its input box sat live on screen). 'login-shell' has a
// persistent shell that handles paste-mode negotiation.
export function createInputReadyTracker({ readyTextPattern = null, launchShape = 'login-shell' } = {}) {
  let pasteModeOn = false;   // LIVE bracketed-paste mode state from the stream
  // Shell turned paste mode OFF to run the command. Pre-latched when the TUI
  // owns its own PTY (runner/direct shapes), where no shell OFF exists.
  const hasOwnPty = shapeHasOwnPty(launchShape);
  let sawCommandRun = hasOwnPty;
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
  let sawReadyText = false;
  // Auto-mode offer: latched when seen, cleared once answered. `autoModeAnswered` makes the ack
  // TERMINAL — `tail` is a rolling 4000-char window, so the modal's text lingers in it long after
  // the dialog is gone and would otherwise re-arm the flag on the very next chunk, re-answering
  // forever and pinning `ready` false until the 45s deadline.
  let needsAutoModeChoice = false;
  let autoModeAnswered = false;
  // External-import selector: latched until the consumer sends the conservative "disable" choice,
  // then terminally acknowledged so its stale screen text cannot re-arm the gate from the rolling
  // tail.
  let needsExternalImportsChoice = false;
  let externalImportsAnswered = false;
  // Like the auto-mode offer, hook-review text remains in the rolling tail after its selector
  // closes. A terminal acknowledgement prevents a repaint from re-arming the dialog and blocking
  // delivery forever.
  let needsHookReview = false;
  let hookReviewAnswered = false;
  let needsOpencodeUpdate = false;
  let opencodeUpdateAnswered = false;
  // Latched on first sight and never cleared: callers consult it only before the prompt is
  // delivered, so a later echo of the toast text is ignored.
  let opencodeModelRejection = null;
  let opencodeRejectionTail = '';
  let tail = '';
  // node-pty can split `ESC[?2004h` across reads. Keep only the trailing prefix of that exact
  // toggle so the next chunk can complete it without treating unrelated escape traffic as a
  // readiness signal.
  let rawTail = '';
  return {
    // Ready once the TUI has RE-ENABLED bracketed-paste mode after the launch shell turned it off
    // to run the command — for claude that means its input box is live and a paste will be read as
    // a paste. (The launch shell's own initial ON does not count: sawCommandRun gates on the
    // intervening OFF.) Providers that enable paste mode before their composer exists supply a
    // readyTextPattern to close the gap.
    get ready() {
      return sawCommandRun && pasteModeOn && !needsTrust && !needsAutoModeChoice
        && !needsExternalImportsChoice && !needsHookReview && !needsOpencodeUpdate
        && (!readyTextPattern || sawReadyText);
    },
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
    get needsAutoModeChoice() { return needsAutoModeChoice; },
    get needsExternalImportsChoice() { return needsExternalImportsChoice; },
    get needsHookReview() { return needsHookReview; },
    get needsOpencodeUpdate() { return needsOpencodeUpdate; },
    get opencodeModelRejection() { return opencodeModelRejection; },
    /** Spawner selected the affirmative trust choice. */
    ackTrustChoice() { needsTrust = false; trustAnswered = true; },
    /** Spawner reports the dismissal keystrokes went out; re-arms `ready`. */
    ackAutoModeChoice() { needsAutoModeChoice = false; autoModeAnswered = true; },
    /** Spawner selected Claude's "No, disable external imports" option. */
    ackExternalImportsChoice() { needsExternalImportsChoice = false; externalImportsAnswered = true; },
    /** Spawner selected Codex's safe "Continue without trusting" option. */
    ackHookReview() { needsHookReview = false; hookReviewAnswered = true; },
    ackOpencodeUpdate() { needsOpencodeUpdate = false; opencodeUpdateAnswered = true; },
    // rawText: un-stripped chunk (paste-mode toggles live here); strippedText: ANSI-stripped chunk
    // (the trust-gate / composer text).
    observe(rawText, strippedText) {
      if (rawText) {
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
      }
      if (needsTrust && (rawText || strippedText)) trustLastOutputAt = Date.now();
      if (strippedText) {
        const compact = strippedText.replace(/\s+/g, '');
        tail = (tail + compact).slice(-OBSERVE_TAIL_MAX_LEN);
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
        if (!needsAutoModeChoice && !autoModeAnswered && TUI_AUTO_MODE_PROMPT_PATTERN.test(tail)) needsAutoModeChoice = true;
        if (!needsExternalImportsChoice && !externalImportsAnswered && TUI_EXTERNAL_IMPORTS_PROMPT_PATTERN.test(tail)) {
          needsExternalImportsChoice = true;
        }
        if (!needsHookReview && !hookReviewAnswered && TUI_HOOK_REVIEW_PROMPT_PATTERN.test(tail)) needsHookReview = true;
        if (!needsOpencodeUpdate && !opencodeUpdateAnswered && OPENCODE_UPDATE_PROMPT_PATTERN.test(tail)) needsOpencodeUpdate = true;
        if (readyTextPattern && !sawReadyText && readyTextPattern.test(tail)) sawReadyText = true;
        if (!opencodeModelRejection) {
          opencodeRejectionTail = (opencodeRejectionTail + strippedText.replace(BOX_AND_BLOCK_GLYPHS, '')).slice(-OBSERVE_TAIL_MAX_LEN);
          const rejected = OPENCODE_MODEL_REJECTION_PATTERN.exec(opencodeRejectionTail);
          if (rejected) opencodeModelRejection = describeOpencodeModelRejection(rejected[1]);
        }
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


// Claude Code and Codex render a bulleted elapsed counter while a model request is in flight; agy
// uses its own `Generating…` indicator.
export const WORK_COUNTER_PATTERN = /\(\s*(\d+)\s*s\s*[·•]/g;

// Chrome a TUI paints only while a model request is actually IN FLIGHT. agy renders an animated
// `Generating…` for exactly as long as the request runs; Claude Code and Codex render their
// bulleted elapsed counter, so WORK_COUNTER_PATTERN's shape is spliced in (rather than re-spelled)
// to keep the two from drifting apart. `esc to cancel` is DELIBERATELY NOT HERE, despite being
// half of agy's in-flight footer.
export const GENERATION_ACTIVITY_PATTERN =
  new RegExp(`Generating\\s*[.·•…]|${WORK_COUNTER_PATTERN.source}`, 'i');

// Chrome a TUI's status line shows while a request is still in flight, for the one-shot runner's
// idle-completion guard (`screenShowsInFlightChrome`). Broader than GENERATION_ACTIVITY_PATTERN on
// purpose — that one latches "recovered" and must never false-positive, while a false positive
// here only means waiting for the response file or the hard timeout instead of scraping the screen
// early.
const IN_FLIGHT_CHROME_PATTERN = new RegExp([
  `Generating\\s*[.·•…]`,
  `\\(\\s*(?:\\d+\\s*[hm]\\s*)*\\d+\\s*s\\s*[·•]`,
  `thinking\\s*with\\s*\\w+\\s*effort`,
  `esc\\s*to\\s*interrupt`,
].join('|'), 'gi');
// How much visible text may follow the last in-flight chrome before the screen counts as having
// moved on. Below the spinner Claude Code paints its composer box and footer (`? for shortcuts`,
// mode hints), so the allowance has to clear that chrome; an inline answer — the case idle
// completion exists for — is a structured response that runs far longer.
const IN_FLIGHT_CHROME_TRAILING_CHARS = 300;
// Box-drawing (U+2500–U+257F) and block elements (U+2580–U+259F) are composer frame, not content,
// so they never count toward the trailing allowance.
const NON_CONTENT_CHARS = /[\s\u2500-\u259F]+/g;

/**
 * Whether the END of an ANSI-stripped screen transcript is still showing a request in flight — a
 * working counter, `thinking with <level> effort`, `esc to interrupt` — rather than an answer
 * printed after it. A model can sit in a long thinking stretch without repainting its spinner
 * (Claude Code on Fable did, 2026-10-11), so silence alone is not completion: the one-shot runner
 * consults this before idle-completing, and while it holds the run waits for its response file,
 * process exit, or the hard timeout.
 * @param {string} strippedTail recent ANSI-stripped output (a few KB is plenty)
 * @returns {boolean}
 */
export function screenShowsInFlightChrome(strippedTail) {
  if (typeof strippedTail !== 'string' || !strippedTail) return false;
  let lastEnd = -1;
  for (const match of strippedTail.matchAll(IN_FLIGHT_CHROME_PATTERN)) {
    lastEnd = match.index + match[0].length;
  }
  if (lastEnd < 0) return false;
  const trailing = strippedTail.slice(lastEnd).replace(NON_CONTENT_CHARS, '');
  return trailing.length <= IN_FLIGHT_CHROME_TRAILING_CHARS;
}

// Carry-over kept across chunks so in-flight chrome split by a PTY chunk boundary (`Generat` +
// `ing…`) still matches. Only needs to span the longest pattern alternative, because `observe`
// tests the FULL `carry + chunk` window and trims only afterwards (see below) — the cap bounds
// retained state, it never bounds what gets matched.
const GENERATION_ACTIVITY_CARRY_CAP = 64;

/**
 * Stateful latch for "the TUI is actively generating a response". Feed it each ANSI-stripped chunk
 * via `observe(strippedText)`; it becomes (and stays) `active` once any in-flight chrome appears,
 * and returns true on the call that flipped it (so a caller can react to the transition).
 * @returns {{ observe: (strippedText: string) => boolean, readonly active: boolean }}
 */
export function createGenerationActivityTracker() {
  let active = false;
  let tail = '';
  return {
    observe(strippedText) {
      if (active) return true;
      if (typeof strippedText !== 'string' || !strippedText) return false;
      // Test the WHOLE window, then trim. Trimming first (the sibling trackers' shape) throws away
      // everything but the last CAP characters of the chunk, so chrome anywhere earlier in a
      // typical multi-hundred-byte PTY repaint is never matched at all — the tracker would miss a
      // provider that HAD recovered and the run would be failed over to a fallback for nothing.
      const window = tail + strippedText;
      if (GENERATION_ACTIVITY_PATTERN.test(window)) active = true;
      tail = window.slice(-GENERATION_ACTIVITY_CARRY_CAP);
      return active;
    },
    get active() { return active; },
  };
}

// How often to re-submit the prompt while a self-clearing signal's grace window is open. A passive
// wait CANNOT clear agy's eligibility banner: the banner is that submission's REJECTION, not a
// progress spinner. agy discards the submitted prompt, empties its composer and returns to the
// idle `? for shortcuts` footer — verbatim from agent-1f08178b's raw.txt, and confirmed on a live
// session left sitting at the banner.
export const SELF_CLEARING_RESUBMIT_INTERVAL_MS = 20000;

// How often a consumer without its own poll should ASK the gate whether a re-submission is due.
// Deliberately a sub-multiple of the interval above rather than equal to it: a timer whose period
// matches the cadence exactly can tick a hair early (timer rounding vs. `Date.now()`) and `takeResubmit` refuses, silently forfeiting that attempt for a whole interval.
// Polling faster than the cadence leaves the gate the single authority on timing.
export const SELF_CLEARING_RESUBMIT_POLL_MS = 5000;

// How long after a re-submission the gate ignores output when deciding whether the provider
// recovered. The generation tracker matches a single chunk, which is safe only while the stream
// cannot contain the prompt.
export const SELF_CLEARING_RESUBMIT_ECHO_MS = 3000;

/**
 * The wait-it-out policy for a provider signal that carries a `graceMs` (today: agy's
 * account-eligibility banner — see IMMEDIATE_FALLBACK_SIGNALS in aiToolkit/errorDetection.js for
 * the canonical account of why it exists). Owns the whole state machine so the consumers can't
 * drift: arm-once (a repainting TUI re-matches constantly and must not restart the clock),
 * feed-the-tracker only inside the window, re-submit the prompt on a cadence (see
 * SELF_CLEARING_RESUBMIT_INTERVAL_MS — the wait is ACTIVE, because the banner rejected the
 * submission), disarm the moment the provider is demonstrably generating again, and hand back a
 * verdict at the deadline.
 * @returns {{ arm: (analysis: object, nowMs: number) => boolean,
 *             observe: (strippedText: string, nowMs: number) => boolean,
 *             takeResubmit: (nowMs: number) => number,
 *             takeExpired: (nowMs: number) => object|null,
 *             readonly armed: boolean }}
 */
export function createSelfClearingSignalGate() {
  let armed = null; // { analysis, deadlineAt, nextResubmitAt, echoUntil, resubmits }
  let activity = null;
  // Latched once a window is ridden out successfully, which suppresses re-arming for the rest of
  // the run. This is not just tidiness: the caller's detector is a BUFFERED stream matcher
  // (createImmediateFallbackSignalDetector keeps a 512-char window), so the banner keeps matching
  // for many chunks after the provider has recovered.
  let recovered = false;
  return {
    get armed() { return armed !== null; },
    get recovered() { return recovered; },
    arm(analysis, nowMs) {
      if (armed || recovered || !analysis || !(analysis.graceMs > 0)) return false;
      armed = {
        analysis,
        deadlineAt: nowMs + analysis.graceMs,
        // First retry is one full interval out, not immediate: the banner paints within a second
        // of the submit-Enter, and re-pasting on top of a TUI still settling from the rejected
        // paste is how you get two prompts concatenated in the composer.
        nextResubmitAt: nowMs + SELF_CLEARING_RESUBMIT_INTERVAL_MS,
        // Nothing has been re-pasted yet, so nothing in the stream is our echo.
        echoUntil: 0,
        // 1-based count of re-submissions made inside THIS window, used only to label the attempt
        // in the consumers' logs. Lives on `armed` so its per-window lifetime is structural rather
        // than a reset to remember.
        resubmits: 0,
      };
      activity = createGenerationActivityTracker();
      return true;
    },
    // Returns true on the call that ends the window because the provider came back — disarming
    // here (rather than at the deadline) is what stops a recovered run from sitting under idle
    // suppression for the rest of the window. `nowMs` is required: without a clock there is no way
    // to tell our own re-pasted prompt from the provider's output.
    observe(strippedText, nowMs) {
      if (!armed || nowMs < armed.echoUntil) return false;
      if (!activity.observe(strippedText)) return false;
      armed = null;
      activity = null;
      recovered = true;
      return true;
    },
    // Returns the 1-based attempt number when the prompt is due to be re-sent, or 0. The consumer
    // owns the actual paste; this only owns "is it time?" so both consumers keep the same cadence.
    takeResubmit(nowMs) {
      if (!armed || nowMs < armed.nextResubmitAt || nowMs >= armed.deadlineAt) return 0;
      armed.nextResubmitAt = nowMs + SELF_CLEARING_RESUBMIT_INTERVAL_MS;
      armed.echoUntil = nowMs + SELF_CLEARING_RESUBMIT_ECHO_MS;
      armed.resubmits += 1;
      return armed.resubmits;
    },
    // Returns the analysis to fail over with, or null while still waiting (or after a recovery).
    // `nowMs` is OPTIONAL: a poller passes the clock and gets a deadline comparison, while a
    // consumer whose own `setTimeout` fired for exactly this window omits it and force-expires.
    takeExpired(nowMs) {
      if (!armed) return null;
      if (nowMs !== undefined && nowMs < armed.deadlineAt) return null;
      const { analysis } = armed;
      armed = null;
      activity = null;
      return analysis;
    },
  };
}

// A SINGLE Enter after a large bracketed paste is unreliable: the TUI can still be
// processing/reflowing the multi-line paste when the `\r` arrives and swallow it, leaving the
// whole prompt sitting unsent in the input box. (The marker fast path above now fires again once
// matched against stripped output — see detectPasteMarker — but the marker only renders for large
// multi-line pastes; short prompts still lean on the fallback timer, so multi-Enter remains the
// safety net for both.) Send a few Enters spaced apart so at least one lands after the paste
// settles.
export const SUBMIT_ENTER_ATTEMPTS = 3;
export const SUBMIT_ENTER_SPACING_MS = 700;

// The byte a real terminal sends when the user presses Enter — the one every `write()` above hands
// to a PTY, and the terminator on any command PortOS injects into a shell session
// (services/shell.js#submitToSession). CR, never LF.
export const SUBMIT_KEY = '\r';

/**
 * Submit a freshly-pasted TUI prompt by sending Enter SUBMIT_ENTER_ATTEMPTS times: once
 * immediately, then on a SUBMIT_ENTER_SPACING_MS interval until the attempt budget is spent (see
 * the constants above for why a single Enter is unreliable). Shared by both the agent path and the
 * one-shot runner so the two can't drift.
 * @param {() => void} write — sends one `\r` to the TUI. The caller owns the
 *   write mechanism (PTY vs shell session) and its error handling.
 * @param {() => boolean} isFinalized — true once the run has ended; stops the
 *   retry loop so it can't write into a torn-down session.
 * @returns {ReturnType<typeof setInterval>|null} the retry interval id (null
 *   when no retries were scheduled). The caller stores it so its finalize path
 *   can cancel pending retries; calling clearInterval on an already-self-cleared
 *   id is a harmless no-op.
 */
export function scheduleSubmitEnters(write, isFinalized) {
  if (isFinalized()) return null;
  write();
  let attemptsLeft = SUBMIT_ENTER_ATTEMPTS - 1;
  if (attemptsLeft <= 0) return null;
  const timer = setInterval(() => {
    if (isFinalized() || attemptsLeft <= 0) {
      clearInterval(timer);
      return;
    }
    attemptsLeft -= 1;
    write();
  }, SUBMIT_ENTER_SPACING_MS);
  return timer;
}

// Defaults the consumer applies when the provider config doesn't pin per-provider prompt timing
// values (provider.tuiPromptDelayMs).
export const DEFAULT_TUI_PROMPT_DELAY_MS = 2500;


// ─── Codex MCP-server boot detection ────────────────────────────────────── Codex (unlike Claude
// Code) boots any MCP servers configured in the user's GLOBAL `~/.codex/config.toml` on every
// startup — INCLUDING for our headless CoS agents, which never asked for them.
const MCP_BOOT_MARKERS = ['booting mcp server', 'starting mcp servers'];

// Covers a `node_repl` with the documented `startup_timeout_sec = 120` plus an `npx`-fetched
// server's cold download and margin, while still bounding a genuinely-hung boot's failure. The
// deadline is independent of CoS agent runtime handling so a slow MCP boot gets its full retry
// budget.
export const MCP_BOOT_PASTE_DEADLINE_MS = 150000;
// Spacing between paste retries while codex is booting MCP servers. A swallowed mid-boot paste
// renders nothing, so a re-paste every few seconds is a cheap no-op until the box is finally live;
// this is additive to each attempt's own marker-wait + verify window (~5.5s), so the effective
// cadence is ~10s.
export const MCP_BOOT_PASTE_RETRY_DELAY_MS = 5000;

// Rolling tail cap for createMcpBootTracker's cross-chunk buffer: a boot banner can split across
// two onData chunks during streaming, so concatenate onto a short tail before testing.
const MCP_BOOT_TAIL_CAP = 256;

/**
 * True when a chunk of ANSI-stripped TUI output shows codex booting its MCP servers. Callers MUST
 * pass stripped output.
 * @param {string} strippedText — ANSI-stripped output (a chunk or accumulator).
 * @returns {boolean}
 */
export function isMcpBootSignal(strippedText) {
  if (typeof strippedText !== 'string' || !strippedText) return false;
  const lower = strippedText.toLowerCase();
  return MCP_BOOT_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Latching tracker for "this TUI is booting its MCP servers" — the codex slow- boot failure mode
 * above. Feed it each ANSI-stripped STARTUP chunk (before the prompt is submitted) via
 * `observe(text)`; it latches `active` the first time a boot banner appears and STAYS active
 * thereafter.
 * @returns {{ observe: (strippedText: string) => boolean, readonly active: boolean }}
 */
export function createMcpBootTracker() {
  let active = false;
  let tail = '';
  return {
    observe(strippedText) {
      if (active) return true;
      if (typeof strippedText !== 'string' || !strippedText) return active;
      // Search BEFORE truncating. Codex commonly sends a whole-screen repaint in one PTY chunk:
      // the MCP status sits above the composer/footer, and that suffix alone can exceed
      // MCP_BOOT_TAIL_CAP.
      const combined = tail + strippedText;
      if (isMcpBootSignal(combined)) active = true;
      tail = combined.slice(-MCP_BOOT_TAIL_CAP);
      return active;
    },
    get active() { return active; },
  };
}

// ─── Buffer caps (defensive RAM bounds) ─────────────────────────────────── RAW caps stay small —
// the raw PTY stream is only used for paste-marker detection and a short failure-tail in the exit
// error message, both of which need only the recent past.
export const POST_PASTE_BUFFER_CAP = 64 * 1024;
export const RAW_BUFFER_CAP = 512 * 1024;
export const RAW_BUFFER_HEADROOM = 640 * 1024;
export const OUTPUT_BUFFER_CAP = 8 * 1024 * 1024;
export const OUTPUT_BUFFER_HEADROOM = 10 * 1024 * 1024;
// Disk safety valve for the agent-mode raw.txt spool. Counted as UTF-8 bytes actually written.
export const RAW_SPOOL_MAX_BYTES = 256 * 1024 * 1024;

// ─── Command + args helpers ───────────────────────────────────────────────

/**
 * The launch command a TUI provider gets when it names none — the spawners'
 * blank-`provider.command` fallback (`buildTuiSpawnConfig`, and mirrored by
 * `buildCliSpawnConfig`'s default branch). An unrecognized id resolves to `claude`, matching
 * `isClaudeCommand`'s blank-is-Claude policy.
 * @param {string|null|undefined} id - provider id
 * @returns {string}
 */
export { inferTuiCommand };

/** TUI posture-flag dispatch (approval/trust bypass per vendor). */
export { applyCommandDefaults };

/**
 * Build the spawn args for a TUI invocation. When `provider.args` already has a `--model X` (or
 * `-m X`) pin, the args-baked flag wins and we skip the per-call --model append — otherwise the
 * CLI would see two flags and either error or take the last one (provider-specific).
 */
export function buildTuiInvocation(provider, model) {
  const command = provider?.command || inferTuiCommand(provider?.id);
  const baseArgs = applyCommandDefaults(command, [...(provider?.args || [])], provider);
  const effort = provider?.effort || null;
  return {
    command,
    args: injectTuiModelAndEffort(command, baseArgs, provider, model, effort),
  };
}

/**
 * Returns true when the stripped chunk looks like a `command not found` error for our spawned TUI
 * binary. Used as an early-fail probe so a typo'd provider.command surfaces in seconds instead of
 * after a completion timeout.
 */
export function detectMissingTuiBinary(strippedText, commandName) {
  const lower = strippedText.toLowerCase();
  return lower.includes('command not found') && lower.includes(commandName.toLowerCase());
}

// ── Local-runtime OOM nudge ──────────────────────────────────────────────── Recovery policy for
// a LOCAL inference runtime that ran out of accelerator memory mid-turn (detectLocalRuntimeOom in
// aiToolkit/errorDetection.js). This is NOT the self-clearing gate above, and the difference is
// what the provider did with the turn. agy's eligibility banner REJECTS the submission: the
// composer empties, nothing is in flight, and the remedy is to re-send the whole prompt.

// How long the session must have been SILENT before a nudge goes out. This is the whole
// false-positive defense, and it is deliberately a silence test rather than a chrome test: the
// generation-activity tracker above is spelled in agy/claude/codex footer text that OpenCode does
// not paint at all (its in-flight chrome is an animated block wave plus an `esc interrupt` footer
// that repaints only ~8 times across a 74MB transcript), so a chrome-based recovery check would
// read a perfectly healthy OpenCode session as stuck.
export const OOM_NUDGE_SETTLE_MS = 25000;
// How long an armed nudge waits for that silence before giving up. Bounds the blast radius of the
// one case the cooldown can't dedupe — the error box being repainted long after the session
// recovered — so a stale arm can't sit around and fire into the next quiet stretch of a healthy
// run.
export const OOM_NUDGE_ARM_WINDOW_MS = 120000;
// Two matches this close together are one OOM: the detector re-tests a 512-char rolling window,
// and a TUI repaint re-delivers the same error box for many chunks after the event.
export const OOM_NUDGE_COOLDOWN_MS = 120000;
export const OOM_NUDGE_MAX_ATTEMPTS = 3;
// What gets pasted. The literal word a human used, for the literal reason it worked: the TUI still
// holds the conversation and the model just needs a turn.
export const OOM_NUDGE_TEXT = 'continue';

/**
 * State machine for "nudge a TUI session that a local-GPU OOM left parked". Feed it every OOM
 * detection via `arm(analysis, nowMs)`, then poll `takeNudge(nowMs, lastOutputAtMs)` on whatever
 * timer the consumer already runs.
 * @returns {{ arm: (analysis: object, nowMs: number) => 'armed'|'exhausted'|null,
 *             takeNudge: (nowMs: number, lastOutputAtMs: number) => number }}
 */
export function createOomNudgeGate() {
  const gate = createSilenceNudgeGate({
    cooldownMs: OOM_NUDGE_COOLDOWN_MS,
    settleMs: OOM_NUDGE_SETTLE_MS,
    armWindowMs: OOM_NUDGE_ARM_WINDOW_MS,
    maxAttempts: OOM_NUDGE_MAX_ATTEMPTS,
  });
  return {
    arm: (analysis, nowMs) => (analysis ? gate.arm(nowMs) : null),
    takeNudge: gate.takeNudge,
  };
}

// ─── Truncation nudge — "the harness cut the response off mid-generation" ──── pi's TUI halts the
// whole session on `Response was truncated before completion.` — the turn is dead, but the session
// still holds the whole conversation, and the only thing that resumes it is somebody typing
// `continue` and pressing Enter.

// Reuses the OOM gate's timing wholesale. The truncation banner, like the OOM box, keeps
// repainting for chunks after the event, so the cooldown and the wait-for-silence window are the
// same load-bearing details; and a response that truncates three times in one run is not going to
// complete on the fourth, for the same reason an OOM that outlasts three nudges isn't.
export const TRUNCATION_NUDGE_MAX_ATTEMPTS = OOM_NUDGE_MAX_ATTEMPTS;
// What gets pasted — the same word the OOM nudge pastes, for the same reason: the TUI still holds
// the conversation and the model just needs a turn.
export const TRUNCATION_NUDGE_TEXT = OOM_NUDGE_TEXT;

/**
 * State machine for "nudge a TUI session a truncated response left halted". Delegates to
 * `createOomNudgeGate` — the two conditions share every policy detail (a dead turn, an intact
 * session, a banner that repaints), so the gate is literally the same machine under a name that
 * says what it watches for.
 * @returns {{ arm: (analysis: object, nowMs: number) => 'armed'|'exhausted'|null,
 *             takeNudge: (nowMs: number, lastOutputAtMs: number) => number }}
 */
export function createTruncationNudgeGate() {
  return createOomNudgeGate();
}

// ─── Model-at-capacity nudge — "the provider is overloaded, try again later" ── Codex halts the
// turn on `Selected model is at capacity.` and waits at the composer for a human to type
// `continue`.
export const CAPACITY_NUDGE_SETTLE_MS = 90000;
export const CAPACITY_NUDGE_ARM_WINDOW_MS = 300000;
export const CAPACITY_NUDGE_COOLDOWN_MS = 180000;
export const CAPACITY_NUDGE_MAX_ATTEMPTS = 6;
export const CAPACITY_NUDGE_TEXT = OOM_NUDGE_TEXT;

/**
 * State machine for "nudge a TUI session a model-at-capacity rejection parked". See
 * `createSilenceNudgeGate` for the semantics of `arm` / `takeNudge`.
 */
export function createModelCapacityNudgeGate() {
  const gate = createSilenceNudgeGate({
    cooldownMs: CAPACITY_NUDGE_COOLDOWN_MS,
    settleMs: CAPACITY_NUDGE_SETTLE_MS,
    armWindowMs: CAPACITY_NUDGE_ARM_WINDOW_MS,
    maxAttempts: CAPACITY_NUDGE_MAX_ATTEMPTS,
  });
  return {
    arm: (analysis, nowMs) => (analysis ? gate.arm(nowMs) : null),
    takeNudge: gate.takeNudge,
  };
}

/**
 * The "wait for silence, then nudge" policy the OOM gate and the tool-permission gate share:
 * dedupe sightings inside `cooldownMs` (a TUI repaints an error box for many chunks), fire once
 * the session has been quiet for `settleMs`, drop an arm the session outran (`armWindowMs` — it
 * recovered on its own), and report `'exhausted'` once `maxAttempts` nudges have already been
 * spent on a condition that keeps coming back. `arm(nowMs)` returns `'armed'`, `'exhausted'`, or
 * null for a sighting inside the cooldown or while a nudge is already pending.
 */
export function createSilenceNudgeGate({ cooldownMs, settleMs, armWindowMs, maxAttempts }) {
  let armedAt = null;
  let lastArmedAt = null;
  let attempts = 0;
  return {
    inCooldown: (nowMs) => lastArmedAt !== null && nowMs - lastArmedAt < cooldownMs,
    arm(nowMs) {
      // A sighting while a nudge is already pending is the same condition still on screen: it
      // neither restarts the window (a box that repaints forever must still expire it) nor
      // refreshes the cooldown (or a repaint outlasting the window could never re-arm once it
      // stops).
      if (armedAt !== null) return null;
      if (lastArmedAt !== null && nowMs - lastArmedAt < cooldownMs) return null;
      lastArmedAt = nowMs;
      // Budget spent: this is a genuinely NEW sighting (it cleared the cooldown) after the nudges
      // already bought the run more than one recovery. Hand the verdict back rather than arming a
      // window nobody will act on.
      if (attempts >= maxAttempts) return 'exhausted';
      armedAt = nowMs;
      return 'armed';
    },
    takeNudge(nowMs, lastOutputAtMs) {
      if (armedAt === null) return 0;
      if (nowMs - armedAt > armWindowMs) { armedAt = null; return 0; }
      if (nowMs - lastOutputAtMs < settleMs) return 0;
      armedAt = null;
      attempts += 1;
      return attempts;
    },
  };
}

// How long one request's retry sequence may span before the run is failed over. Long enough that
// Claude Code's own retry ladder for a transient cloud fault (ten attempts, seconds of backoff
// each) always finishes inside it — that ladder either recovers or ends in a terminal gutter line
// the idle reaper handles — and short enough that a request the provider can never answer is not
// left to burn a lane for the run's whole 3h ceiling.
export const RETRY_STALL_MS = 10 * 60 * 1000;
export const RETRY_STALL_MIN_ADVANCES = 2;
// Carry-over kept across chunks so a banner split by a PTY chunk boundary still matches. Spans the
// longest banner (`Retrying in 999s · attempt 10/10`) plus the cursor-positioning residue
// stripping leaves around it.
const RETRY_STALL_CARRY_CAP = 96;

/**
 * Feed it every ANSI-stripped chunk after the prompt is in via `observe(strippedText, nowMs)`;
 * poll `takeStall(nowMs)` on whatever timer the consumer already runs. It tracks one EPISODE at a
 * time — the retry sequence of a single request, recognised by its attempt counter climbing.
 * @returns {{ observe: (strippedText: string, nowMs: number) => void,
 *             takeStall: (nowMs: number) => object|null }}
 */
export function createRetryStallGate() {
  let episode = null; // { firstSeenAt, lastSeenAt, firstAttempt, lastAttempt }
  let verdict = null;
  let tail = '';
  return {
    observe(strippedText, nowMs) {
      if (typeof strippedText !== 'string' || !strippedText) return;
      const window = tail + strippedText;
      const banner = detectTuiRetryBanner(window);
      // Consume through the match so the carry-over cannot re-sight the same banner on the next
      // chunk; without one, keep only the cap.
      tail = (banner ? window.slice(banner.endIndex) : window).slice(-RETRY_STALL_CARRY_CAP);
      if (!banner) return;
      const isNewEpisode = !episode
        || banner.attempt < episode.lastAttempt
        || nowMs - episode.lastSeenAt > RETRY_STALL_MS;
      if (isNewEpisode) {
        episode = { firstSeenAt: nowMs, lastSeenAt: nowMs, firstAttempt: banner.attempt, lastAttempt: banner.attempt };
        return;
      }
      episode.lastSeenAt = nowMs;
      episode.lastAttempt = banner.attempt;
      const spanMs = nowMs - episode.firstSeenAt;
      if (episode.lastAttempt - episode.firstAttempt < RETRY_STALL_MIN_ADVANCES || spanMs < RETRY_STALL_MS) return;
      verdict = describeTuiRetryStall({ attempts: episode.lastAttempt - episode.firstAttempt + 1, spanMs });
      episode = null;
    },
    // The stall analysis to fail over with, once, or null.
    takeStall() {
      const analysis = verdict;
      verdict = null;
      return analysis;
    },
  };
}

// Claude Code's tool-permission dialog, as the ANSI-stripped screen renders it (spaces between
// cursor-positioned glyphs can vanish, hence `\s*`): Read(/data.reference/providers.json) Do you
// want to proceed? ❯ 1.
export const TUI_TOOL_PERMISSION_PROMPT_PATTERN = /do\s*you\s*want\s*to\s*proceed\?/i;
const TUI_TOOL_PERMISSION_NO_OPTION_PATTERN = /(\d+)\.\s*No\b/i;
const TUI_TOOL_PERMISSION_CALL_PATTERN = /([A-Z][A-Za-z]*\([^\n]{0,300}?\))\s*do\s*you\s*want\s*to\s*proceed\?/i;
// Screen around the question: how far back the tool-call header may sit, and how far ahead the
// option list may span before it is judged not painted yet.
const TUI_TOOL_PERMISSION_CALL_LEAD = 400;
const TUI_TOOL_PERMISSION_OPTIONS_SPAN = 600;

/**
 * The tool-permission dialog on screen, or null. Null also while the question has painted but the
 * option list has not — the consumer waits for the next repaint rather than guessing which key
 * declines.
 * @returns {{ noOption: number, toolCall: string|null }|null}
 */
export function detectToolPermissionPrompt(strippedText) {
  if (typeof strippedText !== 'string' || !strippedText) return null;
  const question = TUI_TOOL_PERMISSION_PROMPT_PATTERN.exec(strippedText);
  if (!question) return null;
  const options = strippedText.slice(question.index, question.index + TUI_TOOL_PERMISSION_OPTIONS_SPAN);
  const no = TUI_TOOL_PERMISSION_NO_OPTION_PATTERN.exec(options);
  if (!no) return null;
  const lead = strippedText.slice(Math.max(0, question.index - TUI_TOOL_PERMISSION_CALL_LEAD), question.index + question[0].length);
  const call = TUI_TOOL_PERMISSION_CALL_PATTERN.exec(lead);
  return { noOption: Number(no[1]), toolCall: call ? call[1].replace(/\s+/g, ' ') : null };
}

// A declined dialog keeps repainting for a few chunks and the keystrokes take a moment to land;
// sightings this close to a decline are the same dialog.
export const TOOL_PERMISSION_REPAINT_COOLDOWN_MS = 15000;
// Declining a tool call ends the assistant turn in current Claude Code builds ("What should Claude
// do instead?"), so the session then needs a message to carry on. It rides the OOM nudge's silence
// policy (OOM_NUDGE_SETTLE_MS / OOM_NUDGE_ARM_WINDOW_MS): sent only once the session has gone
// quiet, so a build that instead hands the model a rejection and lets it continue is left alone.
export const TOOL_PERMISSION_DECLINE_MAX = 8;
export const TOOL_PERMISSION_NUDGE_TEXT = 'That tool call reached outside this run\'s allowed scope, so it was declined. Nobody is watching this session and no permission can be granted. Everything you need is inside your worktree and your prompt; continue using paths under the worktree only, and write the completion sentinel when you are done.';

/**
 * "Decline every tool-permission dialog, then get the session moving again": the dialog detector
 * with a carry-over tail, on top of createSilenceNudgeGate. Feed it every ANSI-stripped chunk
 * after the prompt is in via `observe(strippedText, nowMs)`: it returns the dialog to decline (`{
 * noOption, toolCall, count }`) once per dialog, `'exhausted'` once TOOL_PERMISSION_DECLINE_MAX
 * dialogs have been declined, or null.
 * @returns {{ observe: (strippedText: string, nowMs: number) => object|'exhausted'|null,
 *             takeNudge: (nowMs: number, lastOutputAtMs: number) => number }}
 */
export function createToolPermissionGate() {
  const nudge = createSilenceNudgeGate({
    cooldownMs: TOOL_PERMISSION_REPAINT_COOLDOWN_MS,
    settleMs: OOM_NUDGE_SETTLE_MS,
    armWindowMs: OOM_NUDGE_ARM_WINDOW_MS,
    // The budget is counted in declines (below), not nudges: a build that lets the model continue
    // after a rejection never goes quiet, so a nudge budget would never be spent while the
    // declines climbed forever.
    maxAttempts: Infinity,
  });
  let tail = '';
  let declines = 0;
  return {
    observe(strippedText, nowMs) {
      if (typeof strippedText !== 'string' || !strippedText) return null;
      tail = (tail + strippedText).slice(-1024);
      if (nudge.inCooldown(nowMs)) return null;
      const dialog = detectToolPermissionPrompt(tail);
      if (!dialog) return null;
      tail = '';
      if (declines >= TOOL_PERMISSION_DECLINE_MAX) return 'exhausted';
      declines += 1;
      // A null here means a nudge is already pending from the previous decline; it will fire on
      // the same silence and covers this one too.
      nudge.arm(nowMs);
      return { ...dialog, count: declines };
    },
    takeNudge: nudge.takeNudge,
  };
}

// --------------------------------------------------------------------------- Stall nudge — "the
// session stopped mid-task and nothing will ever re-ask"
// --------------------------------------------------------------------------- The failure this
// exists for has no error banner, no dialog and no exit: the model narrates its next step ("Next:
// /do:pr"), ends its turn, and the TUI returns to its idle composer.

// How long the session must have printed NOTHING before it counts as stopped. Deliberately a
// silence test rather than a chrome test, for the reason OOM_NUDGE_SETTLE_MS spells out: in-flight
// chrome is per-provider vocabulary, while silence is universal.
export const STALL_NUDGE_IDLE_MS = 10 * 60 * 1000;
// How much output AFTER a nudge proves the session took the hint. Long enough to exclude the
// bracketed-paste echo of the nudge itself (which lands within a second or so), short enough that
// a session that genuinely resumed clears its streak immediately.
export const STALL_NUDGE_RECOVERY_MS = 30000;
// After this many CONSECUTIVE unanswered nudges, stop. A session that ignored three of them is
// wedged below the composer (a dead child, a TUI that stopped reading its PTY), and pasting into
// it forever only fills raw.txt.
export const STALL_NUDGE_MAX_ATTEMPTS = 3;
// Lifetime ceiling across every streak of one session. The recovery reset above trusts "it printed
// for 30s" as proof the nudge worked, but a model that has lost the thread answers every nudge
// with a paragraph ("the story is finished") and then stops again — each reply clears the streak,
// so the per-streak budget never runs out and the run loops for hours on a local GPU.
export const STALL_NUDGE_MAX_TOTAL = 6;
// The original prompt still owns scope, publication authority, and the exact sentinel contract.
// Recovery asks for an honest disposition, not a success.
export const STALL_NUDGE_TEXT = [
  'Continue the task from where you stopped. If you are waiting on a background command, CI run, or job you started, check its current state and keep working toward the goal your original instructions set; a pending or failed check is a step to handle, not a reason to stop.',
  'Write the completion sentinel once the task is done, or once a real blocker your original instructions name stops it. File GitHub issues for anything that is too big for this session.',
  'Stay within the original task scope, permissions, and safety limits; do not bypass a refusal or permission block.',
  'Follow the owning repository\'s issue-filing instructions: search for duplicates and reuse an existing issue, or file an actionable issue with redacted evidence, affected paths, a chosen next step, and acceptance criteria.',
  'If issue filing is not authorized, unavailable, or fails, report the filing blocker and ready-to-file details as an INCOMPLETE disposition; do not claim it was filed.',
  'Use the exact sentinel path and format from your existing completion instructions. Summarize verified work, checks, issue links, unresolved work, and blockers honestly; writing the sentinel does not itself mean the task succeeded.',
].join(' ');

/**
 * State machine for "nudge a TUI session that stopped mid-task". Poll `takeNudge(nowMs,
 * lastOutputAtMs)` on whatever timer the consumer already runs.
 * @param {{ idleMs?: number, recoveryMs?: number, maxAttempts?: number, maxTotal?: number }} [options]
 * @returns {{ takeNudge: (nowMs: number, lastOutputAtMs: number) => number|'exhausted', readonly nudgesSent: number }}
 */
export function createStallNudgeGate({
  idleMs = STALL_NUDGE_IDLE_MS,
  recoveryMs = STALL_NUDGE_RECOVERY_MS,
  maxAttempts = STALL_NUDGE_MAX_ATTEMPTS,
  maxTotal = STALL_NUDGE_MAX_TOTAL,
} = {}) {
  let attempts = 0;
  let total = 0;
  let nudgedAt = null;
  let reportedExhausted = false;
  return {
    takeNudge(nowMs, lastOutputAtMs) {
      // Checked before the budget so an exhausted streak can still be cleared by a session that
      // came back to life — which also re-arms the verdict, since a run that recovered and stalled
      // again is wedged afresh.
      if (nudgedAt !== null && lastOutputAtMs - nudgedAt > recoveryMs) {
        attempts = 0;
        nudgedAt = null;
        reportedExhausted = false;
      }
      if (nowMs - lastOutputAtMs < idleMs) return 0;
      if (nudgedAt !== null && nowMs - nudgedAt < idleMs) return 0;
      if (attempts >= maxAttempts || total >= maxTotal) {
        if (reportedExhausted) return 0;
        reportedExhausted = true;
        return 'exhausted';
      }
      attempts += 1;
      total += 1;
      nudgedAt = nowMs;
      return attempts;
    },
    get nudgesSent() { return total; },
  };
}

// ─── Unsubmitted prompt — "the paste landed, the Enter did not" ───────────── A TUI can render
// the paste chip and still ignore every submit Enter that follows it: the composer shows `❯
// [Pasted text #1 +353 lines]` and nothing else ever happens.
export const UNSUBMITTED_PROMPT_SETTLE_MS = 20000;
export const UNSUBMITTED_PROMPT_ENTER_MAX_ATTEMPTS = 3;
// Evidence the turn started: the TUI's own in-flight chrome (a working counter, `Generating…` —
// createGenerationActivityTracker) at any time, or any output arriving this long after PortOS's
// last keystroke, which cannot be its echo. The same 30s that proves a stall nudge took.
export const PROMPT_WORK_EVIDENCE_MS = STALL_NUDGE_RECOVERY_MS;
const UNSUBMITTED_PROMPT_TAIL_CAP = 4096;
// A selector or confirmation painted after the chip owns the Enter key; a bare Enter there would
// pick its highlighted default.
const SELECTOR_AFTER_PASTE_PATTERN = /enter\s*to\s*(?:select|confirm)|↑\s*\/\s*↓|❯\s*1\.|do\s*you\s*want\s*to\s*proceed\?|press\s*enter\s*to\s*continue/i;

/**
 * State machine for "the prompt was pasted and submitted, but the turn never started". Owned per
 * run by the agent session controller.
 * @param {{ promptMarkerCount?: number, settleMs?: number, maxAttempts?: number, workEvidenceMs?: number }} [options]
 */
export function createPromptSubmissionGate({
  promptMarkerCount = 0,
  settleMs = UNSUBMITTED_PROMPT_SETTLE_MS,
  maxAttempts = UNSUBMITTED_PROMPT_ENTER_MAX_ATTEMPTS,
  workEvidenceMs = PROMPT_WORK_EVIDENCE_MS,
} = {}) {
  let inputAt = null;
  let worked = false;
  let tail = '';
  let enters = 0;
  const generation = createGenerationActivityTracker();
  const holdsUnsubmittedPaste = () => {
    if (!isPasteCommitted(tail, { promptMarkerCount })) return false;
    let lastMarkerEnd = -1;
    for (const match of tail.matchAll(PASTE_MARKER_PATTERN_GLOBAL)) lastMarkerEnd = match.index + match[0].length;
    return lastMarkerEnd >= 0 && !SELECTOR_AFTER_PASTE_PATTERN.test(tail.slice(lastMarkerEnd));
  };
  return {
    noteInput(nowMs, evidence = '') {
      inputAt = nowMs;
      if (!worked && evidence) tail = (tail + evidence).slice(-UNSUBMITTED_PROMPT_TAIL_CAP);
    },
    observe(strippedText, nowMs) {
      if (worked || inputAt === null || !strippedText) return;
      if (generation.observe(strippedText) || nowMs - inputAt >= workEvidenceMs) {
        worked = true;
        tail = '';
        return;
      }
      tail = (tail + strippedText).slice(-UNSUBMITTED_PROMPT_TAIL_CAP);
    },
    takeEnter(nowMs, lastOutputAtMs) {
      if (worked || inputAt === null || enters >= maxAttempts) return 0;
      if (nowMs - lastOutputAtMs < settleMs || nowMs - inputAt < settleMs) return 0;
      if (!holdsUnsubmittedPaste()) return 0;
      enters += 1;
      inputAt = nowMs;
      return enters;
    },
    get worked() { return worked; },
    get awaitingSubmit() {
      return !worked && inputAt !== null && enters < maxAttempts && holdsUnsubmittedPaste();
    },
  };
}

// ─── agy exited to its launch shell ───────────────────────────────────────── When agy quits (a
// crash, a dropped connection, a stray `/exit`), it prints
const AGY_CONVERSATION_PATTERN = /--conversation=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
// Carry-over so a banner split by a PTY chunk boundary still matches: the flag plus a full uuid is
// 51 chars.
const AGY_RESUME_CARRY_CAP = 96;
// A run that exits to the shell this many times is not going to survive one more relaunch.
export const AGY_RESUME_MAX_ATTEMPTS = 3;
// The shell must have been silent this long before the relaunch is typed, so the banner has
// finished painting and the prompt is back.
export const AGY_RESUME_SETTLE_MS = 3000;

/**
 * State machine for "agy left its shell behind — relaunch it on the same conversation". `observe`
 * records the newest conversation id seen in the (ANSI-stripped) stream; `takeResume` returns it
 * once, when the stream has been quiet long enough and the budget allows, else null; the caller
 * reports each real relaunch via `recordRelaunch`.
 * @returns {{ observe: (chunk: string) => void,
 *             takeResume: (nowMs: number, lastOutputAtMs: number) => string|null,
 *             recordRelaunch: () => void, readonly attempts: number }}
 */
export function createAgyResumeGate({ settleMs = AGY_RESUME_SETTLE_MS, maxAttempts = AGY_RESUME_MAX_ATTEMPTS } = {}) {
  let carry = '';
  let pending = null;
  let attempts = 0;
  return {
    observe(chunk) {
      if (!chunk) return;
      const window = carry + chunk;
      carry = window.slice(-AGY_RESUME_CARRY_CAP);
      let last = null;
      for (const match of window.matchAll(AGY_CONVERSATION_PATTERN)) last = match[1];
      if (last) pending = last.toLowerCase();
    },
    takeResume(nowMs, lastOutputAtMs) {
      if (!pending || attempts >= maxAttempts) return null;
      if (nowMs - lastOutputAtMs < settleMs) return null;
      const id = pending;
      pending = null;
      return id;
    },
    // Counted separately from `takeResume`: a banner that scrolled past in a session whose agy is
    // still alive is not a relaunch and must not spend budget.
    recordRelaunch() { attempts += 1; },
    get attempts() { return attempts; },
  };
}
