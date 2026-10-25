import { refuseRetiredTraining, withRetiredDataAccess, acquireRetiredDataAccess } from '../../lib/retiredLoraTraining.js';
/**
 * Retired trainer recovery only: observe/cancel a verified detached survivor,
 * finalize its output and keep historical records/checkpoint promotion readable.
 * New launch, resume and queue admission are permanently refused.
 */

import { spawn } from '../../lib/childProcess.js';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { platform } from 'os';
import { PATHS, ensureDir, shortId, copyFileGuarded, writeFileGuarded, rmGuarded } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';

import { reattachDetached, isReattachable } from '../../lib/detachedSpawn.js';
import { killWithEscalation } from '../../lib/killWithEscalation.js';
import { getImageModels } from '../../lib/mediaModels.js';

import { getSettings } from '../settings.js';
import { deleteLora, writeLoraSidecar } from '../loras.js';
import { getJob, mediaJobEvents } from '../mediaJobQueue/index.js';
import { updateDataset } from '../loraDatasets.js';
import { trainingEvents } from './events.js';
import { sleepDisplayForTraining, wakeDisplay } from './displayPower.js';

import { makeTrainingLineHandler } from './progress.js';
import { makeStallDetector } from './stallDetector.js';

import { claimHeavyLocalJob, adoptHeavyLocalJob } from '../../lib/heavyJobClaim.js';
import { classifyTrainingFailure } from './failure.js';
import { buildTrainedSidecar, trainedLoraFilename } from './sidecar.js';

import { listRunCheckpoints, listRunSamples, resolveCheckpointAdapterBuffer, selectDeployableCheckpoint } from './checkpoints.js';
import * as runsDb from './db.js';

export { listRuns, getRun, getRunRequired, deleteRun } from './db.js';
export { trainingEvents } from './events.js';

export const runDir = (runId) => join(PATHS.trainingRuns, runId);
export const runSamplesDir = (runId) => join(runDir(runId), 'samples');

// GPU lane serializes training with renders, so at most one trainer child
// exists at a time. Keyed by jobId anyway so a stale cancel can't kill a
// newer run.
let activeProcess = null;
let activeJobId = null;
const explicitlyCanceledTrainers = new WeakSet();

// Recovery still observes a surviving trainer for stalls.
const STALL_TICK_MS = 30_000;

export const cancel = (jobId) => {
  if (!activeProcess || (jobId && activeJobId !== jobId)) return false;
  const proc = activeProcess;
  explicitlyCanceledTrainers.add(proc);
  // Keep activeProcess set until 'close' clears it — the trainer may spend
  // a few seconds writing its cancel checkpoint. Escalate after 8s.
  killWithEscalation(proc, { label: 'training child', stillRunning: () => activeProcess === proc });
  return true;
};

export async function startTrainingRun() { refuseRetiredTraining(); }

export async function resumeTrainingRun() { refuseRetiredTraining(); }

const emitFailed = (jobId, error) => trainingEvents.emit('failed', { generationId: jobId, error });

// Collapse checkpoint records to one per `step`, preserving first-seen order
// (last value wins for a given step). Keeps run.artifacts.checkpoints unique
// when a #1332 re-attach replays already-persisted checkpoint lines.
const dedupeCheckpointsByStep = (checkpoints) => {
  const byStep = new Map();
  for (const c of checkpoints) byStep.set(c?.step, c);
  return [...byStep.values()];
};

const flipDatasetAfterRun = (run, { trained, loraFilename = null }) => {
  const datasetId = run?.datasetId;
  if (!datasetId) return Promise.resolve();
  // A run owns the dataset's training state only while the dataset still
  // points at the run's character. The dataset can be reassigned to a
  // different character mid-run (patchDataset resets it to draft); flipping
  // it here would otherwise mark the NEW character trained with the OLD
  // character's adapter, or clobber a fresh run's 'training' status. Skip the
  // flip when the dataset has moved on. Match on the full (universeId,
  // entryId) key the dataset store uses — a different universe can reuse the
  // same entryId, so entryId alone would falsely re-own a moved dataset.
  // Pre-reassignment runs predate the `character` snapshot guarantee, so a
  // missing entryId falls through (flip).
  const runEntryId = run?.character?.entryId || null;
  const runUniverseId = run?.character?.universeId || null;
  const runEntryKind = run?.character?.entryKind || 'characters';
  return updateDataset(datasetId, (current) => {
    const mismatch = runEntryId && (
      current.character?.entryId !== runEntryId
      || (runUniverseId && current.character?.universeId !== runUniverseId)
      || ((current.character?.entryKind || 'characters') !== runEntryKind)
    );
    if (mismatch) return null;
    return {
      ...current,
      status: trained ? 'trained' : 'draft',
      training: {
        ...current.training,
        ...(trained ? { loraFilename, completedAt: new Date().toISOString() } : {}),
      },
    };
  });
};

