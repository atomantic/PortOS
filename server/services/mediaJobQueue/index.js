/**
 * Media Job Queue — single-worker FIFO for image + video gen jobs.
 *
 * Why this exists: video gen (mlx_video) and image gen (mflux/diffusers) both
 * spawn heavy GPU/Metal child processes. Running two simultaneously OOMs the
 * machine, so the gen modules used to throw 409 BUSY when one was already in
 * flight. That made any agent-driven pipeline (e.g. Creative Director) need
 * to retry/backoff. This queue serializes submissions so callers always get
 * an immediate `queued` ack and watch progress via SSE.
 *
 * Scope: gates `videoGen/local#generateVideo` (always) and
 * `imageGen/local#generateImage` (only when imageGen mode === 'local'). The
 * external/codex image-gen backends bypass the queue — they don't share the
 * MLX runtime so they can run concurrently with anything in the queue.
 *
 * Persistence: data/media-jobs.json holds queued + running + recently-finished
 * jobs. On boot, any 'running' is reclassified as 'failed (interrupted by
 * restart)' since the spawned child died with the previous server process.
 * Completed/failed/canceled entries older than 24h or beyond the 500-most-
 * recent are pruned to keep the file small.
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { unlink } from 'fs/promises';
import { join } from 'path';
import { PATHS, readJSONFile, atomicWrite, ensureDir } from '../../lib/fileUtils.js';
import {
  broadcastSse,
  attachSseClient as attachSse,
  closeJobAfterDelay,
} from '../../lib/sseUtils.js';
import { videoGenEvents } from '../videoGen/events.js';
import { imageGenEvents } from '../imageGenEvents.js';

const JOBS_FILE = join(PATHS.data, 'media-jobs.json');
const COMPLETED_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PERSISTED_ARCHIVE = 500;

export const JOB_KINDS = Object.freeze(['video', 'image']);
export const JOB_STATUSES = Object.freeze(['queued', 'running', 'completed', 'failed', 'canceled']);

export const mediaJobEvents = new EventEmitter();

// Live state. Single worker → at most one job in `running` at a time. `queue`
// holds pending jobs in submission order. `archive` holds recently-finished
// jobs (visible for ~24h via /api/media-jobs?status=completed).
const queue = [];
let running = null;
const archive = [];

// jobId → entry consumed by lib/sseUtils.js#{broadcastSse,attachSseClient,
// closeJobAfterDelay}. Each entry carries `clients: []` and `lastPayload`,
// so we can hand it directly to those helpers. Survives the queued→running
// transition so a client that attached during queue keeps its stream open
// through the render and final completion. Entries are removed after
// SSE_CLEANUP_DELAY_MS by closeJobAfterDelay on terminal events.
const sseJobs = new Map();

let workerStarted = false;
let initPromise = null;

function findJob(jobId) {
  if (running && running.id === jobId) return running;
  const inQueue = queue.find((j) => j.id === jobId);
  if (inQueue) return inQueue;
  return archive.find((j) => j.id === jobId) || null;
}

export function getJob(jobId) {
  return findJob(jobId);
}

export function listJobs({ status, kind, owner } = {}) {
  const all = [
    ...(running ? [running] : []),
    ...queue,
    ...archive,
  ];
  return all.filter((j) => {
    if (status && j.status !== status) return false;
    if (kind && j.kind !== kind) return false;
    if (owner && j.owner !== owner) return false;
    return true;
  });
}

async function persist() {
  const cutoff = Date.now() - COMPLETED_TTL_MS;
  const trimmedArchive = archive
    .filter((j) => {
      const ts = j.completedAt ? new Date(j.completedAt).getTime() : Date.now();
      return ts > cutoff;
    })
    .slice(-MAX_PERSISTED_ARCHIVE);
  // Mutate `archive` in place so subsequent reads see the trim too.
  archive.length = 0;
  archive.push(...trimmedArchive);
  const live = [
    ...(running ? [running] : []),
    ...queue,
    ...archive,
  ];
  // Strip non-serializable bits.
  const serializable = live.map(({ id, kind, owner, status, queuedAt, startedAt, completedAt, params, result, error, position }) =>
    ({ id, kind, owner, status, queuedAt, startedAt, completedAt, params, result, error, position }),
  );
  await atomicWrite(JOBS_FILE, { jobs: serializable });
}

export async function initMediaJobQueue() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    // Once-at-boot: subsequent persist() calls assume the data dir exists.
    await ensureDir(PATHS.data);
    const data = await readJSONFile(JOBS_FILE, { jobs: [] });
    const persistedJobs = Array.isArray(data?.jobs) ? data.jobs : [];
    for (const j of persistedJobs) {
      if (j.status === 'running') {
        archive.push({
          ...j,
          status: 'failed',
          error: 'interrupted by restart',
          completedAt: new Date().toISOString(),
        });
      } else if (j.status === 'queued') {
        queue.push({ ...j });
      } else {
        archive.push(j);
      }
    }
    // The persisted `position` reflects the previous process' queue layout
    // (which may have included a now-failed running job). Recompute against
    // the current queue so /api/media-jobs and the initial SSE `queued`
    // event report accurate slots.
    queue.forEach((q, i) => { q.position = i + 1; });
    if (persistedJobs.length) {
      console.log(`📦 mediaJobQueue restored: ${queue.length} queued, ${archive.length} archived`);
    }
    await persist();
    startWorker();
  })();
  return initPromise;
}

function startWorker() {
  if (workerStarted) return;
  workerStarted = true;
  // Detach from awaiting so init can return; the loop runs forever.
  drainLoop().catch((err) => {
    console.log(`❌ mediaJobQueue worker crashed: ${err.message}`);
    workerStarted = false;
  });
}

async function drainLoop() {
  while (true) {
    if (running || queue.length === 0) {
      await sleep(150);
      continue;
    }
    const job = queue.shift();
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    running = job;
    // Recompute positions for everyone still queued.
    queue.forEach((q, i) => { q.position = i + 1 + (running ? 1 : 0); });
    persist().catch((e) => console.log(`⚠️ mediaJobQueue persist on start failed: ${e.message}`));
    broadcastSse(ensureSseEntry(job.id), { type: 'started', kind: job.kind });
    mediaJobEvents.emit('started', job);
    console.log(`▶️  media-job [${job.id.slice(0, 8)}] ${job.kind} started`);
    await runJob(job);
    running = null;
    archive.push(job);
    persist().catch((e) => console.log(`⚠️ mediaJobQueue persist on done failed: ${e.message}`));
  }
}

// Filter videoGenEvents/imageGenEvents down to a single jobId and translate
// them into SSE-wire payloads + queue-status transitions. Returns
// `{ attach, detach }` so runJob can deterministically clean up listeners
// even on the throw path.
//
// Event shapes (match the underlying gens):
//   videoGen.progress  → { generationId, progress: number, step?, totalSteps? }
//   imageGen.progress  → { generationId, progress: number, step?, totalSteps? }
//   imageGen.progress  → { generationId, currentImage } (preview-only frames)
// Neither gen module emits `message`, so we don't pass it through (passing
// `undefined` clobbers any prior status text on the client).
function makeGenDispatcher(emitter, job, handlers) {
  const onProgress = (e) => {
    if (e.generationId !== job.id) return;
    const hasProgress = typeof e.progress === 'number' && Number.isFinite(e.progress);
    const hasCurrentImage = typeof e.currentImage === 'string' && e.currentImage.length > 0;
    if (hasProgress) {
      const payload = { type: 'progress', progress: e.progress };
      if (hasCurrentImage) payload.currentImage = e.currentImage;
      if (e.message !== undefined) payload.message = e.message;
      handlers.progress(payload);
      return;
    }
    if (hasCurrentImage) {
      // Preview-only frame (imageGen step thumbnail) — distinct SSE type so
      // existing consumers can keep their progress-bar value untouched.
      handlers.progress({ type: 'preview', currentImage: e.currentImage });
    }
  };
  const onCompleted = (e) => { if (e.generationId === job.id) handlers.completed(e); };
  const onFailed = (e) => { if (e.generationId === job.id) handlers.failed({ error: e.error }); };
  return {
    attach() {
      emitter.on('progress', onProgress);
      emitter.on('completed', onCompleted);
      emitter.on('failed', onFailed);
    },
    detach() {
      emitter.off('progress', onProgress);
      emitter.off('completed', onCompleted);
      emitter.off('failed', onFailed);
    },
  };
}

async function runJob(job) {
  const sseEntry = ensureSseEntry(job.id);
  const handlers = {
    progress: (payload) => {
      broadcastSse(sseEntry, payload);
    },
    completed: (payload) => {
      job.status = 'completed';
      job.result = payload;
      job.completedAt = new Date().toISOString();
      broadcastSse(sseEntry, { type: 'complete', result: payload });
      closeJobAfterDelay(sseJobs, job.id);
      mediaJobEvents.emit('completed', job);
      console.log(`✅ media-job [${job.id.slice(0, 8)}] completed`);
    },
    failed: (payload) => {
      job.status = 'failed';
      job.error = payload.error || 'unknown error';
      job.completedAt = new Date().toISOString();
      broadcastSse(sseEntry, { type: 'error', error: job.error });
      closeJobAfterDelay(sseJobs, job.id);
      mediaJobEvents.emit('failed', job);
      console.log(`❌ media-job [${job.id.slice(0, 8)}] failed: ${job.error}`);
    },
  };

  const emitter = job.kind === 'video' ? videoGenEvents : imageGenEvents;
  const dispatcher = makeGenDispatcher(emitter, job, handlers);
  dispatcher.attach();

  try {
    if (job.kind === 'video') {
      const { generateVideo } = await import('../videoGen/local.js');
      await generateVideo({ ...job.params, jobId: job.id });
    } else if (job.kind === 'image') {
      const { generateImage } = await import('../imageGen/local.js');
      await generateImage({ ...job.params, jobId: job.id });
    } else {
      throw new Error(`Unknown job kind: ${job.kind}`);
    }
  } catch (err) {
    // generateVideo / generateImage threw before reaching their proc.on
    // cleanup hooks (e.g. PYTHON not configured, validation fail). Clean up
    // multipart upload temp files the route handed us so they don't leak
    // in /tmp.
    if (job.params?.uploadedTempPath) {
      await unlink(job.params.uploadedTempPath).catch(() => {});
    }
    if (job.status === 'running') handlers.failed({ error: err.message });
  }

  // Wait for the underlying gen to settle (the gen modules emit completed/
  // failed asynchronously after the proc closes — runJob's await above only
  // gates the spawn, not the render finish). Handlers flip job.status to a
  // terminal state; short-sleep poll so we don't busy-spin.
  while (job.status === 'running') await sleep(100);
  dispatcher.detach();
}

export function enqueueJob({ kind, params, owner = null }) {
  if (!JOB_KINDS.includes(kind)) {
    throw new Error(`enqueueJob: invalid kind '${kind}'`);
  }
  const id = randomUUID();
  const job = {
    id,
    kind,
    owner,
    status: 'queued',
    queuedAt: new Date().toISOString(),
    params,
    // position counts "where you sit in the overall pipeline" — the running
    // job (if any) occupies slot 1, then queued jobs follow. So the second
    // submission while one is running sits at position 2.
    position: queue.length + (running ? 1 : 0) + 1,
  };
  queue.push(job);
  const sseEntry = ensureSseEntry(id);
  broadcastSse(sseEntry, { type: 'queued', position: job.position });
  mediaJobEvents.emit('enqueued', job);
  persist().catch((e) => console.log(`⚠️ mediaJobQueue persist on enqueue failed: ${e.message}`));
  startWorker();
  console.log(`📥 media-job [${id.slice(0, 8)}] ${kind} queued (position ${job.position})`);
  return { jobId: id, position: job.position, status: 'queued' };
}

// Cancel: drops a queued job, or sends SIGTERM to a running gen process.
export async function cancelJob(jobId) {
  const queueIdx = queue.findIndex((j) => j.id === jobId);
  if (queueIdx >= 0) {
    const [job] = queue.splice(queueIdx, 1);
    // Multipart uploads (e.g. /api/video-gen with an image) hand us a path
    // in the OS temp dir. If we drop the job before it starts, runJob never
    // gets a chance to delete it — clean up here so /tmp doesn't accumulate.
    if (job.params?.uploadedTempPath) {
      await unlink(job.params.uploadedTempPath).catch(() => {});
    }
    job.status = 'canceled';
    job.completedAt = new Date().toISOString();
    archive.push(job);
    queue.forEach((q, i) => { q.position = i + 1 + (running ? 1 : 0); });
    const sseEntry = ensureSseEntry(jobId);
    broadcastSse(sseEntry, { type: 'error', error: 'Canceled before start' });
    closeJobAfterDelay(sseJobs, jobId);
    mediaJobEvents.emit('canceled', job);
    persist().catch(() => {});
    console.log(`🛑 media-job [${jobId.slice(0, 8)}] canceled (was queued)`);
    return { ok: true, status: 'canceled' };
  }
  if (running && running.id === jobId) {
    if (running.kind === 'video') {
      const { cancel } = await import('../videoGen/local.js');
      cancel();
    } else if (running.kind === 'image') {
      const { cancel } = await import('../imageGen/local.js');
      cancel();
    }
    console.log(`🛑 media-job [${jobId.slice(0, 8)}] cancel signal sent (was running)`);
    return { ok: true, status: 'canceling' };
  }
  return { ok: false, error: 'Job not found or already finished' };
}

function ensureSseEntry(jobId) {
  if (!sseJobs.has(jobId)) {
    // Shape required by lib/sseUtils.js#{broadcastSse,attachSseClient}.
    sseJobs.set(jobId, { clients: [], lastPayload: null });
  }
  return sseJobs.get(jobId);
}

// Routes call this. Returns false when the jobId is unknown to the queue.
export function attachSseClient(jobId, res) {
  if (!findJob(jobId)) return false;
  ensureSseEntry(jobId);
  return attachSse(sseJobs, jobId, res);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Test-only reset hook. Real callers go through enqueueJob/cancelJob.
export function __resetForTests() {
  queue.length = 0;
  running = null;
  archive.length = 0;
  sseJobs.clear();
  workerStarted = false;
  initPromise = null;
}
