/** Applies, retries and learns Metal command-buffer policy across the children of a single render. */

import { join } from 'path';
import { PATHS } from '../../lib/fileUtils.js';
import { spawnDetached } from '../../lib/detachedSpawn.js';
import { videoGenEvents } from './events.js';
import { broadcastSse } from '../../lib/sseUtils.js';
import { isAppleSilicon } from '../../lib/platform.js';
import {
  verifyPostCompletionOutputs,
  isPromptEncodingMetalWatchdog,
  planMetalBufferRetry,
  METAL_BUFFER_RETRY_ENV,
  bufferChildExit,
} from './generateVideoHelpers.js';
import { BYOV_RUNTIME_INFO, runtimeNeedsProcessGroupKill, runtimeUsesMlx, currentMetalProfileFingerprint } from './runtimes.js';
import { videoJobState } from './jobState.js';

export function createMetalWatchdog({
  job, jobId, bin, args, meta, model, encoder = null, batch = null, speedProfileId = null, preparation, numFrames: parsedNumFrames,
}, { getMetalBufferProfiles, metalBufferExecutionSignature }, {
  publications, expectedOutputPaths, heavyClaim, ownershipSettled, stopAbandonedChild,
}) {
  // The one allowed relaunch per job: a second watchdog abort at the smaller
  // command-buffer setting is a real failure the user has to see, not something
  // to keep grinding the GPU over. Covers every phase, prompt encode included.
  let metalBufferRetriesUsed = 0;
  let childEnv;
  let metalProfile = null;
  let reactiveRecovery = false;
  const reportMetalPolicy = (policy, diagnostic, message) => {
    job.metalBufferPolicy = { ...job.metalBufferPolicy, policy, diagnostic };
    broadcastSse(job, { type: 'status', message, metalBufferPolicy: job.metalBufferPolicy });
    videoGenEvents.emit('status', { generationId: jobId, message, metalBufferPolicy: job.metalBufferPolicy });
  };
  const cacheDiagnostic = () => reportMetalPolicy(job.metalBufferPolicy?.policy || 'stock', 'cache-write-failed', 'Metal buffer profile cache update unavailable; ordinary rendering remains available');

  const configure = async (env) => {
    childEnv = env;
    const operatorBufferCaps = Object.keys(METAL_BUFFER_RETRY_ENV).some(key => Object.hasOwn(process.env, key) || Object.hasOwn(childEnv, key));
    const metalEligible = isAppleSilicon() && runtimeUsesMlx(model.runtime);
    if (metalEligible) reportMetalPolicy(operatorBufferCaps ? 'operator' : 'stock', 'not-eligible', operatorBufferCaps ? 'Using operator Metal buffer settings' : 'Using stock Metal buffer settings');
    if (metalEligible && !operatorBufferCaps) {
      try {
        const fingerprint = await currentMetalProfileFingerprint(model.runtime);
        const signature = await metalBufferExecutionSignature({ model, encoder, runtimeInfo: BYOV_RUNTIME_INFO[model.runtime], fingerprint,
          bin, args, meta, batch, env: childEnv, policy: METAL_BUFFER_RETRY_ENV });
        if (signature) {
          metalProfile = await getMetalBufferProfiles().lookup(signature);
          if (metalProfile.applied) {
            Object.assign(childEnv, METAL_BUFFER_RETRY_ENV);
            metalBufferRetriesUsed = 1;
          }
          reportMetalPolicy(metalProfile.applied ? 'learned-initial' : 'stock', metalProfile.diagnostic,
            metalProfile.applied ? 'Using proven smaller Metal command buffers from a matching successful recovery' : `Metal buffer profile cache: ${metalProfile.diagnostic}`);
        }
      } catch {
        reportMetalPolicy('stock', 'fingerprint-or-cache-unavailable', 'Metal buffer profile evidence unavailable; using ordinary rendering');
      }
    }
  };

  // Cancel/ownership recheck shared by both sides of the learning probe: a new
  // cancel source must be added here once, or a canceled render could teach a profile.
  const renderStillOwned = (cancelEpochAtClose) => ownershipSettled()
    && videoJobState.cancelEpoch === cancelEpochAtClose && !preparation?.wasCanceled();

  // Did the runner actually apply the requested speed profile?
  const profileConfirmed = () => !speedProfileId || (job.speedProfile?.id === speedProfileId && job.speedProfile.degraded?.length === 0);

  // A Metal recovery profile is learned only from a clean, fully published,
  // verified, still-owned render that ran under the reactive retry.
  const learnReactiveMetalProfile = async ({ proc, code, signal, cancelEpochAtClose, completedOutputs }) => {
    if (!(reactiveRecovery && metalProfile && profileConfirmed() && code === 0 && !signal && !proc.killed
      && renderStillOwned(cancelEpochAtClose)
      && [...publications.values()].every(publication => publication.committed))) return;
    const verified = await verifyPostCompletionOutputs({ outputPaths: expectedOutputPaths, completedOutputs,
      startedAtMs: job.renderStartedAtMs, expectedFrames: parsedNumFrames, fps: meta?.fps });
    if (!verified.ok || !renderStillOwned(cancelEpochAtClose)) return;
    await getMetalBufferProfiles().learn(metalProfile).then(result => {
      if (!result.learned) reportMetalPolicy('reactive-retry', result.diagnostic, 'Metal buffer recovery completed; profile was not retained');
    }).catch(cacheDiagnostic);
  };

  // Whether a cancel landed while the relaunch was awaiting something, and if so
  // stop the replacement child. Checked after EVERY await in the relaunch: until
  // the shared active process points at it, cancel() has no handle on this child and bumping
  // the epoch is the only trace the cancel leaves.
  const canceledDuringRelaunch = (cancelEpochAtClose, retryProc) => {
    if (videoJobState.cancelEpoch === cancelEpochAtClose) return false;
    // Fall through to the normal failure path, so the job still reports a
    // terminal event instead of quietly running to completion after a cancel.
    console.log(`🛑 canceled during the prompt-encode relaunch — stopping the replacement child [${jobId.slice(0, 8)}]`);
    stopAbandonedChild(retryProc);
    return true;
  };

  // Retry once with the original arguments and staged inputs. Returning true
  // transfers ownership to the wired replacement, including its terminal events.
  const maybeRelaunchForMetalWatchdog = async ({ code, signal, childKilled, cancelEpochAtClose, stderr }, wireSpawnedChild) => {
    if (code === 0) return false;
    if (metalProfile?.applied && !childKilled && planMetalBufferRetry({ signal, stderr, mlxRuntime: runtimeUsesMlx(model.runtime) })) {
      await getMetalBufferProfiles().invalidate(metalProfile).catch(cacheDiagnostic);
      reportMetalPolicy('learned-initial', 'invalidated', 'Learned Metal buffer settings hit the watchdog again; profile invalidated');
      return false;
    }
    // A batch member already in history must never be rendered again over its
    // committed filename by a whole-batch prompt-encode retry.
    if ([...publications.values()].some(publication => publication.started || publication.committed)) return false;
    // A child PortOS killed on purpose — a user cancel, or either watchdog — is
    // never a spontaneous Metal abort to recover from, whatever signal it
    // finally landed on. Without this a cancel that raced an in-flight abort
    // would be answered by relaunching the render the user just stopped.
    if (childKilled) return false;
    const stderrText = typeof stderr === 'string' ? stderr : '';
    const bufferPlan = planMetalBufferRetry({
      signal,
      stderr: stderrText,
      retriesUsed: metalBufferRetriesUsed,
      mlxRuntime: runtimeUsesMlx(model.runtime),
    });
    if (!bufferPlan) return false;
    const inEncoder = isPromptEncodingMetalWatchdog({ signal, stderr: stderrText, promptEncodePhase: job.promptEncodePhase });
    // Runs from a child 'close' handler, outside the Express request lifecycle —
    // an uncaught throw here would crash the process, and a failed relaunch must
    // degrade into the normal failure report rather than strand the job.
    // Declared outside the try so the catch can stop a child that was spawned
    // before a later step threw — an unwired child has only the exit buffer
    // absorbing its events, and nothing that would ever reap it. `retryWired` is
    // the cut-off: past that point the child owns the job and reports its own
    // terminal event, so the catch must leave it alone.
    let retryProc = null;
    let retryWired = false;
    try {
      metalBufferRetriesUsed += 1;
      reactiveRecovery = true;
      job.metalBufferPolicy = { ...job.metalBufferPolicy, abortedAttemptMs: Date.now() - job.renderStartedAtMs };
      const retryArgs = args;
      const retryEnv = { ...childEnv, ...bufferPlan.env };
      reportMetalPolicy('reactive-retry', metalProfile?.diagnostic || 'not-eligible', 'Retrying with smaller Metal command buffers');
      const message = inEncoder
        ? 'Metal watchdog aborted the prompt encoder — retrying once with smaller command buffers (prompt unchanged)'
        : 'Metal watchdog stopped the GPU — retrying once with smaller command buffers';
      console.log(`♻️ ${message} [${jobId.slice(0, 8)}]`);
      broadcastSse(job, { type: 'status', message });
      videoGenEvents.emit('status', { generationId: jobId, message });
      retryProc = await spawnDetached(bin, retryArgs, {
        env: retryEnv,
        controlDir: join(PATHS.videos, '.detached', `${jobId}-retry`),
        cleanup: true,
        killProcessGroup: runtimeNeedsProcessGroupKill(model.runtime),
      });
      // Catch the replacement's terminal event in the same tick the spawn
      // resolved — the handoff below yields to the event loop, and a child that
      // dies in that window would otherwise emit into the void.
      const takeRetryEarlyExit = bufferChildExit(retryProc, { bufferOutput: true });
      if (canceledDuringRelaunch(cancelEpochAtClose, retryProc)) return false;
      // Both awaits finish BEFORE the shared active process starts pointing at the
      // replacement, and the statements that follow them are synchronous.
      // That ordering is load-bearing twice over:
      //   - cancel() can never reach a child that is not fully wired yet, so no
      //     exit can be acted on before the job is ready for it;
      //   - the child therefore cannot run its close handler (and release the
      //     accelerator claim) while this handoff is still in flight, which would
      //     otherwise let the handoff re-write the claim file with a dead PID and
      //     wedge every later render.
      await heavyClaim.handoffTo?.(retryProc.pid);
      if (canceledDuringRelaunch(cancelEpochAtClose, retryProc)) return false;
      videoJobState.activeProcess = retryProc;
      // Re-stamp the render clock: eta.js calibrates future estimates from
      // spawn → finalize, and charging the aborted child's wall time to the
      // render that actually produced the video would poison every later
      // estimate for this model.
      job.renderStartedAtMs = Date.now();
      const replayEarlyExit = wireSpawnedChild(retryProc, takeRetryEarlyExit);
      retryWired = true;
      await replayEarlyExit();
      return true;
    } catch (err) {
      console.error(`❌ prompt-encode retry failed to spawn [${jobId.slice(0, 8)}]: ${err.message}`);
      // Wired means the child owns the job and will report its own terminal
      // event, so nothing here may kill it. Unwired, it can never report at all.
      if (retryWired) return true;
      stopAbandonedChild(retryProc);
      // Nothing is running under this job any more; leave the invariant cancel()
      // reads (videoJobState.activeProcess === the live child, or null) intact.
      videoJobState.activeProcess = null;
      return false;
    }
  };
  return { configure, learnReactiveMetalProfile, maybeRelaunchForMetalWatchdog };
}