// When a trained LoRA artifact is deleted (DELETE /runs/:id?deleteLora=true),
// reset the owning dataset back to the untrained baseline so the training list
// stops advertising the subject as trained against a now-deleted file. Reset
// ONLY when the dataset still points at THIS run's adapter: same character
// (reuses flipDatasetAfterRun's ownership guard) AND the dataset's current
// `training.loraFilename` is exactly the file being deleted. A dataset that was
// retrained (different loraFilename) or reassigned to another character must
// keep its current state.
export const clearDatasetForDeletedLora = (run, deletedFilename) => {
  const datasetId = run?.datasetId;
  if (!datasetId || !deletedFilename) return Promise.resolve();
  const runEntryId = run?.character?.entryId || null;
  const runUniverseId = run?.character?.universeId || null;
  const runEntryKind = run?.character?.entryKind || 'characters';
  return updateDataset(datasetId, (current) => {
    const mismatch = runEntryId && (
      current.character?.entryId !== runEntryId
      || (runUniverseId && current.character?.universeId !== runUniverseId)
      || ((current.character?.entryKind || 'characters') !== runEntryKind)
    );
    if (mismatch || current.training?.loraFilename !== deletedFilename) return null;
    return { ...current, status: 'draft', training: {} };
  }).catch((err) => console.error(`❌ dataset reset after LoRA delete failed: ${err?.message}`));
};

/**
 * Delete a terminal run: its artifact dir, optionally its trained LoRA (and the
 * dataset's trained flag naming it), then the row. One backup admission spans
 * every step, so a snapshot never dumps a row naming samples or an adapter its
 * own file pass skipped (#9982).
 */
export async function deleteTrainingRun(runId, { withLora = false } = {}) {
  return withBackupAssetPublication(async () => {
    const run = await runsDb.getRunRequired(runId);
    if (['queued', 'running'].includes(run.status)) {
      throw new ServerError('Cancel the run before deleting it', { status: 409, code: 'RUN_ACTIVE' });
    }
    // Artifact dir is server-derived from the run id (uuid) — confined under
    // PATHS.trainingRuns by construction.
    await rmGuarded(runDir(run.id), { recursive: true, force: true });
    const loraFilename = run.output?.loraFilename;
    if (withLora && loraFilename) {
      await deleteLora(loraFilename).catch((err) => {
        console.warn(`⚠️ trained LoRA delete skipped: ${err?.message}`);
      });
      // Reset the owning dataset off 'trained' so it can't keep advertising the
      // subject as trained against the file just deleted.
      await clearDatasetForDeletedLora(run, loraFilename);
    }
    return runsDb.deleteRun(run.id);
  });
}

/**
 * Queue-worker entry — `mediaJobQueue.runJob` calls this for kind
 * 'training'. Resolves the trainer binary + args, spawns, parses the line
 * protocol into trainingEvents, and finalizes (LoRA registration or
 * failure classification) on close. Terminal status flows through the
 * queue's dispatcher; this function resolves once the observer attaches
 * (the queue awaits the terminal event separately).
 */
