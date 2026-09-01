/** Render-child spawning, supervision, retry, and terminal finalization. */

import { spawn } from '../../lib/childProcess.js';
import { watch as fsWatch } from 'fs';
import { rm, readFile } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '../../lib/fileUtils.js';
import { spawnDetached } from '../../lib/detachedSpawn.js';
import { createLineReader } from '../../lib/streamLines.js';
import { claimHeavyLocalJob } from '../../lib/heavyJobClaim.js';
import { prepareLocalMemory, gpuBlockersMessage } from '../localMemory.js';
import { ServerError } from '../../lib/errorHandler.js';
import { videoGenEvents } from './events.js';
import {
  broadcastSse, closeJobAfterDelay, PYTHON_NOISE_RE,
} from '../../lib/sseUtils.js';
import { hfChildEnv } from '../hfToken.js';
import { safeChildProcessEnv } from '../../lib/processEnv.js';
import {
  makeVideoGenLineHandler,
  finalizeGeneratedVideo,
  isWatchdogSuccess,
  describeSignalDeath,
  planPromptEncodingRetry,
  bufferChildExit,
} from './generateVideoHelpers.js';
import {
  BYOV_RUNTIME_INFO,
  runtimeIsCacheOnly,
  runtimeNeedsProcessGroupKill,
  runtimeUsesMlx,
  invalidateByovReadyCache,
  pickDeathFingerprint,
} from './runtimes.js';
import { sleepDisplay, wakeDisplay } from '../displayPower.js';
import { loadHistory, mutateVideoHistory } from './history.js';
import { estimateRenderMs } from './eta.js';
import { videoJobState } from './jobState.js';

const MODULE_NOT_FOUND_RE = /ModuleNotFoundError: No module named ['"]([^'"]+)['"]/;
const STDERR_TAIL_LINES = 40;

