/**
 * One paste-and-submit driver for both TUI runners (#16105).
 *
 * `createPasteSubmitDriver({ prompt, command, write, paste, isFinalized, onFail, settleRule, mcpBoot,
 * promptGate, … })` — the one paste-and-submit sequence both TUI runners drive (#16105): bracketed
 * paste → commit evidence (marker / collapsed chip / rendered prefix) → verify window → MCP-boot-aware
 * retry of a swallowed paste → Codex settle (`settleRule: 'codex'`) → spaced submit Enters →
 * re-pressed Enter while the prompt sits unsubmitted. Owns every paste/Enter timer; readiness and
 * startup dialogs stay with each runner. Returns `{ start, ingest, resubmit, pressUnsubmittedEnter,
 * cancel }`.
 *
 * The one-shot prompt runner (`services/tuiPromptRunner.js`) and the CoS agent
 * session controller (`services/agentTuiSpawning/sessionController.js`) used to
 * hand-implement the same PTY sequence with their own timers, and the copies
 * drifted: only the agent path verified and retried a swallowed paste, only the
 * prompt path knew Codex's settle rule. This module owns that sequence once:
 *
 *   bracketed paste → wait for commit evidence (marker / chip / rendered text)
 *   → verify window for a markerless paste → retry a swallowed paste (MCP-boot
 *   aware) → settle (Codex) → submit Enters → re-press Enter while the prompt
 *   still sits unsubmitted in the composer.
 *
 * Ready detection and startup-dialog handling stay with each runner: they decide
 * WHEN `start()` is called. Everything that touches a PTY or a run record is
 * injected, so the driver is drivable with fake timers and no PTY.
 *
 * Imports only the pure constants/predicates from `tuiHandshake.js`, which both
 * callers already load, so it adds one file to their import closures.
 */

import { stripAnsi } from './ansiStrip.js';
import {
  countPasteMarkers,
  extractVerifiablePromptPrefix,
  isPasteCommitted,
  isPasteConfirmed,
  scheduleSubmitEnters,
  MCP_BOOT_PASTE_DEADLINE_MS,
  MCP_BOOT_PASTE_RETRY_DELAY_MS,
  PASTE_COMMIT_PATIENCE_MS,
  PASTE_MARKER_POLL_MS,
  PASTE_RETRY_BASE_DELAY_MS,
  PASTE_RETRY_MAX_ATTEMPTS,
  PASTE_RETRY_MIN_WINDOW_MS,
  PASTE_RETRY_WINDOW_DELAY_MS,
  PASTE_TO_ENTER_FALLBACK_MS,
  PASTE_TO_ENTER_MIN_DELAY_MS,
  PASTE_VERIFY_POLL_MS,
  PASTE_VERIFY_WINDOW_MS,
  POST_PASTE_BUFFER_CAP,
  SUBMIT_KEY,
  UNSUBMITTED_PROMPT_ENTER_MAX_ATTEMPTS,
} from './tuiHandshake.js';