export async function runTraining({ jobId, runId, reattach = false, recoveryPermit = null }) {
  const fail = (message) => {
    console.error(`❌ training [${shortId(jobId)}] ${message}`);
    emitFailed(jobId, message);
  };

  const run = await runsDb.getRun(runId);
  if (!run) return fail(`run record missing: ${runId}`);
  const settings = await getSettings();
  const dir = runDir(runId);
  let heavyClaim = null;
  const retainOwnership = () => {
    maintenance.markCurrentUnsettled();
    maintenance.markResourceUnsettled('media', jobId);
  };
  let claimRelease;
  const releaseClaim = () => claimRelease ||= Promise.resolve().then(() => heavyClaim?.release()).catch(err => {
    retainOwnership();
    console.error(`❌ training [${shortId(jobId)}] claim release failed: ${err.message}`);
  });

  // Terminal failure BEFORE the child spawns: flip the run record to failed
  // AND release the dataset's `training` status, then emit the failed event.
  // Every pre-spawn exit funnels through here so none can leave the run row
  // stuck `running` (lingering until the next boot reconcile) or the dataset
  // stuck on its `training` chip.
  const failBeforeSpawn = async (message) => {
    await releaseClaim();
    await runsDb.updateRun(runId, {
      status: 'failed', error: message, completedAt: new Date().toISOString(),
    }).catch(retainOwnership);
    await flipDatasetAfterRun(run, { trained: false }).catch(retainOwnership);
    return fail(message);
  };

  // Recovery attaches only to a trainer that already exists. The queue restores a run whose detached trainer
  // SURVIVED a hard server restart with `reattach: true`. The child reparented
  // to init and is still training (or finished during the downtime), so we tail
  // its existing control-dir output instead of spawning a second trainer — no
  // staging, no validation, no fresh spawn. wireProcLifecycle then drives the
  // exact same line-handling/finalize path as a normal spawn, so a run that
  // completed mid-restart still registers its LoRA instead of being discarded.
  //
  // The survivor already
  // holds the machine-wide accelerator claim from before the restart (handed
  // off to its PID pre-crash), so acquiring a NEW claim here would see that
  // live claim as a competing job and refuse it — failing every restart-
  // survived run outright. Adopt the existing claim instead of contending for
  // a fresh one.
  if (reattach) {
    const proc = await reattachDetached(join(dir, '.detached'));
    if (!proc) {
      // The survivor died (killed mid-run) with no RESULT to recover — fail the
      // run; its latest checkpoint stays retained for inspection, same as the
      // pre-#1332 reap path would have left it.
      return failBeforeSpawn('Trainer did not survive the restart — marking failed; artifacts are preserved.');
    }
    heavyClaim = (await adoptHeavyLocalJob({ kind: 'LoRA training', id: jobId, pid: proc.pid }))
      || (await claimHeavyLocalJob({ kind: 'LoRA training', id: jobId }));
    if (!heavyClaim.ok) return failBeforeSpawn(heavyClaim.message);
    // Only true on the claimHeavyLocalJob fallback (no matching on-disk claim
    // survived) — adoptHeavyLocalJob only ever returns a claim already
    // recorded against this exact pid.
    if (heavyClaim.holder?.pid !== proc.pid) await heavyClaim.handoffTo?.(proc.pid);
    console.log(`🔁 training [${shortId(jobId)}] re-attached to surviving trainer pid ${proc.pid} (run ${shortId(runId)})`);
    trainingEvents.emit('status', { generationId: jobId, message: 'Re-attached to trainer that survived a restart' });
    wireProcLifecycle(proc, { isReattach: true });
    return { observing: true };
  }

  refuseRetiredTraining();

  function wireProcLifecycle(proc, { isReattach = false } = {}) {
  const releaseDataAccess = acquireRetiredDataAccess();
  activeProcess = proc;
  activeJobId = jobId;
  void heavyClaim?.handoffTo?.(proc.pid)?.catch((err) => console.error(`❌ training [${shortId(jobId)}] claim handoff failed: ${err.message}`));

  // Keep the Mac awake for the duration of the training child (idle + system
  // sleep held off) — but DELIBERATELY let the *display* sleep. An active
  // display makes WindowServer contend for the GPU, which triggers the watchdog
  // kernel panic during heavy training (mlx #3267; see the incident doc). The
  // flags are `-is`, NOT `-dis`: `-d` would force the display awake and is what
  // was crashing the box. We then proactively sleep the display below so the
  // protection doesn't wait on the OS idle timeout. Best-effort — caffeinate
  // exits with the child.
  if (platform() === 'darwin' && proc.pid) {
    const caf = spawn('caffeinate', ['-is', '-w', String(proc.pid)], { stdio: 'ignore' });
    caf.on('error', () => {});
    caf.unref();
  }
  // Sleep the display now (Apple Silicon, opt-out via settings.loraTraining
  // .displaySleep) so sustained GPU training never competes with the display.
  // The close handler wakes it when the run finishes. Gated on proc.pid (like
  // the caffeinate spawn above) so a failed launch that emits 'error' without a
  // 'close' never sleeps a display nothing will wake. Re-sleeping a still-running
  // run on reattach is harmless (pmset displaysleepnow is idempotent).
  if (proc.pid) sleepDisplayForTraining(settings);

  // Debounced run-record progress mirror (~2s). Per-step DB writes from a
  // hot loop are the high-frequency-write anti-pattern; SSE is the live
  // channel, the row is the durable snapshot.
  let progressDirty = null;
  let progressTimer = null;
  // Persist whatever progress/artifacts are pending. Returns the write promise
  // so the close handler can AWAIT a final flush before finalize reads the run
  // record — otherwise the final checkpoint + last sample (which the collapse
  // guard and previewImageUrl both read from run.artifacts) can still be in the
  // debounce buffer, not on disk.
  const flushProgress = () => {
    if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
    if (!progressDirty) return Promise.resolve();
    const flushing = progressDirty;
    progressDirty = null;
    // The trainer writes sample and checkpoint files in place before announcing
    // them, so only the row that first names them takes backup admission
    // (#9982); a progress-only flush never waits out a cut.
    const namesArtifacts = !!(flushing.checkpoints || flushing.samples);
    const write = () => runsDb.updateRun(runId, (current) => ({
      ...current,
      progress: { ...current.progress, ...flushing.progress },
      artifacts: {
        ...current.artifacts,
        // Dedupe on merge: a #1332 re-attach replays the survivor's whole log
        // from offset 0, re-firing onCheckpoint/onSample for artifacts already
        // persisted before the restart. Key checkpoints by step and samples by
        // filename (both unique) so a replay can't double-list them — last write
        // wins, which is identical for a true replay.
        ...(flushing.checkpoints ? { checkpoints: dedupeCheckpointsByStep([...current.artifacts.checkpoints, ...flushing.checkpoints]) } : {}),
        ...(flushing.samples ? { samples: [...new Set([...current.artifacts.samples, ...flushing.samples])] } : {}),
      },
    }));
    return (namesArtifacts ? withBackupAssetPublication(write) : write()).then(() => {
      if (namesArtifacts) trainingEvents.emit('checkpoints:changed', { runId });
    }).catch((err) => console.error(`❌ training [${shortId(jobId)}] progress persist failed: ${err?.message}`));
  };
  // Checkpoints/samples accumulate as arrays so two that land in one debounce
  // window (common in the final post-exit scan) both survive — a single-value
  // patch would let the later one clobber the earlier.
  const scheduleProgressPersist = (patch) => {
    progressDirty = progressDirty || {};
    if (patch.progress) progressDirty.progress = { ...progressDirty.progress, ...patch.progress };
    if (patch.checkpoint) (progressDirty.checkpoints ||= []).push(patch.checkpoint);
    if (patch.sample) (progressDirty.samples ||= []).push(patch.sample);
    if (progressTimer) return;
    progressTimer = setTimeout(() => { flushProgress(); }, 2000);
    progressTimer.unref?.();
  };

  const { handleLine, getState } = makeTrainingLineHandler({
    jobId,
    totalSteps: run.params.steps,
    emit: (event, payload) => {
      trainingEvents.emit(event, payload);
      if (event === 'progress' && typeof payload.step === 'number') {
        scheduleProgressPersist({ progress: { step: payload.step, totalSteps: payload.totalSteps } });
      }
    },
    onCheckpoint: (path, step, loss) => scheduleProgressPersist({
      checkpoint: { step, path: basename(path), loss: Number.isFinite(loss) ? loss : null },
      progress: { lastCheckpointStep: step },
    }),
    onSample: (path) => scheduleProgressPersist({ sample: basename(path) }),
    sampleUrl: (path) => `/api/lora-training/runs/${runId}/samples/${basename(path)}`,
  });

  // Phase-aware soft-hang stall watchdog (issue #1330). The queue's flat 30-min
  // idle watchdog only trips on TOTAL silence and can't see a soft GPU hang
  // mid-training (the python heartbeat/telemetry threads keep emitting lines, so
  // the flat watchdog never fires). This detector keys off the STAGE/STEP
  // protocol to apply a tight, step-rate-derived budget ONLY during
  // STAGE:training — load/encode/sampling/cooldown stay on the flat watchdog so
  // a legitimately slow phase is never false-killed. On a training-phase stall
  // we stop the wedged child and retain its newest checkpoint. Disable via settings.loraTraining.stallWatchdog = false.
  const stallWatchdogOn = (settings?.loraTraining?.stallWatchdog !== false);
  const stallDetector = makeStallDetector();
  let stallKilled = false; // set when the tick SIGKILLs — close handler reads it
  let stallTimer = null;
  const stopStallWatchdog = () => { if (stallTimer) { clearInterval(stallTimer); stallTimer = null; } };
  // The stall detector derives its budget from WALL-CLOCK gaps between STEP
  // lines. On a #1332 re-attach the survivor's whole log is replayed from
  // offset 0 in a few ms, so feeding those historical steps would record
  // ~0ms intervals and instantly exit the 20-min warmup into the tight floor —
  // false-killing a healthy slow-step run on its next live step. So on a
  // re-attach we withhold step observation until the tailer's one-time
  // 'replayed' signal (initial backlog drained); the detector then warms up
  // fresh on genuinely-live output, exactly as a fresh spawn would.
  let stallObserveLive = !isReattach;
  if (isReattach) proc.on('replayed', () => { stallObserveLive = true; });

  const makeSplitter = (stream) => {
    let buf = '';
    const safeLine = (text) => {
      // try/catch: this runs inside a child-process data/end callback — an
      // uncaught throw here would crash the server process.
      try {
        handleLine(text, stream);
        if (stallWatchdogOn && stallObserveLive) stallDetector.observe(text);
      } catch (err) {
        console.error(`❌ training [${shortId(jobId)}] line handler failed: ${err?.message}`);
      }
    };
    return {
      push: (chunk) => {
        buf += chunk.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          safeLine(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
        }
      },
      // Flush any trailing line that arrived without a final newline. The
      // trainers hard-exit via os._exit (teardown-hang defense), which can
      // truncate the pipe before the final `RESULT:{...}\n` newline flushes
      // — without this drain that line (the run's only success signal) is lost.
      flush: () => { if (buf) { safeLine(buf); buf = ''; } },
    };
  };
  const stdoutSplitter = makeSplitter('stdout');
  const stderrSplitter = makeSplitter('stderr');
  proc.stdout.on('data', stdoutSplitter.push);
  proc.stdout.on('end', stdoutSplitter.flush);
  proc.stderr.on('data', stderrSplitter.push);
  proc.stderr.on('end', stderrSplitter.flush);

  if (stallWatchdogOn) {
    stallTimer = setInterval(() => {
      // setInterval callback — runs outside the request lifecycle, so guard
      // against any throw (a crash here would take down the server process).
      try {
        if (stallKilled || activeProcess !== proc) return;
        const { stalled, idleMs, budgetMs } = stallDetector.checkStall();
        if (!stalled) return;
        stallKilled = true;
        stopStallWatchdog();
        console.log(`⏱️ training [${shortId(jobId)}] phase-aware watchdog: training stalled ${Math.round(idleMs / 1000)}s (budget ${Math.round(budgetMs / 1000)}s) — stopping stalled trainer; checkpoints preserved`);
        // Soft hang: SIGKILL straight away (SIGTERM relies on the GIL the hang
        // holds, so the 8s escalation in cancel() would just waste the window).
        // Direct PID kill through the already-owned detached handle.
        proc.kill('SIGKILL');
      } catch (err) {
        console.error(`❌ training [${shortId(jobId)}] stall watchdog tick failed: ${err?.message}`);
      }
    }, STALL_TICK_MS);
    stallTimer.unref?.();
  }

  let terminalStarted = false;
  let processError;
  proc.on('error', (err) => {
    if (terminalStarted) return;
    processError = err;
    // Detached handles can report failed signals while their trainer is live.
    // Preserve its cancel handle and claim until physical close.
    if (proc.pid) return;
    terminalStarted = true;
    stopStallWatchdog();
    if (activeProcess === proc) { activeProcess = null; activeJobId = null; }
    // A no-PID launch failure owns no running trainer.
    wakeDisplay(settings);
    // A launch failure after the run was marked `running` — a genuine spawn
    // error, including a detached observer losing its control directory.
    // Route through the same terminal cleanup as pre-spawn failures so the run
    // row doesn't stay stuck `running` and the dataset's `training` chip is
    // released; `fail()` alone only logs + emits. Async + guarded since this
    // runs outside the request lifecycle.
    Promise.resolve(failBeforeSpawn(`trainer spawn failed: ${err.message}`))
      .catch((e) => {
        retainOwnership();
        console.error(`❌ training [${shortId(jobId)}] failure cleanup failed: ${e?.message}`);
      });
  });

  proc.on('close', (code, signal) => {
    if (terminalStarted) return;
    terminalStarted = true;
    stopStallWatchdog();
    if (activeProcess === proc) { activeProcess = null; activeJobId = null; }
    // Flush the debounced progress (final checkpoint + last sample) BEFORE
    // finalize reads the run record — the collapse guard and previewImageUrl
    // both read run.artifacts. Async finalize wrapped so a rejection can't
    // escape the event handler (unhandled rejection kills the process on Node ≥15).
    // The trainer has exited; release its accelerator claim before finalizing.
    const settle = async () => {
      await releaseClaim();
      await flushProgress();
      if (processError) return failBeforeSpawn(`trainer process failed: ${processError.message}`);
      return finalizeTraining({ jobId, runId, code, signal, state: getState(), stallKilled, canceledByOperator: explicitlyCanceledTrainers.has(proc) });
    };
    const terminalWork = recoveryPermit ? recoveryPermit.run(settle) : settle();
    terminalWork
      .then(async () => { wakeDisplay(settings); await recoveryPermit?.finish(); })
      .catch((err) => {
        retainOwnership();
        // A finalize/flush rejection is still a terminal end with no auto-resume
        // enqueued, so wake the display here too — otherwise this error path
        // would leave it asleep (no .then ran). No-op unless we slept it.
        wakeDisplay(settings);
        console.error(`❌ training [${shortId(jobId)}] finalize failed: ${err?.message}`);
        fail(`finalize failed: ${err?.message}`);
      }).finally(releaseDataAccess);
  });
  } // end wireProcLifecycle
}

