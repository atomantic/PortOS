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
import { copyFile, mkdir, writeFile } from 'fs/promises';
import { join, basename, dirname } from 'path';
import { platform } from 'os';
import { PATHS, ensureDir, atomicWrite, shortId } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { v4 as uuidv4 } from '../../lib/uuid.js';
import { hfTokenEnv } from '../../lib/hfToken.js';
import { safeChildProcessEnv } from '../../lib/processEnv.js';
import { getImageModels } from '../../lib/mediaModels.js';
import { resolveFlux2Python, isFlux2VenvHealthy } from '../../lib/pythonSetup.js';
import { getSettings } from '../settings.js';
import { enqueueJob, getJob, mediaJobEvents } from '../mediaJobQueue/index.js';
import { updateDataset } from '../loraDatasets.js';
import { trainingEvents } from './events.js';
import {
  TRAINING_DEFAULTS,
  TRAINING_RUNTIMES,
  buildFlux2TrainArgs,
  buildMfluxTrainArgs,
  buildMfluxTrainConfig,
  resolveTrainingRuntime,
} from './runtimes.js';
import { makeTrainingLineHandler } from './progress.js';
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

// A dataset belongs to a run only while it still points at the run's character.
// Match the full (universeId, entryId) key the dataset store uses — a different
// universe can reuse the same entryId, so entryId alone would falsely re-own a
// reassigned dataset. (flipDatasetAfterRun keeps its own missing-entryId
// fallthrough for pre-reassignment runs that predate the character snapshot.)
const sameCharacter = (a, b) =>
  a?.entryId === b?.entryId && a?.universeId === b?.universeId;

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
export async function startTrainingRun({ datasetId, baseModelId, name = null, params = {} }) {
  const settings = await getSettings();
  const pythonPath = settings?.imageGen?.local?.pythonPath || null;
  // Engine pick: prefer mflux's MLX trainer when the user's mflux install
  // ships it (Apple Silicon native, no second venv); fall back to the
  // torch/diffusers trainer in venv-flux2.
  const mlxAvailable = isMfluxTrainAvailable(pythonPath);
  const routing = resolveTrainingRuntime(baseModelId, getImageModels(), { mlxAvailable });
  const { dataset } = await validateDatasetReady(datasetId);

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
export async function resumeTrainingRun(runId) {
  const run = await runsDb.getRunRequired(runId);
  if (!['failed', 'canceled'].includes(run.status)) {
    throw new ServerError(`Can only resume a failed or canceled run (status: ${run.status})`, {
      status: 409, code: 'RUN_NOT_RESUMABLE',
    });
  }
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
  const { dataset } = await validateDatasetReady(run.datasetId);
  if (!sameCharacter(dataset.character, run.character)) {
    throw new ServerError('Dataset was reassigned to a different character — start a fresh run.', {
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
      fromStep: checkpoint.step,
      resumedAt: new Date().toISOString(),
    },
  }));
  await stampDatasetTrainingStatus(run, queued.jobId);

  console.log(`🏋️ Training run ${shortId(runId)} resumed from step ${checkpoint.step} — job=${shortId(queued.jobId)}`);
  return { runId, jobId: queued.jobId, position: queued.position, status: 'queued', fromStep: checkpoint.step };
}

