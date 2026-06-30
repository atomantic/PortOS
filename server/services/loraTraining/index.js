/**
 * LoRA training engine — run lifecycle + python trainer spawn.
 *
 * Routed through mediaJobQueue's GPU lane as `kind: 'training'` (training
 * shares the Metal/MLX runtime with renders, so serialization is correct).
 * The queue owns job status / SSE / watchdog / cancel escalation; this
 * module owns the run RECORD (PostgreSQL `lora_training_runs`), the child
 * process, artifact collection under `data/training-runs/<runId>/`, and
 * trained-LoRA registration into `data/loras/`.
 *
 * Spawn/cancel mirrors videoGen/local.js: SIGTERM → 8s SIGKILL escalation,
 * PYTHONUNBUFFERED, safeChildProcessEnv + hfTokenEnv, caffeinate on darwin.
 * The trainers checkpoint on SIGTERM, so a cancel keeps its progress.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { copyFile, writeFile } from 'fs/promises';
import { join, basename, dirname } from 'path';
import { platform } from 'os';
import { PATHS, ensureDir, atomicWrite, shortId } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { v4 as uuidv4 } from '../../lib/uuid.js';
import { hfTokenEnv } from '../../lib/hfToken.js';
import { safeChildProcessEnv } from '../../lib/processEnv.js';
import { spawnDetached, reapDetached, reattachDetached, isReattachable } from '../../lib/detachedSpawn.js';
import { getImageModels } from '../../lib/mediaModels.js';
import { resolveFlux2Python, isFlux2VenvHealthy } from '../../lib/pythonSetup.js';
import { getSettings } from '../settings.js';
import { enqueueJob, getJob, mediaJobEvents } from '../mediaJobQueue/index.js';
import { updateDataset } from '../loraDatasets.js';
import { trainingEvents } from './events.js';
import { sleepDisplayForTraining, wakeDisplay } from './displayPower.js';
import {
  TRAINING_DEFAULTS,
  TRAINING_RUNTIMES,
  buildFlux2TrainArgs,
  buildMfluxTrainArgs,
  buildMfluxTrainConfig,
  resolveTrainingRuntime,
  MFLUX_DEFAULT_COOLDOWN_SEC,
} from './runtimes.js';
import { makeTrainingLineHandler } from './progress.js';
import { makeStallDetector } from './stallDetector.js';
import { prepareMemoryForTraining, TRAINING_MIN_HEADROOM_GB } from './memoryPrep.js';
import { classifyTrainingFailure } from './failure.js';
import { buildTrainedSidecar, trainedLoraFilename } from './sidecar.js';
import { validateDatasetReady } from './dataset.js';
import {
  listRunCheckpoints,
  listRunSamples,
  resolveCheckpointAdapterBuffer,
  resolveLatestCheckpointArtifact,
  selectDeployableCheckpoint,
} from './checkpoints.js';
import * as runsDb from './db.js';

export { listRuns, getRun, getRunRequired, deleteRun } from './db.js';
export { trainingEvents } from './events.js';

const TRAINER_SCRIPTS = {
  [TRAINING_RUNTIMES.MFLUX]: join(PATHS.root, 'scripts', 'train_mflux_lora.py'),
  [TRAINING_RUNTIMES.FLUX2]: join(PATHS.root, 'scripts', 'train_flux2_lora.py'),
};

export const runDir = (runId) => join(PATHS.trainingRuns, runId);
export const runSamplesDir = (runId) => join(runDir(runId), 'samples');

/**
 * mflux ships its trainer as the `mflux-train` console script — probe for
 * it next to the configured local-image-gen python (e.g.
 * /opt/miniconda3/bin/python3 → /opt/miniconda3/bin/mflux-train). Present
 * only on mflux ≥0.17 installs.
 */
export const isMfluxTrainAvailable = (pythonPath) =>
  !!pythonPath && existsSync(join(dirname(pythonPath), 'mflux-train'));

// GPU lane serializes training with renders, so at most one trainer child
// exists at a time. Keyed by jobId anyway so a stale cancel can't kill a
// newer run.
let activeProcess = null;
let activeJobId = null;

// Phase-aware stall watchdog (issue #1330): how many times a single run may be
// auto-resumed after a *soft* GPU hang before we give up and let it stay failed.
// Bounded so a config that wedges every segment can't resume-loop forever — the
// user sees a failed run after N attempts and intervenes. Counted separately
// from manual resumes (run.resume.autoCount). Env-overridable.
const STALL_MAX_AUTO_RESUMES = (() => {
  const n = Number(process.env.LORA_TRAIN_STALL_MAX_AUTO_RESUMES);
  return Number.isFinite(n) && n >= 0 ? n : 2;
})();
// How often the watchdog polls checkStall while a trainer is running. Well
// under the 90s floor budget so a stall is caught within ~one tick of the
// budget elapsing (worst-case detection lag = budget + one tick).
const STALL_TICK_MS = 30_000;

