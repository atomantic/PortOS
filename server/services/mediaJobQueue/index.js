/**
 * Media Job Queue — two-lane FIFO for image + video gen jobs.
 *
 * Why this exists: video gen (mlx_video) and local image gen (mflux/diffusers)
 * both spawn heavy GPU/Metal child processes. Running two simultaneously OOMs
 * the machine, so the gen modules used to throw 409 BUSY when one was already
 * in flight. That made any agent-driven pipeline (e.g. Creative Director) need
 * to retry/backoff. This queue serializes submissions so callers always get
 * an immediate `queued` ack and watch progress via SSE.
 *
 * Lanes: GPU jobs (video + local image) drain serially through `running` since
 * they share the MLX runtime. Codex image jobs run in a parallel `codexRunning`
 * lane — they shell out to an external CLI and don't compete for GPU memory,
 * so a long video render never blocks a Codex storyboard generation.
 *
 * Scope: gates `videoGen/local#generateVideo` (always),
 * `imageGen/local#generateImage` (when imageGen mode === 'local'), and
 * `imageGen/codex#generateImage` (when mode === 'codex') in a separate
 * concurrent lane — Codex doesn't share the MLX runtime so it runs alongside
 * GPU jobs without OOMing the machine. External SD-API mode bypasses the
 * queue entirely — it's a remote call with no local single-flight
 * constraint to absorb.
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
import { join, resolve as pathResolve, sep as PATH_SEP } from 'path';
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
// Defaults (env-overridable). `Number(non-numeric)` → NaN, and
// `setTimeout(NaN)` fires immediately — that would fail every job at boot
// if MEDIA_JOB_WATCHDOG_*_MS were set to garbage. Fall back to the default
// when the parsed value isn't a positive finite number.
const watchdogMs = (envValue, defaultMs) => {
  const n = Number(envValue);
  return Number.isFinite(n) && n > 0 ? n : defaultMs;
};
const WATCHDOG_VIDEO_MS = watchdogMs(process.env.MEDIA_JOB_WATCHDOG_VIDEO_MS, 30 * 60 * 1000);
const WATCHDOG_IMAGE_MS = watchdogMs(process.env.MEDIA_JOB_WATCHDOG_IMAGE_MS, 5 * 60 * 1000);

// Returns true if `p` resolves strictly under PATHS.uploads. Shared by
// safeUnlinkUpload (cleanup) and the pre-gen sanitizer (Thread #1 guard).
function isUnderUploadsRoot(p) {
  if (typeof p !== 'string') return false;
  const uploadsRoot = `${pathResolve(PATHS.uploads)}${PATH_SEP}`;
  return pathResolve(p).startsWith(uploadsRoot);
}

// Normalize `uploadedTempPaths` to an array regardless of how it arrived
// in persisted params. Handles three cases:
//   - Array  → use as-is (normal path)
//   - string → wrap in array (legacy/corrupt single-string serialization)
//   - other  → treat as empty (null, undefined, corrupt non-string)
function normalizeTempPaths(p) {
  if (Array.isArray(p)) return p;
  if (typeof p === 'string' && p.length > 0) return [p];
  return [];
}

// Defense-in-depth helper for cleaning up staged multipart uploads. Job
// params are persisted (and replayed on boot), so a corrupted media-jobs.json
// or a buggy caller could otherwise feed an arbitrary path into unlink().
// Confine deletion to PATHS.uploads — the routes (videoGen.js, imageGen.js)
// always copy multipart uploads into that directory before enqueueing, so
// any legitimate `uploadedTempPath` is under that root.
async function safeUnlinkUpload(path) {
  if (!path || typeof path !== 'string') return;
  if (!isUnderUploadsRoot(path)) {
    console.log(`⚠️ mediaJobQueue refused to unlink path outside PATHS.uploads: ${path}`);
    return;
  }
  await unlink(path).catch(() => {});
}

export const JOB_KINDS = Object.freeze(['video', 'image']);
export const JOB_STATUSES = Object.freeze(['queued', 'running', 'completed', 'failed', 'canceled']);

// Returns a Promise that resolves to the gen module for the given job's
// provider (video/local, imageGen/local, or imageGen/codex). Single source
// of provider-dispatch truth — used by the watchdog, runJob, and cancelJob
// so a new provider addition is one edit instead of three.
function getGenModuleForJob(job) {
  if (job.kind === 'video') return import('../videoGen/local.js');
  if (job.kind === 'image' && job.params?.mode === 'codex') return import('../imageGen/codex.js');
  if (job.kind === 'image') return import('../imageGen/local.js');
  return Promise.resolve(null);
}

export const mediaJobEvents = new EventEmitter();

// Live state. GPU jobs: at most one in `running` at a time. Codex image jobs
// (`kind === 'image' && params.mode === 'codex'`) run in a separate concurrent
// lane (`codexRunning`) because they don't share the MLX runtime. `queue`
// holds pending jobs in submission order. `archive` holds recently-finished
// jobs (visible for ~24h via /api/media-jobs?status=completed).
const queue = [];
let running = null;
let codexRunning = null;
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
  if (codexRunning && codexRunning.id === jobId) return codexRunning;
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
    ...(codexRunning ? [codexRunning] : []),
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

// Serialize persist() calls through a single chain. atomicWrite rename can
// finish out-of-order under concurrent calls, so a slow "start" persist
// landing after a fast "done" persist would regress the on-disk snapshot
// (e.g. completed→running). Chaining ensures every snapshot reflects the
// state at its enqueue time, in submission order.
let persistChain = Promise.resolve();
function persist() {
  persistChain = persistChain.then(persistImpl, persistImpl);
  return persistChain;
}
async function persistImpl() {
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
    ...(codexRunning ? [codexRunning] : []),
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
    const restartedFailedIds = [];
    for (const j of persistedJobs) {
      if (j.status === 'running') {
        const failed = {
          ...j,
          status: 'failed',
          error: 'interrupted by restart',
          completedAt: new Date().toISOString(),
        };
        archive.push(failed);
        restartedFailedIds.push(failed.id);
        // The failed job will never reach the worker's cleanup, so any
        // multipart upload it staged into data/uploads would leak forever.
        // safeUnlinkUpload constrains the delete to PATHS.uploads so we
        // never delete a file the job merely referenced (gallery image,
        // prior render, etc).
        safeUnlinkUpload(j.params?.uploadedTempPath);
        for (const p of normalizeTempPaths(j.params?.uploadedTempPaths)) {
          safeUnlinkUpload(p);
        }
      } else if (j.status === 'queued') {
        queue.push({ ...j });
      } else {
        archive.push(j);
      }
    }
    // The persisted `position` reflects the previous process' queue layout
    // (which may have included a now-failed running job). Recompute against
    // the current queue so /api/media-jobs and the initial SSE `queued`
    // event report accurate slots. Positions are lane-scoped: Codex image
    // jobs and GPU jobs each get their own counter so a queued Codex job
    // behind a running GPU job is restored as position 1 (not position 2).
    const isCodexJob = (j) => j.kind === 'image' && j.params?.mode === 'codex';
    let codexCounter = 0;
    let gpuCounter = 0;
    for (const q of queue) {
      if (isCodexJob(q)) {
        q.position = ++codexCounter;
      } else {
        q.position = ++gpuCounter;
      }
    }
    if (persistedJobs.length) {
      console.log(`📦 mediaJobQueue restored: ${queue.length} queued, ${archive.length} archived`);
    }
    // Pre-seed terminal SSE payloads for each restart-failed job so that any
    // client that reconnects to /:jobId/events after a restart (the route
    // attaches via attachSseClient → attachSse, which replays lastPayload)
    // gets an immediate error event instead of a silent stream.
    for (const id of restartedFailedIds) {
      const entry = ensureSseEntry(id);
      broadcastSse(entry, { type: 'error', error: 'interrupted by restart' });
      closeJobAfterDelay(sseJobs, id);
    }
    // Pre-seed SSE entries for recovered queued jobs too. Without this, a
    // client reconnecting to /:jobId/events between boot and the worker
    // dequeueing the job would hit attachSseClient's "no sse entry" branch
    // and synthesize a terminal `error` frame from a still-`queued` archive
    // miss (since the job is in `queue`, not `archive`). The pre-seeded
    // payload also gives the client an immediate `queued` heartbeat with the
    // recomputed position.
    for (const j of queue) {
      const entry = ensureSseEntry(j.id);
      broadcastSse(entry, { type: 'queued', position: j.position });
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

// Both lanes use fire-and-forget so the poll loop is never blocked by a
// running job. This lets a Codex job that arrives while a GPU render is in
// flight be picked up immediately on the next 150 ms tick instead of having
// to wait for the entire GPU job to finish first.
function startLaneJob(job, { isCodex }) {
  queue.splice(queue.indexOf(job), 1);
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  job.position = 1;
  if (isCodex) {
    codexRunning = job;
  } else {
    running = job;
  }
  recomputeQueuePositions();
  persist().catch((e) => console.log(`⚠️ mediaJobQueue persist on ${isCodex ? 'codex' : 'gpu'} start failed: ${e.message}`));
  broadcastSse(ensureSseEntry(job.id), { type: 'started', kind: job.kind });
  mediaJobEvents.emit('started', job);
  console.log(`▶️  media-job [${job.id.slice(0, 8)}] ${isCodex ? 'codex' : job.kind} started`);

  const label = isCodex ? 'codex' : job.kind;
  (async () => {
    try {
      await runJob(job);
    } catch (err) {
      // runJob threw before its own terminal handlers ran (e.g. PYTHON
      // not configured). Recover so a single bad job can't freeze its lane.
      console.log(`❌ media-job [${job.id.slice(0, 8)}] ${label} runJob threw: ${err.message}`);
      if (job.status === 'running') {
        job.status = 'failed';
        job.error = `runJob threw: ${err.message}`;
        job.completedAt = new Date().toISOString();
        broadcastSse(ensureSseEntry(job.id), { type: 'error', error: job.error });
        closeJobAfterDelay(sseJobs, job.id);
        mediaJobEvents.emit('failed', job);
      }
    }
    if (isCodex) {
      codexRunning = null;
    } else {
      running = null;
    }
    archive.push(job);
    recomputeQueuePositions();
    persist().catch((e) => console.log(`⚠️ mediaJobQueue persist on ${label} done failed: ${e.message}`));
  })();
}

async function drainLoop() {
  while (true) {
    // Codex lane: concurrent with GPU lane.
    if (!codexRunning) {
      const nextCodex = queue.find((j) => j.kind === 'image' && j.params?.mode === 'codex');
      if (nextCodex) startLaneJob(nextCodex, { isCodex: true });
    }

    // GPU lane: serialized — at most one video or local-image job at a time.
    if (!running) {
      const nextGpu = queue.find((j) => !(j.kind === 'image' && j.params?.mode === 'codex'));
      if (nextGpu) startLaneJob(nextGpu, { isCodex: false });
    }

    await sleep(150);
  }
}

// Recompute queue positions and notify each waiting SSE client of its new
// slot. Called whenever the queue layout shifts (job dequeued, finished, or
// canceled mid-queue). Without the broadcast, a client connected to
// /:jobId/events would keep showing the position from its original enqueue
// frame even after the line ahead of it cleared.
function recomputeQueuePositions() {
  const isCodexJob = (j) => j.kind === 'image' && j.params?.mode === 'codex';
  const codexJobs = queue.filter(isCodexJob);
  const gpuJobs = queue.filter((j) => !isCodexJob(j));

  codexJobs.forEach((q, i) => {
    const newPosition = i + 1 + (codexRunning ? 1 : 0);
    if (q.position !== newPosition) {
      q.position = newPosition;
      const entry = sseJobs.get(q.id);
      if (entry) broadcastSse(entry, { type: 'queued', position: newPosition });
    }
  });

  gpuJobs.forEach((q, i) => {
    const newPosition = i + 1 + (running ? 1 : 0);
    if (q.position !== newPosition) {
      q.position = newPosition;
      const entry = sseJobs.get(q.id);
      if (entry) broadcastSse(entry, { type: 'queued', position: newPosition });
    }
  });
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
// `message` is synthesized from `step` / `totalSteps` so the existing UIs
// (which display `msg.message` as the status line) keep working through
// the queue, even though the underlying emitters don't supply one.
function synthesizeMessage(e, kind) {
  if (typeof e.step === 'number' && typeof e.totalSteps === 'number' && e.totalSteps > 0) {
    const verb = kind === 'video' ? 'Rendering' : 'Generating';
    return `${verb} step ${e.step}/${e.totalSteps}`;
  }
  return undefined;
}
function makeGenDispatcher(emitter, job, handlers) {
  const onProgress = (e) => {
    if (e.generationId !== job.id) return;
    const hasProgress = typeof e.progress === 'number' && Number.isFinite(e.progress);
    const hasCurrentImage = typeof e.currentImage === 'string' && e.currentImage.length > 0;
    const message = e.message !== undefined ? e.message : synthesizeMessage(e, job.kind);
    if (hasProgress) {
      const payload = { type: 'progress', progress: e.progress };
      if (hasCurrentImage) payload.currentImage = e.currentImage;
      if (message !== undefined) payload.message = message;
      handlers.progress(payload);
      return;
    }
    if (hasCurrentImage) {
      // Preview-only frame (imageGen step thumbnail) — distinct SSE type so
      // existing consumers can keep their progress-bar value untouched.
      const payload = { type: 'preview', currentImage: e.currentImage };
      if (message !== undefined) payload.message = message;
      handlers.progress(payload);
    }
  };
  const onStatus = (e) => {
    // Optional explicit `status` event for gens that want to push a status
    // line independent of progress. Unused today; here so a future emitter
    // can call `videoGenEvents.emit('status', { generationId, message })`.
    if (e.generationId !== job.id) return;
    if (typeof e.message === 'string' && e.message.length > 0) {
      handlers.progress({ type: 'status', message: e.message });
    }
  };
  const onCompleted = (e) => { if (e.generationId === job.id) handlers.completed(e); };
  const onFailed = (e) => { if (e.generationId === job.id) handlers.failed({ error: e.error }); };
  return {
    attach() {
      emitter.on('progress', onProgress);
      emitter.on('status', onStatus);
      emitter.on('completed', onCompleted);
      emitter.on('failed', onFailed);
    },
    detach() {
      emitter.off('progress', onProgress);
      emitter.off('status', onStatus);
      emitter.off('completed', onCompleted);
      emitter.off('failed', onFailed);
    },
  };
}

async function runJob(job) {
  const sseEntry = ensureSseEntry(job.id);

  // Single idempotent terminal sink. All terminal paths (completed, failed,
  // canceled, watchdog) funnel through here. The status check at the top
  // ensures only the first caller wins; any subsequent call (e.g. watchdog
  // fired and then the gen emits 'completed') is a no-op.
  let watchdogTimer;
  function terminate(state, apply) {
    if (job.status !== 'running') return;
    // setInterval now (was setTimeout) — using clearInterval to match the new
    // API. (Node accepts either clearTimeout or clearInterval on the same
    // Timeout handle, so this is purely stylistic.)
    clearInterval(watchdogTimer);
    emitter.off?.('activity', onActivity);
    emitter.off?.('progress', onActivity);
    apply(job);
    job.status = state;
    job.completedAt = new Date().toISOString();
    const logPrefix = state === 'completed' ? '✅' : state === 'canceled' ? '🛑' : '❌';
    const logSuffix = state === 'failed' ? `: ${job.error}` : state === 'canceled' ? ' (was running)' : '';
    console.log(`${logPrefix} media-job [${job.id.slice(0, 8)}] ${state}${logSuffix}`);
    const ssePayload =
      state === 'completed' ? { type: 'complete', result: job.result }
      : state === 'canceled' ? { type: 'canceled', reason: job.error }
      : { type: 'error', error: job.error };
    broadcastSse(sseEntry, ssePayload);
    closeJobAfterDelay(sseJobs, job.id);
    mediaJobEvents.emit(state, job);
  }

  const handlers = {
    progress: (payload) => {
      broadcastSse(sseEntry, payload);
    },
    completed: (payload) => {
      terminate('completed', (j) => { j.result = payload; });
    },
    failed: (payload) => {
      // If cancelJob() flagged this job before the underlying gen reported
      // failure, treat the SIGTERM-induced failure as a clean cancel rather
      // than an error so /api/media-jobs?status=canceled works.
      if (job.cancelRequested) {
        terminate('canceled', (j) => {
          // Persist the reason so a late SSE reconnect after the live entry
          // is cleaned up still gets a meaningful terminal frame from the
          // archived state, rather than the generic "Canceled" fallback.
          j.error = 'Canceled while running';
        });
        return;
      }
      terminate('failed', (j) => { j.error = payload.error || 'unknown error'; });
    },
  };

  // Thread #1: sanitize uploadedTempPath before passing params to the gen
  // module. Even though safeUnlinkUpload guards the *delete* path, the gen
  // module receives the raw job.params spread and could itself act on a
  // corrupted path from a hand-edited media-jobs.json. Null it out here if
  // it doesn't resolve under PATHS.uploads so the constraint holds end-to-end.
  const safeParams = { ...job.params };
  if (safeParams.uploadedTempPath && (typeof safeParams.uploadedTempPath !== 'string' || !isUnderUploadsRoot(safeParams.uploadedTempPath))) {
    console.log(`⚠️ media-job [${job.id.slice(0, 8)}] uploadedTempPath outside PATHS.uploads — nulled before gen invoke: ${safeParams.uploadedTempPath}`);
    safeParams.uploadedTempPath = null;
  }
  if (safeParams.audioFilePath && (typeof safeParams.audioFilePath !== 'string' || !isUnderUploadsRoot(safeParams.audioFilePath))) {
    console.log(`⚠️ media-job [${job.id.slice(0, 8)}] audioFilePath outside PATHS.uploads — nulled before gen invoke: ${safeParams.audioFilePath}`);
    safeParams.audioFilePath = null;
  }
  safeParams.uploadedTempPaths = normalizeTempPaths(safeParams.uploadedTempPaths).filter((p) => {
    if (isUnderUploadsRoot(p)) return true;
    console.log(`⚠️ media-job [${job.id.slice(0, 8)}] uploadedTempPaths entry outside PATHS.uploads — rejected before gen invoke: ${p}`);
    return false;
  });
  // Clamp chunks to the same 1-8 bound the route enforces on new submissions.
  // Replayed jobs read params from media-jobs.json which could be hand-edited
  // to an out-of-range value, bypassing the route-layer Zod validation.
  safeParams.chunks = Math.min(8, Math.max(1, Math.trunc(Number(safeParams.chunks) || 1)));

  const emitter = job.kind === 'video' ? videoGenEvents : imageGenEvents;
  const dispatcher = makeGenDispatcher(emitter, job, handlers);
  dispatcher.attach();

  // Thread #2: per-job idle watchdog — fires when the gen has been silent
  // for the configured window. Switched from "max wall time" to "max idle"
  // because first-run downloads of multi-GB models (Z-Image-Turbo ~13 GB,
  // ERNIE-Image ~16 GB) routinely exceed any sensible total-time bound,
  // but the runner emits stderr lines (tqdm / STAGE markers / status
  // prose) regularly while it's actually working. Any non-noise line in
  // imageGen/videoGen/local.js#handleLine emits 'activity' which resets
  // lastActivityAt; only true hangs (process wedged, no output) trip it.
  const idleTimeoutMs = job.kind === 'video'
    ? WATCHDOG_VIDEO_MS * Math.max(1, Number(safeParams.chunks) || 1)
    : WATCHDOG_IMAGE_MS;
  let lastActivityAt = Date.now();
  const onActivity = (e) => {
    if (e?.generationId === job.id) lastActivityAt = Date.now();
  };
  emitter.on('activity', onActivity);
  // Treat real progress events as activity too — covers the (rare) case
  // where a runner emits structured progress without going through
  // handleLine (e.g. a future direct emit).
  emitter.on('progress', onActivity);
  // setInterval with an async tick can overlap if the await
  // (getGenModuleForJob → dynamic import) takes longer than the interval.
  // Without this guard, two ticks could both pass the post-await
  // status check and both call mod.cancel() + handlers.failed(). The
  // terminal sink in terminate() is idempotent, but mod.cancel() being
  // called twice racing with the SIGKILL escalation is messy. Track an
  // inFlight flag so only one tick is ever past the await at a time.
  let watchdogInFlight = false;
  watchdogTimer = setInterval(async () => {
    if (watchdogInFlight) return;
    if (job.status !== 'running') return;
    const idleFor = Date.now() - lastActivityAt;
    if (idleFor < idleTimeoutMs) return;
    watchdogInFlight = true;
    // try/catch is mandatory here: this body is the listener for an
    // EventEmitter-like setInterval — a rejected await inside an async
    // callback escapes as an unhandled promise rejection (process-killing
    // on Node ≥15). getGenModuleForJob does a dynamic import and can
    // realistically reject under disk pressure / hot-reload / a stale
    // module cache. Route any failure through handlers.failed so the
    // queue still settles, and reset inFlight in finally.
    try {
      const mod = await getGenModuleForJob(job);
      if (job.status !== 'running') return;
      console.log(`⏱️ media-job [${job.id.slice(0, 8)}] watchdog fired after ${idleFor}ms idle (limit ${idleTimeoutMs}ms) — marking failed`);
      if (mod?.cancel) mod.cancel();
      handlers.failed({ error: `watchdog timeout: no runner output for ${Math.round(idleFor / 1000)}s (limit ${Math.round(idleTimeoutMs / 1000)}s)` });
    } catch (err) {
      // Don't take down the server over a watchdog tick that couldn't
      // resolve the gen module. Log and let the next tick retry — if
      // job.status is still 'running', the next idle check will fire
      // again (and may succeed once the import cache stabilizes).
      console.log(`⚠️ media-job [${job.id.slice(0, 8)}] watchdog tick errored: ${err?.message || err}`);
    } finally {
      watchdogInFlight = false;
    }
  }, Math.min(30_000, Math.max(25, Math.floor(idleTimeoutMs / 4))));
  watchdogTimer.unref?.();

  try {
    const mod = await getGenModuleForJob(job);
    if (!mod) throw new Error(`Unknown job kind: ${job.kind}`);
    if (job.kind === 'video' && safeParams.chunks > 1) {
      await mod.generateChainedVideo({ ...safeParams, jobId: job.id });
    } else if (job.kind === 'video') {
      await mod.generateVideo({ ...safeParams, jobId: job.id });
    } else {
      await mod.generateImage({ ...safeParams, jobId: job.id });
    }
  } catch (err) {
    // generateVideo / generateChainedVideo / generateImage threw before
    // reaching their proc.on cleanup hooks (e.g. PYTHON not configured,
    // validation fail). Clean up multipart upload temp files the route
    // handed us so they don't leak under data/uploads.
    // safeUnlinkUpload constrains the delete to PATHS.uploads as
    // defense-in-depth against corrupted persisted params.
    await safeUnlinkUpload(job.params?.uploadedTempPath);
    for (const p of normalizeTempPaths(job.params?.uploadedTempPaths)) {
      await safeUnlinkUpload(p);
    }
    handlers.failed({ error: err.message });
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
    // position counts "where you sit in your lane" — a running job in the
    // same lane occupies slot 1, then same-lane queued jobs follow. Codex
    // jobs only count Codex ahead-of-them; GPU jobs only count GPU jobs.
    position: (() => {
      const isCodex = kind === 'image' && params?.mode === 'codex';
      const laneQueue = queue.filter((j) => (j.kind === 'image' && j.params?.mode === 'codex') === isCodex);
      return laneQueue.length + (isCodex ? (codexRunning ? 1 : 0) : (running ? 1 : 0)) + 1;
    })(),
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

// Bulk-cancel every queued job (optionally filtered by kind: 'image' | 'video').
// Running jobs are left alone — they have to be canceled individually with
// cancelJob(id) so the SIGTERM path runs. Returns the count of jobs that were
// dropped from the queue.
export async function cancelQueuedJobs({ kind } = {}) {
  // Snapshot the IDs before cancel — cancelJob mutates the queue array, and
  // we don't want our iteration to skip entries when prior splices shift
  // indexes. The cancelJob path already handles upload cleanup, archive
  // push, position recompute, and SSE broadcast, so reuse it.
  const ids = queue
    .filter((j) => !kind || j.kind === kind)
    .map((j) => j.id);
  let canceled = 0;
  for (const id of ids) {
    const r = await cancelJob(id);
    if (r?.ok) canceled += 1;
  }
  return { canceled };
}

// Cancel: drops a queued job, or sends SIGTERM to a running gen process.
export async function cancelJob(jobId) {
  const queueIdx = queue.findIndex((j) => j.id === jobId);
  if (queueIdx >= 0) {
    const [job] = queue.splice(queueIdx, 1);
    // Multipart uploads (e.g. /api/video-gen with an image) hand us a path
    // staged under PATHS.uploads. If we drop the job before it starts,
    // runJob never gets a chance to delete it — clean up here so the
    // uploads dir doesn't accumulate. safeUnlinkUpload constrains the
    // delete to PATHS.uploads.
    await safeUnlinkUpload(job.params?.uploadedTempPath);
    for (const p of normalizeTempPaths(job.params?.uploadedTempPaths)) {
      await safeUnlinkUpload(p);
    }
    job.status = 'canceled';
    // Persist the cancel reason on the job so a late SSE reconnect (after
    // the live SSE entry was cleaned up) can synthesize the same terminal
    // payload from the archived state — without this, attachSseClient's
    // post-cleanup terminal frame would just say "Canceled" and lose the
    // more specific "Canceled before start" reason we just broadcast.
    job.error = 'Canceled before start';
    job.completedAt = new Date().toISOString();
    archive.push(job);
    // Removing a queued job shifts everyone behind it up one slot. Recompute
    // + broadcast so clients still attached to those SSE streams see the new
    // position immediately, instead of waiting for the next dequeue.
    recomputeQueuePositions();
    const sseEntry = ensureSseEntry(jobId);
    // Emit `canceled` (not `error`) so clients can distinguish a user-
    // initiated cancellation from a real failure. Mirror the event type
    // emitted for running-job cancellation in runJob's failed handler.
    broadcastSse(sseEntry, { type: 'canceled', reason: job.error });
    closeJobAfterDelay(sseJobs, jobId);
    mediaJobEvents.emit('canceled', job);
    persist().catch(() => {});
    console.log(`🛑 media-job [${jobId.slice(0, 8)}] canceled (was queued)`);
    return { ok: true, status: 'canceled' };
  }
  // Check both the GPU slot and the Codex slot for a running-cancel.
  const runningJob = (running?.id === jobId ? running : null) ?? (codexRunning?.id === jobId ? codexRunning : null);
  if (runningJob) {
    // Flag the job so the dispatcher's `failed` handler treats the SIGTERM-
    // induced failure as `canceled` rather than `failed`. Without this the
    // job would land in archive with status='failed' and listing by
    // status='canceled' would be empty for running cancels.
    runningJob.cancelRequested = true;
    const mod = await getGenModuleForJob(runningJob);
    if (mod?.cancel) mod.cancel();
    console.log(`🛑 media-job [${jobId.slice(0, 8)}] cancel signal sent (was running)`);
    return { ok: true, status: 'canceling' };
  }
  // Distinguish "no such id" from "id exists but is already terminal" so
  // the route layer can map the right HTTP status (404 vs 409).
  const archived = archive.find((j) => j.id === jobId);
  if (archived) {
    return { ok: false, code: 'ALREADY_TERMINAL', status: archived.status, error: `Job is already ${archived.status}` };
  }
  return { ok: false, code: 'NOT_FOUND', error: 'Job not found' };
}

function ensureSseEntry(jobId) {
  if (!sseJobs.has(jobId)) {
    // Shape required by lib/sseUtils.js#{broadcastSse,attachSseClient}.
    sseJobs.set(jobId, { clients: [], lastPayload: null });
  }
  return sseJobs.get(jobId);
}

// Routes call this. Returns false when the jobId is unknown to the queue.
//
// Three cases:
// 1. Live job (queued/running) — sseJobs already has an entry created by
//    enqueueJob; attach replays lastPayload (queued/started/progress).
// 2. Terminal job within the SSE_CLEANUP_DELAY_MS grace window — entry is
//    still around with the terminal lastPayload (complete/error/canceled),
//    so attach immediately replays + the deferred close ends the stream.
// 3. Terminal job after the grace window — entry is gone; we synthesize a
//    one-shot terminal frame from the archived job and end the stream so
//    a late client doesn't hang on an empty SSE stream forever.
export function attachSseClient(jobId, res) {
  const job = findJob(jobId);
  if (!job) return false;
  if (sseJobs.has(jobId)) {
    return attachSse(sseJobs, jobId, res);
  }
  // No SSE entry but the job is still live (queued/running) — the entry was
  // dropped or never created (e.g. crash recovery). Create one on the fly
  // and attach so the client receives subsequent progress/terminal events
  // rather than a synthetic `error` frame for a job that is still running.
  if (job.status === 'queued' || job.status === 'running') {
    const entry = ensureSseEntry(jobId);
    // Seed a heartbeat so the freshly-attached client sees the current
    // status immediately instead of waiting for the next worker emit.
    const heartbeat = job.status === 'queued'
      ? { type: 'queued', position: job.position }
      : { type: 'started', kind: job.kind };
    broadcastSse(entry, heartbeat);
    return attachSse(sseJobs, jobId, res);
  }
  // Terminal job whose SSE entry was already cleaned up. Synthesize the
  // expected terminal payload from the archived state and end immediately.
  const terminal =
    job.status === 'completed' ? { type: 'complete', result: job.result }
    : job.status === 'canceled' ? { type: 'canceled', reason: job.error || 'Canceled' }
    : { type: 'error', error: job.error || `Job ${job.status}` };
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify(terminal)}\n\n`);
  res.end();
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Test-only reset hook. Real callers go through enqueueJob/cancelJob.
export function __resetForTests() {
  queue.length = 0;
  running = null;
  codexRunning = null;
  archive.length = 0;
  sseJobs.clear();
  workerStarted = false;
  initPromise = null;
  // Reset the persist chain so a leftover rejection from a previous test's
  // ENOENT writes doesn't poison subsequent persist() calls.
  persistChain = Promise.resolve();
}