async function finalizeTraining({ jobId, runId, code, signal, state, stallKilled = false, canceledByOperator = false }) {
  const run = await runsDb.getRun(runId);
  const job = getJob(jobId);
  const canceled = !!job?.cancelRequested || canceledByOperator;

  // Run record vanished mid-training (direct DB edit / race — the DELETE
  // route blocks active runs, so this is defensive). Don't register a LoRA
  // with no run to anchor its sidecar lineage — that would leave an orphan
  // .safetensors in data/loras/. Just settle the job terminally.
  if (!run) {
    const msg = canceled ? 'Canceled' : `Run record vanished during finalize (exit ${code})`;
    console.error(`❌ training [${shortId(jobId)}] ${msg}`);
    trainingEvents.emit('failed', { generationId: jobId, error: msg });
    return;
  }

  if (code === 0 && state.result?.adapter_path) {
    const finalStep = Number.isInteger(state.result.steps) ? state.result.steps : (run.progress?.step ?? null);
    // Collapse guard: deploy the final adapter unless its preview diverged
    // (near-black/uniform), in which case fall back to the latest healthy
    // checkpoint. Loss is NOT used to pick — it was anti-correlated with
    // quality on the divergence run that motivated this (see checkpoints.js).
    const selection = await selectDeployableCheckpoint(run, state.result.adapter_path, finalStep);
    const filename = trainedLoraFilename({
      name: run?.name, characterName: run?.character?.name, runId,
    });
    // One backup admission from the adapter write through the run row and the
    // dataset flag that name it (#9982). The completion event fires after the
    // lease, so the queue's own admitted commit never borrows this one.
    const { sizeBytes } = await withBackupAssetPublication(async () => {
      const registered = await registerTrainedLora({
        run,
        buffer: selection.buffer,
        filename,
        result: state.result,
        previewImageUrl: selection.previewUrl,
        selectedStep: selection.step,
        autoSelected: selection.autoSelected,
      });
      await runsDb.updateRun(runId, {
        status: 'completed',
        completedAt: new Date().toISOString(),
        output: {
          loraFilename: filename,
          finalLoss: Number.isFinite(state.result.final_loss) ? state.result.final_loss : null,
          selectedCheckpointStep: selection.step,
          autoSelectedCheckpoint: selection.autoSelected,
        },
      });
      await flipDatasetAfterRun(run, { trained: true, loraFilename: filename });
      return registered;
    });
    if (selection.autoSelected) console.log(`⚠️ training [${shortId(jobId)}] ${selection.reason} (size ${sizeBytes ?? '?'}B)`);
    console.log(`✅ training [${shortId(jobId)}] complete — registered ${filename} @ step ${selection.step}`);
    trainingEvents.emit('completed', {
      generationId: jobId, runId, loraFilename: filename, filename,
    });
    return;
  }

  if (canceled) {
    // Queue's cancelRequested flips the failed event into a clean cancel;
    // record keeps the checkpoint lineage for inspection or explicit promotion.
    await runsDb.updateRun(runId, { status: 'canceled', completedAt: new Date().toISOString(), error: 'Canceled' });
    await flipDatasetAfterRun(run, { trained: false });
    trainingEvents.emit('failed', { generationId: jobId, error: 'Canceled' });
    return;
  }

  if (code === 0) {
    // Exited cleanly but emitted no parseable RESULT: line (success with a
    // result was handled above) — the trainer finished without producing an
    // adapter. Report the trainer's own USER_ERROR if it surfaced one,
    // otherwise a clear message instead of the confusing "exited with code 0".
    const message = state.userError?.message
      || 'Trainer exited cleanly but produced no adapter — check the dataset and run logs';
    await runsDb.updateRun(runId, {
      status: 'failed', completedAt: new Date().toISOString(),
      error: message, errorCode: state.userError?.kind || 'NO_RESULT',
    });
    await flipDatasetAfterRun(run, { trained: false });
    console.error(`❌ training [${shortId(jobId)}] no-result: ${message}`);
    trainingEvents.emit('failed', { generationId: jobId, error: message });
    return;
  }

  const { code: failCode, message, repo: failRepo = null } = classifyTrainingFailure({
    stderrTail: state.stderrTail, exitCode: code, signal, userError: state.userError,
  });
  await runsDb.updateRun(runId, {
    status: 'failed', completedAt: new Date().toISOString(), error: message, errorCode: failCode,
    // Gated-repo deep-link target for the UI banner (HF_AUTH only); null otherwise.
    errorRepo: failRepo,
  });
  await flipDatasetAfterRun(run, { trained: false });
  console.error(`❌ training [${shortId(jobId)}] ${failCode}: ${message}`);
  trainingEvents.emit('failed', { generationId: jobId, error: message, code: failCode, repo: failRepo });

}

