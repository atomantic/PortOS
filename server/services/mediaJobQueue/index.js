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
import { videoGenEvents } from '../videoGen/events.js';
import { imageGenEvents } from '../imageGenEvents.js';

const JOBS_FILE = join(PATHS.data, 'media-jobs.json');
const COMPLETED_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PERSISTED_ARCHIVE = 500;
// Mirrors sseUtils.SSE_CLEANUP_DELAY_MS — late EventSource clients that
// reconnect within this window after a terminal event still see the final
// frame replayed from `lastPayload`.
const SSE_CLEANUP_DELAY_MS = 5000;

export const mediaJobEvents = new EventEmitter();

// Live state. Single worker → at most one job in `running` at a time. `queue`
// holds pending jobs in submission order. `archive` holds recently-finished
// jobs (visible for ~24h via /api/media-jobs?status=completed).
const queue = [];
let running = null;
const archive = [];

// jobId → SSE response objects + lastPayload cache. Survives the queued→
// running transition so a client that attached during queue can keep its
// stream open through the render and final completion.
const sseRegistry = new Map();

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
  await ensureDir(PATHS.data);
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
    broadcastToSse(job.id, { type: 'started', kind: job.kind });
    mediaJobEvents.emit('started', job);
    console.log(`▶️  media-job [${job.id.slice(0, 8)}] ${job.kind} started`);
    await runJob(job);
    running = null;
    archive.push(job);
    persist().catch((e) => console.log(`⚠️ mediaJobQueue persist on done failed: ${e.message}`));
  }
}

async function runJob(job) {
  const handlers = {
    progress: (payload) => {
      // The gen module's per-frame progress also drives the SSE stream we own.
      broadcastToSse(job.id, payload);
    },
    completed: (payload) => {
      job.status = 'completed';
      job.result = payload;
      job.completedAt = new Date().toISOString();
      broadcastToSse(job.id, { type: 'complete', result: payload });
      closeSseAfterDelay(job.id);
      mediaJobEvents.emit('completed', job);
      console.log(`✅ media-job [${job.id.slice(0, 8)}] completed`);
    },
    failed: (payload) => {
      job.status = 'failed';
      job.error = payload.error || 'unknown error';
      job.completedAt = new Date().toISOString();
      broadcastToSse(job.id, { type: 'error', error: job.error });
      closeSseAfterDelay(job.id);
      mediaJobEvents.emit('failed', job);
      console.log(`❌ media-job [${job.id.slice(0, 8)}] failed: ${job.error}`);
    },
  };

  const dispatcher = job.kind === 'video'
    ? new GenDispatcher(videoGenEvents, job.id, handlers)
    : new GenDispatcher(imageGenEvents, job.id, handlers);
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
    if (job.status === 'running') {
      handlers.failed({ error: err.message });
    }
  }

  // Wait for the underlying gen to settle (the gen modules emit completed/
  // failed asynchronously after the proc closes — runJob's await above only
  // gates the spawn, not the render finish). The handlers above flip job.status
  // to a terminal state; loop with a short sleep so we don't busy-spin.
  while (job.status === 'running') await sleep(100);
  dispatcher.detach();
}

// Adapter that translates videoGenEvents/imageGenEvents into the queue's
// per-job SSE wire format, filtering by generationId to a specific job.
class GenDispatcher {
  constructor(emitter, jobId, handlers) {
    this.emitter = emitter;
    this.jobId = jobId;
    this.handlers = handlers;
    this.bound = {
      progress: (e) => this.onProgress(e),
      completed: (e) => this.onCompleted(e),
      failed: (e) => this.onFailed(e),
      started: () => {}, // queue emits its own `started`; ignore the gen's.
    };
  }
  attach() {
    this.emitter.on('progress', this.bound.progress);
    this.emitter.on('completed', this.bound.completed);
    this.emitter.on('failed', this.bound.failed);
    this.emitter.on('started', this.bound.started);
  }
  detach() {
    this.emitter.off('progress', this.bound.progress);
    this.emitter.off('completed', this.bound.completed);
    this.emitter.off('failed', this.bound.failed);
    this.emitter.off('started', this.bound.started);
  }
  onProgress(e) {
    if (e.generationId !== this.jobId) return;
    this.handlers.progress({ type: 'progress', progress: e.progress, message: e.message });
  }
  onCompleted(e) {
    if (e.generationId !== this.jobId) return;
    this.handlers.completed(e);
  }
  onFailed(e) {
    if (e.generationId !== this.jobId) return;
    this.handlers.failed({ error: e.error });
  }
}

export function enqueueJob({ kind, params, owner = null }) {
  if (!['video', 'image'].includes(kind)) {
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
  // Pre-create SSE registry so a client that races and attaches before the
  // queued event fires still gets it replayed via lastPayload.
  ensureSseEntry(id);
  broadcastToSse(id, { type: 'queued', position: job.position });
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
    job.status = 'canceled';
    job.completedAt = new Date().toISOString();
    archive.push(job);
    queue.forEach((q, i) => { q.position = i + 1 + (running ? 1 : 0); });
    broadcastToSse(jobId, { type: 'error', error: 'Canceled before start' });
    closeSseAfterDelay(jobId);
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

// SSE plumbing -------------------------------------------------------------

function ensureSseEntry(jobId) {
  if (!sseRegistry.has(jobId)) {
    sseRegistry.set(jobId, { clients: [], lastPayload: null, closed: false });
  }
  return sseRegistry.get(jobId);
}

function broadcastToSse(jobId, payload) {
  const entry = sseRegistry.get(jobId);
  if (!entry) return;
  entry.lastPayload = payload;
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const c of entry.clients) c.write(msg);
}

function closeSseAfterDelay(jobId, delay = SSE_CLEANUP_DELAY_MS) {
  const entry = sseRegistry.get(jobId);
  if (!entry) return;
  entry.closed = true;
  setTimeout(() => {
    const e = sseRegistry.get(jobId);
    if (!e) return;
    for (const c of e.clients) {
      try { c.end(); } catch { /* response already ended */ }
    }
    sseRegistry.delete(jobId);
  }, delay);
}

export function attachSseClient(jobId, res) {
  const job = findJob(jobId);
  if (!job) return false;
  const entry = ensureSseEntry(jobId);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  entry.clients.push(res);
  // Replay the last payload so a client that connected mid-event sees state.
  if (entry.lastPayload) {
    res.write(`data: ${JSON.stringify(entry.lastPayload)}\n\n`);
  } else if (job.status === 'queued') {
    // First-attach for a queued job that hasn't broadcast yet.
    res.write(`data: ${JSON.stringify({ type: 'queued', position: job.position })}\n\n`);
  }
  res.req.on('close', () => {
    entry.clients = entry.clients.filter((c) => c !== res);
  });
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Test-only reset hook. Real callers go through enqueueJob/cancelJob.
export function __resetForTests() {
  queue.length = 0;
  running = null;
  archive.length = 0;
  sseRegistry.clear();
  workerStarted = false;
  initPromise = null;
}