const NO_MCP_BOOT = Object.freeze({ active: false });
const WINDOWS_CODEX_MS_PER_CODE_UNIT = 2;
const WINDOWS_CODEX_MAX_COMMIT_MS = 150000;
const CODEX_PASTE_CHIP_PATTERN = /\[Pasted\s*Content\s*(\d+)\s*chars\](?:[ \t]*#(\d+))?/gi;

// Native Codex reads ConPTY input records one character at a time. A task-sized
// paste can take over a minute to drain and may render as separate paste chips.
// The numeric suffix distinguishes equal-sized chips from ordinary repaints.
function countCodexPastedCharacters(buffer, promptChipSizes) {
  const counts = new Map();
  for (const [, size, suffix] of buffer.matchAll(CODEX_PASTE_CHIP_PATTERN)) {
    const chars = Number(size);
    if (promptChipSizes.has(chars)) continue;
    counts.set(chars, Math.max(counts.get(chars) || 0, Number(suffix ?? 1)));
  }
  let total = 0;
  for (const [size, count] of counts) total += size * count;
  return total;
}

/**
 * @param {object} options
 * @param {string} options.prompt — the exact text bracketed-pasted on `start()`.
 * @param {string} options.command — the TUI command, named in failure summaries.
 * @param {(keys: string, opts?: { promptSubmission?: boolean }) => unknown} options.write
 *   — raw PTY write. A throw on the paste write fails the run `write-failed`,
 *   on the first submit Enter `prompt-submit-failed`; a throw on a retry Enter
 *   is ignored (the PTY may already be gone).
 * @param {(text: string, opts: { label: string }) => unknown} options.paste
 *   — re-delivery through the session layer, which schedules its own submit
 *   Enters and returns their interval handle (falsy once the session is gone).
 * @param {() => boolean} options.isFinalized — true once the run is over.
 * @param {(reason: string, summary: string) => unknown} options.onFail — the
 *   run's failure path. May return a promise; its rejection is logged.
 * @param {(event: object) => void} [options.onEvent] — progress events for the
 *   caller's transcript: `pasted` {reason, attempt}, `paste-retrying`
 *   {delayMs, mcpBootActive}, `paste-not-rendered` {attempts, mcpBootActive,
 *   seconds}, `unsubmitted-enter` {attempt, max}.
 * @param {() => void} [options.onSubmitted] — fired once, when the first submit
 *   Enter goes out.
 * @param {ReturnType<import('./tuiHandshake.js').createPromptSubmissionGate>} [options.promptGate]
 *   — told about every submit/re-delivery, and consulted for unsubmitted Enters.
 * @param {() => number} [options.getLastOutputAt] — the caller's last-output
 *   clock, for the gate's settle check.
 * @param {'codex'|'default'} [options.settleRule='default'] — `codex` enables
 *   Codex's two paste rules: a patient first commit wait (PASTE_COMMIT_PATIENCE_MS,
 *   skipped while MCP servers boot) and waiting for paste output to settle
 *   before Enter, failing `prompt-not-submitted` if it never does.
 * @param {{ active: boolean }} [options.mcpBoot] — Codex MCP-boot tracker, read
 *   live; while active the retry budget is time-based (MCP_BOOT_PASTE_DEADLINE_MS).
 * @param {number} [options.unsubmittedPollMs] — when set, the driver polls for
 *   an unsubmitted prompt itself after submit. Callers that already run a
 *   periodic gate (the agent's provider-signal poll) leave it unset and call
 *   `pressUnsubmittedEnter()` in their own ordering.
 * @param {(message: string) => void} [options.logError]
 */
export function createPasteSubmitDriver({
  prompt,
  command,
  write,
  paste,
  isFinalized,
  onFail,
  onEvent = () => {},
  onSubmitted = () => {},
  promptGate = null,
  getLastOutputAt = () => 0,
  settleRule = 'default',
  mcpBoot = NO_MCP_BOOT,
  unsubmittedPollMs = 0,
  logError = (message) => console.error(message),
}) {
  const codexSettle = settleRule === 'codex';
  const windowsCommitMs = codexSettle && process.platform === 'win32'
    ? Math.min(prompt.length * WINDOWS_CODEX_MS_PER_CODE_UNIT, WINDOWS_CODEX_MAX_COMMIT_MS)
    : 0;
  const slowWindowsPaste = windowsCommitMs > PASTE_COMMIT_PATIENCE_MS;
  // ConPTY can deliver CR and LF as two separate key events. Use the same line
  // endings Codex's paste handler uses and count Unicode scalar values as it does.
  const pasteText = slowWindowsPaste ? prompt.replace(/\r\n?/g, '\n') : prompt;
  const expectedChars = slowWindowsPaste ? [...pasteText].length : 0;
  // Markers already present in the prompt itself (a transcript-analysis task can
  // echo `[Pasted text #N]` back). The commit fast path waits for the TUI's OWN
  // marker — the count must EXCEED this — so an echoed marker can't fire the
  // submit Enters mid-reflow (#1229 review). Counted on the STRIPPED prompt so a
  // cursor-positioned marker in a raw transcript counts the way it echoes back.
  const strippedPrompt = stripAnsi(prompt);
  const promptMarkerCount = countPasteMarkers(strippedPrompt);
  // Literal examples in the prompt cannot establish how many characters landed.
  const promptChipSizes = slowWindowsPaste
    ? new Set(Array.from(strippedPrompt.matchAll(CODEX_PASTE_CHIP_PATTERN), ([, size]) => Number(size)))
    : null;
  // One verification target for every attempt (#2192).
  const verifiablePrefix = extractVerifiablePromptPrefix(prompt);
  // isPasteConfirmed minus its "nothing to verify against" pass: the commit wait
  // keeps WAITING for a short prompt that has not visibly landed. Memoized on
  // buffer identity — the poll re-asks every PASTE_MARKER_POLL_MS for up to
  // PASTE_COMMIT_PATIENCE_MS while a booting codex is silent, and the buffer is
  // only rebound when output arrives.
  let lastCommitBuffer = null;
  let lastCommitVerdict = false;
  let visiblePasteChars = 0;
  const pasteCommitted = (buffer) => {
    if (buffer !== lastCommitBuffer) {
      lastCommitBuffer = buffer;
      if (promptChipSizes) {
        visiblePasteChars = countCodexPastedCharacters(buffer, promptChipSizes);
        lastCommitVerdict = visiblePasteChars === expectedChars;
      } else {
        lastCommitVerdict = isPasteCommitted(buffer, { verifiablePrefix, promptMarkerCount });
      }
    }
    return lastCommitVerdict;
  };
  const pasteConfirmed = (buffer) => slowWindowsPaste
    ? pasteCommitted(buffer)
    : isPasteConfirmed(buffer, { verifiablePrefix, promptMarkerCount });

  // Paste-confirmation state:
  //   idle            no attempt in flight; incoming output is ignored
  //   awaiting-marker attempt fired; waiting for the TUI's commit evidence
  //   awaiting-verify commit wait elapsed with no evidence; short window for a
  //                   late marker / prompt echo before declaring it swallowed
  //   backoff         verification failed; waiting out the retry delay
  // The buffer survives every phase change except `idle`, so delayed TUI output
  // can still confirm a paste that looked failed (a re-paste on top of a queued
  // one made Codex commit neither).
  const pasteState = { phase: 'idle', buffer: '', lastOutputAt: 0 };
  const clearPaste = () => { pasteState.phase = 'idle'; pasteState.buffer = ''; };

  let pasteEnterTimer = null;
  let pasteVerifyTimer = null;
  let pasteRetryTimer = null;
  let pasteSettleTimer = null;
  let submitEnterTimer = null;
  let unsubmittedTimer = null;
  let pasteSettleStartedAt = null;
  let pasteAttempt = 0;
  // Anchor for the retry budgets, which are time-bounded as well as count-bounded.
  let firstPasteStartedAt = null;
  let started = false;
  let submitted = false;

  const fail = (reason, summary) => {
    try {
      Promise.resolve(onFail(reason, summary))
        .catch(err => logError(`❌ TUI ${command} ${reason} failure handling failed: ${err?.message || err}`));
    } catch (err) {
      logError(`❌ TUI ${command} ${reason} failure handling failed: ${err?.message || err}`);
    }
  };

  const writeEnter = () => {
    try { return write(SUBMIT_KEY, { promptSubmission: true }); } catch { return false; }
  };

  /**
   * Press the Enter a prompt still sitting in the composer missed. Returns the
   * attempt number when one was pressed, else 0. A no-op before the first submit.
   */
  const pressUnsubmittedEnter = (nowMs = Date.now()) => {
    if (!submitted || !promptGate || isFinalized()) return 0;
    const enter = promptGate.takeEnter(nowMs, getLastOutputAt());
    if (!enter) return 0;
    if (writeEnter() !== false) {
      onEvent({ type: 'unsubmitted-enter', attempt: enter, max: UNSUBMITTED_PROMPT_ENTER_MAX_ATTEMPTS });
    }
    return enter;
  };

  const armUnsubmittedPoll = () => {
    if (!unsubmittedPollMs || !promptGate || unsubmittedTimer) return;
    unsubmittedTimer = setInterval(() => {
      if (isFinalized() || promptGate.worked) {
        clearInterval(unsubmittedTimer);
        unsubmittedTimer = null;
        return;
      }
      pressUnsubmittedEnter(Date.now());
    }, unsubmittedPollMs);
  };

  const submitConfirmedPaste = () => {
    if (isFinalized() || submitted) return;
    // A late/partial chip proves receipt, not that the input burst ended. Codex's
    // burst reader suppresses an Enter that lands mid-burst, so measure the
    // settle interval from the latest paste output, never the initial write.
    const remaining = PASTE_TO_ENTER_MIN_DELAY_MS - (Date.now() - pasteState.lastOutputAt);
    if (codexSettle && remaining > 0) {
      pasteSettleStartedAt ??= Date.now();
      // A fixed cap, never a moving deadline: continuous redraws fail explicitly
      // rather than hold forever or force Enter into an unknown input state.
      if (Date.now() - pasteSettleStartedAt >= PASTE_COMMIT_PATIENCE_MS) {
        clearPaste();
        fail('prompt-not-submitted', 'Codex paste output never settled; no submission Enter was sent.');
        return;
      }
      if (pasteSettleTimer) clearTimeout(pasteSettleTimer);
      pasteSettleTimer = setTimeout(() => {
        pasteSettleTimer = null;
        submitConfirmedPaste();
      }, remaining);
      return;
    }
    // The commit buffer holds the paste chip: a TUI that ignores the submit Enter
    // may never repaint it (createPromptSubmissionGate).
    const evidence = pasteState.buffer;
    clearPaste();
    if (pasteRetryTimer) { clearTimeout(pasteRetryTimer); pasteRetryTimer = null; }
    submitted = true;
    onSubmitted();
    promptGate?.noteInput(Date.now(), evidence);
    // Several spaced Enters: a single `\r` can be swallowed while a large paste
    // is still reflowing. Each one is input the gate must measure from. The
    // first write runs synchronously here, so its throw is the submission
    // failing; a later retry's throw only means the PTY already went away.
    let firstEnter = true;
    try {
      submitEnterTimer = scheduleSubmitEnters(() => {
        if (firstEnter) {
          firstEnter = false;
          write(SUBMIT_KEY, { promptSubmission: true });
          return;
        }
        promptGate?.noteInput(Date.now());
        writeEnter();
      }, isFinalized);
    } catch (err) {
      fail('prompt-submit-failed', `Could not submit the pasted prompt: ${err.message}`);
      return;
    }
    armUnsubmittedPoll();
  };

  const attemptPaste = (reason) => {
    pasteAttempt += 1;
    const attemptNum = pasteAttempt;
    if (firstPasteStartedAt === null) firstPasteStartedAt = Date.now();
    if (pasteEnterTimer) { clearInterval(pasteEnterTimer); pasteEnterTimer = null; }
    if (pasteVerifyTimer) { clearInterval(pasteVerifyTimer); pasteVerifyTimer = null; }
    if (pasteRetryTimer) { clearTimeout(pasteRetryTimer); pasteRetryTimer = null; }
    // Armed BEFORE the write so every chunk answering it is captured.
    pasteState.phase = 'awaiting-marker';
    pasteState.buffer = '';
    pasteState.lastOutputAt = Date.now();
    try {
      write(`\x1b[200~${pasteText}\x1b[201~`);
    } catch (err) {
      clearPaste();
      fail('write-failed', `Failed to write prompt: ${err.message}`);
      return false;
    }
    onEvent({ type: 'pasted', reason, attempt: attemptNum });

    // Markerless AND the prompt text never rendered → swallowed by a
    // still-initializing TUI (#2192): retry, then fail. While codex boots MCP
    // servers EVERY paste is swallowed for up to ~2min, so the budget becomes a
    // time window at a fixed cadence (MCP_BOOT_PASTE_DEADLINE_MS).
    const retryOrFailPaste = () => {
      if (isFinalized()) return;
      if (slowWindowsPaste && (visiblePasteChars > 0
        || isPasteCommitted(pasteState.buffer, { verifiablePrefix, promptMarkerCount }))) {
        clearPaste();
        fail('paste-not-rendered', 'Codex did not confirm the full Windows TUI paste. No prompt was submitted.');
        return;
      }
      const bootActive = mcpBoot.active && !slowWindowsPaste;
      const sinceFirst = Date.now() - firstPasteStartedAt;
      const withinBudget = bootActive
        ? sinceFirst < MCP_BOOT_PASTE_DEADLINE_MS
        : attemptNum < PASTE_RETRY_MAX_ATTEMPTS || sinceFirst < PASTE_RETRY_MIN_WINDOW_MS;
      if (withinBudget) {
        const delayMs = bootActive
          ? MCP_BOOT_PASTE_RETRY_DELAY_MS
          : attemptNum < PASTE_RETRY_MAX_ATTEMPTS
            ? PASTE_RETRY_BASE_DELAY_MS * Math.pow(2, attemptNum - 1)
            : PASTE_RETRY_WINDOW_DELAY_MS;
        onEvent({ type: 'paste-retrying', delayMs, mcpBootActive: bootActive });
        pasteState.phase = 'backoff';
        pasteRetryTimer = setTimeout(() => {
          pasteRetryTimer = null;
          if (isFinalized()) return;
          if (pasteConfirmed(pasteState.buffer)) {
            submitConfirmedPaste();
            return;
          }
          attemptPaste(reason);
        }, delayMs);
        return;
      }
      const seconds = Math.round(MCP_BOOT_PASTE_DEADLINE_MS / 1000);
      onEvent({ type: 'paste-not-rendered', attempts: attemptNum, mcpBootActive: bootActive, seconds });
      clearPaste();
      fail('paste-not-rendered', bootActive
        ? `${command} did not finish booting its MCP servers within ${seconds}s, so the prompt was never delivered. A slow or hung MCP server in your ~/.codex config (e.g. playwright via npx, or a node_repl) blocks codex from accepting input — disable or fix it, or remove it for headless runs.`
        : `${command} did not confirm the prompt in the TUI buffer after ${attemptNum} attempts. No prompt was submitted.`);
    };

    const pasteSentAt = Date.now();
    // The MCP banner can latch after the write. A large Windows paste still
    // needs time to drain even if an earlier repaint showed that banner.
    const commitWaitMs = () => {
      if (slowWindowsPaste) return windowsCommitMs;
      return codexSettle && attemptNum === 1 && !mcpBoot.active
        ? PASTE_COMMIT_PATIENCE_MS
        : PASTE_TO_ENTER_FALLBACK_MS;
    };
    pasteEnterTimer = setInterval(() => {
      if (isFinalized()) {
        clearInterval(pasteEnterTimer);
        pasteEnterTimer = null;
        clearPaste();
        return;
      }
      const elapsed = Date.now() - pasteSentAt;
      if ((pasteCommitted(pasteState.buffer) && elapsed >= PASTE_TO_ENTER_MIN_DELAY_MS)
        || elapsed >= commitWaitMs()) {
        clearInterval(pasteEnterTimer);
        pasteEnterTimer = null;
        // The marker is authoritative: Claude/OpenCode collapse a multi-line
        // paste into a chip and HIDE the body, so text verification alone
        // false-negatives. Only the commit-wait timeout falls through to verify.
        if (pasteConfirmed(pasteState.buffer)) {
          submitConfirmedPaste();
          return;
        }
        const verifyStartedAt = Date.now();
        pasteState.phase = 'awaiting-verify';
        pasteVerifyTimer = setInterval(() => {
          if (isFinalized()) {
            clearInterval(pasteVerifyTimer);
            pasteVerifyTimer = null;
            clearPaste();
            return;
          }
          const confirmed = pasteConfirmed(pasteState.buffer);
          if (confirmed || Date.now() - verifyStartedAt >= PASTE_VERIFY_WINDOW_MS) {
            clearInterval(pasteVerifyTimer);
            pasteVerifyTimer = null;
            if (confirmed) submitConfirmedPaste();
            else retryOrFailPaste();
          }
        }, PASTE_VERIFY_POLL_MS);
      }
    }, PASTE_MARKER_POLL_MS);
    return true;
  };

  return {
    /**
     * Deliver the prompt once. Returns whether a paste is now in flight: false
     * when already started, finalized, or the paste write failed (the run's
     * onFail has already been told), so the caller arms nothing further.
     */
    start(reason) {
      if (started || isFinalized()) return false;
      started = true;
      return attemptPaste(reason) && !isFinalized();
    },

    /** Feed ANSI-stripped PTY output. A no-op unless a paste attempt is open. */
    ingest(stripped) {
      if (pasteState.phase === 'idle' || !stripped) return;
      pasteState.lastOutputAt = Date.now();
      // Tail-bounded: the commit predicates only need the last few screens.
      pasteState.buffer = (pasteState.buffer + stripped).slice(-POST_PASTE_BUFFER_CAP);
      // A late marker or prompt echo during the retry backoff proves the
      // existing paste landed: submit it and cancel the duplicate.
      if (pasteState.phase === 'backoff' && pasteRetryTimer && pasteConfirmed(pasteState.buffer)) {
        clearTimeout(pasteRetryTimer);
        pasteRetryTimer = null;
        submitConfirmedPaste();
      }
    },

    /**
     * Re-deliver text into the live session (the whole prompt after a
     * self-clearing provider rejection, or a short nudge). Skips paste
     * verification on purpose: the prompt already rendered once, and routing
     * through the startup retry ladder would let a mid-run hiccup fail the run
     * `paste-not-rendered`. Returns whether the paste actually went out.
     */
    resubmit({ text = prompt, label = 'provider-handshake resubmit' } = {}) {
      if (isFinalized()) return false;
      // Overwriting a live handle would leak the previous Enter interval past cancel().
      if (submitEnterTimer) clearInterval(submitEnterTimer);
      const handle = paste(text, { label });
      submitEnterTimer = handle || null;
      if (handle) promptGate?.noteInput(Date.now());
      return !!handle;
    },

    pressUnsubmittedEnter,

    /** Stop everything this driver armed. Safe to call repeatedly. */
    cancel() {
      if (pasteSettleTimer) { clearTimeout(pasteSettleTimer); pasteSettleTimer = null; }
      if (pasteEnterTimer) { clearInterval(pasteEnterTimer); pasteEnterTimer = null; }
      if (pasteVerifyTimer) { clearInterval(pasteVerifyTimer); pasteVerifyTimer = null; }
      if (pasteRetryTimer) { clearTimeout(pasteRetryTimer); pasteRetryTimer = null; }
      if (submitEnterTimer) { clearInterval(submitEnterTimer); submitEnterTimer = null; }
      if (unsubmittedTimer) { clearInterval(unsubmittedTimer); unsubmittedTimer = null; }
      clearPaste();
    },
  };
}
