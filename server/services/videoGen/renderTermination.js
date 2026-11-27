/** Wires one child’s terminal events and replays an early exit through the same guarded finalization path. */

import { spawn } from '../../lib/childProcess.js';
import { normalizeVideoFailure } from '../../lib/videoFailure.js';
import { recordVideoExecutionDiagnostics } from './executionRecorder.js';
import { videoGenEvents } from './events.js';
import { broadcastSse, closeJobAfterDelay } from '../../lib/sseUtils.js';
import {
  finalizeGeneratedVideo,
  isWatchdogSuccess,
  isNativeTeardownAbort,
  verifyPostCompletionOutputs,
  describeSignalDeath,
} from './generateVideoHelpers.js';
import { BYOV_RUNTIME_INFO, runtimeUsesMlx, invalidateByovReadyCache, pickDeathFingerprint } from './runtimes.js';
import { isDisplaySleepEnabled, sleepDisplayForVideo, wakeDisplayForVideo } from './displayPower.js';
import { mutateVideoHistory } from './history.js';
import { spliceExtendSource } from './extendSplice.js';
import { videoJobState } from './jobState.js';
import { attachRenderChildProtocol } from './renderChildProtocol.js';

async function describeChildFailure({ code, signal, failure, model, job, batch }, { missingPyModule, stderrTail, batchResults }) {
  let reason;
  if (missingPyModule) {
    const runtimeInfo = BYOV_RUNTIME_INFO[model.runtime];
    if (runtimeInfo) {
      // The probe believed the venv was ready but a runtime import
      // disagreed — drop the cached "ready" so the next /runtime-status
      // re-probes and the install banner re-appears.
      invalidateByovReadyCache(runtimeInfo.id);
      reason = `Python module '${missingPyModule}' is missing from the ${runtimeInfo.label} runtime. Use Install / Repair in Video Gen's model setup panel.`;
    } else {
      reason = `Python module '${missingPyModule}' is missing. Install it into the configured Python environment and retry.`;
    }
  } else if (signal) {
    // Signal → actionable cause (SIGABRT = the macOS Metal command-buffer
    // watchdog only when stderr proves it, SIGBUS/SIGSEGV = a native MLX/Metal crash;
    // SIGKILL alone does not prove OOM),
    // stamped with the runtime fingerprint that died so the report is
    // self-documenting. See describeSignalDeath in generateVideoHelpers.js.
    reason = describeSignalDeath(signal, {
      fingerprint: await pickDeathFingerprint({ emitted: job.runtime, runtimeId: model.runtime }),
      stderr: stderrTail.join('\n'),
      mlxRuntime: runtimeUsesMlx(model.runtime),
    });
  } else {
    const diagnostic = failure?.summary || failure?.cause;
    reason = `Exit code ${code}${diagnostic ? `: ${diagnostic}` : ''}`;
  }
  return batch ? `${reason} (${batchResults.length}/${batch.length} videos saved to history)` : reason;
}

function preventRenderSleep(proc, { model, videoGenSettings }) {
  // Hold a sleep-prevention lock for the lifetime of the python child, so a
  // 90s+ render doesn't get aborted by sleep on a laptop. `-s` blocks system
  // sleep (lid-close / low-power), `-i` blocks idle sleep, `-d` blocks display
  // sleep — together they survive everything short of the user forcing sleep
  // from the Apple menu. `-w` makes caffeinate self-exit when our pid does, so
  // no manual cleanup is needed and a server crash mid-render still releases
  // the assertion. macOS-only — `caffeinate` is a darwin binary.
  const sleepDisplayForRender = runtimeUsesMlx(model.runtime) && isDisplaySleepEnabled(videoGenSettings);
  let displaySlept = false;
  if (process.platform === 'darwin' && proc.pid) {
    // MLX renders must keep the system awake but let the display sleep: `-d`
    // forces WindowServer to contend with Metal and can trigger the M5 GPU
    // watchdog. Other runtimes keep their existing display-awake behavior.
    const caffeineArgs = sleepDisplayForRender ? ['-is', '-w', String(proc.pid)] : ['-dis', '-w', String(proc.pid)];
    spawn('caffeinate', caffeineArgs, { stdio: 'ignore', detached: false }).on('error', () => {});
    displaySlept = sleepDisplayForRender && sleepDisplayForVideo(videoGenSettings, 'Video generation');
  }
  return () => {
    if (displaySlept) wakeDisplayForVideo(videoGenSettings, 'Video generation');
  };
}

