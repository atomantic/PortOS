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
 * they share the MLX runtime. Codex image jobs run in a parallel `cloudRunning`
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
import { PATHS, readJSONFile, atomicWrite, ensureDir, sleep } from '../../lib/fileUtils.js';
import { SSE_HEADERS } from '../../lib/sseHeaders.js';
import { reapAndCleanDetachedDirs } from '../../lib/detachedSpawn.js';
import {
  broadcastSse,
  attachSseClient as attachSse,
  closeJobAfterDelay,
} from '../../lib/sseUtils.js';
import { videoGenEvents } from '../videoGen/events.js';
import { imageGenEvents } from '../imageGenEvents.js';
import { trainingEvents } from '../loraTraining/events.js';
import { audioGenEvents } from '../audioGen/events.js';
import { getSettings } from '../settings.js';
import { IMAGE_GEN_MODE, CLOUD_IMAGE_GEN_MODES } from '../imageGen/modes.js';

// Cloud-CLI jobs (codex/grok images, grok videos) share one parallel lane —
// each render
// shells out to its own external child spending remote quota, so they don't
// serialize on the MLX runtime the way GPU jobs do. The lane's slot count is
// `codexParallelLimit` (settings key `imageGen.codex.parallelLimit`, kept
// under the codex name for backward compat — it now bounds codex + grok
// renders combined).
const isCloudImageJob = (j) =>
  (j.kind === 'image' && CLOUD_IMAGE_GEN_MODES.includes(j.params?.mode))
  || (j.kind === 'video' && j.params?.mode === IMAGE_GEN_MODE.GROK);

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
// Codex jobs are silent until completion — no per-step output to reset the
// idle watchdog. With parallel codex renders sharing OpenAI throughput, a
// single render can easily exceed 5 minutes wall-clock, so the image-kind
// default trips false positives. 20 minutes covers a slow generation +
// queueing delay, and is env-overridable when batch limits change.
const WATCHDOG_CODEX_MS = watchdogMs(process.env.MEDIA_JOB_WATCHDOG_CODEX_MS, 20 * 60 * 1000);
// Training is idle-based like video — per-step STEP: lines and the python
// heartbeat thread reset it, so 30 minutes only trips on true hangs (model
// download stalls emit tqdm lines; GIL-pinned wedges emit nothing).
const WATCHDOG_TRAINING_MS = watchdogMs(process.env.MEDIA_JOB_WATCHDOG_TRAINING_MS, 30 * 60 * 1000);
// Audio (music-bed) generation is a single short sidecar call (≤240s of
// rendered audio across all engines) but a cold model download can still take
// a while on a slow connection — mirrors the image-kind rationale. The
// sidecar's STAGE: lines reset the idle clock via 'activity' (audioGen/local.js
// threads them through), so this only trips on a genuine hang, not a slow
// first-run download.
const WATCHDOG_AUDIO_MS = watchdogMs(process.env.MEDIA_JOB_WATCHDOG_AUDIO_MS, 10 * 60 * 1000);
const PROGRESS_PERSIST_DEBOUNCE_MS = 250;

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

export const JOB_KINDS = Object.freeze(['video', 'image', 'training', 'audio']);
export const JOB_STATUSES = Object.freeze(['queued', 'running', 'completed', 'failed', 'canceled']);

// Returns a Promise that resolves to the gen module for the given job's
// provider (video/local, imageGen/local, or imageGen/codex). Single source
// of provider-dispatch truth — used by the watchdog, runJob, and cancelJob
// so a new provider addition is one edit instead of three.
function getGenModuleForJob(job) {
  if (job.kind === 'video' && job.params?.mode === IMAGE_GEN_MODE.GROK) return import('../videoGen/grok.js');
  if (job.kind === 'video') return import('../videoGen/local.js');
  if (job.kind === 'training') return import('../loraTraining/index.js');
  if (job.kind === 'audio') return import('../audioGen/local.js');
  if (job.kind === 'image' && job.params?.mode === IMAGE_GEN_MODE.CODEX) return import('../imageGen/codex.js');
  if (job.kind === 'image' && job.params?.mode === IMAGE_GEN_MODE.GROK) return import('../imageGen/grok.js');
  if (job.kind === 'image') return import('../imageGen/local.js');
  return Promise.resolve(null);
}