/**
 * Write an adapter Buffer into data/loras/ as the registered trained LoRA and
 * emit its sidecar. Shared by finalize (collapse-guarded final) and manual
 * checkpoint promotion — both deploy a chosen adapter under one filename, so
 * promoting overwrites in place and the LoRA's identity in the picker is
 * stable across re-promotes.
 */
async function registerTrainedLora({
  run, buffer, filename, result = {}, previewImageUrl = null, selectedStep = null, autoSelected = false,
}) {
  await ensureDir(PATHS.loras);
  const dest = join(PATHS.loras, filename);
  await writeFileGuarded(dest, buffer);
  const sizeBytes = buffer.length; // bytes written === on-disk size; no stat round-trip
  const sidecar = buildTrainedSidecar({
    run, result, filename, previewImageUrl, sizeBytes, selectedStep, autoSelected,
  });
  await writeLoraSidecar(filename, sidecar);
  return { sizeBytes, sidecar };
}

/** Listable checkpoints (step, loss, preview, deployed flag) for a run. */
export async function listCheckpoints(runId) {
  const run = await runsDb.getRunRequired(runId);
  return { runId, runtime: run.runtime, checkpoints: listRunCheckpoints(run) };
}

/** Mid-training sample previews (step + url) for the live progress gallery. */
export async function listSamples(runId) {
  const run = await runsDb.getRunRequired(runId);
  return { runId, samples: listRunSamples(run) };
}