const COMPLETION_WATCHDOG_GRACE_MS = (() => {
  const raw = parseInt(process.env.VIDEOGEN_COMPLETION_WATCHDOG_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 40000;
})();

const MUXING_DONE_RE = /\[Decoding video \+ audio \+ muxing\]\s+done in/i;

export async function spawnAndWatchVideo({
  jobId,
  speedProfileId = null,
  cleanupTempFiles,
  stepwiseDir,
  job,
  bin,
  args,
  outputPath,
  filename,
  meta,
  actualSeed,
  model,
  modelId,
  width: w,
  height: h,
  numFrames: parsedNumFrames,
  steps: actualSteps,
  videoGenSettings,
}) {
  const heavyClaim = await claimHeavyLocalJob({ kind: 'local video generation', id: jobId });
  if (!heavyClaim.ok) {
    videoJobState.jobs.delete(jobId);
    await cleanupTempFiles({ includeUploads: true });
    await rm(stepwiseDir, { recursive: true, force: true });
    throw new ServerError(heavyClaim.message, { status: 409, code: 'HEAVY_LOCAL_JOB_BUSY', context: { holder: heavyClaim.holder } });
  }
  const releaseHeavyClaim = () => heavyClaim.release()
    .catch((err) => console.error(`❌ Video generation claim release [${jobId.slice(0, 8)}]: ${err.message}`));
  // The first render child. Named apart from the `proc` each wireRenderChild()
  // call binds, so a relaunch cannot be confused with the original.
  let firstProc;
  // Reads (and detaches) whatever terminal event the first child emitted before
  // its real listeners were attached. Set the instant the spawn resolves.
  let takeEarlyExit = null;
  // Prompt-encode relaunches already spent on this job. Exactly one is allowed:
  // a second watchdog abort at the reduced budget is a real failure the user has
  // to see, not something to keep grinding the GPU over.
  let promptEncodingRetriesUsed = 0;
  // Hoisted out of the try so a relaunch can respawn with the SAME child env
  // plus a lowered Gemma budget, instead of rebuilding it from scratch.
  let childEnv;

  // Runners publish one atomically-replaced `preview.png`. Keep the reader
  // serialized because fs.watch can report several events for one replacement;
  // a pending flag collapses those events to the newest available frame.
  let previewWatcher = null;
  let previewReading = false;
  let previewPending = false;
  let previewClosed = false;
  const cleanupStepwisePreview = () => {
    if (previewClosed) return;
    previewClosed = true;
    if (previewWatcher) {
      try { previewWatcher.close(); } catch { /* already closed */ }
      previewWatcher = null;
    }
    void rm(stepwiseDir, { recursive: true, force: true });
  };
  const processLatestPreview = async () => {
    if (previewClosed) return;
    if (previewReading) {
      previewPending = true;
      return;
    }
    previewReading = true;
    try {
      const framePath = join(stepwiseDir, 'preview.png');
      const currentImage = (await readFile(framePath)).toString('base64');
      if (videoJobState.jobs.get(jobId) === job && job.status === 'running') {
        job.currentImage = currentImage;
        videoGenEvents.emit('progress', { generationId: jobId, currentImage });
      }
    } catch (err) {
      // A replacement can race a read, and cancel/close removes the directory;
      // both are ordinary teardown races rather than render failures.
      if (!previewClosed) console.log(`⚠️ Video preview read skipped [${jobId.slice(0, 8)}]: ${err.message}`);
    }
    previewReading = false;
    if (previewPending) {
      previewPending = false;
      void processLatestPreview();
    }
  };
  try {
    previewWatcher = fsWatch(stepwiseDir, (event) => {
      if (event === 'rename' || event === 'change') void processLatestPreview();
    });
  } catch { /* preview is best-effort; the final video remains authoritative */ }

  // ── one render child, fully wired ──────────────────────────────────────────
  // Everything per-CHILD lives in here — the process handle, the completion watchdog, the
  // line readers, the close handler — so the same job can be relaunched once
  // without minting a new one. Everything job-level (jobId, args, seed, meta,
  // history entry, heavy claim, staged temp files) is closed over and survives
  // the relaunch. The only thing that relaunches a render is a Metal
  // command-buffer watchdog abort inside the Gemma prompt encoder; see
  // maybeRelaunchForPromptEncoding below.
  const wireRenderChild = (proc) => {
    // The prompt-encode phase belongs to ONE child, but `job` outlives the
    // relaunch — reset it explicitly so a phase left open by the child that just
    // died can never be read as the replacement child's state.
    job.promptEncodePhase = null;
    // Panel-side completion watchdog. Armed once we see the render's completion
    // marker on stdout; SIGKILLs the child if it hasn't exited after the grace
    // window. clearCompletionWatchdog() runs in every terminal path ('close',
    // 'error') so the timer can't outlive this child or fire against a recycled
    // PID. Armed at most once per child (re-seeing the marker is a no-op).
    let completionWatchdog = null;
    // Set when the watchdog itself fires the SIGKILL. The 'close' handler reads
    // it so it can treat that kill as success (the render already wrote its file —
    // we only killed a post-completion teardown hang) rather than reporting the
    // generic "killed, likely OOM" failure.
    let completionWatchdogFired = false;
    const clearCompletionWatchdog = () => {
      if (completionWatchdog) {
        clearTimeout(completionWatchdog);
        completionWatchdog = null;
      }
    };
    const armCompletionWatchdog = () => {
      if (completionWatchdog) return;
      completionWatchdog = setTimeout(() => {
        // Runs outside the Express request lifecycle — an uncaught throw here
        // would crash the Node process, so guard the whole body.
        try {
          completionWatchdog = null;
          // proc.killed covers a manual-cancel SIGTERM that hasn't reached close
          // yet (killWithEscalation sets it before exitCode/signalCode populate).
          if (videoJobState.activeProcess !== proc || proc.killed || proc.exitCode !== null || proc.signalCode !== null) return;
          console.log(`⚠️ video child reported completion but never exited — SIGKILL [${jobId.slice(0, 8)}]`);
          completionWatchdogFired = true;
          proc.kill('SIGKILL');
        } catch (err) {
          console.error(`❌ completion watchdog failed [${jobId.slice(0, 8)}]: ${err.message}`);
        }
      }, COMPLETION_WATCHDOG_GRACE_MS);
      // Don't let the watchdog timer keep the event loop alive on its own.
      if (typeof completionWatchdog.unref === 'function') completionWatchdog.unref();
    };

    // Hold a sleep-prevention lock for the lifetime of the python child, so a
    // 90s+ render doesn't get aborted by sleep on a laptop. `-s` blocks system
    // sleep (lid-close / low-power), `-i` blocks idle sleep, `-d` blocks display
    // sleep — together they survive everything short of the user forcing sleep
    // from the Apple menu. `-w` makes caffeinate self-exit when our pid does, so
    // no manual cleanup is needed and a server crash mid-render still releases
    // the assertion. macOS-only — `caffeinate` is a darwin binary.
    const sleepDisplayForRender = runtimeUsesMlx(model.runtime) && videoGenSettings?.displaySleep !== false;
    let displaySlept = false;
    if (process.platform === 'darwin' && proc.pid) {
      // MLX renders must keep the system awake but let the display sleep: `-d`
      // forces WindowServer to contend with Metal and can trigger the M5 GPU
      // watchdog. Other runtimes keep their existing display-awake behavior.
      const caffeineArgs = sleepDisplayForRender ? ['-is', '-w', String(proc.pid)] : ['-dis', '-w', String(proc.pid)];
      spawn('caffeinate', caffeineArgs, { stdio: 'ignore', detached: false }).on('error', () => {});
      displaySlept = sleepDisplayForRender && sleepDisplay(videoGenSettings, 'Video generation');
    }
    // Guards the ONE terminal run of this child's teardown, across BOTH terminal
    // paths ('error' and 'close'). The caller may have to replay a terminal
    // event this child emitted before it was wired, and that must not
    // double-release the accelerator claim, double-clean the temp files, or emit
    // two terminal events if the real event lands as well.
    let closeHandled = false;
    // Without an 'error' handler, a missing/non-executable pythonPath would
    // crash the server with an unhandled error event. Named (rather than an
    // inline arrow) so the caller can replay an 'error' this child emitted
    // before it was wired.
    const handleChildError = (err) => {
      if (closeHandled) return;
      closeHandled = true;
      clearCompletionWatchdog();
      job.status = 'error';
      const reason = `Failed to spawn ${bin}: ${err.message}`;
      console.log(`❌ Video generation spawn error [${jobId.slice(0, 8)}]: ${reason}`);
      broadcastSse(job, { type: 'error', error: reason });
      videoGenEvents.emit('failed', { generationId: jobId, error: reason });
      videoJobState.activeProcess = null;
      if (displaySlept) wakeDisplay(videoGenSettings, 'Video generation');
      void releaseHeavyClaim();
      // Spawn failed, so proc.on('close') will never fire — clean up every
      // temp file we own here, including the multipart upload, otherwise
      // ENOENT/permission errors leak files in os.tmpdir().
      // Defensive cleanup includes audio passed directly without the route's
      // uploadedTempPaths tracking. Duplicate unlinks remain harmless.
      void cleanupTempFiles({ includeUploads: true, includeUntrackedAudio: true });
      cleanupStepwisePreview();
      closeJobAfterDelay(videoJobState.jobs, jobId);
    };

    let missingPyModule = null;
    // Rolling tail of this child's stderr. The Metal abort text is the only
    // evidence of WHY the watchdog fired and it is not a protocol line, so
    // nothing else on the path retains it. Bounded so a chatty runtime cannot
    // grow it without limit; the abort banner is the last thing printed before
    // the process dies, so the tail always holds it.
    const stderrTail = [];
    const recordStderrTail = (raw) => {
      stderrTail.push(raw);
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
    };

    // The python child's STATUS:/STAGE:/DOWNLOAD:/tqdm → SSE-frame parser lives
    // in generateVideoHelpers.js so it can be unit-tested without a real child.
    // Returns true for a recognized progress/status/noise line (suppress raw
    // logging), false for an unhandled line worth raw-logging.
    const handleLine = makeVideoGenLineHandler({ job, jobId, pythonNoiseRe: PYTHON_NOISE_RE });

    // Per-stream line readers carry the partial trailing line across chunk
    // boundaries and decode through a StringDecoder, so a marker (or multibyte
    // char) split across a pipe chunk can't tear an event — and the final
    // unterminated line is emitted on 'close' via flush().
    const stdoutReader = createLineReader((raw) => {
      const line = raw.trim();
      if (!line) return;
      // mlx_video emits one JSON line on stdout when finished — capture it
      // for the result metadata; otherwise raw-log so we can debug failures.
      try {
        const parsed = JSON.parse(line);
        if (parsed.video_path) {
          job.resultJson = parsed;
          // The result JSON is the strongest "work is done" signal — arm the
          // watchdog so a post-completion teardown hang can't wedge the job.
          armCompletionWatchdog();
        }
        return;
      } catch { /* not JSON */ }
      // Some runtimes don't print the result JSON but do log the final
      // decode+mux line right before they should exit — treat it the same way.
      if (MUXING_DONE_RE.test(line)) armCompletionWatchdog();
      console.log(`🐍-out [${jobId.slice(0, 8)}] ${line}`);
    });
    const stderrReader = createLineReader((raw) => {
      recordStderrTail(raw);
      // Record the root-cause module only — downstream imports in the same
      // traceback raise the same error against later names.
      if (!missingPyModule) {
        const m = raw.match(MODULE_NOT_FOUND_RE);
        if (m) missingPyModule = m[1];
      }
      if (!handleLine(raw)) console.log(`🐍 [${jobId.slice(0, 8)}] ${raw.trim()}`);
    }, { splitRe: /[\n\r]+/ });

    proc.stdout.on('data', (chunk) => {
      stdoutReader.push(chunk);
    });

    proc.stderr.on('data', (chunk) => {
      stderrReader.push(chunk);
    });

    const handleChildClose = async (code, signal) => {
      if (closeHandled) return;
      closeHandled = true;
      // Flush any final unterminated line each stream buffered (the JSON result,
      // a missing-module trace) BEFORE clearing the watchdogs, so a flush that
      // captures the result JSON and re-arms the completion watchdog is then
      // immediately cancelled by clearCompletionWatchdog() rather than firing a
      // stray SIGKILL during teardown.
      stdoutReader.flush();
      stderrReader.flush();
      clearCompletionWatchdog();
      // The relaunch window opens the instant the shared active process is cleared: until a
      // replacement child is tracked, cancel() has nothing to kill and silently
      // reports false. Snapshot the epoch at exactly that boundary so the
      // relaunch can observe a cancel it otherwise could not see — and so the
      // guard survives anyone later putting an await between the two.
      const cancelEpochAtClose = videoJobState.cancelEpoch;
      videoJobState.activeProcess = null;
      // One-shot relaunch for a Metal command-buffer watchdog abort that landed
      // INSIDE the Gemma prompt encoder (issue #4589). Decided here, ahead of
      // the claim release and the temp-file cleanup below, because a relaunch
      // has to keep both: it renders the SAME job off the SAME staged inputs and
      // must not surrender the GPU lane between the two children.
      if (await maybeRelaunchForPromptEncoding({ code, signal, childKilled: proc.killed, cancelEpochAtClose, stderr: stderrTail.join('\n') })) return;
      // The child has exited, so its accelerator allocation is gone. Release
      // before emitting the terminal completion event: an extend chain starts its
      // next child from that event and must be able to acquire the machine claim.
      await releaseHeavyClaim();
      cleanupStepwisePreview();
      // Wrap the whole teardown so a throw from finalizeGeneratedVideo (history
      // save, thumbnail, file move) can't leak as an unhandled rejection — on
      // Node ≥15 that kills the process AND strands the media job `running` with
      // no terminal SSE. The catch routes any failure through the job's error
      // finalizer so the client still gets a terminal 'failed' event.
      try {
        // Cleanup the resized temp images if we made them. Track via flags rather
        // than a path-prefix check — tmpdir() can return a symlinked path
        // (macOS /var → /private/var) so startsWith() can silently miss.
        // Cleanup internally generated resize/reference files, route-staged
        // uploads, and direct-call audio through the same ownership-aware helper.
        await cleanupTempFiles({ includeUploads: true, includeUntrackedAudio: true });

        // A PortOS-fired completion-watchdog SIGKILL is a SUCCESS when the
        // output file is already on disk and non-empty: the render wrote its
        // result, but the child hung during teardown. A kill with no output on
        // disk still fails loudly below.
        const watchdogSuccess = isWatchdogSuccess({ completionWatchdogFired, signal, outputPath });

        if (code !== 0 && !watchdogSuccess) {
          job.status = 'error';
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
            // watchdog, SIGBUS/SIGSEGV = a native MLX/Metal crash, SIGKILL = OOM),
            // stamped with the runtime fingerprint that died so the report is
            // self-documenting. See describeSignalDeath in generateVideoHelpers.js.
            reason = describeSignalDeath(signal, {
              fingerprint: await pickDeathFingerprint({ emitted: job.runtime, runtimeId: model.runtime }),
            });
          } else {
            reason = `Exit code ${code}`;
          }
          console.log(`❌ Video generation failed [${jobId.slice(0, 8)}]: ${reason}`);
          broadcastSse(job, { type: 'error', error: `Generation failed: ${reason}` });
          videoGenEvents.emit('failed', { generationId: jobId, error: reason });
        } else {
          if (watchdogSuccess) {
            console.log(`⚠️ video child force-killed (completion teardown hang) — output is intact [${jobId.slice(0, 8)}]`);
          }
          await finalizeGeneratedVideo({ job, jobId, outputPath, filename, meta, actualSeed, mutateHistory: mutateVideoHistory });
        }
      } catch (err) {
        // Finalize/teardown threw — fail the job loudly instead of crashing the
        // process. The job may already be partway through finalize, so force the
        // error state and emit the terminal event the client is waiting on.
        job.status = 'error';
        console.error(`❌ Video close handler failed [${jobId.slice(0, 8)}]: ${err.message}`);
        broadcastSse(job, { type: 'error', error: `Generation failed: ${err.message}` });
        videoGenEvents.emit('failed', { generationId: jobId, error: err.message });
      } finally {
        // A prompt-encode relaunch returns before this finalizer, deliberately
        // leaving the display asleep while its replacement owns the GPU.
        if (displaySlept) wakeDisplay(videoGenSettings, 'Video generation');
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
    return { handleChildClose, handleChildError };
  };

  // Wire a freshly spawned render child and return the replay for whatever
  // terminal event the exit buffer caught while the claim handoff was in flight.
  // `takeEarlyExit` is read in the SAME tick the real listeners go on — no await
  // between — or the gap the buffer exists to close reopens.
  //
  // The replay is separated from the wiring so a caller can mark the child
  // OWNED before awaiting it: the replay runs the full teardown, and a child
  // that already owns the job must never be mistaken for an abandoned one by
  // the failure path that would otherwise kill it.
  const wireSpawnedChild = (proc, takeEarlyExit) => {
    // Wire first, then read the buffer: wireRenderChild() never awaits, so
    // nothing can fire between the two — and if it throws, the buffer is still
    // attached and keeps absorbing this child's events while the caller kills
    // it. The buffer is the primary catch; reading the corpse's exit state is
    // the backstop for a handle that recorded its exit without emitting.
    const { handleChildClose, handleChildError } = wireRenderChild(proc);
    const earlyExit = takeEarlyExit()
      || (proc.exitCode !== null || proc.signalCode !== null
        ? { type: 'close', code: proc.exitCode, signal: proc.signalCode }
        : null);
    const replayEarlyExit = async () => {
      if (!earlyExit) return;
      console.log(`⚠️ video render child exited before it was wired [${jobId.slice(0, 8)}]`);
      if (earlyExit.type === 'error') handleChildError(earlyExit.error);
      else await handleChildClose(earlyExit.code, earlyExit.signal);
    };
    return replayEarlyExit;
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

  // Stop a render child that was spawned but will never be wired up — the first
  // child when its claim handoff threw, or a replacement canceled mid-relaunch /
  // abandoned because a later setup step threw. It has no real close handler by
  // then, so nothing else would ever reap it.
  // Tolerant of a null handle (the spawn itself threw) and of a kill that throws
  // on an already-dead PID, because this runs on the failure path of a failure
  // path and must not replace the real error with its own.
  const stopAbandonedChild = (child) => {
    if (!child) return;
    try {
      child.kill('SIGTERM');
    } catch (err) {
      console.error(`❌ abandoned video render child would not stop [${jobId.slice(0, 8)}]: ${err.message}`);
    }
  };

  // Relaunch this render once when the macOS Metal command-buffer watchdog
  // aborted the child while the Gemma prompt encoder was running, with a lowered
  // prompt-encode budget so each encoder command buffer finishes inside the
  // watchdog window. Returns true when a replacement child owns the job (the
  // caller must then leave the failure path alone), false when the render should
  // fail normally.
  //
  // Everything the render is defined by — jobId, seed, output path, history
  // metadata, staged source images/audio — is closed over and reused verbatim, so
  // the relaunch is the same render at a smaller prompt budget, not a new job.
  // Deliberately NOT gated on a runtime allowlist: the phase markers the decision
  // reads are emitted by scripts/generate_ltx2.py alone, so every other runtime is
  // excluded by construction rather than by a list that could drift.
  const maybeRelaunchForPromptEncoding = async ({ code, signal, childKilled, cancelEpochAtClose, stderr }) => {
    if (code === 0) return false;
    // A child PortOS killed on purpose — a user cancel, or either watchdog — is
    // never a spontaneous Metal abort to recover from, whatever signal it
    // finally landed on. Without this a cancel that raced an in-flight abort
    // would be answered by relaunching the render the user just stopped.
    if (childKilled) return false;
    const plan = planPromptEncodingRetry({
      signal,
      stderr,
      promptEncodePhase: job.promptEncodePhase,
      retriesUsed: promptEncodingRetriesUsed,
      platform: process.platform,
    });
    if (!plan) return false;
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
      promptEncodingRetriesUsed += 1;
      const retryArgs = [...args, '--gemma-max-length', String(plan.gemmaMaxLength)];
      const message = `Metal watchdog aborted the prompt encoder — retrying once at ${plan.gemmaMaxLength} Gemma tokens`;
      console.log(`♻️ ${message} [${jobId.slice(0, 8)}]`);
      broadcastSse(job, { type: 'status', message });
      videoGenEvents.emit('status', { generationId: jobId, message });
      retryProc = await spawnDetached(bin, retryArgs, {
        env: childEnv,
        controlDir: join(PATHS.videos, '.detached', `${jobId}-retry`),
        cleanup: true,
        killProcessGroup: runtimeNeedsProcessGroupKill(model.runtime),
      });
      // Catch the replacement's terminal event in the same tick the spawn
      // resolved — the handoff below yields to the event loop, and a child that
      // dies in that window would otherwise emit into the void.
      const takeRetryEarlyExit = bufferChildExit(retryProc);
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

  // Every failure before this render child is wired converges here. Nothing
  // is listening yet, so the child can never report its own terminal event —
  // without this the job would sit `running` in the shared jobs map forever, holding
  // the accelerator claim and its staged temp files, exactly the way #4617's
  // lost 'close' did. Mirrors the buildArgs failure path above so every
  // pre-wiring failure looks the same to the client and to the media queue.
  const abandonBeforeWiring = async (err) => {
    stopAbandonedChild(firstProc);
    if (videoJobState.activeProcess === firstProc) videoJobState.activeProcess = null;
    await releaseHeavyClaim();
    job.status = 'error';
    const reason = err.message || 'Video generation failed before the render child was wired';
    console.log(`❌ Video generation setup error [${jobId.slice(0, 8)}]: ${reason}`);
    broadcastSse(job, { type: 'error', error: reason });
    videoGenEvents.emit('failed', { generationId: jobId, error: reason });
    void cleanupTempFiles({ includeUploads: true, includeUntrackedAudio: true });
    cleanupStepwisePreview();
    closeJobAfterDelay(videoJobState.jobs, jobId);
  };

  try {
    const memoryReport = await prepareLocalMemory();
    // Something else already owns the GPU (today: the vLLM Qwen container). Refuse
    // here rather than let the render die inside its model load with an OOM that
    // names neither the tenant nor the fix — the throw converges on
    // abandonBeforeWiring like every other pre-wiring failure.
    if (memoryReport.blockers.length) throw new Error(gpuBlockersMessage(memoryReport.blockers));
    if (memoryReport.unloaded.length) console.log(`🧹 Video generation [${jobId.slice(0, 8)}] freed ${memoryReport.unloaded.length} resident model(s)`);

    // History-calibrated wall-clock estimate (#3801). `null` when this install
    // has never measured a render on this model — an explicit "no estimate"
    // sentinel the UI must render as "unknown", never as 0 or a guess. Stamped
    // on the job so every progress frame can carry it alongside step progress.
    const etaEstimate = estimateRenderMs({
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
    job.renderStartedAtMs = Date.now();

    console.log(`🎬 Generating video [${jobId.slice(0, 8)}]: ${modelId} ${w}x${h} frames=${parsedNumFrames} steps=${actualSteps} eta=${etaEstimate ? `${Math.round(etaEstimate.etaMs / 1000)}s (${etaEstimate.basis}, n=${etaEstimate.sampleCount})` : 'unknown'}`);
    videoGenEvents.emit('started', { generationId: jobId, totalSteps: actualSteps, ...meta, ...etaFields });

    // Clear PYTHONPATH so the child uses the venv's own site-packages instead
    // of the parent shell's PYTHONPATH. Setting to `undefined` in a spread does
    // NOT unset the var — Node coerces it to the literal string "undefined" —
    // so build the env explicitly and `delete`.
    // Build the complete HF child env so BYOV Python helpers can authenticate
    // snapshot_download() against gated repos
    // (mirrors the imageGen child-spawn pattern). LTX-2 doesn't currently use
    // a gated repo, but the merge is harmless when no token is configured.
    childEnv = runtimeIsCacheOnly(model.runtime)
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
    // `spawnDetached` double-forks the render child so it reparents to init
    // (PPID=1) and leaves pm2's process tree — without this a `pm2 restart
    // portos-server` (e.g. on the memory ceiling) SIGINTs the in-flight render
    // mid-inference, since pm2's TreeKill walks PPIDs. (This child previously had
    // no detach at all, so it was fully exposed.) Output streams through on-disk
    // log files under `data/videos/.detached/<jobId>` that the server tails; we
    // still `proc.kill()` it directly by PID on cancel / watchdog. `cleanup: true`
    // lets the helper drop that scratch dir on every terminal path (close/error)
    // so it can't accumulate under data/videos.
    firstProc = await spawnDetached(bin, args, {
      env: childEnv,
      controlDir: join(PATHS.videos, '.detached', jobId),
      cleanup: true,
      killProcessGroup: runtimeNeedsProcessGroupKill(model.runtime),
    });
    // Subscribe in the SAME tick the spawn resolved, before anything below can
    // yield. spawnDetached defers its first emission to a setImmediate so a
    // caller that wires synchronously misses nothing — but the claim handoff
    // below awaits real file I/O, and a child that dies inside that window (a
    // venv that imports and aborts, an OOM kill, a launcher that never produced
    // a PID) emits into the void: a lost 'close' strands the job `running`
    // forever, still holding the accelerator claim, and a lost 'error' is worse
    // — an EventEmitter with no 'error' listener THROWS and takes the server
    // with it.
    takeEarlyExit = bufferChildExit(firstProc);
    videoJobState.activeProcess = firstProc;
    await heavyClaim.handoffTo?.(firstProc.pid);
  } catch (err) {
    await abandonBeforeWiring(err);
    throw err;
  }

  // Terminal listeners go on here, and the buffer hands over anything the child
  // already emitted — so a child that died during the handoff still drives the
  // job to a terminal state and gives the accelerator claim back.
  let replayEarlyExit;
  try {
    replayEarlyExit = wireSpawnedChild(firstProc, takeEarlyExit);
  } catch (err) {
    // Wiring itself threw (a stream handle that vanished under us), so this
    // child has no terminal handler and never will — the same dead end the
    // relaunch path guards with `retryWired`.
    await abandonBeforeWiring(err);
    throw err;
  }
  await replayEarlyExit();
}