async function finalizeSingleOutput({
  extendSplice, lipsyncAlign, outputPath, jobId, executionParent, meta, job, filename, actualSeed,
}, publications) {
  // Best-effort: a failed splice leaves the model's own output in place.
  if (extendSplice && (await spliceExtendSource({ ...extendSplice, outputPath })).applied) {
    meta.extendSourceOriginal = true;
  }
  if (lipsyncAlign) {
    const { alignLipsyncLead } = await import('../../lib/lipsyncAlign.js');
    meta.lipsyncAlign = await alignLipsyncLead({ videoPath: outputPath, label: jobId.slice(0, 8) });
    await recordVideoExecutionDiagnostics(jobId, { lipsyncAlign: meta.lipsyncAlign }, ...(executionParent ? [executionParent] : []))
      .catch(error => console.error(`❌ Lip-sync evidence persistence failed [${jobId.slice(0, 8)}]: ${error.message}`));
  }
  return finalizeGeneratedVideo({ job, jobId, outputPath, filename, meta, actualSeed, terminal: false, mutateHistory: mutateVideoHistory, publication: publications.get(outputPath) });
}

async function assessChildExit({ code, signal, childKilled }, { job, jobId, model, batch, outputPath, numFrames, meta }, protocol, expectedOutputPaths) {
  const allOutputsFinalized = !batch || protocol.batchResults.length === batch.length;
  const watchdogSuccess = allOutputsFinalized && isWatchdogSuccess({
    completionWatchdogFired: protocol.completionWatchdogFired, signal, outputPath,
  });
  if (code === 0 || watchdogSuccess) return { succeeded: true, watchdogSuccess };

  // A native teardown abort is recoverable only with this child's exact result
  // paths and fresh, probed media. A partial batch keeps its published members.
  if (!allOutputsFinalized || !isNativeTeardownAbort({ runtime: model.runtime, signal, childKilled })) {
    return { succeeded: false };
  }
  const verdict = await verifyPostCompletionOutputs({
    outputPaths: expectedOutputPaths, completedOutputs: protocol.completedOutputs,
    startedAtMs: job.renderStartedAtMs, expectedFrames: numFrames, fps: meta?.fps,
  });
  if (!verdict.ok) console.log(`⚠️ teardown abort stays a failure [${jobId.slice(0, 8)}]: ${verdict.reason}`);
  return { succeeded: verdict.ok, teardownRecovered: verdict.ok };
}