export const cancel = (jobId) => {
  if (!activeProcess || (jobId && activeJobId !== jobId)) return false;
  const proc = activeProcess;
  proc.kill('SIGTERM');
  // Keep activeProcess set until 'close' clears it — the trainer may spend
  // a few seconds writing its cancel checkpoint. Escalate after 8s.
  setTimeout(() => {
    if (activeProcess === proc && proc.exitCode === null && proc.signalCode === null) {
      console.log('⚠️ training child ignored SIGTERM — escalating to SIGKILL');
      proc.kill('SIGKILL');
    }
  }, 8000).unref?.();
  return true;
};

/** Merge order: code defaults ← settings slice ← request params. */
const mergeParams = (settings, requestParams = {}) => ({
  ...TRAINING_DEFAULTS,
  ...(settings?.loraTraining?.defaults || {}),
  ...requestParams,
});

// A dataset belongs to a run only while it still points at the run's subject.
// Match the full (universeId, entryId) key the dataset store uses — a different
// universe can reuse the same entryId, so entryId alone would falsely re-own a
// reassigned dataset. (flipDatasetAfterRun keeps its own missing-entryId
// fallthrough for pre-reassignment runs that predate the character snapshot.)
const sameCharacter = (a, b) =>
  a?.entryId === b?.entryId
  && a?.universeId === b?.universeId
  && (a?.entryKind || 'characters') === (b?.entryKind || 'characters');

// Re-stamp a dataset as `training` with the run's new job/run ids, but only
// while it still owns the dataset — the dataset can be reassigned to a different
// character between validation and this stamp (patchDataset resets it to draft);
// stamping a moved dataset would strand it in `training` forever (flipDatasetAfterRun
// is character-guarded and would skip the un-flip). Used by both the fresh-launch
// and resume paths.
const stampDatasetTrainingStatus = (run, jobId) =>
  updateDataset(run.datasetId, (current) => {
    if (!sameCharacter(current.character, run.character)) return null;
    return {
      ...current,
      status: 'training',
      training: { ...current.training, lastJobId: jobId, lastRunId: run.id },
    };
  }).catch((err) => console.error(`❌ dataset training-status stamp failed: ${err?.message}`));

/**
 * Route-facing run launcher. Validates dataset readiness + runtime health,
 * creates the run record, and enqueues the training job. Returns
 * `{ runId, jobId, position }` (202-shaped).
 */
export async function startTrainingRun({
  datasetId, baseModelId, name = null, params = {}, acknowledgeCaptionLeak = false,
}) {
  const settings = await getSettings();
  const pythonPath = settings?.imageGen?.local?.pythonPath || null;
  // Engine pick: prefer mflux's MLX trainer when the user's mflux install
  // ships it (Apple Silicon native, no second venv); fall back to the
  // torch/diffusers trainer in venv-flux2.
  const mlxAvailable = isMfluxTrainAvailable(pythonPath);
  const routing = resolveTrainingRuntime(baseModelId, getImageModels(), { mlxAvailable });
  const { dataset } = await validateDatasetReady(datasetId, { acknowledgeCaptionLeak });

  if (routing.runtime === TRAINING_RUNTIMES.FLUX2) {
    const healthy = await isFlux2VenvHealthy();
    if (!healthy) {
      throw new ServerError(
        'No training engine available — install mflux ≥0.17 in your local image-gen python (Settings → Image Gen) '
        + 'or set up the FLUX.2 venv via `bash scripts/setup-image-video.sh`',
        { status: 412, code: 'TRAINING_ENGINE_MISSING' },
      );
    }
  }

  const mergedParams = mergeParams(settings, params);
  const runId = uuidv4();
  const run = {
    id: runId,
    jobId: null,
    status: 'queued',
    runtime: routing.runtime,
    baseModelId,
    fluxVariant: routing.variant,
    trainRepo: routing.trainRepo,
    mfluxModel: routing.mfluxModel,
    name: name || null,
    character: dataset.character,
    datasetId,
    triggerWord: dataset.triggerWord,
    // Persist whether the launch opted past the caption identity-leak gate, so
    // the staging re-validation can skip the gate for THIS run without also
    // skipping it for ordinary queued runs whose captions were edited (leaky)
    // while waiting in the queue.
    captionLeakAcknowledged: acknowledgeCaptionLeak === true,
    params: mergedParams,
    progress: { step: 0, totalSteps: mergedParams.steps, loss: null, lastCheckpointStep: null },
    artifacts: { dir: `training-runs/${runId}`, checkpoints: [], samples: [] },
    output: { loraFilename: null, finalLoss: null },
    error: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
  };
  await runsDb.createRun(run);

  const queued = enqueueJob({
    kind: 'training',
    owner: 'lora-training',
    params: {
      runId,
      runtime: routing.runtime,
      datasetId,
      characterId: dataset.character.entryId,
      characterName: dataset.character.name,
      triggerWord: dataset.triggerWord,
      baseModelId,
      steps: mergedParams.steps,
      rank: mergedParams.rank,
      pythonPath,
    },
  });
  await runsDb.updateRun(runId, { jobId: queued.jobId });
  await stampDatasetTrainingStatus(run, queued.jobId);

  console.log(`🏋️ Training run ${shortId(runId)} queued — ${routing.runtime}/${baseModelId} dataset=${shortId(datasetId)} job=${shortId(queued.jobId)}`);
  return { runId, jobId: queued.jobId, position: queued.position, status: 'queued' };
}

