/** Coordinates local render admission, spawning and child ownership across retries and terminal events. */

import { maintenance } from '../../lib/maintenanceAdmission.js';
import { join } from 'path';
import { PATHS } from '../../lib/fileUtils.js';
import { spawnDetached } from '../../lib/detachedSpawn.js';
import { normalizeVideoFailure } from '../../lib/videoFailure.js';
import { prepareLocalMemory, gpuBlockersMessage } from '../localMemory.js';
import { miniMaxH3LiveMemoryAdmission } from '../../lib/minimaxH3Memory.js';
import { recordVideoExecutionDiagnostics } from './executionRecorder.js';
import { ServerError } from '../../lib/errorHandler.js';
import { videoGenEvents } from './events.js';
import { broadcastSse, dispatchCanceledJob, closeJobAfterDelay } from '../../lib/sseUtils.js';
import { hfChildEnv } from '../hfToken.js';
import { safeChildProcessEnv } from '../../lib/processEnv.js';
import { bufferChildExit } from './generateVideoHelpers.js';
import { runtimeIsCacheOnly, runtimeNeedsProcessGroupKill } from './runtimes.js';
import { loadHistory } from './history.js';
import { estimateRenderMs } from './eta.js';
import { videoJobState, cancel as cancelLocalVideo } from './jobState.js';
import { acquireRenderClaim, createRenderDiagnostics, stopAbandonedChild, trackRenderOutputs } from './renderResources.js';
import { watchStepwisePreview } from './stepwisePreview.js';
import { createMetalWatchdog } from './metalWatchdog.js';
import { wireSpawnedChild } from './renderTermination.js';

async function prepareRenderMemory({ model, args, jobId, executionParent }) {
  const memoryReport = await prepareLocalMemory();
  // Something else already owns the GPU (today: the vLLM Qwen container). Refuse
  // here rather than let the render die inside its model load with an OOM that
  // names neither the tenant nor the fix — the throw converges on
  // abandonBeforeWiring like every other pre-wiring failure.
  if (memoryReport.blockers.length) throw new Error(gpuBlockersMessage(memoryReport.blockers));
  const admission = miniMaxH3LiveMemoryAdmission({ model, totalMemoryGb: memoryReport.totalGb, availableMemoryGb: memoryReport.availableGb });
  if (admission?.memory) {
    await recordVideoExecutionDiagnostics(jobId, { memory: admission.memory }, ...(executionParent ? [executionParent] : []));
  }
  if (admission?.decline) throw new ServerError(admission.decline.message, { status: 409, code: admission.decline.code });
  if (admission) args.push('--memory-budget-bytes', String(admission.memory.budgetBytes));
  if (memoryReport.unloaded.length) console.log(`🧹 Video generation [${jobId.slice(0, 8)}] freed ${memoryReport.unloaded.length} resident model(s)`);
}

async function announceRenderStart({ batch, job, jobId, modelId, width: w, height: h, numFrames: parsedNumFrames, steps: actualSteps, meta, speedProfileId = null }) {
  // History-calibrated wall-clock estimate (#3801). `null` when this install
  // has never measured a render on this model — an explicit "no estimate"
  // sentinel the UI must render as "unknown", never as 0 or a guess. Stamped
  // on the job so every progress frame can carry it alongside step progress.
  const etaEstimate = batch ? null : estimateRenderMs({
    history: await loadHistory(),
    modelId,
    width: w,
    height: h,
    numFrames: parsedNumFrames,
    steps: actualSteps,
    // Keeps this render's samples in its own cost bucket — a speed profile
    // changes the slope, not just the step count, so pooling the two would
    // over-estimate a fast render and under-estimate a quality one.
    speedProfileId,
  });
  job.etaMs = etaEstimate ? etaEstimate.etaMs : null;
  const etaFields = etaEstimate
    ? { etaMs: etaEstimate.etaMs, etaBasis: etaEstimate.basis, etaSampleCount: etaEstimate.sampleCount }
    : { etaMs: null };

  console.log(`🎬 Generating video [${jobId.slice(0, 8)}]: ${modelId} ${w}x${h} frames=${parsedNumFrames} steps=${actualSteps} eta=${etaEstimate ? `${Math.round(etaEstimate.etaMs / 1000)}s (${etaEstimate.basis}, n=${etaEstimate.sampleCount})` : 'unknown'}`);
  videoGenEvents.emit('started', { generationId: jobId, totalSteps: actualSteps, ...meta, ...etaFields });
}

async function buildRenderEnv(model) {
  // Clear PYTHONPATH so the child uses the venv's own site-packages instead
  // of the parent shell's PYTHONPATH. Setting to `undefined` in a spread does
  // NOT unset the var — Node coerces it to the literal string "undefined" —
  // so build the env explicitly and `delete`.
  // Build the complete HF child env so BYOV Python helpers can authenticate
  // snapshot_download() against gated repos
  // (mirrors the imageGen child-spawn pattern). LTX-2 doesn't currently use
  // a gated repo, but the merge is harmless when no token is configured.
  const childEnv = runtimeIsCacheOnly(model.runtime)
    ? safeChildProcessEnv()
    : await hfChildEnv();
  delete childEnv.PYTHONPATH;
  // Force unbuffered Python I/O so tqdm + loguru + our own STAGE: prints flush
  // immediately. Without this, child stdio is line-buffered against a pipe and
  // long inference loops emit nothing to handleLine() for minutes — the UI
  // looks dead even when the model is making progress.
  childEnv.PYTHONUNBUFFERED = '1';
  if (runtimeIsCacheOnly(model.runtime)) {
    // A cache-only runner never reaches the network. Do not hand it an ambient
    // saved HF credential it neither needs nor may transmit.
    delete childEnv.HF_TOKEN;
    delete childEnv.HUGGING_FACE_HUB_TOKEN;
    childEnv.HF_HUB_DISABLE_IMPLICIT_TOKEN = '1';
    childEnv.HF_HUB_OFFLINE = '1';
    childEnv.TRANSFORMERS_OFFLINE = '1';
  }
  return childEnv;
}

