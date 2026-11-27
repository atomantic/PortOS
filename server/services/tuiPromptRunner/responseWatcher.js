/** Watch a one-shot run for a settled response file, eligible idle completion or the hard deadline. */
import { tryReadFile } from '../../lib/fileUtils.js';
import { screenShowsInFlightChrome } from '../../lib/tuiHandshake.js';
import { isExternalSessionAttached } from '../shell.js';

// Enough stripped screen to hold a status line plus the composer and footer
// painted beneath it; see screenShowsInFlightChrome.
const IN_FLIGHT_SCREEN_TAIL_CHARS = 4096;

export function createResponseWatcher({ runId, invocation, state, finish, blocksIdle }) {
  const { responseFilePath, idleThresholdMs, totalTimeoutMs, requiresResponseFileForIdleCompletion } = invocation;
  let idleWatchTimer = null;
  let responseFileWatchTimer = null;
  let hardTimeoutTimer = null;
  // Only equal, nonempty lengths on consecutive polls prove a live writer has settled.
  let lastResponseLen = -1;
  const responseFileSettled = async () => {
    const txt = await tryReadFile(responseFilePath);
    if (typeof txt !== 'string' || !txt.trim()) { lastResponseLen = -1; return false; }
    if (txt.length === lastResponseLen) return true;
    lastResponseLen = txt.length;
    return false;
  };
  // An exited or timed-out writer can be salvaged on the first nonempty read.
  const responseFileHasContent = async () => {
    const txt = await tryReadFile(responseFilePath);
    return typeof txt === 'string' && !!txt.trim();
  };

  // A provider error can race the final response file during the stability window. Salvage it before falling back.
  const finishWithFallbackSignal = async (signal, { processExited = false } = {}) => {
    const salvaged = processExited
      ? await responseFileHasContent()
      : await responseFileSettled();
    if (state.finalized) return;
    if (salvaged) {
      console.log(`📄 TUI run ${runId} salvaged its completed response file despite a fallback signal: ${signal.message}`);
      await finish({ success: true, exitCode: 0, reason: 'fallback-signal-response-file' });
      return;
    }
    await finish({
      success: false,
      exitCode: signal.exitCode ?? 1,
      error: signal.message || 'Provider requires fallback',
      reason: 'fallback-signal',
    });
  };

  function watchFile() {
    // A model may write its answer without repainting. Start file polling at paste, even for watched sessions.
    responseFileWatchTimer = setInterval(async () => {
      if (state.finalized) return;
      // A transient file read must leave later ticks and the hard deadline armed.
      try {
        if (await responseFileSettled()) {
          finish({ success: true, exitCode: 0, reason: 'response-file' });
        }
      } catch (err) {
        console.error(`❌ TUI run ${runId} response-file poll failed: ${err?.message || err}`);
      }
    }, 1000);
  }

  function watchIdle() {
    if (state.finalized || idleWatchTimer) return;
    idleWatchTimer = setInterval(() => {
      if (state.finalized) return;
      // An attached viewer may still be interacting. Only the file, exit or hard deadline may complete this run.
      if (isExternalSessionAttached(runId)) return;
      // A provider recovery or a prompt still in the composer can look like a finished idle screen.
      if (blocksIdle()) return;
      const idle = Date.now() - state.lastOutputAt;
      if (idle >= idleThresholdMs) {
        if (requiresResponseFileForIdleCompletion) return;
        // A quiet model with in-flight chrome may still be reasoning.
        if (screenShowsInFlightChrome(state.outputBuffer.slice(-IN_FLIGHT_SCREEN_TAIL_CHARS))) return;
        // Providers that return inline output may finish without painting a work counter.
        finish({ success: true, exitCode: 0, reason: 'idle-complete' });
      }
    }, 1000);
  }

  function watchDeadline() {
    // An operator viewing the terminal still has the configured hard deadline.
    if (totalTimeoutMs > 0) hardTimeoutTimer = setTimeout(async () => {
      if (state.finalized) return;
      // A failed salvage read falls through to the timeout verdict.
      try {
        // The final write can race the last file poll before the deadline.
        if (await responseFileHasContent()) {
          finish({ success: true, exitCode: 0, reason: 'timeout-response-file' });
          return;
        }
      } catch (err) {
        console.error(`❌ TUI run ${runId} timeout salvage read failed: ${err?.message || err}`);
      }
      finish({
        success: false,
        exitCode: 124,
        error: `TUI run timed out after ${totalTimeoutMs}ms`,
        reason: 'timeout'
      });
    }, totalTimeoutMs);
  }

  return {
    finishWithFallbackSignal, watchFile, watchIdle, watchDeadline,
    stop() {
      clearInterval(idleWatchTimer);
      clearInterval(responseFileWatchTimer);
      clearTimeout(hardTimeoutTimer);
    },
  };
}
