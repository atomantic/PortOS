/** Persist the one-shot TUI verdict and deliver completion once across every terminal event. */
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { tryReadFile } from '../../lib/fileUtils.js';
import { unregisterActiveRun, finalizeRunRecord } from '../runner.js';
import { unregisterExternalSession } from '../shell.js';

export function createTuiFinalizer({ options, invocation, session, state, cleanupTimers, resolve }) {
  const { runId, onComplete, reportFailure = true } = options;
  const { runIdentity, responseFilePath, wrappedPrompt } = invocation;
  const { childIdentitySaved, killPty } = session;
  return async ({ success, exitCode = 0, error = null, reason = 'completed', canceled = false, errorAnalysis = null }) => {
    if (state.finalized) return;
    state.finalized = true;
    // A throwing completion hook must never receive a second, contradictory result.
    let onCompleteInvoked = false;
    // The public promise must settle even if a PTY/timer callback initiates a failing cleanup.
    try {
      cleanupTimers();
      unregisterActiveRun(runId);
      // Remove the Shell view before the kill can emit its own exit event.
      unregisterExternalSession(runId, { exitCode });
      try { killPty(); } catch { /* already gone */ }

      const { text: responseText, usedResponseFile } = await resolveTuiResponseText({
        success, responseFilePath, outputBuffer: state.outputBuffer, wrappedPrompt,
      });

      // Serialize the final metadata write after the child identity, including when the PTY exited during registration.
      await childIdentitySaved;
      const metadata = await finalizeRunRecord({
        runId, output: responseText, exitCode, success, error, startTime: state.startTime,
        identity: runIdentity,
        reportFailure,
        extras: {
          completionReason: reason,
          ...(errorAnalysis ? { errorAnalysis, executionInterruption: { category: errorAnalysis.category, source: 'provider' } } : {}),
          usedResponseFile,
          outputTruncated: state.outputBufferTruncated,
          ...(canceled ? { canceled: true } : {}),
        },
      }).catch((err) => {
        maintenance.markCurrentUnsettled();
        console.error(`❌ TUI run ${runId} finalize failed: ${err.message}`);
        return {
          exitCode, success, error: error || err.message,
          duration: Date.now() - state.startTime, completionReason: reason,
          ...(errorAnalysis ? { errorAnalysis } : {}),
          ...(canceled ? { canceled: true } : {}),
        };
      });
      onCompleteInvoked = true;
      onComplete?.({ ...metadata, text: responseText, usedResponseFile, outputTruncated: state.outputBufferTruncated });
    } catch (err) {
      maintenance.markCurrentUnsettled();
      console.error(`❌ TUI run ${runId} finish() failed: ${err?.message || err}`);
      // If cleanup failed before the kill, stop the original PTY before callers can start a fallback.
      try { killPty(); } catch { /* already gone */ }
      // Callers settle their own promise through onComplete, including failures before its normal invocation.
      if (!onCompleteInvoked) {
        try {
          onComplete?.({
            runId, success: false, exitCode, error: `finish() failed: ${err?.message || err}`,
            duration: Date.now() - state.startTime, completionReason: reason,
            ...(errorAnalysis ? { errorAnalysis } : {}),
            ...(canceled ? { canceled: true } : {}),
          });
        } catch (cbErr) {
          console.error(`❌ TUI run ${runId} onComplete threw during finish() error handling: ${cbErr?.message || cbErr}`);
        }
      }
    } finally {
      resolve();
    }
  };
}

/**
 * Pick the TUI response text — preferring the file the model was directed
 * to write, falling back to the cleaned screen scrape.
 *
 * Returns `{ text, usedResponseFile }`. `usedResponseFile` is true when the
 * file existed and had non-empty trimmed content; false in every other
 * case (file missing, empty, whitespace-only, or run did not succeed).
 *
 * Extracted out of `executeTuiRun.finish` so the file-read + fallback
 * decision is testable without spawning a PTY.
 */
export async function resolveTuiResponseText({ success, responseFilePath, outputBuffer, wrappedPrompt }) {
  if (success) {
    const fileText = await tryReadFile(responseFilePath);
    if (typeof fileText === 'string' && fileText.trim()) {
      return { text: fileText.trim(), usedResponseFile: true };
    }
  }
  return { text: cleanTuiResponse(outputBuffer, wrappedPrompt), usedResponseFile: false };
}

/**
 * Best-effort response cleanup for an already-ANSI-stripped TUI buffer.
 *
 * The TUI buffer is a screen, not a log — it contains banner art, the
 * pasted prompt echoed back, status lines ("thinking...", token counters),
 * box-drawing characters around the input prompt, and the model's response
 * interleaved with all of it. Reliable carve-out would need per-binary
 * scrapers; this helper just drops the obvious bits (paste marker + echoed
 * prompt) and leaves downstream consumers (`extractJson`,
 * `extractCodexAssistant`) to find structured content in the rest.
 *
 * Input is assumed pre-stripped of ANSI codes (the central handler streams
 * each chunk through `createStreamingAnsiStripper` during accumulation, so
 * `outputBuffer` is already clean). Don't strip again — it's a wasted scan
 * over up to `OUTPUT_BUFFER_CAP` bytes of text.
 */
export function cleanTuiResponse(strippedText, prompt) {
  if (typeof strippedText !== 'string' || !strippedText) return '';
  let text = strippedText.replace(/\[Pasted text #\d+[^\]]*\]/g, '');
  // split-join over the prompt is safe because the prompt is fixed text —
  // no regex escaping needed. Guard on length>16 so a degenerate empty/
  // tiny prompt doesn't accidentally erase model output.
  if (typeof prompt === 'string' && prompt.length > 16) {
    text = text.split(prompt).join('');
  }
  return text.trim();
}