// #1332: probe (via loraTraining, which owns the run's on-disk layout) whether
// a training run's detached trainer survived the restart and is worth
// re-attaching to. Lazy import avoids a static cycle (loraTraining statically
// imports this module). Never throws — a missing module / probe error reads as
// "not reattachable" so the reconcile falls back to the fail path.
async function jobHasSurvivingTrainer(runId) {
  const mod = await import('../loraTraining/index.js').catch(() => null);
  if (!mod?.hasSurvivingTrainer) return false;
  return mod.hasSurvivingTrainer(runId).catch(() => false);
}

// Drop the params snapshot of pythonPath; live settings always win for
// local-Python jobs so a stale persisted snapshot can't poison the spawn.
// Future live-resolved fields (e.g. model.runtime-aware overrides) belong
// here so the seam stays in one place instead of accreting into runJob.
// Mutates safeParams in place.
async function resolveLiveParams(job, safeParams) {
  // mflux training runs in the same venv as local image renders, so the
  // live settings pythonPath wins there too. flux2 training resolves its
  // own venv (resolveFlux2Python) inside runTraining — skip it here.
  const usesLocalPython = (job.kind === 'video' && job.params?.mode !== IMAGE_GEN_MODE.GROK)
    || (job.kind === 'image' && !CLOUD_IMAGE_GEN_MODES.includes(job.params?.mode))
    || (job.kind === 'training' && job.params?.runtime === 'mflux');
  if (!usesLocalPython) return;
  const live = await getSettings().catch(() => null);
  const livePythonPath = live?.imageGen?.local?.pythonPath || null;
  if (livePythonPath && livePythonPath !== safeParams.pythonPath) {
    console.log(`🐍 media-job [${job.id.slice(0, 8)}] pythonPath re-resolved from settings: ${safeParams.pythonPath} → ${livePythonPath}`);
  }
  safeParams.pythonPath = livePythonPath;
}

export const mediaJobEvents = new EventEmitter();

// GPU lane: serialized — `running` holds at most one job (the MLX runtime can't
// share VRAM). Codex lane: up to `codexParallelLimit` jobs in `cloudRunning[]`
// since each call shells out to its own external child process. `queue` is
// shared submission order. `archive` is recently-finished jobs (~24h TTL),
// including canceled ones so /api/media-jobs?status=canceled and the recent-
// reel UI can still find them within the 24h window.
const queue = [];
let running = null;
const cloudRunning = [];
const archive = [];

export const CODEX_PARALLEL_MIN = 1;
export const CODEX_PARALLEL_MAX = 10;
export const CODEX_PARALLEL_DEFAULT = 1;
let codexParallelLimit = CODEX_PARALLEL_DEFAULT;
const clampParallel = (n) => {
  const x = Number(n);
  if (!Number.isFinite(x) || x < 1) return CODEX_PARALLEL_DEFAULT;
  return Math.min(Math.floor(x), CODEX_PARALLEL_MAX);
};
export const getCodexParallelLimit = () => codexParallelLimit;
export function setCodexParallelLimit(n) {
  codexParallelLimit = clampParallel(n);
  return codexParallelLimit;
}
export async function refreshCodexParallelLimit() {
  const s = await getSettings();
  return setCodexParallelLimit(s?.imageGen?.codex?.parallelLimit ?? CODEX_PARALLEL_DEFAULT);
}

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
  const codexHit = cloudRunning.find((j) => j.id === jobId);
  if (codexHit) return codexHit;
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
    ...cloudRunning,
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
    ...cloudRunning,
    ...queue,
    ...archive,
  ];
  // Strip non-serializable bits.
  const serializable = live.map(({ id, kind, owner, status, queuedAt, startedAt, completedAt, params, result, error, position, progress, statusMsg }) =>
    ({ id, kind, owner, status, queuedAt, startedAt, completedAt, params, result, error, position, progress, statusMsg }),
  );
  await atomicWrite(JOBS_FILE, { jobs: serializable });
}

