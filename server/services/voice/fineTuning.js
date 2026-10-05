/**
 * Qwen3-TTS Voice Fine-Tuning Service (#5381).
 *
 * Provides dataset readiness validation, explicit start, streaming progress,
 * checkpoint generation, audition samples, cancellation, and explicit
 * checkpoint promotion.
 *
 * Training is machine-local, optional, and never assumes the last checkpoint is best.
 * It starts only when the runner's probe names a real training adapter (the
 * official Qwen single-speaker recipe on bf16 CUDA). The runner publishes a
 * checkpoint only after it is sealed and reloads to render an audition, and
 * reports the digest-bound revision promotion records. Adapter-less legacy
 * checkpoints and checkpoints without that revision never promote.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { spawn } from '../../lib/childProcess.js';
import { ServerError } from '../../lib/errorHandler.js';
import { atomicWrite, readJSONFileStrict } from '../../lib/fileUtils.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { closeJobAfterDelay } from '../../lib/sseUtils.js';
import {
  DEFAULT_CLONE_MODEL,
  QWEN3_TTS_MODELS_DIR,
  QWEN3_TTS_RUNNER_SCRIPT,
  SUPPORTED_QWEN3_MODELS,
  getQwen3RuntimeStatus,
} from './qwen3TtsRuntime.js';
import {
  getVoiceProfileRequired,
  profileArtifactDirectory,
  promoteFineTunedProfile,
} from './profiles.js';

// In-memory active training job map. Entries are evicted once terminal (see
// `finalizeJob`); the durable record is the `job.json` sidecar written beside
// the run's checkpoints, so a restart mid-training does not orphan them.
const activeJobs = new Map();

// Sidecar record written into `<profileDir>/fine-tune/<jobId>/`. It lives with
// the checkpoints it indexes so the record and its artifacts are deleted
// together, rather than in a separate store that could outlive them.
const JOB_RECORD_FILE = 'job.json';

// Job ids are minted with randomUUID; anything else never named a real run and
// must not reach `join`, where a separator or `..` would escape the profile's
// directory. Enforced here as well as in the route schema because this path is
// built from a caller-supplied id.
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A user cancel is recorded by `cancelFineTuningJob` and, when the abort reaches
// the child before the caller returns, by the child's terminal handler. One
// shape so whichever writes first leaves the same record.
const CANCELLED_OUTCOME = Object.freeze({ status: 'cancelled', error: 'Cancelled by user' });

// The official recipe fine-tunes the Base variants only.
const TRAINABLE_MODELS = new Set(SUPPORTED_QWEN3_MODELS.map((model) => model.id).filter((id) => id.endsWith('-Base')));
// Single-speaker recipe: one registered speaker name per checkpoint.
const TRAINING_SPEAKER = 'portos_voice';
const DATASET_MANIFEST_FILE = 'dataset.json';
const AUDIO_FILE_RE = /\.(wav|mp3|flac|m4a)$/i;
const STDERR_TAIL_BYTES = 8192;

const jobRecordPath = (profileId, jobId) =>
  join(profileArtifactDirectory(profileId), 'fine-tune', jobId, JOB_RECORD_FILE);

// A record that parsed but is not shaped like a job (a truncated `{}`, a `null`,
// a hand-edited file) is not a usable recovery — it must not masquerade as a
// live job whose `checkpoints` a caller is about to `.find` over.
const isJobRecord = (record) => Boolean(
  record
  && typeof record === 'object'
  && typeof record.id === 'string'
  && typeof record.status === 'string'
  && Array.isArray(record.checkpoints)
);

// Drops the runtime-only handles (abort controller, child process, write chain,
// finalize latch) that cannot — and must not — be serialized.
const serializableJob = ({
  controller: _controller,
  child: _child,
  persistChain: _persistChain,
  finalized: _finalized,
  ...record
}) => record;

/**
 * Write the job record to disk. Writes are chained per job because `close` and
 * `error` can both fire for one child and each rewrites the same file.
 *
 * The runner seals a checkpoint before reporting it, so this write is the moment
 * a checkpoint becomes named. It takes backup admission: a snapshot that copied
 * the run directory before a new checkpoint landed must not capture a record
 * listing it afterwards. The runner's own writes are outside the process and
 * cannot be admitted, but nothing names them until this write (#9982).
 */
