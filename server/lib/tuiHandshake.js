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

import { resolveCliModel, hasModelFlag } from './providerModels.js';
import { ensureAntigravityTuiArgs, isAntigravityCommand } from './antigravity.js';

// ─── Paste handshake constants ────────────────────────────────────────────

// PTY readiness — wait for the TUI banner to finish repainting (output-idle
// for READY_IDLE_THRESHOLD_MS) before pasting. A fixed delay loses to slow
// banners and burns time on fast ones; idle-detect adapts.
export const READY_POLL_INTERVAL_MS = 300;
export const READY_IDLE_THRESHOLD_MS = 1200;
export const PASTE_DEADLINE_MS = 10000;

// Claude Code emits `[Pasted text #N +M lines]` after committing a paste.
// Watch for the marker (or fall back after PASTE_TO_ENTER_FALLBACK_MS)
// before sending `\r` so Enter doesn't get swallowed mid-paste-commit.
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
export const PASTE_MARKER_PATTERN = /\[Pasted\s*text\s*#\d+/i;
export const PASTE_TO_ENTER_MIN_DELAY_MS = 200;
export const PASTE_TO_ENTER_FALLBACK_MS = 3500;

/**
 * Count the `[Pasted text #N …]` paste-commit markers in `strippedText`.
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
 * the TUI's genuine (N+1)th marker. (A normal prompt has 0, so the common case
 * is unchanged; a large transcript paste that Claude Code collapses to its own
 * single marker simply falls back to the timer, which is safe.)
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

// "The model is actively processing a submitted prompt" signal. A TUI repaints
// its banner/status line continuously even with an UNSUBMITTED prompt sitting in
// the input box, so "any PTY output after the paste" cannot distinguish real
// work from chrome churn — that conflation is what finalized a never-submitted
// agent as `success: idle-complete` (issue #1229).
//
// We key on the TUI's elapsed-time WORKING COUNTER — `(1s · …` (Claude Code) /
// `(57s • …` (Codex) — which renders only while a request is in flight and
// INCREMENTS as the model works. This is the most model-agnostic signal (present
// in both providers, absent on the stuck screen) AND the only one that's
// echo-proof. The prompt is echoed into the input box BEFORE submission (and
// `promptSentAt` is set when the paste starts, before Enter), so word-matching
// `thinking`/`esc to interrupt` — or even a bare `(5s)` — could be tripped by a
// task description that merely contains those tokens (both flagged in review of
// #1229). Two defenses make the counter immune to the echo:
//   1. We require the counter's trailing bullet separator (`· ` / `• `, U+00B7 /
//      U+2022) — `(\d+s` alone matches log lines and durations in prose, but
//      `(\d+s ·` is the TUI's specific status-line format and effectively never
//      appears in a pasted prompt. (The bullet survives ANSI stripping intact —
//      verified in real transcripts: `(1s · thinking…`.)
//   2. We require ≥ MIN_WORK_COUNTER_SAMPLES DISTINCT second-counts — the live
//      counter passes through many values; a static echoed literal is just one.
// There is one residual echo vector even with the bullet requirement: a task
// that asks the agent to ANALYZE A TUI TRANSCRIPT can paste content that itself
// contains two distinct bulleted counters (`(1s · …` and `(2s · …`), and the
// whole prompt is echoed at paste time — before Enter is known to have submitted
// (flagged in review of #1229). The defining difference is TIMING: the live
// counter is rendered ONE value at a time as wall-clock seconds pass, whereas an
// echoed transcript's counters all arrive together in the paste render. So the
// tracker activates only once it has seen ≥ MIN_WORK_COUNTER_SAMPLES distinct
// values whose observations SPAN ≥ MIN_WORK_COUNTER_SPAN_MS of real time — a
// span a single paste-render burst can't fake. `observe()` therefore takes the
// current timestamp.
// Verified against real transcripts: the working run cycled through many counter
// values across its runtime; the two confirmed stuck runs (`agent-92ed2c56`,
// `agent-30a3ab56`) had none. Heuristic by nature, so it gates only the FALLBACK
// idle-complete path on the long-running agent path — the authoritative success
// signal remains the `.agent-done` sentinel. (The one-shot runner is deliberately
// NOT gated: its idle-complete legitimately captures inline output that may carry
// no counter, and its authoritative path is the response file.)
export const WORK_COUNTER_PATTERN = /\(\s*(\d+)\s*s\s*[·•]/g;
export const MIN_WORK_COUNTER_SAMPLES = 2;
export const MIN_WORK_COUNTER_SPAN_MS = 750;

/**
 * Extract every elapsed-second value from the TUI working counter in
 * `strippedText` (e.g. `(1s · …` → 1, `(57s • …` → 57). Matches only the TUI's
 * bullet-suffixed status-line counter, not a bare `(5s)` in prose. Callers MUST
 * pass ANSI-stripped output. Returns an array (possibly empty); non-string input
 * yields `[]`.
 *
 * @param {string} strippedText — ANSI-stripped output (a chunk or accumulator).
 * @returns {number[]}
 */
export function extractWorkCounterSeconds(strippedText) {
  if (typeof strippedText !== 'string' || !strippedText) return [];
  const out = [];
  // Fresh matcher state per call — a module-level /g regex carries lastIndex
  // across calls and would skip matches on the next invocation.
  const re = new RegExp(WORK_COUNTER_PATTERN.source, 'g');
  let m;
  while ((m = re.exec(strippedText)) !== null) out.push(Number(m[1]));
  return out;
}

/**
 * Stateful tracker for the "model is actively working" signal. Feed it each
 * ANSI-stripped post-paste chunk via `observe(strippedText, nowMs)`; it becomes
 * (and stays) `active` once it has seen ≥ MIN_WORK_COUNTER_SAMPLES DISTINCT
 * bulleted elapsed-second counter values whose observations span ≥
 * MIN_WORK_COUNTER_SPAN_MS of wall-clock time — i.e. the live counter actually
 * ticked across real seconds, which neither a static echoed prompt nor an echoed
 * transcript's counters (all rendered in one paste burst) can fake. Used by the
 * long-running agent path; lives here so the echo-proof logic is unit-testable.
 *
 * @returns {{ observe: (strippedText: string, nowMs: number) => boolean, readonly active: boolean }}
 */
export function createWorkActivityTracker() {
  const seconds = new Set();
  let firstSeenAt = null; // wall-clock ms when the FIRST distinct counter appeared
  let active = false;
  return {
    observe(strippedText, nowMs) {
      if (active) return true;
      for (const s of extractWorkCounterSeconds(strippedText)) {
        if (seconds.has(s)) continue;
        seconds.add(s);
        if (firstSeenAt === null) {
          firstSeenAt = nowMs;
        } else if (
          seconds.size >= MIN_WORK_COUNTER_SAMPLES &&
          typeof nowMs === 'number' && typeof firstSeenAt === 'number' &&
          nowMs - firstSeenAt >= MIN_WORK_COUNTER_SPAN_MS
        ) {
          // A later distinct value, far enough after the first — the live counter
          // advanced across wall-clock time. A one-shot paste-render burst can't.
          active = true;
          return true;
        }
      }
      return active;
    },
    get active() { return active; },
  };
}

// A SINGLE Enter after a large bracketed paste is unreliable: the TUI can still
// be processing/reflowing the multi-line paste when the `\r` arrives and
// swallow it, leaving the whole prompt sitting unsent in the input box. The
// agent then idles out and is falsely finalized as success — observed as the
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
// per-provider values (provider.tuiPromptDelayMs / .tuiIdleTimeoutMs).
export const DEFAULT_TUI_PROMPT_DELAY_MS = 2500;
export const DEFAULT_TUI_IDLE_TIMEOUT_MS = 180000;

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

export function inferTuiCommand(id) {
  if (!id) return 'claude';
  if (id.includes('codex')) return 'codex';
  if (id.includes('antigravity')) return 'agy';
  if (id.includes('gemini')) return 'gemini';
  return 'claude';
}

/**
 * True when the given TUI command renders the elapsed working counter
 * (`(Ns ·` / `(Ns •`) that `createWorkActivityTracker` keys on. Only Claude
 * Code and Codex are known to render it; Antigravity/Gemini/other TUIs do not.
 *
 * The work-activity idle gate (issue #1229) must consult this before
 * downgrading a sentinel-less idle-out to failure: on a provider that never
 * renders the counter, absence of the signal proves nothing, so the original
 * permissive idle-complete=success behavior must be preserved (otherwise every
 * sentinel-less completion on those providers would falsely fail).
 *
 * @param {string} commandName — the spawned binary's basename (e.g. `claude`,
 *   `codex`, `agy`, `gemini`).
 * @returns {boolean}
 */
export function rendersWorkCounter(commandName) {
  if (typeof commandName !== 'string') return false;
  const lower = commandName.toLowerCase();
  return lower.includes('claude') || lower.includes('codex');
}

// Codex TUI blocks on every tool approval AND sandboxes file/network writes
// unless we run it fully bypassed. There's no human-at-keyboard for headless
// calls (one-shot OR agent), so inject the full-yolo flag — the same posture
// the CLI/exec path uses in `agentCliSpawning.js`. The bypass flag is mutually
// exclusive with `--ask-for-approval` / `--sandbox`, so don't add it when the
// provider config already pins an approval/sandbox/bypass policy of its own.
export function applyCommandDefaults(command, args) {
  if (command === 'codex' && !codexHasApprovalPolicy(args)) {
    return ['--dangerously-bypass-approvals-and-sandbox', ...args];
  }
  if (isAntigravityCommand(command)) {
    return ensureAntigravityTuiArgs(args);
  }
  return args;
}

// True when the codex argv already declares an approval/sandbox posture, so
// injecting `--dangerously-bypass-approvals-and-sandbox` would collide with it.
function codexHasApprovalPolicy(args) {
  return args.some(arg =>
    arg === '--ask-for-approval' || arg === '-a' || arg.startsWith('-a=') || arg.startsWith('--ask-for-approval=') ||
    arg === '--sandbox' || arg === '-s' || arg.startsWith('-s=') || arg.startsWith('--sandbox=') ||
    arg === '--dangerously-bypass-approvals-and-sandbox' || arg === '--yolo'
  );
}

/**
 * Build the spawn args for a TUI invocation. When `provider.args` already
 * has a `--model X` (or `-m X`) pin, the args-baked flag wins and we skip
 * the per-call --model append — otherwise the CLI would see two flags and
 * either error or take the last one (provider-specific). Matches the same
 * gate `runner.js#buildCliArgs` uses for CLI providers.
 */
export function buildTuiInvocation(provider, model) {
  const command = provider?.command || inferTuiCommand(provider?.id);
  const baseArgs = applyCommandDefaults(command, [...(provider?.args || [])]);
  const effectiveModel = resolveCliModel(model);
  const shouldInject = !isAntigravityCommand(command) && effectiveModel && !hasModelFlag(baseArgs);
  const args = shouldInject ? [...baseArgs, '--model', effectiveModel] : baseArgs;
  return { command, args };
}

/**
 * Returns true when the stripped chunk looks like a `command not found`
 * error for our spawned TUI binary. Used as an early-fail probe so a typo'd
 * provider.command surfaces in seconds instead of after the idle timeout.
 */
export function detectMissingTuiBinary(strippedText, commandName) {
  const lower = strippedText.toLowerCase();
  return lower.includes('command not found') && lower.includes(commandName.toLowerCase());
}