export async function initMediaJobQueue() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    // Once-at-boot: subsequent persist() calls assume the data dir exists.
    await ensureDir(PATHS.data);
    // Read the codex parallel limit before the worker starts so the first
    // drain tick honors the user's configured value, not the default.
    await refreshCodexParallelLimit().catch(() => {});
    const data = await readJSONFile(JOBS_FILE, { jobs: [] });
    const persistedJobs = Array.isArray(data?.jobs) ? data.jobs : [];
    const restartedFailedIds = [];
    // #1332: training jobs whose detached trainer survived the restart, to be
    // re-enqueued (flagged for re-attach) at the FRONT of the queue so they
    // resume before any new GPU work — collected during the reconcile, unshifted
    // after it (so the position recompute below sees them).
    const reattachJobs = [];
    // Video renders spawn a detached child that survives a pm2 restart, so an
    // interrupted render may still be alive and holding the GPU. Reap every
    // orphan under data/videos/.detached (and clean the scratch dirs) BEFORE
    // freeing lanes below — a job-id keyed reap would miss chained renders,
    // whose live child lives under a random inner chunk id, not the outer queue
    // job id. (Training children are handled per-job below: a survivor is
    // re-attached (#1332), and only a genuinely-dead one is reaped+failed in
    // initLoraTraining.) This runs before the worker starts, so every dir
    // present is an orphan from the prior process.
    const videoReap = await reapAndCleanDetachedDirs(join(PATHS.videos, '.detached')).catch(() => ({ reaped: 0 }));
    if (videoReap.reaped) console.log(`🧹 reaped ${videoReap.reaped} surviving render(s) on boot`);

    for (const j of persistedJobs) {
      if (j.status === 'running') {
        // #1332: a LoRA trainer is a detached child (spawnDetached) that can
        // SURVIVE this restart. If its run still has a live (or just-finished-
        // but-unprocessed) trainer, re-enqueue the SAME job flagged for
        // re-attach instead of failing it — runTraining({reattach:true}) tails
        // the survivor's output and finalizes it, so a run that completed during
        // the downtime still registers its LoRA. The probe lives in loraTraining
        // (it owns the run's on-disk layout); lazy-imported to avoid a static
        // cycle. Falls through to the fail path when nothing survived.
        // eslint-disable-next-line no-await-in-loop
        if (j.kind === 'training' && j.params?.runId && await jobHasSurvivingTrainer(j.params.runId)) {
          reattachJobs.push({ ...j, status: 'queued', params: { ...j.params, reattach: true } });
          console.log(`🔁 media-job [${j.id.slice(0, 8)}] training survived restart — re-enqueued for re-attach`);
          continue;
        }
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
        // prior render, etc). audioFilePath is the same kind of staged
        // upload (a2v/voice/video jobs) — needs the same cleanup.
        safeUnlinkUpload(j.params?.uploadedTempPath);
        safeUnlinkUpload(j.params?.audioFilePath);
        for (const p of normalizeTempPaths(j.params?.uploadedTempPaths)) {
          safeUnlinkUpload(p);
        }
      } else if (j.status === 'queued') {
        queue.push({ ...j });
      } else {
        archive.push(j);
      }
    }
    // Re-attach jobs resume ahead of everything else (they were mid-flight), so
    // unshift them to the front. At most one (single GPU lane), but spread keeps
    // their relative order if that ever changes.
    if (reattachJobs.length) queue.unshift(...reattachJobs);
    // The persisted `position` reflects the previous process' queue layout
    // (which may have included a now-failed running job). Recompute against
    // the current queue so /api/media-jobs and the initial SSE `queued`
    // event report accurate slots. Positions are lane-scoped: Codex image
    // jobs and GPU jobs each get their own counter so a queued Codex job
    // behind a running GPU job is restored as position 1 (not position 2).
    let cloudCounter = 0;
    let gpuCounter = 0;
    for (const q of queue) {
      if (isCloudImageJob(q)) {
        q.position = ++cloudCounter;
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
function startLaneJob(job, { isCloud }) {
  // If the job isn't in the queue, it was already promoted (e.g. by a parallel
  // runJobNow). Skip — promoting again would double-start the job and corrupt
  // the lane (push it onto cloudRunning/running twice). Silently splice(-1)
  // would also lop the wrong job off the queue.
  const idx = queue.indexOf(job);
  if (idx < 0) {
    console.log(`⚠️ media-job [${job.id.slice(0, 8)}] startLaneJob: already removed from queue, skipping`);
    return;
  }
  queue.splice(idx, 1);
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  job.position = 1;
  job.progress = typeof job.progress === 'number' && Number.isFinite(job.progress) ? job.progress : 0;
  job.statusMsg = job.statusMsg || 'Starting';
  if (isCloud) {
    cloudRunning.push(job);
  } else {
    running = job;
  }
  recomputeQueuePositions();
  const label = isCloud ? (job.params?.mode || 'cloud') : job.kind;
  persist().catch((e) => console.log(`⚠️ mediaJobQueue persist on ${label} start failed: ${e.message}`));
  broadcastSse(ensureSseEntry(job.id), { type: 'started', kind: job.kind });
  mediaJobEvents.emit('started', job);
  console.log(`▶️  media-job [${job.id.slice(0, 8)}] ${label} started`);
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
    if (isCloud) {
      const idx = cloudRunning.indexOf(job);
      if (idx >= 0) cloudRunning.splice(idx, 1);
    } else {
      running = null;
    }
    // Archive every terminal job (completed / failed / canceled). The 24h
    // TTL prune in persistImpl keeps the file from growing unbounded, and
    // the UI's recent-reel cap (recentLimit) handles in-memory display.
    archive.push(job);
    recomputeQueuePositions();
    persist().catch((e) => console.log(`⚠️ mediaJobQueue persist on ${label} done failed: ${e.message}`));
  })();
}

