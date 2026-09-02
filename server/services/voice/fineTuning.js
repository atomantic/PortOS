/**
 * Qwen3-TTS Voice Fine-Tuning Service (#5381).
 *
 * Provides dataset readiness validation, explicit start, streaming progress,
 * checkpoint generation, audition samples, cancellation, and explicit
 * checkpoint promotion.
 *
 * Training is machine-local, optional, and never assumes the last checkpoint is best.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from '../../lib/childProcess.js';
import { ServerError } from '../../lib/errorHandler.js';
import { atomicWrite, readJSONFileStrict } from '../../lib/fileUtils.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { closeJobAfterDelay } from '../../lib/sseUtils.js';
import {
  DEFAULT_CLONE_MODEL,
  QWEN3_TTS_RUNNER_SCRIPT,
  resolveQwen3Python,
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
 */
const persistJob = (jobState) => {
  jobState.persistChain = (jobState.persistChain || Promise.resolve())
    .then(() => atomicWrite(jobRecordPath(jobState.profileId, jobState.id), serializableJob(jobState)))
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
  const audioFiles = files.filter((f) => /\.(wav|mp3|flac|m4a)$/i.test(f));
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

  const python = await resolveQwen3Python();
  if (!python) {
    throw new ServerError('Python runtime is unavailable for fine-tuning', {
      status: 503,
      code: 'QWEN3_RUNTIME_UNAVAILABLE',
    });
  }

  const profile = await getVoiceProfileRequired(profileId);
  const jobId = randomUUID();
  const profileDir = profileArtifactDirectory(profile.id);
  const outputDir = join(profileDir, 'fine-tune', jobId);
  await mkdir(outputDir, { recursive: true });

  const abortController = new AbortController();
  const jobState = {
    id: jobId,
    profileId: profile.id,
    universeId: profile.binding.universeId,
    characterId: profile.binding.characterId,
    status: 'running',
    progress: 0,
    step: 0,
    totalSteps: epochs * 50,
    loss: null,
    checkpoints: [],
    outputDir,
    baseModel,
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
    '--dataset-dir', validation.sourceDir,
    '--output-dir', outputDir,
    '--epochs', String(epochs),
    '--checkpoint-interval', String(checkpointInterval),
    '--model-id', baseModel,
  ];

  const child = spawn(python, args, safeChildProcessOptions({ signal: abortController.signal }));
  // Keep a handle on the child so a future shutdown hook can reach in-flight training.
  jobState.child = child;

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
        } else if (event.stage === 'checkpoint') {
          jobState.checkpoints.push({
            id: event.checkpoint,
            step: event.step,
            checkpointPath: event.checkpoint_path,
            sampleWav: event.sample_wav,
            loss: event.loss,
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

  child.on('close', (code) => {
    if (jobState.status === 'running') {
      if (code === 0) {
        jobState.status = 'completed';
        jobState.progress = 100;
      } else {
        jobState.status = abortController.signal.aborted ? 'cancelled' : 'failed';
        jobState.error = abortController.signal.aborted ? 'Cancelled by user' : `Process exited with code ${code}`;
      }
      jobState.completedAt = new Date().toISOString();
    }
    finalizeJob(jobState);
  });

  child.on('error', (err) => {
    jobState.status = 'failed';
    jobState.error = err.message;
    jobState.completedAt = new Date().toISOString();
    finalizeJob(jobState);
  });

  return {
    jobId,
    profileId: profile.id,
    status: jobState.status,
    totalSteps: jobState.totalSteps,
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
    job.status = 'cancelled';
    job.completedAt = new Date().toISOString();
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

  return promoteFineTunedProfile({
    profileId,
    universeId: job.universeId,
    characterId: job.characterId,
    checkpointPath: ckpt.checkpointPath,
    checkpointId: ckpt.id,
    modelRevision: `qwen3-tts:checkpoint-${ckpt.step}`,
    step: ckpt.step,
  });
}