const persistJob = (jobState) => {
  // Capture the durable state when this write is queued. Otherwise a checkpoint
  // write that runs after a later terminal event serializes the mutable current
  // object and can race the terminal write out of order.
  const record = structuredClone(serializableJob(jobState));
  jobState.persistChain = (jobState.persistChain || Promise.resolve())
    .then(() => withBackupAssetPublication(() => atomicWrite(jobRecordPath(jobState.profileId, jobState.id), record)))
    .catch((err) => console.error(`❌ Failed to persist fine-tune job ${jobState.id}: ${err.message}`));
  return jobState.persistChain;
};

/**
 * Resolve a job from memory, falling back to its on-disk record. Returns null
 * only when the record is genuinely absent — a present-but-unreadable record
 * throws instead, because reporting 404 would tell the operator their run is
 * gone while its checkpoints are still sitting on disk.
 */
async function loadJob(jobId, profileId) {
  const active = activeJobs.get(jobId);
  if (active) return active;
  if (!profileId || !JOB_ID_RE.test(jobId)) return null;
  const { ok, value } = await readJSONFileStrict(jobRecordPath(profileId, jobId), null);
  if (!ok || (value !== null && !isJobRecord(value))) {
    throw new ServerError('Fine-tuning job record is unreadable', {
      status: 500,
      code: 'JOB_RECORD_UNREADABLE',
    });
  }
  return value;
}

/**
 * Persist the terminal state, then evict the in-memory entry after the SSE
 * grace window so a status poll racing completion still hits memory while the
 * map stays bounded. Runs at most once per job — `error` and `close` can both
 * fire for the same child.
 */
const finalizeJob = (jobState) => {
  if (jobState.finalized) return;
  jobState.finalized = true;
  persistJob(jobState);
  closeJobAfterDelay(activeJobs, jobState.id);
};

/**
 * Validate training dataset readiness for a given voice profile.
 */
export async function validateFineTuningDataset(profileId) {
  const profile = await getVoiceProfileRequired(profileId);
  const profileDir = profileArtifactDirectory(profile.id);
  const sourceDir = join(profileDir, 'source');

  const issues = [];
  let fileCount = 0;
  let transcriptsCount = 0;

  if (!existsSync(sourceDir)) {
    issues.push('No source audio directory found. Upload reference audio first.');
    return { ready: false, fileCount: 0, transcriptsCount: 0, issues };
  }

  const files = await readdir(sourceDir);
  const audioFiles = files.filter((f) => AUDIO_FILE_RE.test(f));
  fileCount = audioFiles.length;

  if (fileCount === 0) {
    issues.push('At least 1 clean audio recording is required for fine-tuning.');
  }

  for (const asset of profile.sourceAssets || []) {
    if (asset.transcript && asset.transcript.trim()) {
      transcriptsCount += 1;
    }
  }

  if (transcriptsCount === 0 && fileCount > 0) {
    issues.push('Source audio requires transcriptions for training dataset.');
  }

  const ready = issues.length === 0 && fileCount > 0;
  return {
    ready,
    fileCount,
    transcriptsCount,
    issues,
    sourceDir,
  };
}

/**
 * Pair each transcribed source asset with its recording. The first pair is the
 * speaker reference; the recipe recommends one reference for every sample.
 */
function buildTrainingDataset(profile, sourceDir) {
  const samples = (profile.sourceAssets || [])
    .filter((asset) => typeof asset.filename === 'string' && AUDIO_FILE_RE.test(asset.filename)
      && asset.filename === asset.filename.split(/[\\/]/).pop()
      && asset.transcript?.trim() && existsSync(join(sourceDir, asset.filename)))
    .map((asset) => ({ audio: join(sourceDir, asset.filename), text: asset.transcript.trim() }));
  if (samples.length === 0) {
    throw new ServerError('Dataset not ready: no transcribed source recording is available', {
      status: 400,
      code: 'DATASET_NOT_READY',
    });
  }
  return { speaker: TRAINING_SPEAKER, reference_audio: samples[0].audio, samples };
}

// A checkpoint frame is recorded only when the runner sealed and auditioned
// it inside this job's own directory.
const isPublishedCheckpoint = (event, outputDir) => (
  typeof event.checkpoint === 'string'
  && typeof event.checkpoint_path === 'string'
  && dirname(event.checkpoint_path) === outputDir
  && typeof event.model_revision === 'string'
  && /@[0-9a-f]{40}\+sha256\.[0-9a-f]{64}$/.test(event.model_revision)
);