/**
 * Manually promote a checkpoint to be the deployed LoRA. Re-extracts that
 * checkpoint's adapter, registers it under the run's existing LoRA filename
 * (in place), and records the selected step on the run. Lets the user pick by
 * eye when the collapse guard's near-black veto wasn't enough (subtler
 * degradation — see the loss-is-misleading note in checkpoints.js).
 */
export async function promoteCheckpoint(runId, step) {
  return withRetiredDataAccess(() => promoteRetainedCheckpoint(runId, step));
}

async function promoteRetainedCheckpoint(runId, step) {
  const run = await runsDb.getRunRequired(runId);
  // Allow completed runs AND failed/canceled runs that saved at least one
  // checkpoint — promoting a partial checkpoint is a deliberate salvage (the
  // human clicks "Use this" on a specific preview), the same explicit intent
  // the completed-run picker relies on. Only an in-flight run is blocked: its
  // checkpoints are still moving, so "deploy this one" is ambiguous.
  if (['queued', 'running'].includes(run.status)) {
    throw new ServerError('Cancel the run before promoting a checkpoint', {
      status: 409, code: 'RUN_ACTIVE',
    });
  }
  const listed = listRunCheckpoints(run);
  const target = listed.find((c) => c.step === step);
  if (!target) {
    throw new ServerError(`No checkpoint at step ${step} for run ${runId}`, {
      status: 404, code: 'CHECKPOINT_NOT_FOUND',
    });
  }
  const buffer = await resolveCheckpointAdapterBuffer(run, step);
  const filename = run.output?.loraFilename
    || trainedLoraFilename({ name: run.name, characterName: run.character?.name, runId });
  // Keep trainedSteps pointing at the run's final step so the sidecar can note
  // "checkpoint @ step N" whenever the promoted step isn't the final one.
  const finalStep = Math.max(0, ...listed.map((c) => c.step), run.progress?.step || 0) || null;
  // Promotion replaces the deployed adapter in place, so the new bytes, the run
  // row and the dataset flag publish under one backup admission (#9982).
  await withBackupAssetPublication(async () => {
    await registerTrainedLora({
      run,
      buffer,
      filename,
      result: { steps: finalStep, final_loss: target.loss },
      previewImageUrl: target.previewUrl,
      selectedStep: step,
      autoSelected: false,
    });
    await runsDb.updateRun(runId, (current) => ({
      ...current,
      output: {
        ...current.output,
        loraFilename: filename,
        selectedCheckpointStep: step,
        autoSelectedCheckpoint: false,
      },
    }));
    await flipDatasetAfterRun(run, { trained: true, loraFilename: filename });
  });
  trainingEvents.emit('checkpoints:changed', { runId });
  console.log(`📌 training [${shortId(runId)}] promoted checkpoint step ${step} → ${filename}`);
  // If the promoted checkpoint had no preview (its step didn't land on the
  // sampleEvery cadence — most often the final step, e.g. 1188 with sampleEvery
  // 300), render one in the BACKGROUND from the just-registered LoRA so the
  // deployed card isn't blank. Fire-and-forget: promote stays snappy, and a
  // render failure (OOM, missing venv, server restart) must never fail the
  // promote — the LoRA is already deployed; the thumbnail is cosmetic.
  if (!target.previewUrl) {
    withRetiredDataAccess(() => ensureCheckpointPreview(run, step, filename)).catch((err) => {
      console.error(`⚠️ training [${shortId(runId)}] preview render for step ${step} failed: ${err?.message}`);
    });
  }
  return { loraFilename: filename, step };
}