/**
 * Resume a failed/canceled run from its latest on-disk checkpoint. mflux bakes
 * the output path into the checkpoint zip and reads everything (config, dataset
 * paths, optimizer + adapter state, step counter) from `--resume <zip>` — so a
 * resume MUST re-run in the ORIGINAL run dir, not a fresh one, or the trainer
 * would write its new artifacts where the wrapper's watcher can't see them.
 * We therefore re-enqueue a new job against the SAME runId: new checkpoints and
 * samples append to the existing artifact arrays (the checkpoint picker shows
 * the full timeline across the resume), and finalize registers the LoRA as
 * usual. Progress may briefly read low if the trainer restarts its step bar at
 * the resume point — cosmetic; the durable record catches up on the next flush.
 */
export async function resumeTrainingRun(runId, { auto = false } = {}) {
  const run = await runsDb.getRunRequired(runId);
  if (!['failed', 'canceled'].includes(run.status)) {
    throw new ServerError(`Can only resume a failed or canceled run (status: ${run.status})`, {
      status: 409, code: 'RUN_NOT_RESUMABLE',
    });
  }
  // A run can be marked failed (boot reconcile / cancel) while its detached
  // trainer is still alive — reap it before resuming so we never run two
  // trainers against the same checkpoint dir. Idempotent: a no-op when nothing
  // survives. Belt-and-suspenders with the boot-reconcile reap, since resume
  // can race the reconcile's SIGTERM grace window.
  const reaped = await reapDetached(join(runDir(runId), '.detached')).catch(() => ({ reaped: false }));
  if (reaped.reaped) console.log(`🧹 reaped surviving trainer pid ${reaped.pid} before resuming run ${shortId(runId)}`);
  // Both runtimes restore optimizer state + the step counter on resume, so
  // training picks up mid-run and finishes at the original total: mflux via
  // `mflux-train --resume <zip>`, and the torch FLUX.2 trainer via
  // `--resume-from <dir>` (restores the AdamW state from the checkpoint's
  // optimizer.pt and continues range(start_step + 1, steps + 1) — no
  // over-training, no checkpoint renumber collisions).
  const checkpoint = resolveLatestCheckpointArtifact(run);
  if (!checkpoint) {
    throw new ServerError(
      'No checkpoint to resume from — the run was killed before its first checkpoint saved. Start a fresh run.',
      { status: 409, code: 'NO_RESUMABLE_CHECKPOINT' },
    );
  }

  // Re-validate dataset readiness + ownership exactly like a fresh launch — the
  // dataset may have been edited, deleted, or reassigned since the run failed.
  // Skip the caption-leak gate: this run already cleared it at first launch,
  // and resume shouldn't re-block on captions the user already accepted.
  const { dataset } = await validateDatasetReady(run.datasetId, { acknowledgeCaptionLeak: true });
  if (!sameCharacter(dataset.character, run.character)) {
    throw new ServerError('Dataset was reassigned to a different subject — start a fresh run.', {
      status: 409, code: 'DATASET_REASSIGNED',
    });
  }

  // Engine health: mirror startTrainingRun for the run's existing runtime.
  const settings = await getSettings();
  const pythonPath = settings?.imageGen?.local?.pythonPath || null;
  if (run.runtime === TRAINING_RUNTIMES.FLUX2) {
    if (!(await isFlux2VenvHealthy())) {
      throw new ServerError('FLUX.2 training venv is unavailable — run `bash scripts/setup-image-video.sh`', {
        status: 412, code: 'TRAINING_ENGINE_MISSING',
      });
    }
  } else if (!isMfluxTrainAvailable(pythonPath)) {
    throw new ServerError('mflux-train not found next to the configured python — update mflux (≥0.17)', {
      status: 412, code: 'TRAINING_ENGINE_MISSING',
    });
  }

  const queued = enqueueJob({
    kind: 'training',
    owner: 'lora-training',
    params: {
      runId,
      runtime: run.runtime,
      datasetId: run.datasetId,
      characterId: run.character?.entryId,
      characterName: run.character?.name,
      triggerWord: run.triggerWord,
      baseModelId: run.baseModelId,
      steps: run.params?.steps,
      rank: run.params?.rank,
      pythonPath,
      resumeCheckpoint: checkpoint.path,
    },
  });
  await runsDb.updateRun(runId, (current) => ({
    ...current,
    status: 'queued',
    jobId: queued.jobId,
    error: null,
    errorCode: null,
    errorRepo: null,
    completedAt: null,
    resume: {
      count: (current.resume?.count || 0) + 1,
      // Auto (stall-watchdog) resumes are counted separately so the watchdog
      // can cap its own retries without a manual resume resetting the budget.
      autoCount: (current.resume?.autoCount || 0) + (auto ? 1 : 0),
      fromStep: checkpoint.step,
      resumedAt: new Date().toISOString(),
      lastReason: auto ? 'stall-watchdog' : 'manual',
    },
  }));
  await stampDatasetTrainingStatus(run, queued.jobId);

  console.log(`🏋️ Training run ${shortId(runId)} ${auto ? 'auto-resumed (stall watchdog)' : 'resumed'} from step ${checkpoint.step} — job=${shortId(queued.jobId)}`);
  return { runId, jobId: queued.jobId, position: queued.position, status: 'queued', fromStep: checkpoint.step };
}

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
  }).catch((err) => console.error(`❌ dataset post-run stamp failed: ${err?.message}`));
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
 * Queue-worker entry — `mediaJobQueue.runJob` calls this for kind
 * 'training'. Resolves the trainer binary + args, spawns, parses the line
 * protocol into trainingEvents, and finalizes (LoRA registration or
 * failure classification) on close. Terminal status flows through the
 * queue's dispatcher; this function resolves once the child is spawned
 * (the queue awaits the terminal event separately).
 */