/**
 * Start an explicit fine-tuning job for a voice profile.
 */
export async function startFineTuningJob({
  profileId,
  epochs = 5,
  checkpointInterval = 50,
  baseModel = DEFAULT_CLONE_MODEL,
} = {}) {
  const validation = await validateFineTuningDataset(profileId);
  if (!validation.ready) {
    throw new ServerError(`Dataset not ready: ${validation.issues.join('; ')}`, {
      status: 400,
      code: 'DATASET_NOT_READY',
    });
  }

  // Refuse before a job record or child exists. Inference readiness is not
  // training support; only a runner that names a real adapter may train.
  const runtime = await getQwen3RuntimeStatus();
  if (!runtime.ok || !runtime.pythonPath || !runtime.trainingAdapter) {
    throw new ServerError('Qwen3-TTS fine-tuning is unavailable: no supported training adapter is installed', {
      status: 503,
      code: 'QWEN3_TRAINING_UNAVAILABLE',
    });
  }
  if (!TRAINABLE_MODELS.has(baseModel)) {
    throw new ServerError('Qwen3-TTS fine-tuning supports only the Base models', {
      status: 400,
      code: 'QWEN3_TRAINING_UNSUPPORTED_MODEL',
    });
  }
  if (!runtime.models?.[baseModel]?.downloaded) {
    throw new ServerError('Download and verify the Qwen3-TTS base model before fine-tuning', {
      status: 409,
      code: 'QWEN3_MODEL_NOT_INSTALLED',
    });
  }

  const profile = await getVoiceProfileRequired(profileId);
  const dataset = buildTrainingDataset(profile, validation.sourceDir);
  const jobId = randomUUID();
  const profileDir = profileArtifactDirectory(profile.id);
  const outputDir = join(profileDir, 'fine-tune', jobId);
  await mkdir(outputDir, { recursive: true });
  const datasetManifest = join(outputDir, DATASET_MANIFEST_FILE);
  await atomicWrite(datasetManifest, dataset);

  const abortController = new AbortController();
  const jobState = {
    id: jobId,
    profileId: profile.id,
    universeId: profile.binding.universeId,
    characterId: profile.binding.characterId,
    status: 'running',
    progress: 0,
    step: 0,
    // Optimizer steps depend on the dataset; the runner reports the total.
    totalSteps: null,
    loss: null,
    checkpoints: [],
    outputDir,
    baseModel,
    trainingAdapter: runtime.trainingAdapter,
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    controller: abortController,
    child: null,
  };

  activeJobs.set(jobId, jobState);
  await persistJob(jobState);

  const args = [
    QWEN3_TTS_RUNNER_SCRIPT,
    '--mode', 'fine-tune',
    '--models-dir', QWEN3_TTS_MODELS_DIR,
    '--dataset-manifest', datasetManifest,
    '--output-dir', outputDir,
    '--epochs', String(epochs),
    '--checkpoint-interval', String(checkpointInterval),
    '--model-id', baseModel,
  ];

  const child = spawn(runtime.pythonPath, args, safeChildProcessOptions({ signal: abortController.signal }));
  // Keep a handle on the child so a future shutdown hook can reach in-flight training.
  jobState.child = child;

  // Drain stderr so a long run cannot block on a full pipe; keep the tail for
  // the runner's structured (path-free) failure message.
  let stderrTail = '';
  child.stderr?.on('data', (chunk) => { stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES); });
  const runnerError = () => {
    try {
      const failure = JSON.parse(stderrTail.trim().split(/\r?\n/).at(-1));
      return typeof failure?.error === 'string' ? failure.error : null;
    } catch {
      return null;
    }
  };

  let lineBuffer = '';
  child.stdout.on('data', (chunk) => {
    lineBuffer += chunk.toString();
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop(); // keep remainder

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed);
        if (event.stage === 'training') {
          jobState.step = event.step;
          jobState.totalSteps = event.total_steps || jobState.totalSteps;
          jobState.loss = event.loss;
          jobState.progress = event.progress;
        } else if (event.stage === 'checkpoint' && isPublishedCheckpoint(event, outputDir)) {
          jobState.checkpoints.push({
            id: event.checkpoint,
            step: event.step,
            checkpointPath: event.checkpoint_path,
            sampleWav: event.sample_wav,
            loss: event.loss,
            modelRevision: event.model_revision,
            createdAt: new Date().toISOString(),
          });
          // Checkpoints are the promotable artifact, so index each one as it
          // lands — a restart mid-training must not orphan the ones already
          // written. Step/loss progress deliberately is not persisted: it
          // arrives every step and is worthless once the process is gone.
          persistJob(jobState);
        } else if (event.stage === 'completed') {
          jobState.status = 'completed';
          jobState.progress = 100;
          jobState.completedAt = new Date().toISOString();
        }
      } catch {
        // non-JSON log line
      }
    }
  });

  // Only the FIRST terminal event may write the outcome. An aborted spawn fires
  // BOTH — `error` with an AbortError, then `close(null, 'SIGTERM')` — and
  // `cancelFineTuningJob` records 'cancelled' synchronously before either
  // arrives, so an unguarded `error` handler lands a user cancel on disk (and in
  // the next status poll) as 'failed'.
  const settle = (outcome) => {
    if (jobState.status === 'running') {
      Object.assign(jobState, outcome, { completedAt: new Date().toISOString() });
    }
    finalizeJob(jobState);
  };

  child.on('close', (code, signal) => {
    if (code === 0) return settle({ status: 'completed', progress: 100 });
    if (abortController.signal.aborted) return settle(CANCELLED_OUTCOME);
    // A killed child reports a null code — an OOM reap during a long training
    // run is the likely cause, so name the signal rather than "code null".
    settle({
      status: 'failed',
      error: code === null
        ? `Process terminated by signal ${signal}`
        : (runnerError() || `Process exited with code ${code}`),
    });
  });

  child.on('error', (err) => {
    settle(abortController.signal.aborted ? CANCELLED_OUTCOME : { status: 'failed', error: err.message });
  });

  return {
    jobId,
    profileId: profile.id,
    status: jobState.status,
    totalSteps: jobState.totalSteps,
    trainingAdapter: jobState.trainingAdapter,
    startedAt: jobState.startedAt,
  };
}

