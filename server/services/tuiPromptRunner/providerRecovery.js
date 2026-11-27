/** Handle provider fallback signals and their opt-in or bounded automatic retries for a one-shot PTY. */
import {
  createClaudeSessionLimitBannerDetector, createImmediateFallbackSignalDetector,
  createTerminalModelErrorDetector, createTerminalRequestTimeoutDetector,
} from '../../lib/aiToolkit/errorDetection.js';
import { isClaudeCommand } from '../../lib/provider/providerModels.js';
import {
  createSelfClearingSignalGate, CLAUDE_LOW_PRIORITY_RESUBMIT_DELAY_MS, SELF_CLEARING_RESUBMIT_POLL_MS, SUBMIT_KEY,
} from '../../lib/tuiHandshake.js';

export function createProviderRecovery({ runId, invocation, state, ptyProcess, pasteDriver, finishWithFallbackSignal }) {
  const { command, provider } = invocation;
  const detectImmediateFallbackSignal = createImmediateFallbackSignalDetector();
  const detectClaudeSessionLimitBanner = createClaudeSessionLimitBannerDetector();
  const mayUseClaudeLowPriority = provider.type === 'tui'
    && provider.lowPriorityOnUsageLimit === true
    && isClaudeCommand(command);
  let lowPriorityCommandAttempted = false;
  let lowPriorityPromptResubmitted = false;
  // A terminal model rejection leaves an unanswered prompt. Idle scraping would return the error screen.
  const detectTerminalModelError = createTerminalModelErrorDetector();
  // Flush a held request-timeout banner on exit before returning a zero-exit screen as the answer.
  const detectTerminalRequestTimeout = createTerminalRequestTimeoutDetector();
  let claudeLowPriorityResubmitTimer = null;
  // A rejection can arrive before the first response chunk arms any idle timer.
  let selfClearingTimer = null;
  let selfClearingResubmitTimer = null;
  const selfClearingGate = createSelfClearingSignalGate();
  // The deadline and retry poll expire together on recovery, timeout and every run finish.
  const stopSelfClearingTimers = () => {
    if (selfClearingTimer) { clearTimeout(selfClearingTimer); selfClearingTimer = null; }
    if (selfClearingResubmitTimer) { clearInterval(selfClearingResubmitTimer); selfClearingResubmitTimer = null; }
  };

  /**
   * Re-deliver the prompt while a self-clearing provider signal's window is
   * open. The agent path's `resubmitAfterSignal` (and
   * SELF_CLEARING_RESUBMIT_INTERVAL_MS) explain why a passive wait
   * cannot clear agy's eligibility banner: it is the REJECTION of the
   * submission, so the prompt is gone, the composer is empty, and nothing will
   * generate until something re-asks.
   */
  const resubmitAfterSignal = () => {
    // The first delivery belongs to the startup watcher.
    if (state.finalized || !state.promptSentAt) return;
    const attempt = selfClearingGate.takeResubmit(Date.now());
    if (!attempt) return;
    const submitted = pasteDriver.resubmit();
    if (submitted) {
      console.log(`🔁 TUI run ${runId} re-submitted its prompt while the provider handshake is open (attempt ${attempt})`);
    }
  };

  function tryLowPriority(sessionLimit) {
    if (!sessionLimit || !mayUseClaudeLowPriority) return false;
    if (lowPriorityCommandAttempted) return !lowPriorityPromptResubmitted;
    lowPriorityCommandAttempted = true;
    try {
      ptyProcess.write(`/low-priority${SUBMIT_KEY}`);
      console.log(`⏳ TUI run ${runId} reached Claude's session limit; sent /low-priority from the provider opt-in`);
      claudeLowPriorityResubmitTimer = setTimeout(() => {
        claudeLowPriorityResubmitTimer = null;
        if (state.finalized) return;
        state.promptSubmittedAt = Date.now();
        let resubmitted = false;
        try {
          resubmitted = pasteDriver.resubmit({ label: 'Claude low-priority continuation' });
        } catch (err) {
          sessionLimit.message = `Claude Code low-priority mode was enabled, but the task could not be re-submitted: ${err?.message || err}`;
        }
        if (resubmitted) {
          lowPriorityPromptResubmitted = true;
          console.log(`🔁 TUI run ${runId} re-submitted its task after enabling Claude low-priority mode`);
          return;
        }
        finishWithFallbackSignal({
          ...sessionLimit,
          message: sessionLimit.message
            || 'Claude Code low-priority mode was enabled, but the task could not be re-submitted',
        }).catch((err) => {
          console.error(`❌ TUI run ${runId} low-priority re-submit fallback failed: ${err?.message || err}`);
        });
      }, CLAUDE_LOW_PRIORITY_RESUBMIT_DELAY_MS);
      return true;
    } catch (err) {
      sessionLimit.message = `Claude Code session limit reached and /low-priority could not be sent: ${err?.message || err}`;
      return false;
    }
  }

  function observe(stripped, now) {
    // Generation closes the gate. Passing the receive time discounts the echo of a retry paste.
    if (selfClearingGate.observe(stripped, now)) {
      stopSelfClearingTimers();
      console.log(`✅ TUI run ${runId} provider signal cleared — generating again`);
    }

    const sessionLimit = isClaudeCommand(command) && state.promptSubmittedAt
      ? detectClaudeSessionLimitBanner(stripped)
      : null;

    const fallbackSignal = tryLowPriority(sessionLimit) ? null : (sessionLimit || detectImmediateFallbackSignal(stripped))
      || detectTerminalModelError(stripped)
      || detectTerminalRequestTimeout(stripped);
    // A buffered banner can match after recovery. Repeated grace signals must never become immediate fallbacks.
    if (fallbackSignal?.graceMs > 0) {
      if (selfClearingGate.arm(fallbackSignal, now)) {
        console.log(`⏳ TUI run ${runId} holding for a self-clearing provider signal (${Math.round(fallbackSignal.graceMs / 1000)}s): ${fallbackSignal.message}`);
        // Only the gate decides when a retry is due.
        selfClearingResubmitTimer = setInterval(resubmitAfterSignal, SELF_CLEARING_RESUBMIT_POLL_MS);
        selfClearingTimer = setTimeout(() => {
          selfClearingTimer = null;
          stopSelfClearingTimers();
          // The timer firing is the deadline. A second clock check could strand the armed gate.
          const expired = selfClearingGate.takeExpired();
          if (state.finalized || !expired) return;
          finishWithFallbackSignal(expired).catch((err) => {
            console.error(`❌ TUI run ${runId} deferred fallback-signal handling failed: ${err?.message || err}`);
          });
        }, fallbackSignal.graceMs);
      }
    } else if (fallbackSignal) {
      finishWithFallbackSignal(fallbackSignal).catch((err) => {
        console.error(`❌ TUI run ${runId} fallback-signal handling failed: ${err?.message || err}`);
      });
      return true;
    }
    return false;
  }

  return {
    observe, detectTerminalRequestTimeout,
    get blocksIdle() { return selfClearingGate.armed || lowPriorityCommandAttempted; },
    stop() {
      clearTimeout(claudeLowPriorityResubmitTimer);
      stopSelfClearingTimers();
    },
  };
}