export async function runTraining({ jobId, runId, pythonPath = null, resumeCheckpoint = null, reattach = false }) {
  const fail = (message) => {
    console.error(`❌ training [${shortId(jobId)}] ${message}`);
    emitFailed(jobId, message);
  };

  const run = await runsDb.getRun(runId);
  if (!run) return fail(`run record missing: ${runId}`);
  const settings = await getSettings();
  const dir = runDir(runId);

  // Terminal failure BEFORE the child spawns: flip the run record to failed
  // AND release the dataset's `training` status, then emit the failed event.
  // Every pre-spawn exit funnels through here so none can leave the run row
  // stuck `running` (lingering until the next boot reconcile) or the dataset
  // stuck on its `training` chip.
  const failBeforeSpawn = async (message) => {
    await runsDb.updateRun(runId, {
      status: 'failed', error: message, completedAt: new Date().toISOString(),
    }).catch(() => {});
    await flipDatasetAfterRun(run, { trained: false });
    return fail(message);
  };

  // Boot re-attach (#1332): the queue re-enqueues a run whose detached trainer
  // SURVIVED a hard server restart with `reattach: true`. The child reparented
  // to init and is still training (or finished during the downtime), so we tail
  // its existing control-dir output instead of spawning a second trainer — no
  // staging, no validation, no fresh spawn. wireProcLifecycle then drives the
  // exact same line-handling/finalize path as a normal spawn, so a run that
  // completed mid-restart still registers its LoRA instead of being discarded.
  if (reattach) {
    const proc = await reattachDetached(join(dir, '.detached'));
    if (!proc) {
      // The survivor died (killed mid-run) with no RESULT to recover — fail the
      // run; its latest checkpoint stays resumable manually/auto, same as the
      // pre-#1332 reap path would have left it.
      return failBeforeSpawn('Trainer did not survive the restart — marking failed; resume from the latest checkpoint.');
    }
    console.log(`🔁 training [${shortId(jobId)}] re-attached to surviving trainer pid ${proc.pid} (run ${shortId(runId)})`);
    trainingEvents.emit('status', { generationId: jobId, message: 'Re-attached to trainer that survived a restart' });
    wireProcLifecycle(proc, { isReattach: true });
    return;
  }

  // Re-validate — the dataset may have been edited/deleted while queued. Skip
  // the caption identity-leak gate ONLY for a run that already opted past it:
  // one launched with an explicit "Train anyway" (persisted on the record) or a
  // resume (its captions already trained once). An ordinary clean-at-launch run
  // is still re-checked here, so captions edited leaky while it sat in the queue
  // are caught instead of training silently.
  const skipCaptionLeakGate = run.captionLeakAcknowledged === true || resumeCheckpoint != null;
  let manifest;
  let dataset;
  try {
    ({ dataset, manifest } = await validateDatasetReady(
      run.datasetId,
      { acknowledgeCaptionLeak: skipCaptionLeakGate },
    ));
  } catch (err) {
    return failBeforeSpawn(err.message);
  }
  // Stage-time ownership check: if the dataset was reassigned to a different
  // subject after this run was queued, the run no longer owns it. Bail out
  // rather than training the moved dataset and registering a LoRA under the
  // run's now-stale subject. failBeforeSpawn's flipDatasetAfterRun is
  // character-guarded, so it won't disturb the reassigned dataset's state.
  // Match the full (universeId, entryId) key the dataset store uses elsewhere.
  if (!sameCharacter(dataset.character, run.character)) {
    return failBeforeSpawn('Dataset was reassigned to a different subject after this run was queued — cancel and retrain.');
  }

  // Reclaim unified memory before a GPU-heavy run, then gate on real headroom.
  // Training shares the unified-memory pool with resident LLMs and renders; an
  // oversubscribed run swap-thrashes and has coincided with GPU watchdog
  // reboots (docs/research/2026-06-13-mflux-training-watchdog-panic.md). We
  // unload resident models, measure what's actually free, and refuse to start
  // (rather than crash mid-run) when headroom is below the floor. The budget
  // also sizes the mflux quantize/low_ram tier below.
  const memReport = await prepareMemoryForTraining();
  if (memReport.unloaded.length) {
    console.log(`🧹 training [${shortId(jobId)}] freed ${memReport.unloaded.length} resident model(s): ${memReport.unloaded.join(', ')}`);
  }
  console.log(`🧮 training [${shortId(jobId)}] memory budget ${memReport.budgetGb.toFixed(0)} GB free of ${memReport.totalGb.toFixed(0)} GB total`);
  if (!Number.isFinite(memReport.budgetGb) || memReport.budgetGb < TRAINING_MIN_HEADROOM_GB) {
    // Fail safe: a non-finite budget (should never happen — both inputs are
    // finite) must REFUSE the run, not slip past `NaN < x` (always false).
    return failBeforeSpawn(`Not enough free memory to train safely — ${memReport.budgetGb.toFixed(1)} GB available, need ≥ ${TRAINING_MIN_HEADROOM_GB} GB. Stop other model servers or close apps and retry.`);
  }

  const checkpointsDir = join(dir, 'checkpoints');
  const samplesDir = join(dir, 'samples');

  let bin;
  let args;
  // Staging I/O (mkdir + copyFile/writeFile/atomicWrite) is wrapped: a throw
  // here — e.g. a dataset image deleted in the window after validateDatasetReady's
  // existence check (TOCTOU), or disk-full — would otherwise propagate to the
  // queue's catch (no crash) but leave the run record `running` forever.
  try {
    await ensureDir(checkpointsDir);
    await ensureDir(samplesDir);

    if (run.runtime === TRAINING_RUNTIMES.FLUX2) {
      bin = resolveFlux2Python();
      if (!bin) {
        return failBeforeSpawn('FLUX.2 python environment disappeared — re-run scripts/setup-image-video.sh');
      }
      const manifestPath = join(dir, 'manifest.json');
      await atomicWrite(manifestPath, {
        triggerWord: manifest.triggerWord,
        images: manifest.images.map((img) => ({ path: img.path, caption: img.caption })),
      });
      args = buildFlux2TrainArgs({
        scriptPath: TRAINER_SCRIPTS.flux2,
        trainRepo: run.trainRepo,
        manifestPath,
        runDir: dir,
        triggerWord: run.triggerWord,
        params: run.params,
        samplePrompt: run.params?.samplePrompt || null,
        resumeFrom: resumeCheckpoint,
      });
    } else {
      bin = pythonPath;
      if (!bin || !isMfluxTrainAvailable(bin)) {
        return failBeforeSpawn('mflux-train not found next to the configured python — update mflux (≥0.17) or set up the FLUX.2 venv');
      }
      // Stage the dataset in mflux's auto-discovery layout: NNNN.png +
      // NNNN.txt caption pairs, plus preview_1.txt for the periodic sample
      // render. mflux resolves everything from the config's `data` dir.
      const dataDir = join(dir, 'data');
      await ensureDir(dataDir);
      for (let i = 0; i < manifest.images.length; i += 1) {
        const stem = String(i + 1).padStart(4, '0');
        await copyFile(manifest.images[i].path, join(dataDir, `${stem}.png`));
        await writeFile(join(dataDir, `${stem}.txt`), `${manifest.images[i].caption}\n`);
      }
      if ((run.params?.sampleEvery ?? TRAINING_DEFAULTS.sampleEvery) > 0) {
        const samplePrompt = run.params?.samplePrompt || `${run.triggerWord} portrait, neutral background`;
        await writeFile(join(dataDir, 'preview_1.txt'), `${samplePrompt}\n`);
      }
      // output_path must NOT pre-exist — mflux appends a timestamp suffix to
      // an existing dir (its new_folder behavior), which would break the
      // wrapper's artifact watcher. mflux creates checkpoints/ + preview/
      // (+ loss/) inside it.
      const mfluxOutputDir = join(dir, 'mflux');
      const config = buildMfluxTrainConfig({
        params: run.params,
        variant: run.fluxVariant,
        mfluxModel: run.mfluxModel,
        dataDir,
        imageCount: manifest.images.length,
        outputDir: mfluxOutputDir,
        // Memory-derived quantize/low_ram (see deriveMfluxMemoryConfig) keyed
        // on the post-unload AVAILABLE budget, not raw RAM — a bf16 base +
        // in-RAM latent cache OOM-killed a 48 GB machine, and on a shared box
        // resident models eat the same pool, so the tier must track headroom.
        totalMemGb: memReport.budgetGb,
      });
      const configPath = join(dir, 'mflux-train.json');
      await atomicWrite(configPath, config);
      // Segmented training (watchdog-panic mitigation): default ON, globally
      // disable-able via settings.loraTraining.segmentation = false once a
      // macOS/mflux update fixes the underlying GPU-driver hang. Segment size
      // is the config's effective save_frequency so each segment ends exactly
      // on a checkpoint — no extra checkpoints, no lost steps on resume.
      const segCfg = settings?.loraTraining || {};
      const segmentationOn = segCfg.segmentation !== false;
      const cooldownSec = Number.isFinite(segCfg.segmentCooldownSec)
        ? segCfg.segmentCooldownSec : MFLUX_DEFAULT_COOLDOWN_SEC;
      args = buildMfluxTrainArgs({
        scriptPath: TRAINER_SCRIPTS.mflux,
        configPath,
        runDir: dir,
        totalSteps: run.params?.steps || TRAINING_DEFAULTS.steps,
        resumeCheckpoint,
        segmentSteps: segmentationOn ? config.checkpoint.save_frequency : 0,
        cooldownSec,
      });
    }
  } catch (err) {
    return failBeforeSpawn(`staging failed: ${err.message}`);
  }

  await runsDb.updateRun(runId, { status: 'running', startedAt: new Date().toISOString() });
  trainingEvents.emit('status', { generationId: jobId, message: `Starting ${run.runtime} training (${run.params.steps} steps)` });

  const childEnv = safeChildProcessEnv(await hfTokenEnv());
  delete childEnv.PYTHONPATH;
  childEnv.PYTHONUNBUFFERED = '1';

  console.log(`🏋️ training [${shortId(jobId)}] spawn ${basename(bin)} ${run.runtime} steps=${run.params.steps} rank=${run.params.rank} images=${manifest.images.length}${resumeCheckpoint ? ` resume=${basename(resumeCheckpoint)}` : ''}`);
  // `spawnDetached` double-forks the trainer so it reparents to init (PPID=1)
  // and leaves pm2's process tree entirely. A plain `detached: true` child only
  // gets its OWN process group — but pm2's TreeKill keys on PPID, not the group,
  // so the still-PPID-linked trainer was found and SIGINT'd anyway whenever
  // portos-server restarted (e.g. on the memory ceiling, which a long session
  // crosses routinely — observed twice: SIGINT/KeyboardInterrupt at the exact
  // second of a server restart, losing hours of GPU work). The detached trainer
  // streams stdout/stderr through on-disk log files under `<runDir>/.detached`
  // that the server tails. We still `proc.kill()` it directly by PID on cancel,
  // and the queue worker awaits the 'close' event for the run lifecycle. No
  // `cleanup` — those logs are the only copy of raw trainer stdout/stderr, kept
  // in the run dir for post-mortem and removed when the run dir is deleted.
  const proc = await spawnDetached(bin, args, { env: childEnv, controlDir: join(dir, '.detached') });
  wireProcLifecycle(proc);

  // Wire a freshly-spawned OR re-attached (#1332) trainer handle into the full
  // run lifecycle: live output streaming + progress mirror, the phase-aware
  // stall watchdog, and the close→finalize path that registers the LoRA. A
  // hoisted nested function so the early reattach branch (above) can call it too
  // — both paths share identical handling. Closes over jobId/runId/run/dir/
  // settings/fail/failBeforeSpawn.
  function wireProcLifecycle(proc, { isReattach = false } = {}) {
  activeProcess = proc;
  activeJobId = jobId;

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
    return runsDb.updateRun(runId, (current) => ({
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
    })).catch((err) => console.error(`❌ training [${shortId(jobId)}] progress persist failed: ${err?.message}`));
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
  // we SIGKILL the wedged child; the close handler auto-resumes from the newest
  // checkpoint. Disable via settings.loraTraining.stallWatchdog = false.
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
        console.log(`⏱️ training [${shortId(jobId)}] phase-aware watchdog: training stalled ${Math.round(idleMs / 1000)}s (budget ${Math.round(budgetMs / 1000)}s) — SIGKILL + auto-resume`);
        // Soft hang: SIGKILL straight away (SIGTERM relies on the GIL the hang
        // holds, so the 8s escalation in cancel() would just waste the window).
        // The newest checkpoint is the resume point; the close handler picks it
        // up. Direct PID kill via the detached handle.
        proc.kill('SIGKILL');
      } catch (err) {
        console.error(`❌ training [${shortId(jobId)}] stall watchdog tick failed: ${err?.message}`);
      }
    }, STALL_TICK_MS);
    stallTimer.unref?.();
  }

  proc.on('error', (err) => {
    stopStallWatchdog();
    if (activeProcess === proc) { activeProcess = null; activeJobId = null; }
    // Terminal too (no 'close' follows an 'error'), so wake the display here as
    // well — no-op unless we actually slept it (proc.pid was set). Without this,
    // a pid-bearing process that errors instead of closing would leave the
    // display asleep.
    wakeDisplay(settings);
    // A launch failure after the run was marked `running` — a genuine spawn
    // error, or (with spawnDetached) the control dir failing to create/clear.
    // Route through the same terminal cleanup as pre-spawn failures so the run
    // row doesn't stay stuck `running` and the dataset's `training` chip is
    // released; `fail()` alone only logs + emits. Async + guarded since this
    // runs outside the request lifecycle.
    Promise.resolve(failBeforeSpawn(`trainer spawn failed: ${err.message}`))
      .catch((e) => console.error(`❌ training [${shortId(jobId)}] failure cleanup failed: ${e?.message}`));
  });

  proc.on('close', (code, signal) => {
    stopStallWatchdog();
    if (activeProcess === proc) { activeProcess = null; activeJobId = null; }
    // Flush the debounced progress (final checkpoint + last sample) BEFORE
    // finalize reads the run record — the collapse guard and previewImageUrl
    // both read run.artifacts. Async finalize wrapped so a rejection can't
    // escape the event handler (unhandled rejection kills the process on Node ≥15).
    Promise.resolve(flushProgress())
      .then(() => finalizeTraining({ jobId, runId, code, signal, state: getState(), stallKilled }))
      .then((resumed) => {
        // Wake the display now the run is over so the user sees the result —
        // but NOT when finalize actually enqueued a stall-watchdog auto-resume
        // (it re-spawns and re-sleeps the display for the next attempt). Gating
        // on the returned `resumed` flag, not raw `stallKilled`, ensures a
        // budget-exhausted or failed resume (terminal, no re-spawn) still wakes.
        // Best-effort, darwin-only.
        if (!resumed) wakeDisplay(settings);
      })
      .catch((err) => {
        // A finalize/flush rejection is still a terminal end with no auto-resume
        // enqueued, so wake the display here too — otherwise this error path
        // would leave it asleep (no .then ran). No-op unless we slept it.
        wakeDisplay(settings);
        console.error(`❌ training [${shortId(jobId)}] finalize failed: ${err?.message}`);
        fail(`finalize failed: ${err?.message}`);
      });
  });
  } // end wireProcLifecycle
}