export async function spawnAndWatchVideo(options) {
  const { job, jobId, cleanupTempFiles, preparation, bin, args, model } = options;
  delete job.metalBufferPolicy;
  let ownershipSettled = true;
  const retainOwnership = () => {
    ownershipSettled = false;
    // Chained renders use child job IDs; their ambient owner is the outer job.
    maintenance.markCurrentUnsettled();
    maintenance.markResourceUnsettled('media', jobId);
  };
  const cancelEpochAtStart = videoJobState.cancelEpoch;
  const profileStore = await import('./metalBufferProfiles.js');
  const { collectMemoryEvidence, persistTermination } = createRenderDiagnostics(options);
  const heavyClaim = await acquireRenderClaim(options, { retainOwnership, persistTermination });
  const releaseHeavyClaim = () => heavyClaim.release().catch((err) => {
    retainOwnership();
    console.error(`❌ Video generation claim release [${jobId.slice(0, 8)}]: ${err.message}`);
  });
  let firstProc;
  const cleanupStepwisePreview = watchStepwisePreview(options, retainOwnership);
  const cleanupFailedRender = async () => {
    const results = await Promise.allSettled([
      releaseHeavyClaim(),
      cleanupTempFiles({ includeUploads: true, includeUntrackedAudio: true }),
      cleanupStepwisePreview(),
    ]);
    if (results.some(result => result.status === 'rejected')) retainOwnership();
  };
  const outputs = trackRenderOutputs(options, retainOwnership);
  const stopChild = (child) => stopAbandonedChild(child, jobId, retainOwnership);
  const metal = createMetalWatchdog(options, profileStore, {
    ...outputs, heavyClaim, ownershipSettled: () => ownershipSettled, stopAbandonedChild: stopChild,
  });
  const wireChild = (proc, buffer) => wireSpawnedChild(proc, buffer, options, {
    ...outputs, retainOwnership, collectMemoryEvidence, persistTermination, cancelEpochAtStart,
    releaseHeavyClaim, cleanupStepwisePreview, cleanupFailedRender,
    maybeRelaunchForMetalWatchdog: (exit) => metal.maybeRelaunchForMetalWatchdog(exit, wireChild),
    learnReactiveMetalProfile: metal.learnReactiveMetalProfile,
  });

  const abandonBeforeWiring = async (err) => {
    stopChild(firstProc);
    if (videoJobState.activeProcess === firstProc) videoJobState.activeProcess = null;
    await cleanupFailedRender();
    const canceled = preparation?.wasCanceled();
    await persistTermination(null, null, canceled ? 'canceled' : 'refused');
    if (canceled) {
      dispatchCanceledJob(job, jobId, 'Video preparation', () => videoGenEvents.emit('failed', { generationId: jobId, error: 'Canceled' }));
    } else {
      job.status = 'error';
      const reason = err.message || 'Video generation failed before the render child was wired';
      const refused = err.status >= 400 && err.status < 500;
      const log = refused ? console.log : console.error;
      log(`${refused ? '🚫' : '❌'} Video generation setup error [${jobId.slice(0, 8)}]: ${reason}`);
      broadcastSse(job, { type: 'error', error: reason });
      videoGenEvents.emit('failed', { generationId: jobId, error: reason, failure: normalizeVideoFailure(err, { prompts: [options.meta?.prompt, options.meta?.negativePrompt] }) });
    }
    closeJobAfterDelay(videoJobState.jobs, jobId);
  };

  let replayEarlyExit;
  try {
    await prepareRenderMemory(options);
    await announceRenderStart(options);
    const childEnv = await buildRenderEnv(model);
    await metal.configure(childEnv);
    // Keep this last cancellation check adjacent to spawn. The detached child
    // survives a server restart and its temporary control directory is reaped on exit.
    preparation?.throwIfCanceled();
    job.renderStartedAtMs = Date.now();
    firstProc = await spawnDetached(bin, args, {
      env: childEnv,
      controlDir: join(PATHS.videos, '.detached', jobId),
      cleanup: true,
      killProcessGroup: runtimeNeedsProcessGroupKill(model.runtime),
    });
    // Buffer output and terminal events synchronously. Claim handoff yields to
    // file I/O, during which a fast child can already finish or fail to spawn.
    const takeEarlyExit = bufferChildExit(firstProc, { bufferOutput: true });
    videoJobState.activeProcess = firstProc;
    // A cancel() during the spawn await saw no process; deliver it now.
    if (preparation?.wasCanceled()) cancelLocalVideo();
    await heavyClaim.handoffTo?.(firstProc.pid);
    // Install terminal listeners before taking the buffered events. A wiring
    // failure leaves the exit buffer attached until the abandoned child stops.
    replayEarlyExit = wireChild(firstProc, takeEarlyExit);
  } catch (err) {
    await abandonBeforeWiring(err);
    throw err;
  }
  await replayEarlyExit();
}
