/**
 * Shared TUI invocation + paste-handshake constants.
 *
 * Two execution paths need these: `server/lib/tuiPromptRunner.js` (one-shot
 * prompts from the central handler) and `server/services/agentTuiSpawning.js`
 * (long-running CoS agents). Both shell into the same set of TUI binaries
 * (Claude Code, Codex, Antigravity) and use identical PTY-paste choreography to
 * deliver the prompt — banner repaint wait, bracketed-paste, Enter handshake.
 * Without this shared module they had verbatim copies that would silently
 * drift the first time anyone tweaked one side's paste timing.
 *
 * No cycle risk: this module imports nothing from either consumer.
 */

// inferTuiCommand / applyCommandDefaults are RE-EXPORTED below (not defined
// here) — the per-vendor dispatch they used to hand-roll now lives in the
// PROVIDER_VENDORS registry (#3618), consumed by every dispatch site that
// used to duplicate its own vendor if-chain.
import { inferTuiCommand, applyCommandDefaults, injectTuiModelAndEffort } from './providerVendors.js';

// ─── Paste handshake constants ────────────────────────────────────────────

// PTY readiness — wait for the TUI banner to finish repainting (output-idle
// for READY_IDLE_THRESHOLD_MS) before pasting. A fixed delay loses to slow
// banners and burns time on fast ones; idle-detect adapts.
export const READY_POLL_INTERVAL_MS = 300;
export const READY_IDLE_THRESHOLD_MS = 1200;
export const PASTE_DEADLINE_MS = 10000;
// How long to wait for claude's POSITIVE input-ready footer (createInputReadyTracker)
// before giving up and surfacing a startup failure. Generous because a cold
// claude start can spend many seconds on banner + MCP-server + model init
// (well within the normal startup budget). Used only on the input-ready-gated
// path; the non-claude providers use PASTE_DEADLINE_MS.
export const TUI_INPUT_READY_DEADLINE_MS = 45000;

// Claude Code emits `[Pasted text #N +M lines]`, Codex emits
// `[Pasted Content N chars]`, and OpenCode emits `[Pasted ~N lines]` after
// committing a paste. Watch for any of these markers (or fall back after
// PASTE_TO_ENTER_FALLBACK_MS) before sending `\r` so Enter doesn't get
// swallowed mid-paste-commit.
//
// CRITICAL: the marker must be matched against ANSI-STRIPPED output, never the
// raw PTY stream. Claude Code renders the marker by positioning each token with
// absolute-column cursor moves instead of literal spaces — the raw bytes look
// like `[Pasted\x1b[11Gtext\x1b[16G#1\x1b[19G+35\x1b[23Glines]`, so the literal
// substring "Pasted text #1" never exists contiguously and a space-requiring
// regex never matches. Once ANSI is stripped the cursor moves vanish and the
// glyphs collapse adjacent → `[Pastedtext#1+35lines]`. So the pattern tolerates
// arbitrary (including zero) whitespace between tokens and is case-insensitive,
// and `detectPasteMarker()` below is the only sanctioned way to test it. This
// was the root cause of issue #1229: across a month of real transcripts the
// marker "never appeared" only because the matcher ran against the raw stream;
// the fast path was effectively dead and every run fell back to the blind timer.
export const PASTE_MARKER_POLL_MS = 150;