// mflux preview filename for a step (matches stepFromSampleName's mflux regex in
// checkpoints.js, so listRunCheckpoints joins it to the checkpoint by step).
const previewSampleName = (step) => `${String(step).padStart(7, '0')}_preview_image_preview_1.png`;

/**
 * Render a neutral-prompt preview for a promoted checkpoint that has none, in the
 * background, and attach it to the run so the deployed-checkpoint card shows a
 * thumbnail. Best-effort by contract: every failure path logs and returns without
 * throwing (the caller already deployed the LoRA; this is purely cosmetic).
 *
 * Renders at the SAME neutral prompt + seed + dims the trainer uses for its
 * periodic samples (so it's visually comparable to the 600/900 thumbnails), via
 * the registered LoRA on its own 9b/4b base. Uses generateImage (writes into the
 * gallery dir + sidecar) then copies the PNG into the run's samples dir under the
 * step-joined name; the gallery copy is harmless and lets the user find it too.
 */
async function ensureCheckpointPreview(run, step, loraFilename) {
  const runId = run.id;
  const samplesDir = runSamplesDir(runId);
  const dest = join(samplesDir, previewSampleName(step));
  if (existsSync(dest)) return; // already has one (race / re-promote)

  // Resolve the inference model for this LoRA's variant. The registered base is
  // flux2-klein-<variant>; fall back to the run's baseModelId.
  const variant = run.fluxVariant || null;
  const models = getImageModels();
  const modelId = (variant && models.find((m) => m.id === `flux2-klein-${variant}`)?.id)
    || (models.find((m) => m.id === run.baseModelId)?.id)
    || run.baseModelId;
  if (!modelId) { console.error(`⚠️ training [${shortId(runId)}] no inference model for preview`); return; }

  const settings = await getSettings();
  const pythonPath = settings?.imageGen?.local?.pythonPath || null;
  const prompt = run.params?.samplePrompt || `${run.triggerWord} portrait, neutral background`;
  const seed = Number.isInteger(run.params?.seed) ? run.params.seed : 42;
  const res = run.params?.resolution || 768;

  const { generateImage } = await import('../imageGen/local.js');
  console.log(`🖼️ training [${shortId(runId)}] rendering preview for promoted step ${step} (${modelId})`);
  const result = await generateImage({
    pythonPath,
    prompt,
    modelId,
    width: res,
    height: res,
    steps: 20,
    seed,
    loraFilenames: [loraFilename],
    loraScales: [1.0],
    jobId: `lora-preview-${runId}-${step}`,
  });
  // generateImage writes PATHS.images/<filename> (filename = `${jobId}.png`).
  const renderedPath = join(PATHS.images, result?.filename || `lora-preview-${runId}-${step}.png`);
  if (!existsSync(renderedPath)) { console.error(`⚠️ training [${shortId(runId)}] preview render produced no file`); return; }

  // The copy and the row naming it are one backup-admitted publication (#9982);
  // the render above stays outside the lease.
  await withBackupAssetPublication(async () => {
    await ensureDir(samplesDir);
    await copyFileGuarded(renderedPath, dest);
    // Join is by step, sourced from artifacts.samples — append so listRunCheckpoints
    // picks it up. updateRun's function form merges against the freshest record.
    await runsDb.updateRun(runId, (current) => {
      const samples = current.artifacts?.samples || [];
      const name = previewSampleName(step);
      if (samples.includes(name)) return current;
      return { ...current, artifacts: { ...current.artifacts, samples: [...samples, name] } };
    });
  });
  trainingEvents.emit('checkpoint-preview', { generationId: run.jobId || runId, runId, step });
  trainingEvents.emit('checkpoints:changed', { runId });
  console.log(`🖼️ training [${shortId(runId)}] preview attached for step ${step}`);
}