const emitFailed = (jobId, error) => trainingEvents.emit('failed', { generationId: jobId, error });

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
  return updateDataset(datasetId, (current) => {
    const mismatch = runEntryId && (
      current.character?.entryId !== runEntryId
      || (runUniverseId && current.character?.universeId !== runUniverseId)
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

/**
 * Queue-worker entry — `mediaJobQueue.runJob` calls this for kind
 * 'training'. Resolves the trainer binary + args, spawns, parses the line
 * protocol into trainingEvents, and finalizes (LoRA registration or
 * failure classification) on close. Terminal status flows through the
 * queue's dispatcher; this function resolves once the child is spawned
 * (the queue awaits the terminal event separately).
 */
export async function runTraining({ jobId, runId, pythonPath = null, resumeCheckpoint = null }) {
  const fail = (message) => {
    console.error(`❌ training [${shortId(jobId)}] ${message}`);
    emitFailed(jobId, message);
  };

  const run = await runsDb.getRun(runId);
  if (!run) return fail(`run record missing: ${runId}`);

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

  // Re-validate — the dataset may have been edited/deleted while queued.
  let manifest;
  let dataset;
  try {
    ({ dataset, manifest } = await validateDatasetReady(run.datasetId));
  } catch (err) {
    return failBeforeSpawn(err.message);
  }
  // Stage-time ownership check: if the dataset was reassigned to a different
  // character after this run was queued, the run no longer owns it. Bail out
  // rather than training the moved dataset and registering a LoRA under the
  // run's now-stale character. failBeforeSpawn's flipDatasetAfterRun is
  // character-guarded, so it won't disturb the reassigned dataset's state.
  // Match the full (universeId, entryId) key the dataset store uses elsewhere.
  if (!sameCharacter(dataset.character, run.character)) {
    return failBeforeSpawn('Dataset was reassigned to a different character after this run was queued — cancel and retrain.');
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

  const dir = runDir(runId);
  const checkpointsDir = join(dir, 'checkpoints');
  const samplesDir = join(dir, 'samples');

  let bin;
  let args;
  // Staging I/O (mkdir + copyFile/writeFile/atomicWrite) is wrapped: a throw
  // here — e.g. a dataset image deleted in the window after validateDatasetReady's
  // existence check (TOCTOU), or disk-full — would otherwise propagate to the
  // queue's catch (no crash) but leave the run record `running` forever.
  try {
    await mkdir(checkpointsDir, { recursive: true });
    await mkdir(samplesDir, { recursive: true });

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
      await mkdir(dataDir, { recursive: true });
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
      args = buildMfluxTrainArgs({
        scriptPath: TRAINER_SCRIPTS.mflux,
        configPath,
        runDir: dir,
        totalSteps: run.params?.steps || TRAINING_DEFAULTS.steps,
        resumeCheckpoint,
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
  const proc = spawn(bin, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  activeProcess = proc;
  activeJobId = jobId;

  // Keep the Mac awake for the duration of the training child (display can
  // sleep; system must not). Best-effort — caffeinate exits with the child.
  if (platform() === 'darwin' && proc.pid) {
    const caf = spawn('caffeinate', ['-dis', '-w', String(proc.pid)], { stdio: 'ignore' });
    caf.on('error', () => {});
    caf.unref();
  }

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
        ...(flushing.checkpoints ? { checkpoints: [...current.artifacts.checkpoints, ...flushing.checkpoints] } : {}),
        ...(flushing.samples ? { samples: [...current.artifacts.samples, ...flushing.samples] } : {}),
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

  const makeSplitter = (stream) => {
    let buf = '';
    const safeLine = (text) => {
      // try/catch: this runs inside a child-process data/end callback — an
      // uncaught throw here would crash the server process.
      try { handleLine(text, stream); } catch (err) {
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

  proc.on('error', (err) => {
    if (activeProcess === proc) { activeProcess = null; activeJobId = null; }
    fail(`trainer spawn failed: ${err.message}`);
  });

  proc.on('close', (code, signal) => {
    if (activeProcess === proc) { activeProcess = null; activeJobId = null; }
    // Flush the debounced progress (final checkpoint + last sample) BEFORE
    // finalize reads the run record — the collapse guard and previewImageUrl
    // both read run.artifacts. Async finalize wrapped so a rejection can't
    // escape the event handler (unhandled rejection kills the process on Node ≥15).
    Promise.resolve(flushProgress())
      .then(() => finalizeTraining({ jobId, runId, code, signal, state: getState() }))
      .catch((err) => {
        console.error(`❌ training [${shortId(jobId)}] finalize failed: ${err?.message}`);
        fail(`finalize failed: ${err?.message}`);
      });
  });
}

async function finalizeTraining({ jobId, runId, code, signal, state }) {
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
  await writeFile(`${dest}.metadata.json`, JSON.stringify(sidecar, null, 2) + '\n');
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
  return { loraFilename: filename, step };
}

/**
 * Boot reconcile + terminal-state mirror. Called from server/index.js after
 * initMediaJobQueue(). Any run persisted as queued/running whose job isn't
 * live in the queue is marked failed (the queue does the same for its own
 * interrupted jobs — this keeps the two stores agreeing). Also subscribes
 * to mediaJobEvents so a queue-side cancel (user hits cancel while QUEUED,
 * which never reaches runTraining) still lands in the run record.
 */
export async function initLoraTraining() {
  const active = await runsDb.listActiveRuns().catch((err) => {
    console.error(`❌ loraTraining boot reconcile failed: ${err?.message}`);
    return [];
  });
  for (const run of active) {
    const job = run.jobId ? getJob(run.jobId) : null;
    if (!job || ['failed', 'canceled', 'completed'].includes(job.status)) {
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