// Paste verification: after paste-commit (marker or fallback), verify the prompt
// text actually rendered in the buffer before submitting. If verification fails,
// retry the paste with backoff. This catches TUIs that were still initializing
// when the paste was sent and silently swallowed it (issue #2192).
export const PASTE_VERIFY_POLL_MS = 200;
export const PASTE_VERIFY_WINDOW_MS = 2000; // max time to wait for verification after paste-commit
export const PASTE_RETRY_MAX_ATTEMPTS = 3;
export const PASTE_RETRY_BASE_DELAY_MS = 800;
// Minimum prefix length for verification (shorter prompts verify whole-text)
const MIN_VERIFIABLE_PREFIX_LEN = 15;
export const PASTE_MARKER_PATTERN = /\[Pasted\s*(?:text\s*#\d+[^\]]*|content\s*\d+\s*chars|~\s*\d+\s*lines?)\]/i;
export const PASTE_TO_ENTER_MIN_DELAY_MS = 200;
export const PASTE_TO_ENTER_FALLBACK_MS = 3500;

/**
 * Extract a verifiable prefix from a prompt for paste verification. The prefix
 * is a unique-enough substring from the prompt's first "content" line (skipping
 * leading whitespace/common prefixes) that's unlikely to appear in TUI chrome.
 * Used to verify the paste actually rendered rather than being silently swallowed.
 *
 * @param {string} prompt — the full prompt text being pasted.
 * @returns {string|null} a verifiable prefix, or null if the prompt is too short.
 */
export function extractVerifiablePromptPrefix(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) return null;
  // Collapse whitespace and take the first content chunk. Skip leading boilerplate
  // that might match TUI chrome (e.g., "You are a..." is generic).
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  if (normalized.length < MIN_VERIFIABLE_PREFIX_LEN) {
    // Very short prompt: use the whole thing
    return normalized.length >= 5 ? normalized : null;
  }
  // For longer prompts, take a prefix from the middle portion to avoid common
  // prefixes like "You are" or "Please" that might appear elsewhere
  const startOffset = Math.min(10, Math.floor(normalized.length * 0.1));
  const prefixLen = Math.min(40, normalized.length - startOffset);
  return normalized.slice(startOffset, startOffset + prefixLen);
}

/**
 * True when the verifiable prompt prefix appears in the post-paste buffer.
 * ANSI-stripped input; internal whitespace differences are ignored (see below).
 * A null/empty prefix always returns true (no verification possible).
 *
 * Whitespace is stripped ENTIRELY (not just collapsed to a single space) before
 * comparing, on both sides. Claude Code (and potentially other TUIs) can
 * redraw/reflow a pasted multi-word line using cursor-positioning escapes
 * instead of literal space bytes between words — the same "inter-glyph cursor
 * moves" quirk already documented above (BRACKETED_PASTE_MODE_PATTERN) as the
 * reason createInputReadyTracker avoids literal footer-text matching. ANSI
 * stripping drops those inter-word spaces entirely, so a genuinely-rendered
 * paste can still fail a single-space-normalized substring match (real
 * incident: every claude-code-tui CoS agent failed immediately with
 * "paste-not-rendered" after 3 retries — see tuiHandshake.test.js's "real
 * incident" regression test for the captured transcript). Comparing with all
 * whitespace removed makes the match robust to however a given TUI reflows a
 * line, at the cost of a (very low, given the ~40-char prefix) chance of a
 * spurious match spanning a word boundary that only lines up once spaces are
 * gone.
 *
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

/**
 * Count paste-commit markers from Claude Code, Codex, or OpenCode in
 * `strippedText`.
 * Callers MUST pass ANSI-STRIPPED output (see PASTE_MARKER_PATTERN above for why
 * the raw stream never matches). Shared by both TUI consumers so the
 * strip-then-match contract can't drift between them.
 *
 * Why count rather than just detect-presence: when the pasted PROMPT itself
 * contains a paste-marker (a transcript-analysis task — plausible here, since
 * #1229 is about TUI transcripts), the echoed prompt carries that marker into
 * the post-paste stream BEFORE the TUI emits its own commit marker. A bare
 * presence check would then fire the submit-Enters ~200ms in, while the paste is
 * still reflowing, reintroducing the unsent-prompt bug (issue #1229 review). So
 * callers gate on the count EXCEEDING the count already present in the prompt —
 * the TUI's genuine (N+1)th marker. A normal prompt has 0, so the common case is
 * unchanged. When Claude Code COLLAPSES a self-marker-containing multi-line
 * prompt to its own single chip, this count-only comparison false-negatives
 * (`1 > 1` is false) even though the paste landed — `isCollapsedPasteChip` below
 * is what rescues that case in isPasteConfirmed (issue #2228). It is NOT safe to
 * "simply fall back to the timer" there: the collapse HIDES the body, so the
 * verifyPasteRendered text fallback also fails and the agent dies
 * `paste-not-rendered`.
 *
 * @param {string} strippedText — ANSI-stripped text (prompt or post-paste output).
 * @returns {number}
 */
export function countPasteMarkers(strippedText) {
  if (typeof strippedText !== 'string' || !strippedText) return 0;
  const re = new RegExp(PASTE_MARKER_PATTERN.source, 'gi');
  const m = strippedText.match(re);
  return m ? m.length : 0;
}

/**
 * True when `strippedText` contains at least one paste-commit marker. Thin
 * presence wrapper over `countPasteMarkers`. Callers that must ignore markers
 * echoed from the prompt should compare `countPasteMarkers(output)` against
 * `countPasteMarkers(prompt)` instead of using this.
 *
 * @param {string} strippedText — ANSI-stripped post-paste output accumulator.
 * @returns {boolean}
 */
export function detectPasteMarker(strippedText) {
  return countPasteMarkers(strippedText) > 0;
}

// Claude Code's "this chip is a collapsed multi-line paste, click to see the
// body" affordance, rendered right next to the `[Pasted text #N]` chip whenever
// it folds a multi-line paste and HIDES the body. Matched against ANSI-stripped
// output; whitespace-tolerant for the same inter-glyph-cursor-move reason as
// PASTE_MARKER_PATTERN. This chrome is emitted by the TUI ITSELF — it never
// appears in a raw prompt's own echoed `[Pasted text #N]` literal — so it's the
// discriminator that separates issue #2228's genuine collapse (confirm) from the
// echoed-marker false-positive the promptMarkerCount subtraction guards (reject).
export const COLLAPSED_PASTE_CHIP_PATTERN = /paste\s*again\s*to\s*expand/i;

/**
 * True when `strippedText` shows Claude Code's COLLAPSED-paste chip shape: a
 * paste-commit marker present alongside the "paste again to expand" affordance
 * the TUI renders when it folds a multi-line paste and hides the body. A
 * collapsed chip is the TUI's own commit by construction, so its mere presence
 * proves delivery even when the marker count doesn't exceed promptMarkerCount
 * (the self-marker-containing multi-line prompt case, issue #2228). Callers MUST
 * pass an ANSI-STRIPPED buffer.
 *
 * @param {string} strippedText — ANSI-stripped post-paste output accumulator.
 * @returns {boolean}
 */
export function isCollapsedPasteChip(strippedText) {
  if (typeof strippedText !== 'string' || !strippedText) return false;
  return countPasteMarkers(strippedText) >= 1 && COLLAPSED_PASTE_CHIP_PATTERN.test(strippedText);
}

/**
 * True when a post-paste buffer proves the TUI actually RECEIVED the prompt
 * paste — the gate before sending the submit Enter(s). Two independent signals,
 * checked in priority order:
 *
 *   1. The TUI's own paste-commit marker count exceeds the count the prompt
 *      itself carried (promptMarkerCount). This is AUTHORITATIVE and is checked
 *      FIRST because Claude Code collapses a multi-line bracketed paste into a
 *      chip and HIDES the pasted body text from the buffer — so on every
 *      multi-line prompt the literal text is genuinely absent even though the
 *      paste landed perfectly. Real incident (2026-07-05): every
 *      claude-code-tui CoS agent failed `paste-not-rendered` after 3 retries
 *      because #2192's text-only check never saw the collapsed body — while the
 *      marker was sitting right there. (agent-656efa6e et al.)
 *   1b. The COLLAPSED-CHIP shape (`isCollapsedPasteChip`) — a marker present
 *      alongside Claude's "paste again to expand" affordance. This rescues the
 *      subtraction's blind spot: when the prompt ITSELF embeds `[Pasted text #N]`
 *      literals AND is multi-line, Claude folds it into its own single chip and
 *      hides the body, so `count (1) > promptMarkerCount (1)` is false — yet the
 *      collapse chrome proves the visible marker is the TUI's own commit. The
 *      chrome never rides in on an echoed prompt literal, so this can't
 *      re-introduce the echoed-marker false-positive the subtraction guards
 *      (issue #2228; the inline/uncollapsed echo path has no such chrome and keeps
 *      subtracting).
 *   2. Fallback for the MARKERLESS path — a paste too small to render the marker,
 *      or one genuinely SWALLOWED by a still-initializing TUI (the #2192 case,
 *      which renders no marker at all): fall back to confirming the prompt text
 *      literally rendered. A null/empty verifiablePrefix means no verification is
 *      possible, so this returns true (nothing to disconfirm).
 *
 * Callers MUST pass an ANSI-STRIPPED buffer (both signals require it — see
 * countPasteMarkers / verifyPasteRendered).
 *
 * @param {string} strippedBuffer — ANSI-stripped post-paste output accumulator.
 * @param {{ verifiablePrefix?: string|null, promptMarkerCount?: number }} [opts]
 * @returns {boolean}
 */
export function isPasteConfirmed(strippedBuffer, { verifiablePrefix = null, promptMarkerCount = 0 } = {}) {
  if (countPasteMarkers(strippedBuffer) > promptMarkerCount) return true; // marker is authoritative
  if (isCollapsedPasteChip(strippedBuffer)) return true; // collapsed chip is the TUI's own commit (#2228)
  if (!verifiablePrefix) return true; // nothing to verify against
  return verifyPasteRendered(strippedBuffer, verifiablePrefix);
}

// Positive "the launched program's input is ready to receive a bracketed paste"
// signal, derived from the terminal's bracketed-paste-mode toggles in the RAW
// (un-stripped) PTY stream. A program enables bracketed-paste mode (`ESC[?2004h`)
// exactly when its input prompt is live and ready to accept a paste — which is
// precisely the precondition for the `ESC[200~…ESC[201~` paste the spawner is
// about to send. The launch shell already had paste mode ON at its own prompt,
// so we must NOT treat that initial ON as the signal: only an ON that arrives
// AFTER the shell turned it OFF (`ESC[?2004l`) to run the command is the
// launched program (e.g. Claude Code) declaring its input ready. The spawner
// pairs this with a liveness probe to disambiguate "claude's prompt is ready"
// from "claude exited and the shell's prompt came back" (both re-enable paste
// mode). This replaces the old "saw some output, then went idle" heuristic that
// fired during a startup lull — before claude's input existed — and dumped the
// prompt into the bare shell.
// Bracketed-paste mode toggles in the RAW stream — the RELIABLE input-ready
// signal. `ESC[?2004h` = ON (the program will read `ESC[200~…ESC[201~` as a
// paste); `ESC[?2004l` = OFF (then the leading `ESC` of our paste is read as
// Escape, which CANCELS claude's input — the intermittent "something other than
// Enter canceled it"). claude enables paste mode exactly when its input box is
// live, so "paste mode re-enabled after the shell turned it off to run the
// command" means claude is ready AND the paste won't be misread.
//
// (We deliberately do NOT key on claude's visible footer text — `bypass
// permissions on (shift+tab to cycle)` etc. — because claude renders it with
// inter-glyph cursor moves, so its spaces vanish after ANSI stripping and the
// text is not reliably matchable. Terminal-mode toggles survive intact.)
export const BRACKETED_PASTE_MODE_PATTERN = /\x1b\[\?2004([hl])/g;

// Claude Code's first-run folder-trust gate ("Is this a project you trust? →
// 1. Yes, I trust this folder / 2. No, exit"). `--dangerously-skip-permissions`
// does NOT bypass it, and CoS agents can start in folders claude hasn't seen.
// Matched against the WHITESPACE-STRIPPED text (same inter-glyph-spacing caveat
// as the footer). The spawner auto-confirms the default ("Yes, I trust").
export const TUI_TRUST_PROMPT_PATTERN =
  /trustthisfolder|isthisaprojectyou(?:created|trust)/i;

// Claude Code's auto-mode opt-in offer ("Make auto mode your default permission
// mode? → 1. Yes, set auto mode as my default permission mode / 2. No, keep
// don't ask"), added in v2.1.233. Like the trust gate it is NOT bypassed by
// `--dangerously-skip-permissions`, but unlike the trust gate it paints AFTER
// the composer is live — bracketed-paste mode is already ON, so `ready` goes
// true and the prompt is pasted straight into a modal that ignores it. Every
// one of the four claude-code-tui agents launched on 2026-08-14 died
// `paste-not-rendered` this way (agent-f71b794e et al.).
//
// The spawner answers "2. No, keep don't ask" rather than accepting the
// highlighted default: option 1 rewrites the HUMAN's global default permission
// mode in `~/.claude.json`, and an unattended agent must not mutate the
// operator's config as a side effect of dismissing a dialog. Option 2 preserves
// whatever posture the user already chose, and the agent's own session keeps
// the `--dangerously-skip-permissions` it was launched with either way.
export const TUI_AUTO_MODE_PROMPT_PATTERN =
  /automodeyourdefaultpermissionmode|setautomodeasmydefaultpermissionmode/i;

// Codex can stop before its composer on a hook-review selector when a newly
// configured hook has not yet been trusted. `--dangerously-bypass-approvals-and-
// sandbox` deliberately does not answer this prompt: trusting a hook permits
// code outside the sandbox, so unattended PortOS runs must choose Codex's
// explicit "Continue without trusting" option instead. Without this gate the
// normal startup paste lands in the selector and all paste retries are swallowed.
// Match the stable heading after whitespace stripping; the exact count/plural
// wording below it varies with the configured hooks.
export const TUI_HOOK_REVIEW_PROMPT_PATTERN = /hooksneedreview/i;

// Antigravity (agy) needs a SECOND, positive readiness signal on top of paste
// mode. agy enables bracketed paste the moment it enters the alt screen — while
// it is still "Signing in…", before its folder-trust gate has painted and long
// before its composer exists. So `sawCommandRun && pasteModeOn` goes true within
// ~200ms of launch and the paste fires into whatever screen happens to be up.
// When agy's sign-in round trip outran the 2.5s prompt delay, that screen was
// the trust gate — it swallowed the prompt and all three paste retries, and the
// agent died `paste-not-rendered` without the trust auto-confirm ever running
// (`needsTrust` was still false when the paste went out). agy renders
// `? for shortcuts` under its composer, and ONLY once the composer is live —
// i.e. strictly after the trust gate is resolved — so gating on it orders the
// two signals correctly and removes the race.
//
// (`--dangerously-skip-permissions` does NOT bypass agy's trust gate, despite
// what the flag name suggests — real transcripts show the gate appearing under
// it, same as claude's.)
export const AGY_INPUT_READY_PATTERN = /\?forshortcuts/i;

// Handshake markers are matched against a rolling window of whitespace-stripped
// output rather than a single chunk, so a marker split across two PTY reads
// (`? for short` | `cuts`) still matches. Sized to a few screens of chrome.
const OBSERVE_TAIL_MAX_LEN = 4000;

// readyTextPattern: optional extra positive gate, tested against the stripped
// rolling tail. When supplied, `ready` also requires that marker to have been
// seen (see AGY_INPUT_READY_PATTERN).
//
// directLaunch: the TUI was pty.spawn'd DIRECTLY — there is no launch shell on
// the PTY, so the shell's paste-mode OFF (`ESC[?2004l`) that normally proves
// "the command is now running" never occurs; the first `ESC[?2004h` in the
// stream comes from the TUI itself and IS the ready signal. Without this flag a
// direct-launch session can never become ready (the durable-runner regression:
// every runner-tui claude agent died `tui-not-ready` at the 45s deadline while
// its input box sat live on screen).
export function createInputReadyTracker({ readyTextPattern = null, directLaunch = false } = {}) {
  let pasteModeOn = false;   // LIVE bracketed-paste mode state from the stream
  // Shell turned paste mode OFF to run the command. Pre-latched for direct
  // launches, where the TUI owns the PTY from byte zero and no shell OFF exists.
  let sawCommandRun = directLaunch;
  let needsTrust = false;
  let sawReadyText = false;
  // Auto-mode offer: latched when seen, cleared once answered. `autoModeAnswered`
  // makes the ack TERMINAL — `tail` is a rolling 4000-char window, so the modal's
  // text lingers in it long after the dialog is gone and would otherwise re-arm
  // the flag on the very next chunk, re-answering forever and pinning `ready`
  // false until the 45s deadline. Arm-once, same as the gates above it.
  let needsAutoModeChoice = false;
  let autoModeAnswered = false;
  // Like the auto-mode offer, hook-review text remains in the rolling tail
  // after its selector closes. A terminal acknowledgement prevents a repaint
  // from re-arming the dialog and blocking delivery forever.
  let needsHookReview = false;
  let hookReviewAnswered = false;
  let tail = '';
  // node-pty can split `ESC[?2004h` across reads. Keep only the trailing
  // prefix of that exact toggle so the next chunk can complete it without
  // treating unrelated escape traffic as a readiness signal.
  let rawTail = '';
  return {
    // Ready once the TUI has RE-ENABLED bracketed-paste mode after the launch
    // shell turned it off to run the command — for claude that means its input
    // box is live and a paste will be read as a paste. (The launch shell's own
    // initial ON does not count: sawCommandRun gates on the intervening OFF.)
    // Providers that enable paste mode before their composer exists supply a
    // readyTextPattern to close the gap.
    // The auto-mode offer is the one gate that paints with paste mode already ON,
    // so it must SUPPRESS ready — every other signal here says "go" while the
    // modal is still swallowing input. Cleared by ackAutoModeChoice() once the
    // spawner has answered it.
    get ready() {
      return sawCommandRun && pasteModeOn && !needsAutoModeChoice && !needsHookReview
        && (!readyTextPattern || sawReadyText);
    },
    get needsTrust() { return needsTrust; },
    get needsAutoModeChoice() { return needsAutoModeChoice; },
    get needsHookReview() { return needsHookReview; },
    /** Spawner reports the dismissal keystrokes went out; re-arms `ready`. */
    ackAutoModeChoice() { needsAutoModeChoice = false; autoModeAnswered = true; },
    /** Spawner selected Codex's safe "Continue without trusting" option. */
    ackHookReview() { needsHookReview = false; hookReviewAnswered = true; },
    // rawText: un-stripped chunk (paste-mode toggles live here);
    // strippedText: ANSI-stripped chunk (the trust-gate / composer text).
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
      if (strippedText) {
        tail = (tail + strippedText.replace(/\s+/g, '')).slice(-OBSERVE_TAIL_MAX_LEN);
        if (!needsTrust && TUI_TRUST_PROMPT_PATTERN.test(tail)) needsTrust = true;
        if (!needsAutoModeChoice && !autoModeAnswered && TUI_AUTO_MODE_PROMPT_PATTERN.test(tail)) needsAutoModeChoice = true;
        if (!needsHookReview && !hookReviewAnswered && TUI_HOOK_REVIEW_PROMPT_PATTERN.test(tail)) needsHookReview = true;
        if (readyTextPattern && !sawReadyText && readyTextPattern.test(tail)) sawReadyText = true;
      }
    },
  };
}


// Claude Code and Codex render a bulleted elapsed counter while a model request
// is in flight; agy uses its own `Generating…` indicator.
export const WORK_COUNTER_PATTERN = /\(\s*(\d+)\s*s\s*[·•]/g;

// Chrome a TUI paints only while a model request is actually IN FLIGHT. agy
// renders an animated `Generating…` for exactly as long as the request runs;
// Claude Code and Codex render their bulleted elapsed counter, so
// WORK_COUNTER_PATTERN's shape is spliced in (rather than re-spelled) to keep the
// two from drifting apart.
//
// `esc to cancel` is DELIBERATELY NOT HERE, despite being half of agy's in-flight
// footer. It is ambiguous chrome: agy paints the identical footer (down to the
// trailing `Gemini 3.6 Flash · medium` status) for its SLASH-COMMAND PALETTE,
// where it means "esc to cancel the palette". agent-03904eb1 (2026-08-12) is the
// receipt: parked on the eligibility banner, a `/usage` scrape opened the palette
// in its session, the palette footer read as "the provider recovered", and the
// gate latched — which disarms BOTH the re-submission and the fail-over, so the
// run sat at the banner until an old silent-session fallback finalized it as a
// bogus success. That is the failure this whole mechanism exists to prevent,
// and no local feature separates the two footers.
//
// Dropping it costs nothing measurable: across every agy transcript on disk, each
// healthy run carries 10–115 `Generating` hits (2026-08-02 → 08-05, n=14) while
// every stuck-on-the-banner run carries zero. `Generating` alone is the clean
// separator; `esc to cancel` only ever added false positives.
export const GENERATION_ACTIVITY_PATTERN =
  new RegExp(`Generating\\s*[.·•…]|${WORK_COUNTER_PATTERN.source}`, 'i');

// Carry-over kept across chunks so in-flight chrome split by a PTY chunk boundary
// (`Generat` + `ing…`) still matches.
//
// Only needs to span the longest pattern alternative, because `observe` tests the
// FULL `carry + chunk` window and trims only afterwards (see below) — the cap
// bounds retained state, it never bounds what gets matched.
const GENERATION_ACTIVITY_CARRY_CAP = 64;

/**
 * Stateful latch for "the TUI is actively generating a response". Feed it each
 * ANSI-stripped chunk via `observe(strippedText)`; it becomes (and stays)
 * `active` once any in-flight chrome appears, and returns true on the call that
 * flipped it (so a caller can react to the transition).
 *
 * This does not try to be echo-proof by construction — the gate that owns it
 * handles the one case where the prompt can
 * re-enter the stream (a re-submission; see SELF_CLEARING_RESUBMIT_ECHO_MS).
 *
 * It is NOT, however, a "match anything that looks alive" pattern, which is how
 * `esc to cancel` got in and then cost a run (see GENERATION_ACTIVITY_PATTERN).
 * The cost asymmetry runs the other way now that the grace window re-submits: a
 * false "still stuck" merely re-asks a provider that was about to answer, while a
 * false "recovered" latches, disarming the retry AND the fail-over and leaving
 * the run to complete as a reported success it never earned. Only chrome that
 * a TUI paints EXCLUSIVELY while a request is in flight belongs here.
 *
 * @returns {{ observe: (strippedText: string) => boolean, readonly active: boolean }}
 */
export function createGenerationActivityTracker() {
  let active = false;
  let tail = '';
  return {
    observe(strippedText) {
      if (active) return true;
      if (typeof strippedText !== 'string' || !strippedText) return false;
      // Test the WHOLE window, then trim. Trimming first (the sibling trackers'
      // shape) throws away everything but the last CAP characters of the chunk,
      // so chrome anywhere earlier in a typical multi-hundred-byte PTY repaint
      // is never matched at all — the tracker would miss a provider that HAD
      // recovered and the run would be failed over to a fallback for nothing.
      const window = tail + strippedText;
      if (GENERATION_ACTIVITY_PATTERN.test(window)) active = true;
      tail = window.slice(-GENERATION_ACTIVITY_CARRY_CAP);
      return active;
    },
    get active() { return active; },
  };
}

// How often to re-submit the prompt while a self-clearing signal's grace window
// is open.
//
// A passive wait CANNOT clear agy's eligibility banner: the banner is that
// submission's REJECTION, not a progress spinner. agy discards the submitted
// prompt, empties its composer and returns to the idle `? for shortcuts` footer
// — verbatim from agent-1f08178b's raw.txt, and confirmed on a live session left
// sitting at the banner. Nothing is in flight, so the generation chrome the gate
// watches for can never appear and the window's only possible outcome is
// expiry + fail-over. Retrying is also exactly what the vendor's own copy asks
// for ("Please try again shortly"), so the window now re-pastes and re-submits
// on this cadence and only fails over once the retries are exhausted.
//
// 20s: slow enough that a re-paste can't outrun agy's own reflow + round trip
// (a submission that IS accepted starts painting `Generating…` within ~1s, which
// closes the window before the next retry is due), and fast enough to fit
// several attempts inside the grace window.
export const SELF_CLEARING_RESUBMIT_INTERVAL_MS = 20000;

// How often a consumer without its own poll should ASK the gate whether a
// re-submission is due. Deliberately a sub-multiple of the interval above rather
// than equal to it: a timer whose period matches the cadence exactly can tick a
// hair early (timer rounding vs. `Date.now()`, or an event-loop stall shifting
// phase), `takeResubmit` refuses, and that attempt is silently forfeited for a
// whole interval. Polling faster than the cadence leaves the gate the single
// authority on timing — the same shape the agent path gets for free by folding
// the question into its existing 5s provider-signal poll.
export const SELF_CLEARING_RESUBMIT_POLL_MS = 5000;

// How long after a re-submission the gate ignores output when deciding whether
// the provider recovered.
//
// The generation tracker matches a single chunk, which is safe only while the
// stream cannot contain the prompt. Re-pasting breaks that: a prompt quoting
// `Generating…` (a task about this very failure mode does) echoes straight into
// the tracker and latches a bogus recovery — strictly worse than the expiry it
// replaced, because a recovered gate neither retries nor fails over, leaving the
// run to remain latched as a false recovery. 3s covers the paste and its spaced
// submit-Enters (~1.4s).
//
// Applied to every re-submission rather than only to prompts whose text could
// actually match: conditioning on that made the gate's behavior depend on a
// content coincidence in the caller's payload, and the thing it bought — up to
// 3s of recovery latency on a 20s retry cadence, against chrome that repaints
// continuously — is not worth the coupling.
export const SELF_CLEARING_RESUBMIT_ECHO_MS = 3000;

/**
 * The wait-it-out policy for a provider signal that carries a `graceMs` (today:
 * agy's account-eligibility banner — see IMMEDIATE_FALLBACK_SIGNALS in
 * aiToolkit/errorDetection.js for the canonical account of why it exists).
 *
 * Owns the whole state machine so the consumers can't drift: arm-once (a
 * repainting TUI re-matches constantly and must not restart the clock),
 * feed-the-tracker only inside the window, re-submit the prompt on a cadence
 * (see SELF_CLEARING_RESUBMIT_INTERVAL_MS — the wait is ACTIVE, because the
 * banner rejected the submission), disarm the moment the provider is
 * demonstrably generating again, and hand back a verdict at the deadline. Each
 * consumer keeps only its own timing mechanism — `agentTuiSpawning` folds the
 * deadline and the retry cadence into its existing 5s provider-signal timer, while
 * `tuiPromptRunner` needs its own timers because its idle watcher is created
 * lazily on the first post-prompt chunk and may not exist yet when the banner
 * paints.
 *
 * Usage per chunk: `gate.observe(stripped, now)` then, on a match,
 * `gate.arm(analysis, now)`. `gate.armed` tells the provider-signal timer that
 * the handshake is still active; a session waiting out a handshake is silent by
 * design. `gate.takeResubmit(Date.now())` returns the 1-based
 * attempt number when it is time to re-send the prompt (0 otherwise), and
 * `gate.takeExpired(Date.now())` returns the analysis to fail over with, or null
 * while still waiting / after a recovery.
 *
 * @returns {{ arm: (analysis: object, nowMs: number) => boolean,
 *             observe: (strippedText: string, nowMs: number) => boolean,
 *             takeResubmit: (nowMs: number) => number,
 *             takeExpired: (nowMs: number) => object|null,
 *             readonly armed: boolean }}
 */
export function createSelfClearingSignalGate() {
  let armed = null; // { analysis, deadlineAt, nextResubmitAt, echoUntil, resubmits }
  let activity = null;
  // Latched once a window is ridden out successfully, which suppresses re-arming
  // for the rest of the run. This is not just tidiness: the caller's detector is
  // a BUFFERED stream matcher (createImmediateFallbackSignalDetector keeps a
  // 512-char window), so the banner keeps matching for many chunks after the
  // provider has recovered. Without this latch the first post-recovery chunk
  // re-arms a fresh window and fails the run over a full grace window later —
  // the exact bug the grace window exists to prevent (and it would now re-paste
  // the prompt into a working session on the way there). A genuine second banner
  // is therefore ignored rather than re-waited; the provider has demonstrably
  // worked once, and the caller's normal failure/runtime handling remains in charge.
  let recovered = false;
  return {
    get armed() { return armed !== null; },
    get recovered() { return recovered; },
    arm(analysis, nowMs) {
      if (armed || recovered || !analysis || !(analysis.graceMs > 0)) return false;
      armed = {
        analysis,
        deadlineAt: nowMs + analysis.graceMs,
        // First retry is one full interval out, not immediate: the banner paints
        // within a second of the submit-Enter, and re-pasting on top of a TUI
        // still settling from the rejected paste is how you get two prompts
        // concatenated in the composer.
        nextResubmitAt: nowMs + SELF_CLEARING_RESUBMIT_INTERVAL_MS,
        // Nothing has been re-pasted yet, so nothing in the stream is our echo.
        echoUntil: 0,
        // 1-based count of re-submissions made inside THIS window, used only to
        // label the attempt in the consumers' logs. Lives on `armed` so its
        // per-window lifetime is structural rather than a reset to remember.
        resubmits: 0,
      };
      activity = createGenerationActivityTracker();
      return true;
    },
    // Returns true on the call that ends the window because the provider came
    // back — disarming here (rather than at the deadline) is what stops a
    // recovered run from sitting under idle suppression for the rest of the
    // window. `nowMs` is required: without a clock there is no way to tell our
    // own re-pasted prompt from the provider's output.
    observe(strippedText, nowMs) {
      if (!armed || nowMs < armed.echoUntil) return false;
      if (!activity.observe(strippedText)) return false;
      armed = null;
      activity = null;
      recovered = true;
      return true;
    },
    // Returns the 1-based attempt number when the prompt is due to be re-sent,
    // or 0. The consumer owns the actual paste; this only owns "is it time?" so
    // both consumers keep the same cadence. Deliberately silent once the
    // provider has recovered (not armed) — and once the deadline has passed,
    // because a retry that lands after `takeExpired` would paste into a session
    // the fail-over is already tearing down.
    takeResubmit(nowMs) {
      if (!armed || nowMs < armed.nextResubmitAt || nowMs >= armed.deadlineAt) return 0;
      armed.nextResubmitAt = nowMs + SELF_CLEARING_RESUBMIT_INTERVAL_MS;
      armed.echoUntil = nowMs + SELF_CLEARING_RESUBMIT_ECHO_MS;
      armed.resubmits += 1;
      return armed.resubmits;
    },
    // Returns the analysis to fail over with, or null while still waiting (or
    // after a recovery). `nowMs` is OPTIONAL: a poller passes the clock and gets
    // a deadline comparison, while a consumer whose own `setTimeout` fired for
    // exactly this window omits it and force-expires. That distinction matters —
    // a timer scheduled for `graceMs` can fire a hair before `Date.now()` reaches
    // `deadlineAt` (ms-resolution clock vs. timer rounding), and since the timer
    // is one-shot with nothing to reschedule it, a null there would strand the
    // gate armed: idle-completion suppressed and no fail-over, until the run's
    // hard timeout. Force-expiry has no such edge.
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

// A SINGLE Enter after a large bracketed paste is unreliable: the TUI can still
// be processing/reflowing the multi-line paste when the `\r` arrives and
// swallow it, leaving the whole prompt sitting unsent in the input box. The
// old fallback could then falsely finalize the run as success — observed as the
// "the prompt was typed but I had to hit Enter myself" bug. (The marker fast
// path above now fires again once matched against stripped output — see
// detectPasteMarker — but the marker only renders for large multi-line pastes;
// short prompts still lean on the fallback timer, so multi-Enter remains the
// safety net for both.) Send a few Enters spaced apart so at least one lands
// after the paste settles. Re-sending
// is safe: once the prompt submits the input box is empty and a bare Enter is a
// no-op in every TUI we drive (claude/codex/gemini), so the extra Enters can't
// fire a spurious empty message.
export const SUBMIT_ENTER_ATTEMPTS = 3;
export const SUBMIT_ENTER_SPACING_MS = 700;

/**
 * Submit a freshly-pasted TUI prompt by sending Enter SUBMIT_ENTER_ATTEMPTS
 * times: once immediately, then on a SUBMIT_ENTER_SPACING_MS interval until the
 * attempt budget is spent (see the constants above for why a single Enter is
 * unreliable). Shared by both the agent path and the one-shot runner so the two
 * can't drift.
 *
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

// Defaults the consumer applies when the provider config doesn't pin
// per-provider prompt timing values (provider.tuiPromptDelayMs).
export const DEFAULT_TUI_PROMPT_DELAY_MS = 2500;


// ─── Codex MCP-server boot detection ──────────────────────────────────────
//
// Codex (unlike Claude Code) boots any MCP servers configured in the user's
// GLOBAL `~/.codex/config.toml` on every startup — INCLUDING for our headless
// CoS agents, which never asked for them. A user with heavyweight interactive
// servers (e.g. `playwright` via `npx @playwright/mcp@latest`, or a `node_repl`
// with `startup_timeout_sec = 120`) makes codex spend tens of seconds — up to
// two minutes — booting that stack before its input box will accept a paste.
//
// During that boot codex renders its input box EARLY but SWALLOWS pastes, and
// while it waits on a silent boot subprocess (an `npx` download, a stalled
// server) its PTY output goes IDLE — indistinguishable from "ready" to the
// idle-detect readiness heuristic. So the spawner pastes mid-boot, codex
// swallows it (no `[Pasted Content N chars]` marker, and its single-line input
// viewport shows only the TAIL of the long paste, never the verifiable prefix),
// and the paste-verify retry (issue #2192) exhausts its 3 short attempts and
// fails `paste-not-rendered` — killing codex BEFORE its MCP boot ever finished
// (real incident 2026-07-10: agent-c5a26b40 / agent-3f4ae3b1, both gpt-5.6-sol;
// the same prompt succeeded on 2026-07-03..09 back when no MCP servers were
// configured and codex was ready in <10s).
//
// The fix is NOT a new readiness signal (codex gives no reliable boot-complete
// one — a slow boot looks identical to a ready box) but a boot-aware RETRY
// BUDGET: once boot chrome is seen, keep re-pasting until codex finishes booting
// and a paste finally lands its marker, up to MCP_BOOT_PASTE_DEADLINE_MS. The
// spawner (agentTuiSpawning.js) consumes `createMcpBootTracker` for exactly that.
//
// Matched against ANSI-stripped output. Detection is deliberately conservative:
// a false POSITIVE only extends the
// (bounded) retry window, and a false NEGATIVE just preserves the pre-fix 3-retry
// behavior. The two phrases are anchored to codex's literal boot banners rather
// than a bare "mcp server" substring so an agent whose prompt/output merely
// mentions MCP servers can't latch the extended window.
const MCP_BOOT_MARKERS = ['booting mcp server', 'starting mcp servers'];

// Covers a `node_repl` with the documented `startup_timeout_sec = 120` plus an
// `npx`-fetched server's cold download and margin, while still bounding a
// genuinely-hung boot's failure. The deadline is independent of CoS agent
// runtime handling so a slow MCP boot gets its full retry budget.
export const MCP_BOOT_PASTE_DEADLINE_MS = 150000;
// Spacing between paste retries while codex is booting MCP servers. A swallowed
// mid-boot paste renders nothing, so a re-paste every few seconds is a cheap
// no-op until the box is finally live; this is additive to each attempt's own
// marker-wait + verify window (~5.5s), so the effective cadence is ~10s.
export const MCP_BOOT_PASTE_RETRY_DELAY_MS = 5000;

// Rolling tail cap for createMcpBootTracker's cross-chunk buffer: a boot banner
// can split across two onData chunks
// during streaming, so concatenate onto a short tail before testing.
const MCP_BOOT_TAIL_CAP = 256;

/**
 * True when a chunk of ANSI-stripped TUI output shows codex booting its MCP
 * servers. Callers MUST pass stripped output. Non-string / empty input → false.
 *
 * @param {string} strippedText — ANSI-stripped output (a chunk or accumulator).
 * @returns {boolean}
 */
export function isMcpBootSignal(strippedText) {
  if (typeof strippedText !== 'string' || !strippedText) return false;
  const lower = strippedText.toLowerCase();
  return MCP_BOOT_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Latching tracker for "this TUI is booting its MCP servers" — the codex slow-
 * boot failure mode above. Feed it each ANSI-stripped STARTUP chunk (before the
 * prompt is submitted) via `observe(text)`; it latches `active` the first time a
 * boot banner appears and STAYS active thereafter. Latching (not a sliding
 * window) is deliberate: the boot banner prints once and then codex updates the
 * line via cursor-positioned partial redraws that don't reprint the full phrase,
 * and the whole point is to keep the extended paste-retry budget in force across
 * the (often silent) boot. Keeps a small rolling tail so a marker split across a
 * chunk boundary still matches. Lives here so the detection is unit-testable.
 *
 * @returns {{ observe: (strippedText: string) => boolean, readonly active: boolean }}
 */
export function createMcpBootTracker() {
  let active = false;
  let tail = '';
  return {
    observe(strippedText) {
      if (active) return true;
      if (typeof strippedText !== 'string' || !strippedText) return active;
      tail = (tail + strippedText).slice(-MCP_BOOT_TAIL_CAP);
      if (isMcpBootSignal(tail)) active = true;
      return active;
    },
    get active() { return active; },
  };
}

// ─── Buffer caps (defensive RAM bounds) ───────────────────────────────────
//
// RAW caps stay small — the raw PTY stream is only used for paste-marker
// detection and a short failure-tail in the exit error message, both of
// which need only the recent past.
//
// OUTPUT caps are larger because the ANSI-stripped buffer is the fallback
// response text when a TUI fails to write its response file. A 1MB cap was
// silently truncating the *head* of large model responses mid-token; bumped
// to 8MB so realistic full-context replies (~600KB UTF-8 from a 200K-token
// window, plus screen chrome) fit cleanly. Consumers should still treat
// overflow as a fault — see `outputBufferTruncated` tracking in
// `tuiPromptRunner.js`.
export const RAW_BUFFER_CAP = 512 * 1024;
export const RAW_BUFFER_HEADROOM = 640 * 1024;
export const OUTPUT_BUFFER_CAP = 8 * 1024 * 1024;
export const OUTPUT_BUFFER_HEADROOM = 10 * 1024 * 1024;
// Disk safety valve for the agent-mode raw.txt spool. Counted as UTF-8 bytes
// actually written. Tests can override this via the same vi.mock pattern that
// shrinks OUTPUT_BUFFER_HEADROOM, so the cap-overflow test doesn't have to
// push hundreds of MB through the spawner to exercise the truncation path.
export const RAW_SPOOL_MAX_BYTES = 256 * 1024 * 1024;

// ─── Command + args helpers ───────────────────────────────────────────────

/**
 * The launch command a TUI provider gets when it names none — the spawners'
 * blank-`provider.command` fallback (`buildTuiSpawnConfig`, and mirrored by
 * `buildCliSpawnConfig`'s default branch). An unrecognized id resolves to
 * `claude`, matching `isClaudeCommand`'s blank-is-Claude policy.
 *
 * Also read by `resolveSlashdoStyle`'s `assumeClaudeWhenUnknown` posture, which
 * asks "which command will actually be spawned?" before deciding whether the
 * session can type `/do:pr` — so a missing signature here means a provider is
 * told to run slash commands its real binary doesn't have.
 *
 * Defined in providerVendors.js (the PROVIDER_VENDORS registry, #3618);
 * re-exported here for existing importers of this module.
 * @param {string|null|undefined} id - provider id
 * @returns {string}
 */
export { inferTuiCommand };

/**
 * TUI posture-flag dispatch (approval/trust bypass per vendor). Defined in
 * providerVendors.js (the PROVIDER_VENDORS registry, #3618); re-exported here
 * for existing importers of this module.
 */
export { applyCommandDefaults };

/**
 * Build the spawn args for a TUI invocation. When `provider.args` already
 * has a `--model X` (or `-m X`) pin, the args-baked flag wins and we skip
 * the per-call --model append — otherwise the CLI would see two flags and
 * either error or take the last one (provider-specific). Matches the same
 * gate `runner.js#buildCliArgs` uses for CLI providers.
 *
 * `provider.effort` carries a per-run reasoning-effort override (callers clone
 * the provider with it pinned, same as `defaultModel`) and becomes
 * `--effort <level>` / codex's `-c model_reasoning_effort=<level>`. For agy an
 * effort-suffixed model id is split so the base rides `--model` and its baked
 * tier becomes the `--effort` — see antigravity.js for why. The antigravity-
 * vs-everyone-else split lives in providerVendors.js#injectTuiModelAndEffort,
 * shared with agentTuiSpawning.js#buildTuiSpawnConfig so the two spawn paths
 * can't diverge (they already had once, before #3618).
 */
export function buildTuiInvocation(provider, model) {
  const command = provider?.command || inferTuiCommand(provider?.id);
  const baseArgs = applyCommandDefaults(command, [...(provider?.args || [])]);
  const effort = provider?.effort || null;
  return {
    command,
    args: injectTuiModelAndEffort(command, baseArgs, provider, model, effort),
  };
}

/**
 * Returns true when the stripped chunk looks like a `command not found`
 * error for our spawned TUI binary. Used as an early-fail probe so a typo'd
 * provider.command surfaces in seconds instead of after a completion timeout.
 */
export function detectMissingTuiBinary(strippedText, commandName) {
  const lower = strippedText.toLowerCase();
  return lower.includes('command not found') && lower.includes(commandName.toLowerCase());
}