/**
 * After a phase-aware-watchdog SIGKILL, auto-resume the run from its newest
 * checkpoint (issue #1330) — bounded by STALL_MAX_AUTO_RESUMES so a config that
 * wedges every segment can't resume-loop forever. Best-effort: any failure
 * leaves the run in its finalize-set `failed` state for manual resume. Runs
 * outside the request lifecycle (called from the close handler), so it owns its
 * own error handling rather than bubbling.
 *
 * Returns true ONLY when a resume was actually enqueued (a fresh trainer will
 * re-spawn). The close handler relies on this to decide whether to wake the
 * display: a budget-exhausted or failed resume does NOT re-spawn, so the display
 * must be woken just like any other terminal end — gating on raw `stallKilled`
 * would leave it asleep forever on those paths.
 */
async function autoResumeAfterStall(runId, jobId) {
  const run = await runsDb.getRun(runId).catch(() => null);
  if (!run) return false;
  const autoCount = run.resume?.autoCount || 0;
  if (autoCount >= STALL_MAX_AUTO_RESUMES) {
    console.log(`⚠️ training [${shortId(jobId)}] stall auto-resume budget exhausted (${autoCount}/${STALL_MAX_AUTO_RESUMES}) — leaving run failed for manual resume`);
    return false;
  }
  // resumeTrainingRun requires a failed/canceled status + a resumable checkpoint;
  // finalize has already flipped the run to failed by the time this runs.
  return resumeTrainingRun(runId, { auto: true }).then(
    (res) => { console.log(`🔁 training [${shortId(jobId)}] auto-resumed run ${shortId(runId)} from step ${res.fromStep} (attempt ${autoCount + 1}/${STALL_MAX_AUTO_RESUMES})`); return true; },
    (err) => { console.error(`❌ training [${shortId(jobId)}] stall auto-resume failed: ${err?.message} — run stays failed for manual resume`); return false; },
  );
}

