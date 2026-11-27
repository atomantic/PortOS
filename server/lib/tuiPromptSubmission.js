/** Detect paste commits, verify prompt submission and schedule the terminal Enter sequence. */
import { createGenerationActivityTracker, STALL_NUDGE_RECOVERY_MS } from './tuiSignalGates.js';

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
const PASTE_MARKER_PATTERN = /\[Pasted?\s*(?:text\s*#\d+[^\]]*|content\s*\d+\s*chars|~\s*\d+\s*lines?|#\d+\s*\+\d+\s*lines?|:\s*\d+(?:\.\d+)?\s*(?:B|KB|MB))\]/i;
export const PASTE_TO_ENTER_MIN_DELAY_MS = 200;
export const PASTE_TO_ENTER_FALLBACK_MS = 3500;

// Codex QUEUES a bracketed paste that arrives before its composer has finished initializing and
// commits it once the composer is live — it is not lost. On a cold Windows start (`cmd.exe /c
// codex.cmd` -> node -> the native binary) that commit was measured at ~11s for a paste written at
// 3.7s, far past the 3.5s marker wait + 2s verify window above.
export const PASTE_COMMIT_PATIENCE_MS = 45000;

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
function verifyPasteRendered(strippedBuffer, prefix) {
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

// Claude Code's "this chip is a collapsed multi-line paste, click to see the body" affordance,
// rendered right next to the `[Pasted text #N]` chip whenever it folds a multi-line paste and
// HIDES the body. Matched against ANSI-stripped output; whitespace-tolerant for the same
// inter-glyph-cursor-move reason as PASTE_MARKER_PATTERN.
const COLLAPSED_PASTE_CHIP_PATTERN = /paste\s*again\s*to\s*expand/i;

/**
 * True when a post-paste buffer proves the TUI actually RECEIVED the prompt paste — the gate
 * before sending the submit Enter(s). An unverifiable prompt can proceed without positive evidence.
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
  // A bare marker may have been echoed from the prompt. The collapse affordance belongs to the TUI.
  const markers = countPasteMarkers(strippedBuffer);
  if (markers > promptMarkerCount) return true; // marker is authoritative
  // Collapsed chip is the TUI's own commit (#2228).
  if (markers >= 1 && COLLAPSED_PASTE_CHIP_PATTERN.test(strippedBuffer)) return true;
  return !!verifiablePrefix && verifyPasteRendered(strippedBuffer, verifiablePrefix);
}

// A SINGLE Enter after a large bracketed paste is unreliable: the TUI can still be
// processing/reflowing the multi-line paste when the `\r` arrives and swallow it, leaving the
// whole prompt sitting unsent in the input box. (The marker fast path above now fires again once
// matched against stripped output — see countPasteMarkers — but the marker only renders for large
// multi-line pastes; short prompts still lean on the fallback timer, so multi-Enter remains the
// safety net for both.) Send a few Enters spaced apart so at least one lands after the paste
// settles.
const SUBMIT_ENTER_ATTEMPTS = 3;
const SUBMIT_ENTER_SPACING_MS = 700;

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
function isMcpBootSignal(strippedText) {
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

// ─── Unsubmitted prompt — "the paste landed, the Enter did not" ───────────── A TUI can render
// the paste chip and still ignore every submit Enter that follows it: the composer shows `❯
// [Pasted text #1 +353 lines]` and nothing else ever happens.
const UNSUBMITTED_PROMPT_SETTLE_MS = 20000;
export const UNSUBMITTED_PROMPT_ENTER_MAX_ATTEMPTS = 3;
// Evidence the turn started: the TUI's own in-flight chrome (a working counter, `Generating…` —
// createGenerationActivityTracker) at any time, or any output arriving this long after PortOS's
// last keystroke, which cannot be its echo. The same 30s that proves a stall nudge took.
const PROMPT_WORK_EVIDENCE_MS = STALL_NUDGE_RECOVERY_MS;
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