async function drainLoop() {
  while (true) {
    // Single queue scan, promote eligible codex jobs while there's room and a
    // GPU job if the lane is open. Stops cleanly on an empty queue.
    let gpuOpen = !running;
    let cloudSlots = codexParallelLimit - cloudRunning.length;
    if ((gpuOpen || cloudSlots > 0) && queue.length > 0) {
      for (const job of queue.slice()) {
        if (isCloudImageJob(job)) {
          if (cloudSlots > 0) {
            startLaneJob(job, { isCloud: true });
            cloudSlots -= 1;
          }
        } else if (gpuOpen) {
          startLaneJob(job, { isCloud: false });
          gpuOpen = false;
        }
        if (!gpuOpen && cloudSlots <= 0) break;
      }
    }
    await sleep(150);
  }
}

// Drop a job from the archive (e.g. after a successful retry — the old failed
// row shouldn't keep cluttering the recent-reel UI now that a fresh job has
// inherited its work). Returns true if removed, false if the id wasn't found
// or was still live. Live jobs are deliberately left alone — the caller
// should cancel them first.
export function removeArchivedJob(jobId) {
  const idx = archive.findIndex((j) => j.id === jobId);
  if (idx < 0) return false;
  archive.splice(idx, 1);
  // End any SSE clients still attached within the SSE_CLEANUP_DELAY_MS grace
  // window before dropping the entry — a bare `sseJobs.delete()` here would
  // leave their HTTP responses dangling because closeJobAfterDelay's pending
  // timer would find no entry to drain when it fires.
  const sseEntry = sseJobs.get(jobId);
  if (sseEntry) {
    for (const c of sseEntry.clients) c.end();
    sseJobs.delete(jobId);
  }
  persist().catch((e) => console.log(`⚠️ mediaJobQueue persist on archive prune failed: ${e.message}`));
  return true;
}