/**
 * Get the current status and checkpoints of a fine-tuning job, from memory
 * while it is live and from its `job.json` sidecar afterwards.
 */
export async function getFineTuningJobStatus(jobId, profileId) {
  const job = await loadJob(jobId, profileId);
  if (!job) {
    throw new ServerError('Fine-tuning job not found', { status: 404, code: 'JOB_NOT_FOUND' });
  }
  return serializableJob(job);
}

/**
 * Cancel an active fine-tuning job.
 */
export function cancelFineTuningJob(jobId) {
  const job = activeJobs.get(jobId);
  if (!job) {
    throw new ServerError('Fine-tuning job not found', { status: 404, code: 'JOB_NOT_FOUND' });
  }
  if (job.status === 'running') {
    job.controller.abort();
    Object.assign(job, CANCELLED_OUTCOME, { completedAt: new Date().toISOString() });
  }
  return { ok: true, jobId, status: job.status };
}

/**
 * Explicitly promote a selected checkpoint to the character's voice profile.
 */
export async function promoteCheckpoint({ profileId, jobId, checkpointId }) {
  const job = await loadJob(jobId, profileId);
  if (!job) {
    throw new ServerError('Fine-tuning job not found', { status: 404, code: 'JOB_NOT_FOUND' });
  }
  const ckpt = job.checkpoints.find((c) => c.id === checkpointId || String(c.step) === String(checkpointId));
  if (!ckpt) {
    throw new ServerError(`Checkpoint not found: ${checkpointId}`, { status: 404, code: 'CHECKPOINT_NOT_FOUND' });
  }
  // Earlier runners wrote text placeholders named .safetensors. A checkpoint
  // without its producing adapter and sealed revision never becomes a voice.
  if (!job.trainingAdapter || typeof ckpt.modelRevision !== 'string') {
    throw new ServerError('Checkpoint was not produced by a supported training adapter', {
      status: 409,
      code: 'CHECKPOINT_UNVERIFIED',
    });
  }

  return promoteFineTunedProfile({
    profileId,
    universeId: job.universeId,
    characterId: job.characterId,
    checkpointPath: ckpt.checkpointPath,
    checkpointId: ckpt.id,
    modelRevision: ckpt.modelRevision,
    step: ckpt.step,
  });
}
