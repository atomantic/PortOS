/**
 * Media Job Queue — lane-aware FIFO for image + video gen jobs.
 *
 * Why this exists: video gen (mlx_video) and image gen (mflux/diffusers) both
 * spawn heavy GPU/Metal child processes. Running two simultaneously OOMs the
 * machine, so the gen modules used to throw 409 BUSY when one was already in
 * flight. The codex image provider had the same single-flight constraint at
 * the provider level. That made any agent-driven pipeline (Creative Director,
 * writers-room storyboard) need to retry/backoff. This queue serializes
 * submissions so callers always get an immediate `queued` ack and watch
 * progress via SSE.
 *
 * Lanes: jobs run concurrently across lanes but serialize within a lane.
 *   - `gpu` lane: videoGen/local + imageGen/local — share the MLX/Metal
 *     runtime and OOM together, so they all share a single slot.
 *   - `codex` lane: imageGen/codex — runs the external `codex` CLI, doesn't
 *     touch the MLX runtime, gets its own slot so a writers-room storyboard
 *     burst doesn't sit behind unrelated video work.
 *
 * Scope: gates `videoGen/local#generateVideo` (always),
 * `imageGen/local#generateImage` (when imageGen mode === 'local'), and
 * `imageGen/codex#generateImage` (when imageGen mode === 'codex'). The
 * external SD-API backend bypasses the queue — it's a remote call with no
 * shared local state.
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

// Walks both `uploadedTempPath` (single, start-frame upload) and
// `uploadedTempPaths` (array, additional staged uploads such as the FFLF
// lastImage) so cleanup paths stay agnostic to which fields contributed.
async function safeUnlinkAllUploads(params) {
  if (!params) return;
  await safeUnlinkUpload(params.uploadedTempPath);
  if (Array.isArray(params.uploadedTempPaths)) {
    for (const p of params.uploadedTempPaths) await safeUnlinkUpload(p);
  }
}

export const JOB_KINDS = Object.freeze(['video', 'image']);
export const JOB_STATUSES = Object.freeze(['queued', 'running', 'completed', 'failed', 'canceled']);

export const mediaJobEvents = new EventEmitter();

// Lane keying — controls which jobs share a single in-flight slot.
//
// `gpu` lane: video gen (mlx_video) + local image gen (mflux/diffusers/flux2)
// share the Metal/MLX runtime and OOM the box if they run together, so only
// one runs at a time across both kinds.
//
// `codex` lane: codex CLI image gen runs externally (it shells out to the
// user's locally-installed `codex` binary, which doesn't touch our GPU/MLX
// runtime). It needs its own slot so a queued storyboard render doesn't sit
// behind a video render that has nothing to do with it. Multiple codex jobs
// still serialize against EACH OTHER on this lane (the codex provider only
// holds one child process at a time).
const LANE_GPU = 'gpu';
const LANE_CODEX = 'codex';

const isCodexJob = (job) => job.kind === 'image' && job.params?.mode === 'codex';

function laneForJob(job) {
  return isCodexJob(job) ? LANE_CODEX : LANE_GPU;
}

// Resolve the gen module that owns the job's process so cancel() and the
// watchdog know which provider's `cancel()` to call. Codex image jobs route
// through a separate provider from local image jobs even though they share
// the kind='image' bucket, so dispatching by kind alone wouldn't suffice.
async function importGenModuleForJob(job) {
  if (job.kind === 'video') return import('../videoGen/local.js');
  if (job.kind === 'image') {
    return isCodexJob(job)
      ? import('../imageGen/codex.js')
      : import('../imageGen/local.js');
  }
  return null;
}

// Live state. `queue` holds pending jobs in submission order. `running` maps
// lane → job (at most one job per lane at any time). `archive` holds
// recently-finished jobs (visible for ~24h via /api/media-jobs?status=completed).
const queue = [];
const running = new Map();
const archive = [];

// Snapshot of all currently-running jobs as an array, in lane-insertion order.
// Convenience for the persistence + listing paths that previously did
// `running ? [running] : []`.
const runningArray = () => Array.from(running.values());

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
  for (const r of running.values()) {
    if (r.id === jobId) return r;
  }
  const inQueue = queue.find((j) => j.id === jobId);
  if (inQueue) return inQueue;
  return archive.find((j) => j.id === jobId) || null;
}

export function getJob(jobId) {
  return findJob(jobId);
}

export function listJobs({ status, kind, owner } = {}) {
  const all = [
    ...runningArray(),
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
    ...runningArray(),
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
        // multipart uploads it staged into data/uploads would leak forever.
        // safeUnlinkAllUploads constrains each delete to PATHS.uploads so we
        // never delete a file the job merely referenced (gallery image,
        // prior render, etc).
        safeUnlinkAllUploads(j.params);
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

async function drainLoop() {
  while (true) {
    // Walk the queue in submission order and start the first job in each
    // currently-free lane. Lanes run concurrently — a codex render and a
    // video render can be in flight at the same time without sharing a
    // single global slot. Within a lane, jobs serialize FIFO.
    let started = false;
    for (let i = 0; i < queue.length; i++) {
      const j = queue[i];
      const lane = laneForJob(j);
      if (running.has(lane)) continue;
      const [job] = queue.splice(i, 1);
      i--;
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      // The running job is always slot 1 in its lane. Without this, a job
      // dequeued from position 2 (queued behind another lane-mate that just
      // finished) would keep its old position=2 even while running.
      job.position = 1;
      running.set(lane, job);
      // Recompute positions for everyone still queued AND broadcast the new
      // position over SSE so clients listening to /:jobId/events see their
      // updated slot instead of staying frozen at the original enqueue-time
      // value.
      recomputeQueuePositions();
      persist().catch((e) => console.log(`⚠️ mediaJobQueue persist on start failed: ${e.message}`));
      broadcastSse(ensureSseEntry(job.id), { type: 'started', kind: job.kind });
      mediaJobEvents.emit('started', job);
      console.log(`▶️  media-job [${job.id.slice(0, 8)}] ${job.kind} started (lane=${lane})`);
      // Detach: each lane runs its own job concurrently. runJobInLane wraps
      // runJob with the lane cleanup (release the lane, archive, recompute,
      // persist) so when this iteration of the drainLoop continues we can
      // start the next free-lane job without waiting for the in-flight one.
      runJobInLane(job, lane);
      started = true;
    }
    if (!started) await sleep(150);
  }
}

async function runJobInLane(job, lane) {
  // The worker is a top-level fire-and-forget — if runJob throws unexpectedly
  // (an unhandled emitter / listener edge case, etc.), an uncaught error here
  // would orphan the lane (running.has(lane) would stay true forever and
  // freeze that lane's queue). Catch + recover so a single bad job can't kill
  // the lane.
  try {
    await runJob(job);
  } catch (err) {
    console.log(`❌ media-job [${job.id.slice(0, 8)}] runJob threw: ${err.message}`);
    if (job.status === 'running') {
      job.status = 'failed';
      job.error = `runJob threw: ${err.message}`;
      job.completedAt = new Date().toISOString();
      broadcastSse(ensureSseEntry(job.id), { type: 'error', error: job.error });
      closeJobAfterDelay(sseJobs, job.id);
      mediaJobEvents.emit('failed', job);
    }
  }
  running.delete(lane);
  archive.push(job);
  // Now that the lane is free, every same-lane queued job has shifted up
  // one slot. Recompute immediately so /api/media-jobs and any subsequent
  // persist() see accurate positions even before the next dequeue, and
  // broadcast the new position to each waiting client.
  recomputeQueuePositions();
  persist().catch((e) => console.log(`⚠️ mediaJobQueue persist on done failed: ${e.message}`));
}

// Recompute queue positions and notify each waiting SSE client of its new
// slot. Called whenever the queue layout shifts (job dequeued, finished, or
// canceled mid-queue). Without the broadcast, a client connected to
// /:jobId/events would keep showing the position from its original enqueue
// frame even after the line ahead of it cleared.
//
// Position is per-lane: a queued GPU job sits behind only the running GPU
// job + other queued GPU jobs, ignoring codex jobs entirely (and vice versa).
// Without this, a writers-room storyboard with 5 codex renders queued behind
// one running video would show position 6, which is misleading — the codex
// jobs have nothing to wait on except each other.
function recomputeQueuePositions() {
  const counters = new Map();
  for (const lane of running.keys()) {
    counters.set(lane, 1); // running occupies slot 1 in its lane
  }
  for (const q of queue) {
    const lane = laneForJob(q);
    const newPosition = (counters.get(lane) ?? 0) + 1;
    counters.set(lane, newPosition);
    if (q.position !== newPosition) {
      q.position = newPosition;
      const entry = sseJobs.get(q.id);
      if (entry) broadcastSse(entry, { type: 'queued', position: newPosition });
    }
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
    clearTimeout(watchdogTimer);
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

  // Thread #1: sanitize uploadedTempPath(s) before passing params to the gen
  // module. Even though safeUnlinkUpload guards the *delete* path, the gen
  // module receives the raw job.params spread and could itself act on a
  // corrupted path from a hand-edited media-jobs.json. Null/strip anything
  // that doesn't resolve under PATHS.uploads so the constraint holds end-to-end.
  const safeParams = { ...job.params };
  if (safeParams.uploadedTempPath && (typeof safeParams.uploadedTempPath !== 'string' || !isUnderUploadsRoot(safeParams.uploadedTempPath))) {
    console.log(`⚠️ media-job [${job.id.slice(0, 8)}] uploadedTempPath outside PATHS.uploads — nulled before gen invoke: ${safeParams.uploadedTempPath}`);
    safeParams.uploadedTempPath = null;
  }
  if (Array.isArray(safeParams.uploadedTempPaths)) {
    const filtered = safeParams.uploadedTempPaths.filter((p) => {
      if (typeof p === 'string' && isUnderUploadsRoot(p)) return true;
      console.log(`⚠️ media-job [${job.id.slice(0, 8)}] uploadedTempPaths entry outside PATHS.uploads — dropped before gen invoke: ${p}`);
      return false;
    });
    safeParams.uploadedTempPaths = filtered;
  } else if (safeParams.uploadedTempPaths != null) {
    // Persisted as a non-array (corrupted JSON) — drop it rather than feed
    // a non-iterable into the worker's cleanup loop.
    safeParams.uploadedTempPaths = [];
  }

  const emitter = job.kind === 'video' ? videoGenEvents : imageGenEvents;
  const dispatcher = makeGenDispatcher(emitter, job, handlers);
  dispatcher.attach();

  // Thread #2: per-job watchdog — fires if the gen never emits a terminal
  // event (hung child process or emitter regression). On trigger it marks
  // the job failed via the normal handlers path (SSE + mediaJobEvents +
  // persistence all fire) and best-effort cancels the underlying process
  // so the queue can make forward progress.
  // Renamed from `watchdogMs` to avoid shadowing the top-level
  // `watchdogMs(envValue, defaultMs)` helper that parses the env-var
  // overrides. Both lived as `watchdogMs` previously and made the call
  // site easy to misread.
  // Multi-chunk video chains run N renders end-to-end, so the wall time
  // scales linearly with chunks. Without this the watchdog would SIGTERM
  // the chain mid-stream on a healthy 4-chunk render. Route-side Zod has
  // already validated chunks ∈ 1..8.
  const chunks = Number(job.params?.chunks) || 1;
  const watchdogTimeoutMs = job.kind === 'video'
    ? WATCHDOG_VIDEO_MS * chunks
    : WATCHDOG_IMAGE_MS;
  watchdogTimer = setTimeout(async () => {
    // Two-stage status guard: first check stops us if the gen settled
    // before the timer fired. The await on the dynamic import below opens
    // a window during which a natural completion / failure could land —
    // re-check after the await so we don't fire `handlers.failed` and
    // SIGTERM the *next* job's child (cancel() targets the gen module's
    // current activeProcess; once handlers.failed marks this job
    // terminal, runJob's await exits and the worker advances).
    if (job.status !== 'running') return;
    const mod = await importGenModuleForJob(job);
    if (job.status !== 'running') return;
    console.log(`⏱️ media-job [${job.id.slice(0, 8)}] watchdog fired after ${watchdogTimeoutMs}ms — marking failed`);
    // Cancel BEFORE marking failed — that ordering keeps the SIGTERM
    // pointed at *this* job's child. The gen module will then emit its
    // own 'failed' event, but the terminate() guard makes it a no-op.
    if (mod?.cancel) mod.cancel();
    handlers.failed({ error: `watchdog timeout: job exceeded ${watchdogTimeoutMs}ms` });
  }, watchdogTimeoutMs);
  // Ensure the timer doesn't keep Node alive after the job settles.
  watchdogTimer.unref?.();

  try {
    if (job.kind === 'video') {
      // Route to the chain orchestrator when chunks > 1. The chain function
      // delegates to generateVideo for chunks=1, so we could always call it,
      // but keeping the chunks=1 path on plain generateVideo means the simple
      // case never carries chain bookkeeping or the activeChain global.
      const wantsChain = Number(safeParams.chunks) > 1;
      const mod = await import('../videoGen/local.js');
      const fn = wantsChain ? mod.generateChainedVideo : mod.generateVideo;
      await fn({ ...safeParams, jobId: job.id });
    } else if (job.kind === 'image') {
      const { generateImage } = isCodexJob(job)
        ? await import('../imageGen/codex.js')
        : await import('../imageGen/local.js');
      await generateImage({ ...safeParams, jobId: job.id });
    } else {
      throw new Error(`Unknown job kind: ${job.kind}`);
    }
  } catch (err) {
    // generateVideo / generateImage threw before reaching their proc.on
    // cleanup hooks (e.g. PYTHON not configured, validation fail). Clean up
    // every multipart upload temp file the route handed us so they don't
    // leak under data/uploads. safeUnlinkAllUploads constrains each delete
    // to PATHS.uploads as defense-in-depth against corrupted persisted params.
    await safeUnlinkAllUploads(job.params);
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
  const probe = { kind, params };
  const lane = laneForJob(probe);
  // Per-lane position: running same-lane job (if any) occupies slot 1, then
  // queued same-lane jobs follow. Cross-lane jobs don't add to this count.
  const sameLaneQueued = queue.filter((j) => laneForJob(j) === lane).length;
  const position = sameLaneQueued + (running.has(lane) ? 1 : 0) + 1;
  const job = {
    id,
    kind,
    owner,
    status: 'queued',
    queuedAt: new Date().toISOString(),
    params,
    position,
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
    // Multipart uploads (e.g. /api/video-gen with an image — start frame,
    // end frame, or both) are staged under PATHS.uploads. If we drop the
    // job before it starts, runJob never gets a chance to delete them —
    // clean up here so the uploads dir doesn't accumulate. Each delete is
    // constrained to PATHS.uploads.
    await safeUnlinkAllUploads(job.params);
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
  for (const r of running.values()) {
    if (r.id !== jobId) continue;
    // Flag the job so the dispatcher's `failed` handler treats the SIGTERM-
    // induced failure as `canceled` rather than `failed`. Without this the
    // job would land in archive with status='failed' and listing by
    // status='canceled' would be empty for running cancels.
    r.cancelRequested = true;
    const mod = await importGenModuleForJob(r);
    mod?.cancel?.();
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
  running.clear();
  archive.length = 0;
  sseJobs.clear();
  workerStarted = false;
  initPromise = null;
  // Reset the persist chain so a leftover rejection from a previous test's
  // ENOENT writes doesn't poison subsequent persist() calls.
  persistChain = Promise.resolve();
}