// "Run now" bypass — start a queued cloud-CLI (codex/grok) job immediately
// even if the lane is at its limit. GPU jobs are rejected (single MLX runtime
// would OOM). The rejection code stays 'NOT_CODEX' for client back-compat.
export function runJobNow(jobId) {
  const job = queue.find((j) => j.id === jobId);
  if (!job) return { ok: false, code: 'NOT_FOUND', error: 'Job not found in queue' };
  if (!isCloudImageJob(job)) {
    return { ok: false, code: 'NOT_CODEX', error: 'Only cloud-CLI (Codex/Grok) image jobs can be run-now; GPU jobs serialize on the MLX runtime' };
  }
  startLaneJob(job, { isCloud: true });
  return { ok: true, status: 'running' };
}

// Recompute queue positions and notify each waiting SSE client of its new
// slot. Called whenever the queue layout shifts (job dequeued, finished, or
// canceled mid-queue). Without the broadcast, a client connected to
// /:jobId/events would keep showing the position from its original enqueue
// frame even after the line ahead of it cleared.
function recomputeQueuePositions() {
  const cloudJobs = queue.filter(isCloudImageJob);
  const gpuJobs = queue.filter((j) => !isCloudImageJob(j));

  cloudJobs.forEach((q, i) => {
    const newPosition = i + 1 + cloudRunning.length;
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
    const verb = kind === 'video' ? 'Rendering' : kind === 'training' ? 'Training' : 'Generating';
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
    // Structured step/loss ride along on the wire when the emitter supplies
    // them (LoRA training does) so the client plots a loss curve and keys
    // sample thumbnails by step instead of re-parsing the message string.
    // Additive + presence-guarded — image/video gen omit them, unaffected.
    const addStepFields = (payload) => {
      if (typeof e.step === 'number') payload.step = e.step;
      if (typeof e.totalSteps === 'number') payload.totalSteps = e.totalSteps;
      if (typeof e.loss === 'number') payload.loss = e.loss;
    };
    if (hasProgress) {
      const payload = { type: 'progress', progress: e.progress };
      if (hasCurrentImage) payload.currentImage = e.currentImage;
      if (message !== undefined) payload.message = message;
      addStepFields(payload);
      handlers.progress(payload);
      return;
    }
    if (hasCurrentImage) {
      // Preview-only frame (imageGen step thumbnail) — distinct SSE type so
      // existing consumers can keep their progress-bar value untouched.
      const payload = { type: 'preview', currentImage: e.currentImage };
      if (message !== undefined) payload.message = message;
      addStepFields(payload);
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
  let progressPersistDirty = false;
  let progressPersistTimer = null;
  let progressPersisting = null;

  const flushProgressPersist = async () => {
    if (progressPersistTimer) {
      clearTimeout(progressPersistTimer);
      progressPersistTimer = null;
    }
    if (!progressPersistDirty) return;
    progressPersistDirty = false;
    await persist().catch((e) => console.log(`⚠️ mediaJobQueue persist on progress failed: ${e.message}`));
  };

  const drainProgressPersist = async () => {
    if (progressPersisting) await progressPersisting.catch(() => {});
    await flushProgressPersist();
  };

  const scheduleProgressPersist = () => {
    progressPersistDirty = true;
    if (progressPersistTimer || progressPersisting) return;
    progressPersistTimer = setTimeout(() => {
      progressPersistTimer = null;
      progressPersisting = flushProgressPersist().finally(() => {
        progressPersisting = null;
        if (progressPersistDirty) scheduleProgressPersist();
      });
    }, PROGRESS_PERSIST_DEBOUNCE_MS);
    progressPersistTimer.unref?.();
  };

  // Single idempotent terminal sink. All terminal paths (completed, failed,
  // canceled, watchdog) funnel through here. The status check at the top
  // ensures only the first caller wins; any subsequent call (e.g. watchdog
  // fired and then the gen emits 'completed') is a no-op.
  //
  // `job.terminating` (not a closure-local) is the guard so cancelJob — a
  // module-level function — can also see that a terminal transition has begun.
  // It's set synchronously before the async drain below, during which
  // job.status is still 'running'; a cancel arriving in that window must not
  // fire a redundant provider cancel. It's a transient in-memory flag
  // (excluded from persistImpl's serialized field set).
  let watchdogTimer;
  async function terminate(state, apply) {
    if (job.terminating || job.status !== 'running') return;
    job.terminating = true;
    // setInterval now (was setTimeout) — using clearInterval to match the new
    // API. (Node accepts either clearTimeout or clearInterval on the same
    // Timeout handle, so this is purely stylistic.)
    clearInterval(watchdogTimer);
    emitter.off?.('activity', onActivity);
    emitter.off?.('progress', onActivity);
    await drainProgressPersist();
    apply(job);
    job.status = state;
    if (state === 'completed') {
      job.progress = 1;
      job.statusMsg = 'Completed';
    }
    // failed/canceled intentionally retain the last mid-render progress/statusMsg
    // (how far it got) — consumers gate the progress UI on status === 'running',
    // so the residual values are not displayed for terminal jobs.
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
      if (job.terminating || job.status !== 'running') return;
      let didUpdatePersistedProgress = false;
      if (payload.type === 'progress' && typeof payload.progress === 'number' && Number.isFinite(payload.progress)) {
        job.progress = Math.max(0, Math.min(1, payload.progress));
        didUpdatePersistedProgress = true;
      }
      if (typeof payload.message === 'string' && payload.message.length > 0) {
        job.statusMsg = payload.message;
        didUpdatePersistedProgress = true;
      }
      if (didUpdatePersistedProgress) scheduleProgressPersist();
      broadcastSse(sseEntry, payload);
    },
    completed: (payload) => {
      terminate('completed', (j) => { j.result = payload; })
        .catch((e) => console.log(`⚠️ media-job [${job.id.slice(0, 8)}] terminal handler failed: ${e.message}`));
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
        }).catch((e) => console.log(`⚠️ media-job [${job.id.slice(0, 8)}] terminal handler failed: ${e.message}`));
        return;
      }
      terminate('failed', (j) => { j.error = payload.error || 'unknown error'; })
        .catch((e) => console.log(`⚠️ media-job [${job.id.slice(0, 8)}] terminal handler failed: ${e.message}`));
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

  await resolveLiveParams(job, safeParams);

  const emitter = job.kind === 'video' ? videoGenEvents
    : job.kind === 'training' ? trainingEvents
    : job.kind === 'audio' ? audioGenEvents
    : imageGenEvents;
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
  const idleTimeoutMs = (() => {
    // Cloud check first — a grok VIDEO job must take the cloud watchdog, not
    // the chunk-scaled local-video one (the provider emits 'activity' on
    // stdout so a long-but-active render never trips the idle cap).
    if (isCloudImageJob(job)) return WATCHDOG_CODEX_MS;
    if (job.kind === 'video') return WATCHDOG_VIDEO_MS * Math.max(1, Number(safeParams.chunks) || 1);
    if (job.kind === 'training') return WATCHDOG_TRAINING_MS;
    if (job.kind === 'audio') return WATCHDOG_AUDIO_MS;
    return WATCHDOG_IMAGE_MS;
  })();
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
    // job.terminating closes the window terminate() opens: it now awaits a
    // disk drain before flipping job.status, so a tick that only checked
    // status could fire mod.cancel on a job that is already terminating.
    if (job.terminating || job.status !== 'running') return;
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
      // Re-check after the await — terminate() may have started (and is
      // draining to disk with job.status still 'running') during the import.
      if (job.terminating || job.status !== 'running') return;
      console.log(`⏱️ media-job [${job.id.slice(0, 8)}] watchdog fired after ${idleFor}ms idle (limit ${idleTimeoutMs}ms) — marking failed`);
      if (mod?.cancel) mod.cancel(job.id);
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
    } else if (job.kind === 'training') {
      await mod.runTraining({ ...safeParams, jobId: job.id });
    } else if (job.kind === 'audio') {
      await mod.generateAudio({ ...safeParams, jobId: job.id });
    } else {
      await mod.generateImage({ ...safeParams, jobId: job.id });
    }
  } catch (err) {
    // generateVideo / generateChainedVideo / generateImage threw before
    // reaching their proc.on cleanup hooks (e.g. PYTHON not configured,
    // validation fail). Clean up multipart upload temp files the route
    // handed us so they don't leak under data/uploads.
    // safeUnlinkUpload constrains the delete to PATHS.uploads as
    // defense-in-depth against corrupted persisted params. audioFilePath
    // is the same kind of staged upload (a2v jobs) — clean it up too.
    await safeUnlinkUpload(job.params?.uploadedTempPath);
    await safeUnlinkUpload(job.params?.audioFilePath);
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
      const isCloud = isCloudImageJob({ kind, params });
      const laneQueue = queue.filter((j) => isCloudImageJob(j) === isCloud);
      return laneQueue.length + (isCloud ? cloudRunning.length : (running ? 1 : 0)) + 1;
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
    // delete to PATHS.uploads. audioFilePath is the same kind of staged
    // upload (a2v/voice/video jobs) and would otherwise leak when the user
    // cancels before the job starts.
    await safeUnlinkUpload(job.params?.uploadedTempPath);
    await safeUnlinkUpload(job.params?.audioFilePath);
    for (const p of normalizeTempPaths(job.params?.uploadedTempPaths)) {
      await safeUnlinkUpload(p);
    }
    job.status = 'canceled';
    job.error = 'Canceled before start';
    job.completedAt = new Date().toISOString();
    // Archive so /api/media-jobs?status=canceled and the recent-reel UI
    // can still find it within the 24h TTL. Mirrors the running-cancel path
    // in startLaneJob's terminal handler.
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
  // Cancel-while-running — check the GPU slot and every parallel codex slot.
  const runningJob = (running?.id === jobId ? running : null)
    ?? cloudRunning.find((j) => j.id === jobId)
    ?? null;
  if (runningJob) {
    // A terminal transition already started (completed/failed/watchdog): its
    // async progress-drain leaves job.status === 'running' for a beat, but the
    // outcome is decided. Don't fire a redundant provider cancel or report
    // 'canceling' — treat it like an already-terminal job (route maps to 409).
    if (runningJob.terminating) {
      return { ok: false, code: 'ALREADY_TERMINAL', status: runningJob.status, error: 'Job is already finishing' };
    }
    // cancelRequested flips the dispatcher's `failed` handler into the
    // `canceled` branch instead of marking it failed.
    runningJob.cancelRequested = true;
    const mod = await getGenModuleForJob(runningJob);
    if (mod?.cancel) mod.cancel(jobId);
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
  res.writeHead(200, SSE_HEADERS);
  res.write(`data: ${JSON.stringify(terminal)}\n\n`);
  res.end();
  return true;
}

// Test-only reset hook. Real callers go through enqueueJob/cancelJob.
export function __resetForTests() {
  queue.length = 0;
  running = null;
  // `cloudRunning` is a const array — clear it in place rather than reassigning,
  // which would throw TypeError and break `findJob()` (.find on null).
  cloudRunning.length = 0;
  archive.length = 0;
  sseJobs.clear();
  workerStarted = false;
  initPromise = null;
  // Reset the lane limit too — a test that called setCodexParallelLimit(N)
  // otherwise leaks N into subsequent tests and makes ordering matter.
  codexParallelLimit = CODEX_PARALLEL_DEFAULT;
  // Reset the persist chain so a leftover rejection from a previous test's
  // ENOENT writes doesn't poison subsequent persist() calls.
  persistChain = Promise.resolve();
}
