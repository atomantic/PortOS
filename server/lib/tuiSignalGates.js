/** Track provider generation, failure and recovery signals for interactive TUI runs. */
import { detectTuiRetryBanner, describeTuiRetryStall } from './aiToolkit/errorDetection.js';

// Give Claude Code time to switch into /low-priority mode before retrying a prompt rejected by its
// session limit. Shared by both TUI execution paths.
export const CLAUDE_LOW_PRIORITY_RESUBMIT_DELAY_MS = 1500;

// Claude Code and Codex render a bulleted elapsed counter while a model request is in flight; agy
// uses its own `Generating…` indicator.
const WORK_COUNTER_PATTERN = /\(\s*(\d+)\s*s\s*[·•]/g;

// Chrome a TUI paints only while a model request is actually IN FLIGHT. agy renders an animated
// `Generating…` for exactly as long as the request runs; Claude Code and Codex render their
// bulleted elapsed counter, so WORK_COUNTER_PATTERN's shape is spliced in (rather than re-spelled)
// to keep the two from drifting apart. `esc to cancel` is DELIBERATELY NOT HERE, despite being
// half of agy's in-flight footer.
const GENERATION_ACTIVITY_PATTERN =
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
 * printed after it. A model can sit in a long thinking stretch without repainting its spinner,
 * so silence alone cannot prove completion. The one-shot runner
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
// idle `? for shortcuts` footer until a new submission arrives.
const SELF_CLEARING_RESUBMIT_INTERVAL_MS = 20000;

// How often a consumer without its own poll should ASK the gate whether a re-submission is due.
// Deliberately a sub-multiple of the interval above rather than equal to it: a timer whose period
// matches the cadence exactly can tick a hair early (timer rounding vs. `Date.now()`) and `takeResubmit` refuses, silently forfeiting that attempt for a whole interval.
// Polling faster than the cadence leaves the gate the single authority on timing.
export const SELF_CLEARING_RESUBMIT_POLL_MS = 5000;

// How long after a re-submission the gate ignores output when deciding whether the provider
// recovered. The generation tracker matches a single chunk, which is safe only while the stream
// cannot contain the prompt.
const SELF_CLEARING_RESUBMIT_ECHO_MS = 3000;

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
const OOM_NUDGE_SETTLE_MS = 25000;
// How long an armed nudge waits for that silence before giving up. Bounds the blast radius of the
// one case the cooldown can't dedupe — the error box being repainted long after the session
// recovered — so a stale arm can't sit around and fire into the next quiet stretch of a healthy
// run.
const OOM_NUDGE_ARM_WINDOW_MS = 120000;
// Two matches this close together are one OOM: the detector re-tests a 512-char rolling window,
// and a TUI repaint re-delivers the same error box for many chunks after the event.
const OOM_NUDGE_COOLDOWN_MS = 120000;
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
const CAPACITY_NUDGE_SETTLE_MS = 90000;
const CAPACITY_NUDGE_ARM_WINDOW_MS = 300000;
const CAPACITY_NUDGE_COOLDOWN_MS = 180000;
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
function createSilenceNudgeGate({ cooldownMs, settleMs, armWindowMs, maxAttempts }) {
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
const RETRY_STALL_MS = 10 * 60 * 1000;
const RETRY_STALL_MIN_ADVANCES = 2;
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
function detectToolPermissionPrompt(strippedText) {
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
const TOOL_PERMISSION_REPAINT_COOLDOWN_MS = 15000;
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
const STALL_NUDGE_IDLE_MS = 10 * 60 * 1000;
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
const AGY_RESUME_SETTLE_MS = 3000;

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