async function finalizeTraining({ jobId, runId, code, signal, state, stallKilled = false }) {
  const run = await runsDb.getRun(runId);
  const job = getJob(jobId);
  const canceled = !!job?.cancelRequested;

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
    const { sizeBytes } = await registerTrainedLora({
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
    if (selection.autoSelected) console.log(`⚠️ training [${shortId(jobId)}] ${selection.reason} (size ${sizeBytes ?? '?'}B)`);
    console.log(`✅ training [${shortId(jobId)}] complete — registered ${filename} @ step ${selection.step}`);
    trainingEvents.emit('completed', {
      generationId: jobId, runId, loraFilename: filename, filename,
    });
    return;
  }

  if (canceled) {
    // Queue's cancelRequested flips the failed event into a clean cancel;
    // record keeps the checkpoint lineage for a future resume.
    await runsDb.updateRun(runId, { status: 'canceled', completedAt: new Date().toISOString(), error: 'Canceled' })
      .catch(() => {});
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
    }).catch(() => {});
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
  }).catch(() => {});
  await flipDatasetAfterRun(run, { trained: false });
  console.error(`❌ training [${shortId(jobId)}] ${failCode}: ${message}`);
  trainingEvents.emit('failed', { generationId: jobId, error: message, code: failCode, repo: failRepo });

  // Phase-aware watchdog SIGKILL (issue #1330): the run is now `failed`, so
  // resumeTrainingRun's status precondition is satisfied — auto-resume from the
  // newest checkpoint. Bounded by STALL_MAX_AUTO_RESUMES; awaited so the resume
  // (re-enqueue + run-record flip back to queued) completes within finalize.
  // Return whether a resume was actually enqueued so the close handler knows NOT
  // to wake the display in that case (the re-spawn re-sleeps it); every other
  // terminal path falls through to the implicit `undefined` (falsy) → wake.
  if (stallKilled) return autoResumeAfterStall(runId, jobId);
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
  await writeFile(dest, buffer);
  const sizeBytes = buffer.length; // bytes written === on-disk size; no stat round-trip
  const sidecar = buildTrainedSidecar({
    run, result, filename, previewImageUrl, sizeBytes, selectedStep, autoSelected,
  });
  await atomicWrite(`${dest}.metadata.json`, JSON.stringify(sidecar, null, 2) + '\n');
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
  console.log(`📌 training [${shortId(runId)}] promoted checkpoint step ${step} → ${filename}`);
  // If the promoted checkpoint had no preview (its step didn't land on the
  // sampleEvery cadence — most often the final step, e.g. 1188 with sampleEvery
  // 300), render one in the BACKGROUND from the just-registered LoRA so the
  // deployed card isn't blank. Fire-and-forget: promote stays snappy, and a
  // render failure (OOM, missing venv, server restart) must never fail the
  // promote — the LoRA is already deployed; the thumbnail is cosmetic.
  if (!target.previewUrl) {
    ensureCheckpointPreview(run, step, filename).catch((err) => {
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

  await ensureDir(samplesDir);
  await copyFile(renderedPath, dest);
  // Join is by step, sourced from artifacts.samples — append so listRunCheckpoints
  // picks it up. updateRun's function form merges against the freshest record.
  await runsDb.updateRun(runId, (current) => {
    const samples = current.artifacts?.samples || [];
    const name = previewSampleName(step);
    if (samples.includes(name)) return current;
    return { ...current, artifacts: { ...current.artifacts, samples: [...samples, name] } };
  });
  trainingEvents.emit('checkpoint-preview', { generationId: run.jobId || runId, runId, step });
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
export async function initLoraTraining() {
  const active = await runsDb.listActiveRuns().catch((err) => {
    console.error(`❌ loraTraining boot reconcile failed: ${err?.message}`);
    return [];
  });
  for (const run of active) {
    const job = run.jobId ? getJob(run.jobId) : null;
    if (!job || ['failed', 'canceled', 'completed'].includes(job.status)) {
      // The trainer is a detached child that survives a pm2 restart, so it may
      // STILL be running even though its in-memory job is gone. Reap it (clean
      // SIGTERM → checkpoint → SIGKILL) before marking the run failed/resumable,
      // so a resume can't spawn a second trainer into the same checkpoint dir.
      const reaped = await reapDetached(join(runDir(run.id), '.detached')).catch(() => ({ reaped: false }));
      if (reaped.reaped) console.log(`🧹 reaped surviving trainer pid ${reaped.pid} for run ${shortId(run.id)}`);
      await runsDb.updateRun(run.id, {
        status: 'failed', error: 'interrupted by restart', completedAt: new Date().toISOString(),
      }).catch(() => {});
      await flipDatasetAfterRun(run, { trained: false });
      console.log(`🧹 training run ${shortId(run.id)} marked failed (interrupted by restart)`);
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