export function wireSpawnedChild(proc, takeEarlyExit, options, lifecycle) {
  const { job, jobId, meta, bin, batch, model, cleanupTempFiles, filename, actualSeed, preparation } = options;
  const { expectedOutputPaths, publications, discardFailedOutputs, retainOwnership, persistTermination,
    releaseHeavyClaim, cleanupStepwisePreview, cleanupFailedRender, cancelEpochAtStart, maybeRelaunchForMetalWatchdog, learnReactiveMetalProfile } = lifecycle;
  // The prompt-encode phase belongs to ONE child, but `job` outlives the
  // relaunch — reset it explicitly so a phase left open by the child that just
  // died can never be read as the replacement child's state.
  job.promptEncodePhase = null;
  job.speedProfile = null;
  job.streamingPolicy = null;
  const wakeDisplay = preventRenderSleep(proc, options);
  const protocol = attachRenderChildProtocol(proc, options, lifecycle);
  // Guards the ONE terminal run of this child's teardown, across BOTH terminal
  // paths ('error' and 'close'). The caller may have to replay a terminal
  // event this child emitted before it was wired, and that must not
  // double-release the accelerator claim, double-clean the temp files, or emit
  // two terminal events if the real event lands as well.
  let closeHandled = false;
  let childError;
  // Without an 'error' handler, a missing/non-executable pythonPath would
  // crash the server with an unhandled error event. Named (rather than an
  // inline arrow) so the caller can replay an 'error' this child emitted
  // before it was wired.
  const handleChildError = (err) => {
    if (closeHandled) return;
    // A failed signal/transport operation can emit error for a live child.
    // Keep ownership until close, rather than interpreting it as spawn failure.
    if (proc.pid && proc.exitCode == null && proc.signalCode == null) {
      childError = err;
      return;
    }
    closeHandled = true;
    protocol.clearCompletionWatchdog();
    job.status = 'error';
    const reason = `Failed to spawn ${bin}: ${err.message}`;
    console.error(`❌ Video generation spawn error [${jobId.slice(0, 8)}]: ${reason}`);
    videoJobState.activeProcess = null;
    wakeDisplay();
    // Spawn failed, so proc.on('close') will never fire — clean up every
    // temp file we own here, including the multipart upload, otherwise
    // ENOENT/permission errors leak files in os.tmpdir().
    // Defensive cleanup includes audio passed directly without the route's
    // uploadedTempPaths tracking. Duplicate unlinks remain harmless.
    return cleanupFailedRender().then(async () => {
      await persistTermination(null, null, 'failed');
      broadcastSse(job, { type: 'error', error: reason });
      videoGenEvents.emit('failed', { generationId: jobId, error: reason, failure: normalizeVideoFailure(err, { prompts: [meta?.prompt, meta?.negativePrompt] }) });
      closeJobAfterDelay(videoJobState.jobs, jobId);
    }).catch(error => {
      retainOwnership();
      console.error(`❌ Video spawn cleanup failed [${jobId.slice(0, 8)}]: ${error.message}`);
    });
  };

  const { completedOutputs, diagnostics, batchResults, stderrTail } = protocol;
  const handleChildClose = async (code, signal) => {
    if (closeHandled) return;
    closeHandled = true;
    // Flush any final unterminated line each stream buffered (the JSON result,
    // a missing-module trace) BEFORE clearing the watchdogs, so a flush that
    // captures the result JSON and re-arms the completion watchdog is then
    // immediately cancelled by clearCompletionWatchdog() rather than firing a
    // stray SIGKILL during teardown.
    protocol.flush();
    // The relaunch window opens the instant the shared active process is cleared: until a
    // replacement child is tracked, cancel() has nothing to kill and silently
    // reports false. Snapshot the epoch at exactly that boundary so the
    // relaunch can observe a cancel it otherwise could not see — and so the
    // guard survives anyone later putting an await between the two.
    const cancelEpochAtClose = videoJobState.cancelEpoch;
    videoJobState.activeProcess = null;
    // One-shot relaunch for a Metal command-buffer watchdog abort (issue #4589). Decided here, ahead of
    // the claim release and the temp-file cleanup below, because a relaunch
    // has to keep both: it renders the SAME job off the SAME staged inputs and
    // must not surrender the GPU lane between the two children.
    if (await maybeRelaunchForMetalWatchdog({ code, signal, childKilled: proc.killed, cancelEpochAtClose, stderr: stderrTail.join('\n') })) return;
    // The child has exited, so its accelerator allocation is gone. Release
    // before emitting the terminal completion event: an extend chain starts its
    // next child from that event and must be able to acquire the machine claim.
    await releaseHeavyClaim();
    await cleanupStepwisePreview();
    // Wrap the whole teardown so a throw from finalizeGeneratedVideo (history
    // save, thumbnail, file move) can't leak as an unhandled rejection — on
    // Node ≥15 that kills the process AND strands the media job `running` with
    // no terminal SSE. The catch routes any failure through the job's error
    // finalizer so the client still gets a terminal 'failed' event.
    try {
      // Accepted batch members may still be at their history commit when the
      // child closes. Drain every finalizer before cleanup or a recorded child
      // error can enter the discard path; admission itself is not a mutex.
      await protocol.outputTail;
      // Cleanup the resized temp images if we made them. Track via flags rather
      // than a path-prefix check — tmpdir() can return a symlinked path
      // (macOS /var → /private/var) so startsWith() can silently miss.
      // Cleanup internally generated resize/reference files, route-staged
      // uploads, and direct-call audio through the same ownership-aware helper.
      await cleanupTempFiles({ includeUploads: true, includeUntrackedAudio: true });
      if (childError) throw childError;

      // A PortOS-fired completion-watchdog SIGKILL is a SUCCESS when the
      // output file is already on disk and non-empty: the render wrote its
      // result, but the child hung during teardown. A kill with no output on
      // disk still fails loudly below.
      if (protocol.batchError) throw protocol.batchError;
      const { succeeded, watchdogSuccess, teardownRecovered } = await assessChildExit(
        { code, signal, childKilled: proc.killed }, options, protocol, expectedOutputPaths,
      );
      if (!succeeded) {
        await discardFailedOutputs();
        job.status = 'error';
        const failure = diagnostics.failure({ prompts: [meta?.prompt, meta?.negativePrompt] });
        const reason = await describeChildFailure({ code, signal, failure, model, job, batch }, protocol);
        console.error(`❌ Video generation failed [${jobId.slice(0, 8)}]: ${reason}`);
        await persistTermination(code, signal, preparation?.wasCanceled() || videoJobState.cancelEpoch !== cancelEpochAtStart ? 'canceled' : 'failed');
        broadcastSse(job, { type: 'error', error: `Generation failed: ${reason}` });
        videoGenEvents.emit('failed', { generationId: jobId, error: reason, failure: protocol.missingPyModule ? normalizeVideoFailure(reason) : failure, ...(batch ? { results: batchResults } : {}) });
      } else {
        if (watchdogSuccess) {
          console.log(`⚠️ video child force-killed (completion teardown hang) — output is intact [${jobId.slice(0, 8)}]`);
        }
        if (teardownRecovered) {
          // One concise, scrubbed warning: names the fault and nothing about
          // this machine or where the file lives. The completion event below
          // is the only terminal event this job emits.
          const message = `The renderer aborted during native teardown after finishing — the verified video was kept (${signal})`;
          console.log(`⚠️ ${message} [${jobId.slice(0, 8)}]`);
          broadcastSse(job, { type: 'status', message });
          videoGenEvents.emit('status', { generationId: jobId, message });
        }
        let thumbnail;
        if (batch) {
          if (batchResults.length !== batch.length) throw new Error(`Video batch stopped after ${batchResults.length}/${batch.length} outputs.`);
        } else {
          thumbnail = await finalizeSingleOutput(options, publications);
        }
        await learnReactiveMetalProfile({ proc, code, signal, cancelEpochAtClose, completedOutputs });
        // Complete only after learning settles, so a completion listener's
        // next matching render can observe the successful policy.
        job.status = 'complete';
        await persistTermination(code, signal, 'completed');
        const result = batch ? { ...batchResults[0], results: batchResults }
          : { filename, seed: actualSeed, thumbnail, path: `/data/videos/${filename}` };
        broadcastSse(job, { type: 'complete', result });
        videoGenEvents.emit('completed', batch ? { generationId: jobId, ...result }
          : { generationId: jobId, filename, path: result.path, thumbnail });
      }
    } catch (err) {
      await discardFailedOutputs();
      if (err !== childError) retainOwnership();
      // Finalize/teardown threw — fail the job loudly instead of crashing the
      // process. The job may already be partway through finalize, so force the
      // error state and emit the terminal event the client is waiting on.
      job.status = 'error';
      await persistTermination(code, signal, preparation?.wasCanceled() || videoJobState.cancelEpoch !== cancelEpochAtStart ? 'canceled' : 'failed');
      console.error(`❌ Video close handler failed [${jobId.slice(0, 8)}]: ${err.message}`);
      broadcastSse(job, { type: 'error', error: `Generation failed: ${err.message}` });
      videoGenEvents.emit('failed', { generationId: jobId, error: err.message, failure: normalizeVideoFailure(err, { prompts: [meta?.prompt, meta?.negativePrompt] }), ...(batch ? { results: batchResults } : {}) });
    } finally {
      // A prompt-encode relaunch returns before this finalizer, deliberately
      // leaving the display asleep while its replacement owns the GPU.
      wakeDisplay();
      closeJobAfterDelay(videoJobState.jobs, jobId);
    }
  };
  // Both real subscriptions land here, at the very end. Nothing in this
  // function awaits, so no event can fire before them — and a throw anywhere
  // above (a stream handle that vanished) therefore leaves the child with NO
  // real listeners, so the caller's exit buffer stays its only sink instead of
  // a half-wired handler reporting the job twice.
  proc.on('error', handleChildError);
  proc.on('close', handleChildClose);

  // Take the buffer in the same tick as listener attachment. The caller must
  // mark the child owned before replaying its captured output and terminal event.
  const earlyExit = takeEarlyExit()
    || (proc.exitCode !== null || proc.signalCode !== null
      ? { type: 'close', code: proc.exitCode, signal: proc.signalCode }
      : null);
  const replayEarlyExit = async () => {
    if (!earlyExit) return;
    for (const { stream, chunk } of earlyExit.output || []) proc[stream].emit('data', chunk);
    console.log(`⚠️ video render child exited before it was wired [${jobId.slice(0, 8)}]`);
    if (earlyExit.type === 'error') await handleChildError(earlyExit.error);
    else if (earlyExit.type === 'close') await handleChildClose(earlyExit.code, earlyExit.signal);
  };
  return replayEarlyExit;
}