/**
 * Boot probe used by the media-job queue's reconcile (#1332): does run `runId`
 * have a detached trainer worth re-attaching to (still alive, or finished but
 * its RESULT line never consumed) under its control dir? Lets the queue decide,
 * for a training job that was `running` at restart, whether to re-enqueue it for
 * re-attach or fail it — without the queue needing to know the run's on-disk
 * layout. Resolves false (never throws) when there's nothing to re-attach to.
 *
 * @param {string} runId
 * @returns {Promise<boolean>}
 */
export function hasSurvivingTrainer(runId) {
  if (!runId) return Promise.resolve(false);
  return isReattachable(join(runDir(runId), '.detached')).catch(() => false);
}

/**
 * Boot reconcile + terminal-state mirror. Called from server/index.js after
 * initMediaJobQueue(). Any run persisted as queued/running whose job isn't
 * live in the queue is marked failed (the queue does the same for its own
 * interrupted jobs — this keeps the two stores agreeing). Also subscribes
 * to mediaJobEvents so a queue-side cancel (user hits cancel while QUEUED,
 * which never reaches runTraining) still lands in the run record.
 *
 * A run whose detached trainer SURVIVED the restart is already re-enqueued for
 * re-attach by initMediaJobQueue (#1332) — its job is back in the queue as
 * queued/running, so the `!job || terminal` guard below skips it and the reap
 * path only touches runs that genuinely died.
 */
/** Postgres never accepted the session: missing database or no listener. */
const loraDatabaseUnreachable = (err) => {
  const code = err?.code;
  if (code === '3D000' || code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT') return true;
  return /database ".+" does not exist/i.test(String(err?.message ?? ''));
};

export async function initLoraTraining() {
  const active = await runsDb.listActiveRuns().catch((err) => {
    // Unreachable database is a skip (hermetic smoke, Postgres down). A query
    // that reached the database and then failed is a reconcile failure.
    if (loraDatabaseUnreachable(err)) {
      console.warn(`⚠️ loraTraining boot reconcile skipped: ${err?.message}`);
      return [];
    }
    console.error(`❌ loraTraining boot reconcile failed: ${err?.message}`);
    return [];
  });
  for (const run of active) {
    const job = run.jobId ? getJob(run.jobId) : null;
    if (!job || ['failed', 'canceled', 'completed'].includes(job.status)) {
      // Upgrade never kills an orphan trainer. Keep its artifacts pinned until
      // the existing process finishes or the operator explicitly cancels it.
      if (await hasSurvivingTrainer(run.id)) {
        const jobId = run.jobId || run.id;
        const recoveryPermit = maintenance.recoverOwned('media', jobId);
        const observer = await recoveryPermit.run(() => runTraining({ jobId, runId: run.id, reattach: true, recoveryPermit }));
        if (!observer?.observing) await recoveryPermit.finish();
        console.log(`🔁 Observing retired trainer ${shortId(run.id)} without restarting it`);
        continue;
      }
      await runsDb.updateRun(run.id, {
        status: job?.status === 'canceled' ? 'canceled' : 'failed', error: 'LoRA training retired; artifacts preserved', completedAt: new Date().toISOString(),
      }).catch(() => {});
      await flipDatasetAfterRun(run, { trained: false });
      console.log(`🧹 training run ${shortId(run.id)} retired; artifacts preserved`);
    }
  }

  // Queued-job cancels never reach runTraining, so mirror them here.
  mediaJobEvents.on('canceled', (job) => {
    if (job?.kind !== 'training' || !job?.params?.runId) return;
    runsDb.getRun(job.params.runId).then((run) => {
      if (!run || ['completed', 'failed', 'canceled'].includes(run.status)) return null;
      return runsDb.updateRun(run.id, {
        status: 'canceled', completedAt: new Date().toISOString(), error: job.error || 'Canceled',
      }).then(() => flipDatasetAfterRun(run, { trained: false }));
    }).catch((err) => console.error(`❌ training cancel mirror failed: ${err?.message}`));
  });
  console.log('🏋️ loraTraining initialized');
}
