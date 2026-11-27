/** Wait for a one-shot PTY composer and handle startup selectors before handing off the prompt. */
import { isClaudeCommand, isOpencodeCommand } from '../../lib/provider/providerModels.js';
import {
  createInputReadyTracker, describeTrustGateFailure, OPENCODE_INPUT_READY_PATTERN,
  READY_POLL_INTERVAL_MS, READY_IDLE_THRESHOLD_MS, TUI_INPUT_READY_DEADLINE_MS, PASTE_DEADLINE_MS,
} from '../../lib/tuiHandshake.js';

export function createStartupWatcher({ runId, invocation, ptyProcess, state, finish, sendPrompt }) {
  const { provider, command, promptDelayMs } = invocation;
  let readyTimer;
  // OpenCode requires both the composer placeholder and a settled repaint before pasting.
  const isOpencodeSession = isOpencodeCommand(command);
  const inputReady = createInputReadyTracker({
    launchShape: 'direct',
    ...(isOpencodeSession ? { readyTextPattern: OPENCODE_INPUT_READY_PATTERN } : {}),
  });
  const requiresInputReady = isClaudeCommand(command) || isOpencodeSession;
  // A failed or delayed PTY write must not navigate the hook selector twice.
  let hookReviewDeclined = false;

  const dismissStartupDialog = (keys, dialog) => {
    try {
      ptyProcess.write(keys);
      return true;
    } catch (err) {
      finish({
        success: false,
        exitCode: 1,
        error: `Failed to dismiss ${dialog}: ${err.message}`,
        reason: 'startup-dialog-write-failed',
      }).catch((finishErr) => {
        console.error(`❌ TUI run ${runId} ${dialog} dismissal failed: ${finishErr?.message || finishErr}`);
      });
      return false;
    }
  };

  function start() {
    // Handle startup selectors before sending input on either the readiness or idle/deadline path.
    readyTimer = setInterval(() => {
      if (state.finalized || state.promptSentAt) {
        clearInterval(readyTimer);
        readyTimer = null;
        return;
      }
      const now = Date.now();
      const elapsed = now - state.startTime;
      // The replacement-model composer is unusable for a run bound to the rejected model.
      const opencodeRejection = isOpencodeSession ? inputReady.opencodeModelRejection : null;
      if (opencodeRejection) {
        clearInterval(readyTimer);
        readyTimer = null;
        finish({
          success: false,
          exitCode: 1,
          error: opencodeRejection.message,
          reason: 'opencode-model-rejected',
          errorAnalysis: { ...opencodeRejection, configuredModel: provider.defaultModel },
        }).catch((err) => {
          console.error(`❌ TUI run ${runId} OpenCode model-rejection failure could not finalize: ${err?.message || err}`);
        });
        return;
      }
      // A dismissal can leave a quiet menu on screen. Require a fresh repaint before the idle path may paste.

      if (isOpencodeSession && inputReady.needsOpencodeUpdate) {
        if (dismissStartupDialog('\x1b', 'OpenCode update offer')) inputReady.ackOpencodeUpdate();
        state.lastOutputAt = now;
        state.firstOutputAt = null;
        return;
      }

      // Decline external instructions discovered above the managed app worktree.
      if (inputReady.needsExternalImportsChoice) {
        if (dismissStartupDialog('\x1b[B\r', 'external-imports prompt')) {
          inputReady.ackExternalImportsChoice();
        }
        state.lastOutputAt = now;
        state.firstOutputAt = null;
        return;
      }

      // Continue without trusting external hooks before pasting.
      if (inputReady.needsHookReview && !hookReviewDeclined) {
        hookReviewDeclined = true;
        if (dismissStartupDialog('\x1b[B\x1b[B\r', 'hook-review prompt')) {
          inputReady.ackHookReview();
        }
        state.lastOutputAt = now;
        state.firstOutputAt = null;
        return;
      }
      // Option order varies by CLI version. Wait for the tracker to confirm the highlighted trust choice.
      const trustAnswer = inputReady.trustAnswer();
      if (trustAnswer) {
        if (dismissStartupDialog(trustAnswer.keys, 'folder-trust prompt')) inputReady.ackTrustAnswer(trustAnswer);
        state.lastOutputAt = now;
        state.firstOutputAt = null;
        return;
      }
      if (inputReady.needsTrust) {
        const trustDeadlineMs = requiresInputReady ? TUI_INPUT_READY_DEADLINE_MS : PASTE_DEADLINE_MS;
        if (elapsed >= trustDeadlineMs) {
          clearInterval(readyTimer);
          readyTimer = null;
          finish({ success: false, exitCode: 1, ...describeTrustGateFailure(inputReady, command) });
        }
        return;
      }
      if (requiresInputReady) {
        if (inputReady.needsAutoModeChoice) {
          // Select "No, keep don't ask" so a one-shot run never rewrites the
          // user's global Claude permission default as a startup side effect.
          if (dismissStartupDialog('\x1b[B\r', 'auto-mode prompt')) {
            // Leave a polling interval for the composer to repaint.
            inputReady.ackAutoModeChoice();
          }
          return;
        }
        if (inputReady.ready && elapsed >= promptDelayMs
          && (!isOpencodeSession || (state.firstOutputAt !== null && now - state.lastOutputAt >= READY_IDLE_THRESHOLD_MS))) {
          sendPrompt('input-ready');
          return;
        }
        if (elapsed >= TUI_INPUT_READY_DEADLINE_MS) {
          clearInterval(readyTimer);
          readyTimer = null;
          finish({
            success: false,
            exitCode: 1,
            error: `${command} did not present an input prompt within ${Math.round(TUI_INPUT_READY_DEADLINE_MS / 1000)}s, so no prompt was sent.`,
            reason: 'tui-not-ready',
          }).catch((err) => {
            console.error(`❌ TUI run ${runId} input-readiness failure could not finalize: ${err?.message || err}`);
          });
        }
        return;
      }
      if (elapsed >= PASTE_DEADLINE_MS) {
        sendPrompt('fallback');
        return;
      }
      if (elapsed < promptDelayMs) return;
      if (state.firstOutputAt === null) return;
      if (now - state.lastOutputAt < READY_IDLE_THRESHOLD_MS) return;
      sendPrompt('ready');
    }, READY_POLL_INTERVAL_MS);
  }

  return { observe: inputReady.observe, start, stop: () => clearInterval(readyTimer) };
}
