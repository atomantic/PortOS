import { refuseRetiredTraining, TRAINING_RETIRED_MESSAGE, assertRetiredDataAvailable } from '../../lib/retiredLoraTraining.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
/**
 * Media Job Queue — lane-aware FIFO for media generation jobs.
 *
 * Why this exists: video gen (mlx_video) and local image gen (mflux/diffusers)
 * both spawn heavy GPU/Metal child processes. Running two simultaneously OOMs
 * the machine, so the gen modules used to throw 409 BUSY when one was already
 * in flight. That made any agent-driven pipeline (e.g. Creative Director) need
 * to retry/backoff. This queue serializes submissions so callers always get
 * an immediate `queued` ack and watch progress via SSE.
 *
 * Lanes: GPU jobs drain serially through `running`; cloud CLI jobs use the
 * parallel `cloudRunning` lane; federated audio/image/video use `remoteRunning`
 * so work on another machine never occupies this machine's GPU slot. Slots and
 * queue positions belong to swim lanes (`jobSwimlane`): one per cloud provider,
 * one per peer, one for the local accelerator.
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
 * jobs. On boot, local child-process jobs fail as interrupted; detached
 * training and idempotent remote jobs reconcile against their surviving work.
 * Completed/failed/canceled entries older than 24h or beyond the 500-most-
 * recent are pruned to keep the file small.
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { unlink } from 'fs/promises';
import { join, resolve as pathResolve, sep as PATH_SEP } from 'path';
import { PATHS, readJSONFileStrict, atomicWrite, ensureDir, sleep } from '../../lib/fileUtils.js';
import { SSE_HEADERS } from '../../lib/sseHeaders.js';
import { holdsBackupAssetPublication, runOutsideBackupAssetPublication, withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { ServerError } from '../../lib/errorHandler.js';
import { reapAndCleanDetachedDirs } from '../../lib/detachedSpawn.js';
import {
  broadcastSse,
  attachSseClient as attachSse,
  closeJobAfterDelay,
  SSE_CLEANUP_DELAY_MS,
} from '../../lib/sseUtils.js';
import { videoGenEvents } from '../videoGen/events.js';
import { setVideoExecutionRecorder } from '../videoGen/executionRecorder.js';
import { imageGenEvents } from '../imageGenEvents.js';
import { trainingEvents } from '../loraTraining/events.js';
import { audioGenEvents } from '../audioGen/events.js';
import { getSettings } from '../settings.js';
import { IMAGE_GEN_MODE, CLOUD_IMAGE_GEN_MODES } from '../imageGen/modes.js';
import { parseQuotaDeferral, formatDeferral } from '../../lib/imageQuotaSignal.js';
import { VIDEO_GEN_MODE, CLOUD_VIDEO_GEN_MODES, mediaJobExecutionLane, mediaJobSwimlane } from '../../lib/generationModes.js';
import { REMOTE_MEDIA_MODULES, isRemoteMediaJob } from './remoteMediaJob.js';
import { createVideoHolds } from './videoHolds.js';
import { importedArchiveRow } from './importedJob.js';
import {
  canReceiveProgress, canRequestCancellation, claimTerminalOutcome,
  snapshotCancellationIntent, applyCancellationIntent, restoreCancellationIntent,
} from './jobLifecycle.js';
import {
  createRecoveryEvidence, observeProviderTerminal, recordTerminalDurable, recordOwnedInputCleanup,
  decideOwnershipRelease, OWNERSHIP_RELEASE,
} from './recoverySettlement.js';
import { routedJobParams } from '../federatedMedia/routedJobParams.js';
import { videoExecutionSchema, videoExecutionParentSchema, videoSegmentExecutionSchema, videoSegmentExecutionsSchema, mergeVideoExecutionDiagnostics } from './videoExecution.js';
import {
  MAX_PENDING_MEDIA_JOBS, MEDIA_QUEUE_PERSIST_FAILED, mediaQueueFullError,
} from './admission.js';

// The admission contract lives in ./admission.js so producers that cannot
// import the queue can still recognize a refusal; re-exported where callers
// have always found the queue's API.
export {
  MAX_PENDING_MEDIA_JOBS, MEDIA_QUEUE_PERSIST_FAILED, MEDIA_QUEUE_FULL, isMediaAdmissionRefusal,
  partialBatchAdmissionError,
} from './admission.js';

// Cloud-CLI jobs (Codex/Grok/Agy images, Grok videos) run in the parallel cloud
// lane — each render shells out to its own external child spending remote
// quota, so they don't serialize on the MLX runtime the way GPU jobs do. Each
// provider is its own swim lane (see jobSwimlane) with `codexParallelLimit`
// slots (settings key `imageGen.codex.parallelLimit`, kept under the codex name
// for backward compat), so a Codex backlog never holds a Grok render.
const isCloudImageJob = (j) =>
  mediaJobExecutionLane({ kind: j.kind, mode: j.params?.mode }) === 'cloud';

// The federated-kind map and its predicate live in ./remoteMediaJob.js so light
// consumers (sanitizeJob, route handlers) can ask "is this routed?" without
// pulling the queue in. Re-exported here because that is where callers have
// always found it.
export { isRemoteMediaJob };

const boundedVideoChunks = value => Math.min(8, Math.max(1, Math.trunc(Number(value) || 1)));

// Browser startup and each CDP command have their own deadlines, but a
// multi-step finish needs an overall bound as well. Abort cooperatively and
// retain the lane until the owned browser and any publication work settle.
export const VISUAL_PROFILE_FINISH_TIMEOUT_MS = 3 * 60 * 1000;

const isLocalFinishReplay = (job) => job.kind === 'image' && job.params?.visualProfile && job.params?.visualProfileSource
  && !job.params?.remoteMedia?.reconcile && job.params?.remotePeerReservation !== true;

// A restored remote submission reconnecting to peer work it already admitted.
const isRemoteReconcile = (job) => isRemoteMediaJob(job) && job.params?.remoteMedia?.reconcile === true;

const isTopazUpscale = (job) => job.kind === 'video-upscale' && job.params?.mode === 'topaz';

const laneInput = (job) => ({
  kind: job.kind,
  mode: job.params?.mode,
  remote: isRemoteMediaJob(job),
  peerId: job.params?.remoteMedia?.peerId,
});
const jobLane = (job) => isLocalFinishReplay(job) ? 'gpu' : mediaJobExecutionLane(laneInput(job));
// The unit that owns slots and queue positions: one per cloud provider, one per
// federated peer, one for this machine's accelerator. Work waits only behind
// work in its own swim lane.
const jobSwimlane = (job) => isLocalFinishReplay(job) ? 'gpu:local' : mediaJobSwimlane(laneInput(job));

// Boot restoration is the second way a job enters the queue, so it needs the
// same routed-job normalization enqueueJob applies (#4683). A job written by a
// build older than that fix still carries the top-level model id a legacy
// dispatcher would render from; re-normalizing on restore (and letting the boot
// persist write the safe shape back) means upgrading and then rolling back
// cannot resurrect a locally-renderable routed job.
const restoredParams = (job) => (isRemoteMediaJob(job)
  ? routedJobParams({ params: job.params })
  : job.params);

// A reservation row whose own reconcile attempt failed again is retried when a
// later job to the same peer is blocked behind it, but no faster than this.
const RESERVATION_RECONCILE_RETRY_MS = 30_000;

const JOBS_FILE = join(PATHS.data, 'media-jobs.json');
const COMPLETED_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PERSISTED_ARCHIVE = 500;
// Share-bucket re-render records outlive the 24h TTL (they are old by nature) but
// stay bounded; the oldest imports drop first.
const MAX_IMPORTED_ARCHIVE = 2000;
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

// 'video-upscale' (#6511) is its OWN kind rather than a 'video' mode so the
// generative upscale can never be offered to a peer: the federation layer's
// kind maps (REMOTE_MEDIA_MODULES here, ROUTABLE_MEDIA_KINDS and
// KNOWN_MEDIA_KINDS in federatedMedia/) are closed lists that do not name it,
// so shipping a user's source video across the wire would take a deliberate
// edit to one of them rather than a mode string slipping through.
// 'supercollider' (#9413) is likewise local-only: it executes untrusted source
// inside this machine's verified container, so no peer map names it.
const flatWatchdog = (ms) => () => ms;
const chunkScaledWatchdog = ({ chunks }) => WATCHDOG_VIDEO_MS * Math.max(1, Number(chunks) || 1);

// The single declaration of how each kind runs: its lazily-loaded module (by
// `params.mode`, falling back to `default`), the event bus its progress rides,
// its idle-watchdog window, entry point and progress verb. Module loads stay
// thunks so no static import edge is added (server/AGENTS.md, "Import scoping").
const MEDIA_JOB_RUNTIME = Object.freeze({
  video: {
    events: videoGenEvents,
    verb: 'Rendering',
    watchdogMs: chunkScaledWatchdog,
    modules: {
      [IMAGE_GEN_MODE.GROK]: () => import('../videoGen/grok.js'),
      [VIDEO_GEN_MODE.FAL]: () => import('../videoGen/fal.js'),
      [VIDEO_GEN_MODE.REACTOR]: () => import('../videoGen/reactor.js'),
      [VIDEO_GEN_MODE.RUNWAY]: () => import('../videoGen/runway.js'),
      default: () => import('../videoGen/local.js'),
    },
    invoke: (mod, request, { chunks }) => (chunks > 1 ? mod.generateChainedVideo(request) : mod.generateVideo(request)),
  },
  // An upscale is a single GPU render with no chunking, so it takes the video
  // idle window flat rather than the chunk-scaled one.
  'video-upscale': {
    events: videoGenEvents,
    verb: 'Upscaling',
    watchdogMs: flatWatchdog(WATCHDOG_VIDEO_MS),
    modules: { topaz: () => import('../videoGen/topazJob.js'), default: () => import('../videoGen/upscaleJob.js') },
    invoke: (mod, request) => mod.runVideoUpscale(request),
  },
  // Hand stitching (#13000): ffmpeg only, so it never touches the GPU lane's
  // render state, and local-only like the upscale (no peer map names it).
  'video-stitch': {
    events: videoGenEvents,
    verb: 'Stitching',
    watchdogMs: flatWatchdog(WATCHDOG_VIDEO_MS),
    modules: { default: () => import('../videoGen/stitchJob.js') },
    invoke: (mod, request) => mod.runVideoStitch(request),
  },
  'video-sharing': {
    events: videoGenEvents,
    verb: 'Generating',
    watchdogMs: flatWatchdog(WATCHDOG_VIDEO_MS),
    modules: { default: () => import('../musicVideo/sharingCopy.js') },
    invoke: (mod, request) => mod.runSharingCopy(request),
  },
  // Window and verb are the values this kind inherited from the old default
  // arms, not a reviewed choice; changing them is a separate decision.
  'html-composition': {
    events: videoGenEvents,
    verb: 'Generating',
    watchdogMs: flatWatchdog(WATCHDOG_IMAGE_MS),
    modules: { default: () => import('../htmlComposition/index.js') },
    invoke: (mod, request) => mod.renderComposition(request),
  },
  image: {
    events: imageGenEvents,
    verb: 'Generating',
    watchdogMs: flatWatchdog(WATCHDOG_IMAGE_MS),
    modules: {
      [IMAGE_GEN_MODE.CODEX]: () => import('../imageGen/codex.js'),
      [IMAGE_GEN_MODE.GROK]: () => import('../imageGen/grok.js'),
      [IMAGE_GEN_MODE.AGY]: () => import('../imageGen/agy.js'),
      [IMAGE_GEN_MODE.FAL]: () => import('../imageGen/fal.js'),
      [IMAGE_GEN_MODE.RUNWAY]: () => import('../imageGen/runway.js'),
      default: () => import('../imageGen/local.js'),
    },
    invoke: (mod, request) => mod.generateImage(request),
  },
  training: {
    events: trainingEvents,
    verb: 'Training',
    watchdogMs: flatWatchdog(WATCHDOG_TRAINING_MS),
    modules: { default: () => import('../loraTraining/index.js') },
    invoke: (mod, request) => mod.runTraining(request),
  },
  audio: {
    events: audioGenEvents,
    verb: 'Generating',
    watchdogMs: flatWatchdog(WATCHDOG_AUDIO_MS),
    modules: { default: () => import('../audioGen/local.js') },
    invoke: (mod, request) => mod.generateAudio(request),
  },
  // Window and verb inherited from the old default arms (see html-composition).
  supercollider: {
    events: audioGenEvents,
    verb: 'Generating',
    watchdogMs: flatWatchdog(WATCHDOG_IMAGE_MS),
    modules: { default: () => import('../superColliderRender.js') },
    invoke: (mod, request) => mod.renderSuperCollider(request),
  },
});

export const JOB_KINDS = Object.freeze(Object.keys(MEDIA_JOB_RUNTIME));
export const JOB_STATUSES = Object.freeze(['queued', 'running', 'completed', 'failed', 'canceled']);

// Returns a Promise that resolves to the gen module for the given job's
// provider (video/local, imageGen/local, or imageGen/codex). Single source
// of provider-dispatch truth — used by the watchdog, runJob, and cancelJob
// so a new provider addition is one edit instead of three.
function getGenModuleForJob(job) {
  // The remote check comes FIRST for every federatable kind: a remote job's
  // params deliberately carry no local runtime fields (mode, pythonPath), so a
  // later local branch would happily claim it and render a second time on this
  // machine.
  if (isRemoteMediaJob(job)) return REMOTE_MEDIA_MODULES[job.kind]();
  const runtime = MEDIA_JOB_RUNTIME[job.kind];
  if (!runtime) return Promise.resolve(null);
  return (runtime.modules[job.params?.mode] ?? runtime.modules.default)();
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
  // A remote job renders on the peer's runtime, so this machine's pythonPath is
  // neither used nor meaningful — resolving it would only emit a confusing
  // re-resolution log line for a render that never touches local Python.
  if (isRemoteMediaJob(job)) return;
  // mflux training runs in the same venv as local image renders, so the
  // live settings pythonPath wins there too. flux2 training resolves its
  // own venv (resolveFlux2Python) inside runTraining — skip it here.
  const usesLocalPython = (job.kind === 'video' && !CLOUD_VIDEO_GEN_MODES.includes(job.params?.mode))
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
// Boot already wires 11 permanent `completed` hooks (universe-builder, catalog
// image-attach, writers-room, music-video scene image/video, music bed, sprite
// references, scene frames, and the comicPages/storyboards/seasonCover filename
// hooks), which trips Node's default limit of 10 and prints a bogus
// MaxListenersExceededWarning on every start. These are long-lived subscribers,
// not a leak; per-job waiters add more on top. Matches the caps the sibling
// emitters already set (imageGenEvents 200, videoGenEvents 50).
mediaJobEvents.setMaxListeners(100);

// GPU lane: serialized — `running` holds at most one job. Cloud CLI and remote
// provider lanes are parallel because neither consumes the local GPU. `queue`
// preserves submission order across lanes; positions are swim-lane-scoped.
const queue = [];
let running = null;
const cloudRunning = [];
const remoteRunning = [];
const archive = [];
const videoHolds = createVideoHolds();

// One install can route to several peers, while each provider remains the
// authority on its own capacity. This bound prevents corrupted persisted state
// from creating unbounded local polling loops without serializing independent
// peers behind the local GPU lane.
export const REMOTE_MEDIA_PARALLEL_LIMIT = 20;

export const CODEX_PARALLEL_MIN = 1;
// Keep counts exactly representable without imposing a provider throughput cap.
export const CODEX_PARALLEL_MAX = Number.MAX_SAFE_INTEGER;
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
let workerOperation = null;
let wakeWorker = null;
let resettingForTests = false;
const testLifecycleDisposals = new Set();
const laneOperations = new Set();
let initPromise = null;
// Shutdown latch (#8691): once set, nothing promotes a waiting job to running —
// neither the worker nor Run Now — and nothing re-arms the worker. Waiting jobs
// stay durably queued for the next process, which restores them untouched.
let dispatchQuiesced = false;
export const MEDIA_QUEUE_SHUTTING_DOWN = 'MEDIA_QUEUE_SHUTTING_DOWN';
const terminalOperations = new Set();

// A started job crosses async pre-dispatch work (live settings, provider module
// resolution) before its terminal listeners attach and its provider is invoked.
// Tracked separately so the test drain can wait for that boundary (#9029).
const dispatchOperations = new Set();

function trackOperation(operations, operation) {
  const tracked = Promise.resolve(operation);
  operations.add(tracked);
  tracked.finally(() => operations.delete(tracked)).catch(() => {});
  return tracked;
}

const trackTerminalOperation = (operation) => trackOperation(terminalOperations, operation);

function findJob(jobId) {
  if (running && running.id === jobId) return running;
  const codexHit = cloudRunning.find((j) => j.id === jobId);
  if (codexHit) return codexHit;
  const remoteHit = remoteRunning.find((j) => j.id === jobId);
  if (remoteHit) return remoteHit;
  const inQueue = queue.find((j) => j.id === jobId);
  if (inQueue) return inQueue;
  return archive.find((j) => j.id === jobId) || null;
}

export function getJob(jobId) {
  return findJob(jobId);
}

// Completion hooks may attach a generated artifact to a domain record after
// the audio worker has emitted its result. Persist that attachment on the job
// too so a remounted client can discover the created track without guessing.
export async function updateJobResult(jobId, patch) {
  const job = findJob(jobId);
  if (!job || !patch || typeof patch !== 'object') return false;
  job.result = { ...(job.result || {}), ...patch };
  await persist();
  return true;
}

// Await this receipt before spawning a local video child. A rejected snapshot
// must leave the generator unstarted, rather than lose its random seed on exit.
// Cancellation may settle while metadata resolves; retain that late receipt
// without changing the terminal state or making the job dispatchable again.
const segmentExecutionTarget = (childJobId, executionParent) => {
  const parent = videoExecutionParentSchema.parse(executionParent);
  const job = findJob(parent.jobId);
  if (!job || job.kind !== 'video' || isRemoteMediaJob(job) || jobLane(job) !== 'gpu'
    || !['running', 'failed', 'canceled'].includes(job.status)
    || boundedVideoChunks(job.params?.chunks) !== parent.segmentCount || childJobId === parent.jobId) {
    throw new Error('Queued video segment has no matching local parent');
  }
  return { job, parent };
};

export async function recordVideoExecution(jobId, meta) {
  const target = meta.executionParent == null ? null : segmentExecutionTarget(jobId, meta.executionParent);
  const job = target?.job || findJob(jobId);
  if (!job || job.kind !== 'video' || isRemoteMediaJob(job) || !['running', 'failed', 'canceled'].includes(job.status)) return false;
  const segments = target ? videoSegmentExecutionsSchema.parse(job.videoExecutions || []) : null;
  const previous = target ? segments.find(entry => entry.segmentIndex === target.parent.segmentIndex) : job.videoExecution;
  const receipt = videoExecutionSchema.parse({
    version: 1,
    preparedAt: previous?.preparedAt || new Date().toISOString(),
    seed: meta.seed,
    ...(meta.batchSeeds ? { batchSeeds: meta.batchSeeds } : {}),
    parameters: meta,
    ...(previous?.diagnostics ? { diagnostics: previous.diagnostics } : {}),
  });
  if (previous && (previous.seed !== receipt.seed || (target && (previous.childJobId !== jobId || previous.segmentCount !== target.parent.segmentCount)))) {
    throw new Error('Video execution receipt already belongs to a different seed or child');
  }
  if (target) {
    const { segmentIndex, segmentCount } = target.parent;
    const segment = videoSegmentExecutionSchema.parse({ ...receipt, childJobId: jobId, segmentIndex, segmentCount });
    job.videoExecutions = videoSegmentExecutionsSchema.parse([
      ...segments.filter(entry => entry.segmentIndex !== segmentIndex), segment,
    ].sort((a, b) => a.segmentIndex - b.segmentIndex));
    const requestedSeed = job.params?.seed;
    const segmentSeedBase = requestedSeed == null || requestedSeed === '' ? null : Number(requestedSeed);
    const previousSeeds = job.params?.segmentSeedBase === segmentSeedBase && Array.isArray(job.params?.segmentSeeds)
      ? job.params.segmentSeeds : [];
    const segmentSeeds = Array.from({ length: segmentCount }, (_, index) => {
      const prior = previousSeeds[index];
      const reusable = Number.isSafeInteger(prior) && prior >= 0 ? prior : null;
      return job.videoExecutions.find(entry => entry.segmentIndex === index)?.seed ?? reusable;
    });
    // Preserve known, not-yet-rerendered seeds; changing the outer seed starts
    // a new base so the next unchanged retry can reuse this attempt's seeds.
    job.params = { ...job.params, segmentSeeds, segmentSeedBase };
  } else {
    job.videoExecution = receipt;
    job.params = { ...job.params, seed: receipt.seed };
  }
  await persist();
  return true;
}

// Call once at admission and once on termination, after accumulating numeric
// maxima in memory; never persist a snapshot for every subprocess output line.
export async function recordVideoExecutionDiagnostics(jobId, diagnostics, executionParent) {
  const target = executionParent == null ? null : segmentExecutionTarget(jobId, executionParent);
  const job = target?.job || findJob(jobId);
  if (!job || job.kind !== 'video' || isRemoteMediaJob(job)) return false;
  if (target) {
    const segments = videoSegmentExecutionsSchema.parse(job.videoExecutions || []);
    const index = segments.findIndex(entry => entry.childJobId === jobId && entry.segmentIndex === target.parent.segmentIndex && entry.segmentCount === target.parent.segmentCount);
    if (index < 0) return false;
    const previous = segments[index];
    segments[index] = videoSegmentExecutionSchema.parse({
      ...mergeVideoExecutionDiagnostics(previous, diagnostics),
      childJobId: previous.childJobId, segmentIndex: previous.segmentIndex, segmentCount: previous.segmentCount,
    });
    job.videoExecutions = segments;
  } else {
    if (!job.videoExecution) return false;
    job.videoExecution = mergeVideoExecutionDiagnostics(job.videoExecution, diagnostics);
  }
  await persist();
  return true;
}

const installVideoExecutionRecorder = () => setVideoExecutionRecorder({
  recordExecution: recordVideoExecution, recordDiagnostics: recordVideoExecutionDiagnostics,
});

export function getRunningJob() {
  return running;
}

// One definition of each lane's per-swim-lane slot count, shared by the
// dispatcher, getQueueCapacity and laneConcurrencyFor so a caller can never read
// a limit this module has moved. Cloud providers each get `codexParallelLimit`;
// a federated peer runs one job at a time, and REMOTE_MEDIA_PARALLEL_LIMIT
// bounds all peers together.
const laneLimits = () => ({
  gpu: 1,
  cloud: codexParallelLimit,
  remote: 1,
});
const laneTotalLimits = () => ({ gpu: 1, cloud: Infinity, remote: REMOTE_MEDIA_PARALLEL_LIMIT });

const runningJobs = () => [...(running ? [running] : []), ...cloudRunning, ...remoteRunning];

// Queue position of every waiting job within its own swim lane: running work in
// the swim lane holds the first slots, then queued work in submission order.
function swimlanePositions() {
  const counts = new Map();
  const bump = (job) => {
    const key = jobSwimlane(job);
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    return n;
  };
  runningJobs().forEach(bump);
  return new Map(queue.map((job) => [job, bump(job)]));
}

/**
 * How many jobs like `job` run at once here — the slot count of the swim lane
 * `jobSwimlane` would route it to.
 *
 * Exported for the same reason `getQueueCapacity` is: the lane split is private
 * to this module, so a caller asking "how fast would this drain?" must not
 * answer it by naming lanes. Summing limits by hand also gives the wrong
 * number — the lanes are alternatives, not a pool, so a machine whose parallel
 * cloud-CLI lane is wide would claim that width for GPU work that serializes.
 *
 * @param {{kind: string, params?: object}} job - a real or prospective job
 * @returns {number} the lane's configured concurrency
 */
export function laneConcurrencyFor(job) {
  return laneLimits()[jobLane(job)];
}

/**
 * Lane occupancy and queue depth, reported by the queue itself.
 *
 * The lane split (serialized GPU vs. parallel cloud-CLI vs. parallel remote)
 * and each lane's slot count are private to this module, so a caller that
 * counted `listJobs()` by hand would have to re-derive `jobLane` and would
 * drift from it the first time a new cloud mode is added. Capacity questions
 * are answered here for the same reason `isRemoteMediaJob` has one definition.
 *
 * `limit` is the lane's configured concurrency (per provider for `cloud`, all
 * peers together for `remote`), NOT a queue bound: work over
 * the limit waits rather than being rejected. Waiting work is bounded once,
 * across all lanes, by MAX_PENDING_MEDIA_JOBS (see assertMediaQueueRoom). The
 * federated-provider admission bound is a separate setting (see
 * federatedMediaProvider.js).
 *
 * @returns {{lanes: Record<'gpu'|'cloud'|'remote', {running: number, queued: number, limit: number}>,
 *   byKind: Record<string, {running: number, queued: number}>,
 *   totals: {running: number, queued: number},
 *   runningKind: string|null}}
 */
export function getQueueCapacity() {
  const limits = laneLimits();
  const lanes = {
    gpu: { running: running ? 1 : 0, queued: 0, limit: limits.gpu },
    cloud: { running: cloudRunning.length, queued: 0, limit: limits.cloud },
    remote: { running: remoteRunning.length, queued: 0, limit: laneTotalLimits().remote },
  };
  // Seed every known kind so a lane with no work reports 0 rather than being
  // absent — an absent key and a zero read identically in a UI, and only one
  // of them is true.
  const byKind = Object.fromEntries(JOB_KINDS.map((kind) => [kind, { running: 0, queued: 0 }]));
  // Lane `running` counts come straight off the lane arrays above; only the
  // shared `queue` has to be classified, because it holds every lane's waiting
  // work in one submission-ordered list.
  for (const job of queue) {
    lanes[jobLane(job)].queued += 1;
    if (byKind[job.kind]) byKind[job.kind].queued += 1;
  }
  for (const job of runningJobs()) {
    if (byKind[job.kind]) byKind[job.kind].running += 1;
  }
  return {
    lanes,
    byKind,
    totals: {
      running: lanes.gpu.running + lanes.cloud.running + lanes.remote.running,
      queued: queue.length,
    },
    runningKind: running?.kind ?? null,
  };
}

export function listJobs({ status, kind, owner } = {}) {
  const all = [
    ...(running ? [running] : []),
    ...cloudRunning,
    ...remoteRunning,
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

// The render queue displays every live job and only a short recent failure
// reel. Select that reel before sanitization; the archive can hold 500 rows.
export function listQueueJobs({ kind, owner, limit = 10 } = {}) {
  const matches = (job) => (!kind || job.kind === kind) && (!owner || job.owner === owner);
  const live = [
    ...(running ? [running] : []),
    ...cloudRunning,
    ...remoteRunning,
    ...queue,
    ...archive.filter((job) => job.durabilityPending),
  ].filter(matches);
  const recent = [];
  const uncertainTopaz = [];
  const finishedAt = (job) => new Date(job.completedAt || job.startedAt || job.queuedAt || 0).getTime();
  for (const job of archive) {
    if (!matches(job) || (job.status !== 'failed' && job.status !== 'canceled' && !(kind === 'video-upscale' && job.status === 'completed'))) continue;
    if (job.result?.topazUncertain === true || job.result?.topazRecoveryAvailable === true) { uncertainTopaz.push(job); continue; }
    const time = finishedAt(job);
    let index = 0;
    while (index < recent.length && !(time > recent[index].time)) index += 1;
    if (index >= limit) continue;
    recent.splice(index, 0, { job, time });
    if (recent.length > limit) recent.pop();
  }
  return [...live, ...uncertainTopaz, ...recent.map(({ job }) => job)];
}

// Serialize persist() calls through a single chain. atomicWrite rename can
// finish out-of-order under concurrent calls, so a slow "start" persist
// landing after a fast "done" persist would regress the on-disk snapshot
// (e.g. completed→running). Chaining ensures every snapshot reflects the
// state when each queued write runs, in submission order.
let persistChain = Promise.resolve();
// Terminal outcomes stay private until the snapshot containing them succeeds.
// Recovery commits storage only; it never invokes a generator again.
const pendingTransitions = new Map();
// Only a completion publishes durable output. Its commit holds backup admission
// from staging the terminal row through the hook fan-out, never while rendering
// or waiting in the queue; failures and cancellations stay unadmitted so a
// backup never delays them.
// The output is already rendered, so the commit waits out a whole backup cut
// rather than stranding a finished job half-terminated.
const COMPLETION_ADMISSION_MS = 60 * 60 * 1000;
const admitCompletion = (state, commit) => (state === 'completed'
  ? withBackupAssetPublication(commit, { timeoutMs: COMPLETION_ADMISSION_MS, onWait: () => console.log('⏸️ media-job completion waiting for the backup to finish') })
  : commit());
function stageTerminalTransition(job, apply, acknowledge) {
  job.terminating = true;
  const target = { ...job };
  apply(target);
  job.durabilityPending = { status: target.status, result: target.result, error: target.error,
    completedAt: target.completedAt, progress: target.progress, statusMsg: target.statusMsg, videoFailure: target.videoFailure };
  pendingTransitions.set(job, acknowledge);
}
// A momentarily locked destination (concurrent reader, AV scan) clears within
// milliseconds, so one retry after a short pause can land. ENOSPC, EACCES and
// a blocked writer cannot, so they surface on the first attempt (#12026).
const TERMINAL_PERSIST_RETRY_MS = 250;
const isTransientPersistError = (error) => error?.code === 'EBUSY' || error?.code === 'EAGAIN'
  || (process.platform === 'win32' && error?.code === 'EPERM');
async function persistTerminalTransition(job) {
  const noteFailure = () => {
    job.persistenceError = true;
    mediaJobEvents.emit('changed', {});
  };
  const storageRecovery = () => new ServerError('Media outcome is awaiting storage recovery; restore writable storage and flush the queue', {
    status: 503, code: MEDIA_QUEUE_PERSIST_FAILED,
  });
  try {
    await persist();
    return;
  } catch (error) {
    noteFailure();
    if (!isTransientPersistError(error)) throw storageRecovery();
  }
  await sleep(TERMINAL_PERSIST_RETRY_MS);
  try {
    await persist();
  } catch (_error) {
    noteFailure();
    throw storageRecovery();
  }
}
// Set when the boot read of JOBS_FILE was untrustworthy (#4115). Every persist()
// writes the FULL in-memory snapshot, so persisting on top of a queue we failed
// to restore would replace the real jobs file with whatever this process happens
// to hold — the classic "unreadable read becomes an empty write". Latching the
// writer off preserves the file for the user to recover or delete. Admission
// and dispatch stay disabled because no transition can be made durable.
let persistBlocked = false;
function persist() {
  // A blocked writer cannot satisfy admission or transition durability.
  if (persistBlocked) {
    mediaJobEvents.emit('changed', {});
    return Promise.reject(new Error('Media queue storage is blocked until its snapshot is repaired and the server restarts'));
  }
  // Every queue mutation, including holds, deletion and debounced progress,
  // converges here. Invalidate after the write settles so readers see the final
  // in-memory state even when persistence is unavailable.
  persistChain = persistChain.then(persistImpl, persistImpl).finally(() => {
    mediaJobEvents.emit('changed', {});
  });
  return persistChain;
}
async function persistImpl() {
  trimArchiveForSnapshot();
  const snapshot = captureQueueSnapshot();
  await atomicWrite(JOBS_FILE, snapshot.data);
  await acknowledgeWrittenTransitions(snapshot.transitions);
  if (snapshot.hasDeferredCompletion) recoverCompletionsUnderAdmission();
}

function trimArchiveForSnapshot() {
  const cutoff = Date.now() - COMPLETED_TTL_MS;
  const pendingArchive = archive.filter((job) => job.durabilityPending);
  const retained = (job) => job.params?.remotePeerReservation === true || job.result?.topazUncertain === true || job.result?.topazRecoveryAvailable === true;
  const isImported = (job) => job.imported === true && !job.durabilityPending && !retained(job);
  const trimmedArchive = archive.filter(isImported).slice(-MAX_IMPORTED_ARCHIVE)
    .concat(archive
      .filter((j) => {
        const ts = j.completedAt ? new Date(j.completedAt).getTime() : Date.now();
        return !isImported(j) && !j.durabilityPending && (retained(j) || ts > cutoff);
      })
      .filter((job) => !retained(job)).slice(-MAX_PERSISTED_ARCHIVE))
    .concat(archive.filter((job) => !job.durabilityPending && retained(job)), pendingArchive);
  // Mutate `archive` in place so subsequent reads see the trim too.
  archive.length = 0;
  archive.push(...trimmedArchive);
}

// Capture the rows and eligible acknowledgements together, before storage yields.
// Per-backend quota cooldowns: mode → epoch ms the provider said it resets.
//
// A subscription image backend answers an exhausted quota with the instant it
// recovers ("Your quota will reset after 2h26m1s"). Without this, every job
// queued behind the one that hit the wall dispatches straight into the same
// 429 and fails within seconds — on 2026-10-17 a single comic run burned ten
// renders that way, each one a failed slot the user had to notice and re-drive
// by hand.
//
// Keyed by MODE, not by job: the quota belongs to the provider account, so one
// job's rejection is evidence about every queued job routed to that backend.
// Queue-level rather than per-job because `captureQueueSnapshot` serializes a
// fixed field whitelist, so a new per-job field would silently not survive a
// restart; this rides alongside `videoHolds` in the same snapshot instead.
const quotaCooldowns = new Map();

/** Remaining cooldown for a job's backend, 0 when it is clear to dispatch. */
/** The reset instant for a job's backend, or 0 when it is clear to dispatch. */
function quotaCooldownResumeAt(job, now = Date.now()) {
  const mode = job?.params?.mode;
  if (!mode) return 0;
  const resumeAt = quotaCooldowns.get(mode);
  if (!resumeAt) return 0;
  if (resumeAt <= now) {
    // Expired — drop it so a later failure starts a fresh window rather than
    // extending a stale one, and so the map cannot grow without bound.
    quotaCooldowns.delete(mode);
    return 0;
  }
  return resumeAt;
}

/**
 * Record a cooldown when a failure carries the provider's own reset time.
 * Called from the failed handler for its EVIDENCE only — the job still fails
 * through the normal terminal path, so no lifecycle invariant changes here.
 */
function recordQuotaCooldown(job, errorText) {
  const mode = job?.params?.mode;
  if (!mode) return;
  const deferral = parseQuotaDeferral(errorText);
  if (!deferral) return;
  const existing = quotaCooldowns.get(mode) || 0;
  // Keep the later instant: a second rejection during the same outage reports a
  // shorter remaining wait, and taking it would release the queue early.
  if (deferral.resumeAt <= existing) return;
  quotaCooldowns.set(mode, deferral.resumeAt);
  console.log(`⏳ media-job: ${mode} quota exhausted — holding queued ${mode} renders for ${formatDeferral(deferral.resetsInMs)}`);
}

// Derived from the ABSOLUTE reset so the message is constant for the whole
// window: a countdown would change every tick and force a full-queue snapshot
// per held job each time it did.
const QUOTA_WAIT_PATTERN = /^Waiting for \S+ quota — resumes at /;
function quotaWaitMessage(mode, resumeAt) {
  const at = new Date(resumeAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `Waiting for ${mode} quota — resumes at ${at}`;
}

/** Snapshot shape: [[mode, resumeAt], ...], dropping anything already expired. */
function snapshotQuotaCooldowns(now = Date.now()) {
  return [...quotaCooldowns.entries()].filter(([, resumeAt]) => resumeAt > now);
}

/**
 * Restore cooldowns across a restart. Returns false on a malformed snapshot so
 * the caller can latch persistence the same way a malformed hold does — but
 * never throws: an unreadable cooldown must not keep the server from booting.
 */
function restoreQuotaCooldowns(raw, now = Date.now()) {
  quotaCooldowns.clear();
  if (raw === undefined || raw === null) return true;
  if (!Array.isArray(raw)) return false;
  let ok = true;
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2) { ok = false; continue; }
    const [mode, resumeAt] = entry;
    if (typeof mode !== 'string' || !mode || !Number.isFinite(resumeAt)) { ok = false; continue; }
    if (resumeAt > now) quotaCooldowns.set(mode, resumeAt);
  }
  return ok;
}

/** Test-only reset so a suite cannot leak a cooldown into the next case. */
export function __resetQuotaCooldownsForTest() {
  quotaCooldowns.clear();
}

function captureQueueSnapshot() {
  const live = [
    ...(running ? [running] : []),
    ...cloudRunning,
    ...remoteRunning,
    ...queue,
    ...archive,
  ];
  // A completion's terminal row and its `completed` fan-out publish together,
  // so only a snapshot written inside a backup admission lease commits one. Any
  // other write (progress, enqueue, the shutdown flush, or one landing after a
  // completion's own retries gave up) keeps it `running` on disk and leaves it
  // to an admitted recovery commit, never publishing it in the middle of a cut.
  const completionAdmitted = !completionRecoveryDeferred && holdsBackupAssetPublication();
  const canWriteOutcome = (job) => completionAdmitted || job.durabilityPending?.status !== 'completed';
  const hasDeferredCompletion = [...pendingTransitions.keys()].some((job) => !canWriteOutcome(job));
  // Strip non-serializable bits.
  const serializable = live.map((job) => (canWriteOutcome(job) ? { ...job, ...job.durabilityPending } : job)).map(({ id, kind, owner, status, queuedAt, startedAt, completedAt, params, result, error, position, progress, statusMsg, etaMs, durabilityPending, imported, videoExecution, videoExecutions, cancelRequested, visualProfileFinishing }) =>
    ({ id, kind, owner, status, queuedAt, startedAt, completedAt, params, result, error, position, progress, statusMsg, etaMs,
      ...((status === 'running' && visualProfileFinishing || kind === 'video-upscale' && params?.mode === 'topaz') && cancelRequested === true ? { cancelRequested: true } : {}),
      ...(imported === true ? { imported } : {}),
      ...(videoExecution ? { videoExecution } : {}),
      ...(videoExecutions ? { videoExecutions } : {}),
      ...(status !== 'completed' && durabilityPending?.status === 'completed' ? { durabilityPending } : {}) }),
  );
  const transitions = [...pendingTransitions].filter(([job]) => canWriteOutcome(job));
  return { data: { jobs: serializable, videoHolds: videoHolds.snapshot(), quotaCooldowns: snapshotQuotaCooldowns() }, transitions, hasDeferredCompletion };
}

async function acknowledgeWrittenTransitions(transitions) {
  for (const [job, acknowledge] of transitions) {
    // A replacement staged while storage was pending belongs to a later write.
    if (pendingTransitions.get(job) !== acknowledge) continue;
    pendingTransitions.delete(job);
    Object.assign(job, job.durabilityPending);
    delete job.durabilityPending;
    delete job.persistenceError;
    await acknowledge();
  }
}

// Storage is writable again, but a completion is still staged. Commit it from
// its own admission lease: it waits out an active backup cut, and its attach
// hooks join the lease from the fan-out. Never awaited inside the persist
// chain, so a cut draining an admitted write cannot deadlock on it.
let completionRecovery = null;
let completionRecoveryDeferred = false;

// Boot restores the queue before wiring domain hooks. Open recovery only after
// those listeners exist; keeping the receipt private also protects completions
// from a newly dispatched job during that startup window.
export function resumeMediaJobCompletions() {
  completionRecoveryDeferred = false;
  if ([...pendingTransitions.keys()].some(job => job.durabilityPending?.status === 'completed')) {
    recoverCompletionsUnderAdmission();
  }
}

function recoverCompletionsUnderAdmission() {
  if (completionRecovery || completionRecoveryDeferred) return;
  // Tracked as a terminal operation so the shutdown flush drains it (and times
  // out, reporting failure, if an open cut still holds the commit).
  completionRecovery = trackTerminalOperation(withBackupAssetPublication(() => persist())
    .catch((error) => console.error(`❌ media-job completion recovery commit failed: ${error.message}`))
    .finally(() => { completionRecovery = null; }));
}

async function announceTerminalTransition(job, onDurable = () => {}) {
  if (job.params?.videoProduction) {
    const tag = job.params.videoProduction;
    const { settleVideoAttempt } = await import('../creativeDirector/videoExecution.js');
    await settleVideoAttempt(tag.projectId, tag.attemptId, { jobId: job.id, status: job.params.videoProduction.submissionUncertain || (job.status === 'failed' && /timeout|timed out|interrupted/i.test(job.error || '')) ? 'uncertain' : job.status })
      .catch(error => console.error(`❌ Video receipt could not settle: ${error.message}`));
  }
  // Wake the lane finalizer without polling. Some providers emit their
  // terminal event just before their kickoff promise resolves; the promise
  // retains that signal until runJob reaches the await below.
  onDurable();
  const logPrefix = job.status === 'completed' ? '✅' : job.status === 'canceled' ? '🛑' : '❌';
  const logSuffix = job.status === 'failed' ? `: ${job.error}` : job.status === 'canceled' ? ' (was running)' : '';
  const log = job.status === 'failed' ? console.error : console.log;
  log(`${logPrefix} media-job [${job.id.slice(0, 8)}] ${job.status}${logSuffix}`);
  const ssePayload =
    job.status === 'completed' ? { type: 'complete', result: job.result }
    : job.status === 'canceled' ? { type: 'canceled', reason: job.error }
    : { type: 'error', error: job.error };
  const entry = ensureSseEntry(job.id);
  broadcastSse(entry, ssePayload);
  closeJobAfterDelay(sseJobs, job.id, SSE_CLEANUP_DELAY_MS, entry);
  // Hooks that publish files or rows acquire their own admission; see
  // runOutsideBackupAssetPublication.
  runOutsideBackupAssetPublication(() => mediaJobEvents.emit(job.status, job));
}

// Staged multipart inputs a job owns under data/uploads. safeUnlinkUpload
// constrains each delete to PATHS.uploads, so a corrupted path never removes a
// file the job merely referenced. audioFilePath is the same kind of upload.
async function releaseStagedUploads(params) {
  await Promise.all([params?.uploadedTempPath, params?.audioFilePath, ...normalizeTempPaths(params?.uploadedTempPaths)]
    .map(path => safeUnlinkUpload(path)));
}

// The same training job, flagged to re-attach, when its detached trainer survived.
const reattachSurvivingTrainer = async j => (j.kind === 'training' && j.params?.runId && await jobHasSurvivingTrainer(j.params.runId)
  ? { ...j, status: 'queued', params: { ...j.params, reattach: true } } : null);

// What one persisted job becomes after a restart. Applies it to the queue or
// archive and returns { failedId } / { canceled } / { reattach } for the init
// body's SSE pre-seed and re-attach ordering. Arm order is load-bearing: a
// maintenance hold wins over the video-production fail, and remote reconcile
// (in restoreInterruptedRunningJob) wins over the generic interrupted fail.
async function restorePersistedJob(persisted) {
  // An uncertain terminal observer result is not a terminal peer result.
  // Reconcile the original idempotency key while preserving its peer slot.
  const j = isRemoteMediaJob(persisted) && persisted.params?.remotePeerReservation === true
    && ['failed', 'canceled'].includes(persisted.status) ? { ...persisted, status: 'running' } : persisted;
  if (j.status === 'running' && j.durabilityPending?.status === 'completed') {
    // This optional receipt is private queue state, not a published result.
    // Legacy snapshots have no receipt and retain their existing recovery.
    const receipt = j.durabilityPending;
    const permit = maintenance.recoverOwned('media', j.id);
    archive.push(j);
    stageTerminalTransition(j, target => Object.assign(target, receipt), () => permit.run(async () => {
      videoHolds.recordTerminal(j);
      videoHolds.updateQueued(queue);
      await announceTerminalTransition(j);
      // A receipt proves completion, not remote executor teardown or input
      // cleanup. finish deliberately retains any uncertain ownership.
      await permit.finish();
    }));
    return {};
  }
  // Never dispatch a queued trainer after upgrade. A verified survivor below
  // is observed to completion without launching a replacement process.
  if (j.kind === 'training' && j.status === 'queued' && !j.params?.reattach) {
    archive.push({ ...j, status: 'canceled', error: TRAINING_RETIRED_MESSAGE, completedAt: new Date().toISOString() });
    return { failedId: j.id };
  }
  if (j.status === 'running' && maintenance.held()) {
    maintenance.recoverOwned('media', j.id);
    const reattach = await reattachSurvivingTrainer(j);
    if (reattach) {
      recoveringJobs.add(j.id);
      return { reattach };
    }
    // Preserve uncertain work and staged inputs; no paid replay or orphan
    // kill is safe merely because the observer process restarted.
    archive.push({ ...j, params: restoredParams(j) });
    return {};
  }
  // Explicit Video Start grants one process lifetime. Restored jobs wait for
  // project reconciliation; replaying an unknown paid submit could charge twice.
  if (j.params?.videoProduction && ['queued', 'running'].includes(j.status)) {
    archive.push({ ...j, status: 'failed', error: 'Video production paused after restart', completedAt: new Date().toISOString(),
      params: { ...restoredParams(j), videoProduction: { ...j.params.videoProduction, submissionUncertain: j.status === 'running' } } });
    return { failedId: j.id };
  }
  if (j.status === 'running') return restoreInterruptedRunningJob(j);
  if (j.status === 'queued') queue.push({ ...j, params: restoredParams(j) });
  // The archive needs terminal rows too: a rolled-back build restores these rows,
  // shows them in the Render Queue's recent reel, and its Retry hands the
  // stored params straight to a local render.
  else archive.push({ ...j, params: restoredParams(j) });
  return {};
}

// A job that was running when the previous process stopped.
async function restoreInterruptedRunningJob(j) {
  if (isTopazUpscale(j)) {
    queue.push({ ...j, status: 'queued', params: { ...j.params, topazRecovery: true } });
    return {};
  }
  // A canceled finish already has its original image. When no remote
  // reservation remains, no provider needs reconciliation on restart.
  if (j.kind === 'image' && j.cancelRequested === true && j.params?.visualProfile && j.params?.visualProfileSource
    && (!isRemoteMediaJob(j) || j.params?.remotePeerReservation !== true)) {
    const error = 'Canceled during film finishing; original image retained';
    archive.push({ ...j, status: 'canceled', result: j.params.visualProfileSource, error, completedAt: new Date().toISOString() });
    void releaseStagedUploads(j.params);
    return { canceled: { id: j.id, error } };
  }
  // A remote provider job survives this process: its local queue id is
  // also the stable Idempotency-Key. Re-enqueue the same record and let
  // the remote adapter replay the submission, recover the provider job,
  // and continue polling (or deliver a persisted cancellation intent).
  if (isRemoteMediaJob(j)) {
    maintenance.recoverOwned('media', j.id);
    const marker = j.params?.remoteMedia;
    queue.push({
      ...j,
      status: 'queued',
      cancelRequested: marker?.cancelRequested === true,
      params: restoredParams({
        ...j,
        params: {
          ...j.params,
          remoteMedia: {
            ...(marker && typeof marker === 'object' && !Array.isArray(marker) ? marker : {}),
            reconcile: true,
          },
        },
      }),
    });
    console.log(`🔁 media-job [${j.id.slice(0, 8)}] remote ${j.kind} interrupted — re-enqueued for reconciliation`);
    return {};
  }
  // #1332: a LoRA trainer is a detached child (spawnDetached) that can
  // SURVIVE this restart. If its run still has a live (or just-finished-
  // but-unprocessed) trainer, re-enqueue the SAME job flagged for
  // re-attach instead of failing it — runTraining({reattach:true}) tails
  // the survivor's output and finalizes it, so a run that completed during
  // the downtime still registers its LoRA. The probe lives in loraTraining
  // (it owns the run's on-disk layout); lazy-imported to avoid a static
  // cycle. Falls through to the fail path when nothing survived.
  const reattach = await reattachSurvivingTrainer(j);
  if (reattach) {
    console.log(`🔁 media-job [${j.id.slice(0, 8)}] training survived restart — re-enqueued for re-attach`);
    return { reattach };
  }
  if (j.kind === 'video-sharing') {
    const { cleanupInterruptedSharingCopy } = await import('../musicVideo/sharingCopy.js');
    await cleanupInterruptedSharingCopy(j.id).catch(err => console.error(`❌ Interrupted sharing copy cleanup failed: ${err.message}`));
  }
  archive.push({ ...j, status: 'failed', error: 'interrupted by restart', completedAt: new Date().toISOString() });
  // The failed job never reaches the worker's cleanup, so its staged uploads would leak.
  void releaseStagedUploads(j.params);
  return { failedId: j.id };
}

export async function initMediaJobQueue({ deferCompletionRecovery = false } = {}) {
  installVideoExecutionRecorder();
  if (initPromise) return initPromise;
  completionRecoveryDeferred = deferCompletionRecovery;
  initPromise = (async () => {
    // Once-at-boot: subsequent persist() calls assume the data dir exists.
    await ensureDir(PATHS.data);
    // Read the codex parallel limit before the worker starts so the first
    // drain tick honors the user's configured value, not the default.
    await refreshCodexParallelLimit().catch(() => {});
    // Strict (#4115). A swallowed unreadable jobs file boots an empty queue and
    // the `await persist()` at the end of this init writes that emptiness over
    // the real snapshot — losing the archive and orphaning every job the reload
    // below would have reconciled. This init is an awaited step of
    // `runPostRouteSequence`, where a rejection is FATAL (process.exit), so a
    // bad permission bit on one snapshot file must not take the server down:
    // report it, boot an empty queue, and latch persistence off instead.
    const { ok, value: data } = await readJSONFileStrict(JOBS_FILE, { jobs: [] });
    if (!ok) {
      persistBlocked = true;
      // Name the recovery step: the latch is process-lifetime, so without this
      // the user has a queue that silently stops surviving restarts and no
      // indication that repairing or deleting one file restores it.
      console.error(`❌ media-job queue: ${JOBS_FILE} is present but unreadable — starting empty and NOT persisting so it is preserved; repair or delete it and restart to re-enable persistence`);
    }
    if (!restoreQuotaCooldowns(data?.quotaCooldowns)) {
      // Same latch as a malformed hold: preserve the file rather than
      // overwriting it, but boot normally with no cooldown in force.
      persistBlocked = true;
      console.error('❌ media-job queue: invalid quota cooldowns — snapshot preserved and cooldowns cleared; repair the file and restart');
    }
    const holdsReadable = videoHolds.restore(data?.videoHolds);
    if (!holdsReadable) {
      // A malformed hold must neither kill server boot nor silently release a
      // batch. Preserve the snapshot under the existing unreadable-file latch.
      persistBlocked = true;
      console.error('❌ media-job queue: invalid video holds — snapshot preserved and local video held; repair the holds and restart');
    }
    const persistedJobs = Array.isArray(data?.jobs) ? data.jobs : [];
    const restartedFailedIds = [];
    const restartedCanceled = [];
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
    const videoReap = maintenance.held() ? { reaped: 0 }
      : await reapAndCleanDetachedDirs(join(PATHS.videos, '.detached')).catch(() => ({ reaped: 0 }));
    if (videoReap.reaped) console.log(`🧹 reaped ${videoReap.reaped} surviving render(s) on boot`);
    for (const persisted of persistedJobs) {
      const { failedId, canceled, reattach } = await restorePersistedJob(persisted);
      if (failedId) restartedFailedIds.push(failedId);
      if (canceled) restartedCanceled.push(canceled);
      if (reattach) reattachJobs.push(reattach);
    }
    // Re-attach jobs resume ahead of everything else (they were mid-flight), so
    // unshift them to the front. At most one (single GPU lane), but spread keeps
    // their relative order if that ever changes.
    if (reattachJobs.length) queue.unshift(...reattachJobs);
    if (!persistBlocked && Array.isArray(data?.jobs)) {
      const { cleanupOrphanTopazStaging } = await import('../videoGen/topazStaging.js');
      await cleanupOrphanTopazStaging(listJobs()).catch(() => console.error('❌ Topaz staging cleanup failed; owned files were retained.'));
    }
    // The persisted `position` reflects the previous process' queue layout
    // (which may have included a now-failed running job). Recompute against
    // the current queue so /api/media-jobs and the initial SSE `queued`
    // event report accurate slots. Positions are swim-lane-scoped, so a
    // queued Grok job behind a Codex backlog is restored as position 1.
    for (const [q, position] of swimlanePositions()) q.position = position;
    if (persistedJobs.length) {
      console.log(`📦 mediaJobQueue restored: ${queue.length} queued, ${archive.length} archived`);
    }
    await prepareQueuedVideos();
    videoHolds.updateQueued(queue);
    // Pre-seed terminal SSE payloads for each restart-failed job so that any
    // client that reconnects to /:jobId/events after a restart (the route
    // attaches via attachSseClient → attachSse, which replays lastPayload)
    // gets an immediate error event instead of a silent stream.
    for (const id of restartedFailedIds) {
      const entry = ensureSseEntry(id);
      broadcastSse(entry, { type: 'error', error: 'interrupted by restart' });
      closeJobAfterDelay(sseJobs, id, SSE_CLEANUP_DELAY_MS, entry);
    }
    for (const { id, error } of restartedCanceled) {
      const entry = ensureSseEntry(id);
      broadcastSse(entry, { type: 'canceled', reason: error });
      closeJobAfterDelay(sseJobs, id, SSE_CLEANUP_DELAY_MS, entry);
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
    if (!persistBlocked) {
      await persist();
      startWorker();
    }
  })();
  return initPromise;
}

function startWorker() {
  if (workerStarted || dispatchQuiesced) return;
  workerStarted = true;
  // Detach from awaiting so init can return; the loop runs until shutdown quiesces it.
  workerOperation = drainLoop().catch((err) => {
    console.error(`❌ mediaJobQueue worker crashed: ${err.message}`, err.stack || '');
  }).finally(() => { workerStarted = false; });
}

// Transient (never persisted): why a queued remote job is not dispatching.
// Logged once per blocked job so a silent per-tick skip is still diagnosable.
function holdForPeer(job, blockingJobId) {
  if (job.peerHold?.blockingJobId === blockingJobId) return;
  job.peerHold = { reason: 'peer-settling', blockingJobId };
  console.log(`⏳ media-job [${job.id.slice(0, 8)}] waiting for peer to settle earlier job [${blockingJobId.slice(0, 8)}]`);
}

// A failed/canceled remote job that kept its peer reservation (no terminal peer
// report) is reconciled in-process exactly as boot does, so the peer is not
// blocked until the next restart. Returns whether the row was re-enqueued.
function requeueRetainedReservation(entry) {
  const idx = archive.indexOf(entry);
  if (idx < 0 || entry.durabilityPending || !isRemoteMediaJob(entry)
    || entry.params?.remotePeerReservation !== true || !['failed', 'canceled'].includes(entry.status)) return false;
  const marker = entry.params?.remoteMedia;
  archive.splice(idx, 1);
  // Rebuild from persisted fields only, as boot does: the in-memory row carries
  // transient terminal state (terminating, providerInvoked, ...) that would
  // make the re-run look already settled.
  const { id, kind, owner, queuedAt, startedAt, completedAt, result, error, progress, statusMsg, etaMs } = entry;
  const reconciled = {
    id, kind, owner, queuedAt, startedAt, completedAt, result, error, progress, statusMsg, etaMs,
    status: 'queued',
    cancelRequested: marker?.cancelRequested === true,
    params: restoredParams({ ...entry, params: { ...entry.params, remoteMedia: { ...marker, reconcile: true } } }),
  };
  queue.push(reconciled);
  recomputeQueuePositions();
  // The old terminal grace timer owns the old subscribers. A new stream for
  // this attempt keeps that timer from evicting reconciliation or its clients.
  sseJobs.set(id, { clients: [], lastPayload: { type: 'queued', position: reconciled.position } });
  console.log(`🔁 media-job [${entry.id.slice(0, 8)}] remote ${entry.kind} ended without a terminal peer report — re-enqueued for reconciliation`);
  return true;
}

// Every lane uses fire-and-forget so the poll loop is never blocked by a
// running job in another lane.
function startLaneJob(job, { lane }) {
  // The one promotion boundary every dispatch path crosses, so the shutdown
  // latch holds here even for a caller that raced past its own check.
  if (dispatchQuiesced) return false;
  // If the job isn't in the queue, it was already promoted (e.g. by a parallel
  // runJobNow). Skip — promoting again would double-start the job and corrupt
  // the lane (push it onto cloudRunning/running twice). Silently splice(-1)
  // would also lop the wrong job off the queue.
  const idx = queue.indexOf(job);
  if (idx < 0) {
    console.log(`⚠️ media-job [${job.id.slice(0, 8)}] startLaneJob: already removed from queue, skipping`);
    return false;
  }
  if (lane === 'remote') {
    // Reconciliation occupies the peer slot while it waits for admission. Read
    // the live queue: an in-process requeue can land mid-pass, after the
    // drain loop built its candidate list.
    const reconciling = job.params?.remoteMedia?.reconcile ? null : queue.find((pending) => pending !== job
      && pending.status === 'queued' && pending.params?.remoteMedia?.reconcile
      && pending.params.remoteMedia.peerId === job.params?.remoteMedia?.peerId);
    if (reconciling) { holdForPeer(job, reconciling.id); return false; }
    const blocker = archive.find((entry) => entry.id !== job.id && entry.params?.remotePeerReservation === true
      && entry.params?.remoteMedia?.peerId === job.params?.remoteMedia?.peerId);
    if (blocker) {
      holdForPeer(job, blocker.id);
      // The blocker settled failed/canceled without a terminal peer report;
      // only a reconcile can release it, so do not wait for a restart.
      // A prior reconcile run that failed again is retried at a bounded rate.
      const retryDue = blocker.params.remoteMedia?.reconcile !== true
        || Date.now() - new Date(blocker.completedAt || 0).getTime() >= RESERVATION_RECONCILE_RETRY_MS;
      if (retryDue) requeueRetainedReservation(blocker);
      return false;
    }
  }
  delete job.peerHold;
  const permit = recoveringJobs.has(job.id)
    ? maintenance.recoverOwned('media', job.id)
    : maintenance.tryAdmit('media', job.id, { reconnect: isRemoteReconcile(job) });
  if (!permit) return false;
  queue.splice(idx, 1);
  job.status = 'running';
  if (lane === 'remote') job.params = { ...job.params, remotePeerReservation: true };
  job.startedAt = new Date().toISOString();
  job.position = 1;
  job.progress = typeof job.progress === 'number' && Number.isFinite(job.progress) ? job.progress : 0;
  // A quota wait describes the queued state only; a persisted one also
  // survives a restart that outlasts the cooldown.
  if (QUOTA_WAIT_PATTERN.test(job.statusMsg || '')) job.statusMsg = '';
  job.statusMsg = job.statusMsg || 'Starting';
  if (lane === 'cloud') {
    cloudRunning.push(job);
  } else if (lane === 'remote') {
    remoteRunning.push(job);
  } else {
    running = job;
  }
  recomputeQueuePositions();
  const label = lane === 'cloud'
    ? (job.params?.mode || 'cloud')
    : lane === 'remote' ? `remote ${job.kind}` : job.kind;
  let finalized = false;
  let terminalCounted = false;
  let archiveWrite;
  function finalizeLane() {
    if (!terminalCounted && ['completed', 'failed', 'canceled'].includes(job.status)) {
      terminalCounted = true;
      videoHolds.recordTerminal(job);
      videoHolds.updateQueued(queue);
    }
    if (finalized) return archiveWrite;
    finalized = true;
    if (lane === 'cloud') {
      const idx = cloudRunning.indexOf(job);
      if (idx >= 0) cloudRunning.splice(idx, 1);
    } else if (lane === 'remote') {
      const idx = remoteRunning.indexOf(job);
      if (idx >= 0) remoteRunning.splice(idx, 1);
    } else {
      running = null;
    }
    // Archive every terminal job (completed / failed / canceled). The 24h
    // TTL prune in persistImpl keeps the file from growing unbounded, and
    // the UI's recent-reel cap (recentLimit) handles in-memory display.
    archive.push(job);
    recomputeQueuePositions();
    archiveWrite = persist();
    archiveWrite.catch((e) => console.error(`❌ media-job [${job.id.slice(0, 8)}] mediaJobQueue persist on ${label} done failed: ${e.message}`));
    return archiveWrite;
  }
  let markRunning;
  // Null when the lifecycle threw before returning its evidence.
  let lifecycleEvidence = null;
  trackOperation(dispatchOperations, new Promise((resolve) => { markRunning = resolve; }));
  trackOperation(laneOperations, permit.run(async () => {
    try {
      await persist();
      // Cancellation can win while the running snapshot is blocked.
      if (job.cancelRequested && !isRemoteMediaJob(job)) throw new ServerError('Canceled before provider start');
      broadcastSse(ensureSseEntry(job.id), { type: 'started', kind: job.kind });
      mediaJobEvents.emit('started', job);
      console.log(`▶️  media-job [${job.id.slice(0, 8)}] ${label} started`);
      const lifecycle = runJob(job, permit, finalizeLane);
      markRunning();
      lifecycleEvidence = await lifecycle;
      if (resettingForTests) return;
    } catch (err) {
      markRunning();
      // runJob threw before its own terminal handlers ran (e.g. PYTHON
      // not configured). Recover so a single bad job can't freeze its lane.
      console.error(`❌ media-job [${job.id.slice(0, 8)}] ${label} runJob threw: ${err.message}`, err.stack || '');
      if (job.status === 'running') {
        stageTerminalTransition(job, (j) => {
          j.status = j.cancelRequested ? 'canceled' : 'failed';
          videoHolds.captureFailure(j, err);
          j.error = j.cancelRequested ? 'Canceled' : err instanceof ServerError ? err.message : `runJob threw: ${err.message}`;
          j.completedAt = new Date().toISOString();
        }, () => {
          const entry = ensureSseEntry(job.id);
          broadcastSse(entry, job.cancelRequested
            ? { type: 'canceled', reason: job.error } : { type: 'error', error: job.error });
          closeJobAfterDelay(sseJobs, job.id, SSE_CLEANUP_DELAY_MS, entry);
          mediaJobEvents.emit(job.status, job);
          finalizeLane();
        });
        await trackTerminalOperation(persistTerminalTransition(job));
      }
    }
    await finalizeLane();
    // A shutdown deadline bounds its caller, not the lifetime of this write.
    // Keep owning the reservation until the actual drain settles; timing out
    // and abandoning it would strand a blocker after a later successful write.
    const settled = await drainMediaJobQueue();
    const remoteRecoveryUnsettled = isRemoteMediaJob(job) && (job.params?.remoteMedia?.reconcile === true || job.params?.remotePeerReservation === true);
    if (settled.ok && job.params?.reviewedReferenceSnapshot && ((job.providerInvoked !== true && !remoteRecoveryUnsettled) || lifecycleEvidence?.snapshotProcessSettled === true)) {
      const { markSnapshotState, withReviewedSnapshotLock } = await import('../imageGen/reviewedReference.js');
      await withReviewedSnapshotLock(() => markSnapshotState(job.params.reviewedReferenceSnapshot, 'settled')).catch(error => console.error(`❌ Reviewed image settlement retained for ${job.id}: ${error.message}`));
    }
    recoveringJobs.delete(job.id);
    // Lifecycle evidence certifies recovery only together with this final flush.
    const release = decideOwnershipRelease({
      evidence: lifecycleEvidence, flushed: settled.ok, canCompleteRecovery: Boolean(permit.completeRecovery),
    });
    if (release === OWNERSHIP_RELEASE.UNSETTLED) permit.markUnsettled();
    else if (release === OWNERSHIP_RELEASE.COMPLETE_RECOVERY) await permit.completeRecovery();
    else await permit.finish();
  }).catch((error) => console.error(`❌ media-job [${job.id.slice(0, 8)}] storage settlement pending: ${error.message}`)));
  return true;
}

// Withdraw synchronously before cleanup yields: cancellation and preparation
// can race, but only the caller that removes this exact waiting job owns it.
// Shared by pre-dispatch failures and queued cancellation; no lane is claimed.
async function settleQueuedJob(job, { status, error }) {
  const idx = queue.indexOf(job);
  if (idx < 0 || job.status !== 'queued') return false;
  queue.splice(idx, 1);
  stageTerminalTransition(job, (j) => {
    j.status = status;
    j.error = error;
    j.completedAt = new Date().toISOString();
  }, () => {
    trackTerminalOperation((async () => {
      await releaseStagedUploads(job.params);
      if (isTopazUpscale(job)) {
        const { cleanupPreparedTopaz } = await import('../videoGen/topazJob.js');
        await cleanupPreparedTopaz(job.params.preparedId);
      }
      const entry = ensureSseEntry(job.id);
      broadcastSse(entry, status === 'canceled'
        ? { type: 'canceled', reason: error } : { type: 'error', error });
      closeJobAfterDelay(sseJobs, job.id, SSE_CLEANUP_DELAY_MS, entry);
      mediaJobEvents.emit(status, job);
    })());
  });
  archive.push(job);
  recomputeQueuePositions();
  await trackTerminalOperation(persistTerminalTransition(job));
  if (job.params?.reviewedReferenceSnapshot && !job.durabilityPending
    && !(isRemoteMediaJob(job) && (job.params?.remoteMedia?.reconcile === true || job.params?.remotePeerReservation === true))) {
    const { markSnapshotState, withReviewedSnapshotLock } = await import('../imageGen/reviewedReference.js');
    await withReviewedSnapshotLock(() => markSnapshotState(job.params.reviewedReferenceSnapshot, 'settled')).catch(error => console.error(`❌ Reviewed image settlement retained for ${job.id}: ${error.message}`));
  }
  return true;
}

async function prepareQueuedVideos(jobs = queue.filter((job) => !job.admitting)) {
  // An admission still waiting for its durable snapshot is not eligible for
  // preparation or failure. Re-check after every await before withdrawing it.
  const results = await videoHolds.resolveCohorts(jobs);
  for (const { job, error } of results) {
    if (dispatchQuiesced) break;
    if (!error || job.admitting) continue;
    await settleQueuedJob(job, { status: 'failed',
      error: `Could not prepare local video model: ${error.message || String(error)}` })
      .catch((failure) => console.error(`❌ media preparation outcome awaiting storage: ${failure.message}`));
  }
}

// IDs proven by the boot probe to have an existing trainer; request params cannot grant this.
const recoveringJobs = new Set();

// Quiescing wakes the idle wait even under fake timers, so joining the worker
// never depends on another clock tick. Preparation already in flight still joins.
function waitForWorker() {
  return new Promise(resolve => {
    const timer = setTimeout(() => { wakeWorker = null; resolve(); }, 150);
    wakeWorker = () => { clearTimeout(timer); wakeWorker = null; resolve(); };
  });
}

async function drainLoop() {
  while (!dispatchQuiesced) {
    const held = maintenance.held();
    const candidates = queue.filter((job) => !job.admitting && (!held || recoveringJobs.has(job.id)));
    if (held && !candidates.length) { await waitForWorker(); continue; }
    await prepareQueuedVideos(candidates);
    // Shutdown may have begun while cohorts resolved; exit without promoting.
    if (dispatchQuiesced) break;
    videoHolds.updateQueued(queue);
    // Single queue scan, promoting work independently into each open lane.
    // Each swim lane has its own slots, and each lane its own total bound, so
    // a full swim lane only skips its own work.
    const limits = laneLimits();
    const totals = laneTotalLimits();
    const laneSlots = {
      gpu: totals.gpu - Number(Boolean(running)),
      cloud: totals.cloud - cloudRunning.length,
      remote: totals.remote - remoteRunning.length,
    };
    const swimSlots = new Map();
    const freeSwimSlots = (job) => swimSlots.get(jobSwimlane(job)) ?? limits[jobLane(job)];
    for (const active of runningJobs()) swimSlots.set(jobSwimlane(active), freeSwimSlots(active) - 1);
    let quotaWaitChanged = false;
    for (const job of candidates) {
      if (job.status !== 'queued' || job.hold || job.admitting) continue;
      // The provider told us when it recovers; dispatching before then just
      // converts a queued job into a failed one. Hold rather than fail, and say
      // when it resumes — `statusMsg` is in the persisted field whitelist, so
      // the Render Queue shows the wait across a restart too.
      const resumeAt = quotaCooldownResumeAt(job);
      if (resumeAt) {
        const waiting = quotaWaitMessage(job.params.mode, resumeAt);
        if (job.statusMsg !== waiting) {
          job.statusMsg = waiting;
          quotaWaitChanged = true;
        }
        continue;
      }
      const lane = jobLane(job);
      const free = freeSwimSlots(job);
      if (laneSlots[lane] <= 0 || free <= 0) continue;
      // Reconciliation occupies a peer's slot until settled (startLaneJob).
      if (!startLaneJob(job, { lane })) continue;
      laneSlots[lane] -= 1;
      swimSlots.set(jobSwimlane(job), free - 1);
    }
    // One snapshot for every hold this scan changed, not one per job.
    if (quotaWaitChanged) {
      persist().catch((e) => console.error(`❌ media-job mediaJobQueue persist on quota hold failed: ${e.message}`));
    }
    if (!dispatchQuiesced) await waitForWorker();
  }
}

// Stop dispatch for server shutdown (#8691). Synchronous and idempotent so the
// signal handler can call it before its first await. Waiting jobs are neither
// canceled nor failed — they persist as queued and the next boot restores
// them; already-running jobs keep their normal completion path, which the
// shutdown flush then captures. Returns true on the call that latched it.
export function quiesceMediaJobQueue() {
  if (dispatchQuiesced) return false;
  dispatchQuiesced = true;
  wakeWorker?.();
  console.log(`⏸️  mediaJobQueue dispatch stopped for shutdown (${queue.length} waiting job(s) kept queued)`);
  return true;
}

// Share-bucket import entry point. The queue owns media-jobs.json: a writer
// outside it is overwritten by the next persist() (the snapshot is built from
// memory alone), so imported re-render records go through the in-memory archive
// and are saved with the queue's own snapshot. Ids already known to the queue
// win; returns the number of rows added.
export async function importArchivedJobs(records) {
  if (!initPromise) throw new Error('Media queue is not initialized; imported jobs cannot be saved');
  await initPromise;
  if (persistBlocked) throw new Error('Media queue storage is blocked until its snapshot is repaired and the server restarts');
  let added = 0;
  for (const record of Array.isArray(records) ? records : []) {
    const row = importedArchiveRow(record);
    if (!row || findJob(row.id)) continue;
    archive.push(row);
    added += 1;
  }
  if (added) await persist();
  return added;
}

// Drop a job from the archive (e.g. after a successful retry — the old failed
// row shouldn't keep cluttering the recent-reel UI now that a fresh job has
// inherited its work). Returns true if removed, false if the id wasn't found
// or was still live. Live jobs are deliberately left alone — the caller
// should cancel them first.
export function removeArchivedJob(jobId) {
  const idx = archive.findIndex((j) => j.id === jobId);
  if (idx < 0 || archive[idx].durabilityPending || archive[idx].params?.remotePeerReservation === true || archive[idx].result?.topazUncertain === true) return false;
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
  persist().catch((e) => console.error(`❌ media-job [${jobId.slice(0, 8)}] mediaJobQueue persist on archive prune failed: ${e.message}`));
  return true;
}

// "Run now" bypass — start a queued cloud-CLI image job immediately
// even if the lane is at its limit. GPU jobs are rejected (single MLX runtime
// would OOM). The rejection code stays 'NOT_CODEX' for client back-compat.
export function runJobNow(jobId) {
  const job = queue.find((j) => j.id === jobId && !j.admitting);
  if (!job) return { ok: false, code: 'NOT_FOUND', error: 'Job not found in queue' };
  if (!isCloudImageJob(job)) {
    return { ok: false, code: 'NOT_CODEX', error: 'Only cloud-CLI image jobs can be run now; GPU jobs serialize on the MLX runtime' };
  }
  if (dispatchQuiesced) {
    return { ok: false, code: MEDIA_QUEUE_SHUTTING_DOWN, error: 'The server is shutting down; the job stays queued and resumes after restart' };
  }
  if (!startLaneJob(job, { lane: 'cloud' })) {
    return { ok: false, code: 'MAINTENANCE_HELD', error: 'Maintenance is holding new renders; this job stays queued' };
  }
  return { ok: true, status: 'running' };
}

// Recompute queue positions and notify each waiting SSE client of its new
// slot. Called whenever the queue layout shifts (job dequeued, finished, or
// canceled mid-queue). Without the broadcast, a client connected to
// /:jobId/events would keep showing the position from its original enqueue
// frame even after the line ahead of it cleared.
function recomputeQueuePositions() {
  videoHolds.updateQueued(queue);
  for (const [q, newPosition] of swimlanePositions()) {
    if (q.position === newPosition) continue;
    q.position = newPosition;
    const entry = sseJobs.get(q.id);
    if (entry) broadcastSse(entry, { type: 'queued', position: newPosition });
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
    const verb = MEDIA_JOB_RUNTIME[kind]?.verb ?? 'Generating';
    return `${verb} step ${e.step}/${e.totalSteps}`;
  }
  return undefined;
}
// Two finite positive edges, or nothing. A runner that reports no geometry —
// or a heartbeat-shaped frame with a zero/NaN edge — must produce NO geometry
// rather than a ratio the client would have to defend against.
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
    // `etaMs` (video gen, #3801) rides along the same way: a history-calibrated
    // wall-clock estimate for the whole render. Presence-guarded on purpose —
    // an install with no matching measurement emits no key at all, which the
    // UI must show as "unknown" rather than as a zero countdown.
    // `phase` (video gen, #5872) is the runner's own STAGE: id — 'load-model',
    // 'encode-prompt', 'sampling', 'mux', … The client turns it into a named
    // render step so a runner that reports no numeric progress for minutes
    // (FastH3 streams an ~89 GB DiT before its first denoise step) still says
    // WHAT it is doing rather than showing a motionless 0%.
    const addFrameFields = (payload) => {
      if (typeof e.step === 'number') payload.step = e.step;
      if (typeof e.totalSteps === 'number') payload.totalSteps = e.totalSteps;
      if (typeof e.loss === 'number') payload.loss = e.loss;
      if (typeof e.etaMs === 'number') payload.etaMs = e.etaMs;
      if (typeof e.phase === 'string' && e.phase) payload.phase = e.phase;
    };
    if (hasProgress) {
      const payload = { type: 'progress', progress: e.progress };
      if (hasCurrentImage) payload.currentImage = e.currentImage;
      if (message !== undefined) payload.message = message;
      addFrameFields(payload);
      handlers.progress(payload);
      return;
    }
    if (hasCurrentImage) {
      // Preview-only frame (imageGen step thumbnail) — distinct SSE type so
      // existing consumers can keep their progress-bar value untouched.
      const payload = { type: 'preview', currentImage: e.currentImage };
      if (message !== undefined) payload.message = message;
      addFrameFields(payload);
      handlers.progress(payload);
    }
  };
  const onStatus = (e) => {
    // Optional explicit `status` event for gens that want to push a status
    // line independent of progress. Unused today; here so a future emitter
    // can call `videoGenEvents.emit('status', { generationId, message })`.
    if (e.generationId !== job.id) return;
    if (typeof e.message === 'string' && e.message.length > 0) {
      const payload = { type: 'status', message: e.message };
      if (typeof e.phase === 'string' && e.phase) payload.phase = e.phase;
      handlers.progress(payload);
    }
  };
  const onCompleted = (e) => { if (e.generationId === job.id) handlers.completed(e); };
  const onFailed = (e) => { if (e.generationId === job.id) handlers.failed(e); };
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

// The dispatch window closes once the provider has been invoked (not settled —
// a provider kickoff may legitimately stay pending) or the job failed before
// reaching it. The finally covers a throw anywhere before that point.
async function runJob(job, permit, finalizeLane) {
  let markDispatched;
  trackOperation(dispatchOperations, new Promise((resolve) => { markDispatched = resolve; }));
  try {
    return await runJobLifecycle(job, markDispatched, permit, finalizeLane);
  } finally {
    markDispatched();
  }
}

// The provider-dispatch copy of job.params; the retained job stays unchanged.
// Thread #1 (pre-gen sanitizer): even though safeUnlinkUpload guards the
// *delete* path, the gen module receives this spread and could itself act on a
// corrupted path from a hand-edited media-jobs.json. Null any upload path that
// doesn't resolve under PATHS.uploads so the constraint holds end-to-end.
function buildDispatchParams(job) {
  const safeParams = { ...job.params };
  if (job.params?.reviewedReferenceRequest) {
    const request = job.params.reviewedReferenceRequest;
    // JSON drops undefined properties. Restore those absences explicitly so
    // the top-level downgrade placeholders do not override provider defaults.
    Object.assign(safeParams, request, { prompt: request.prompt, modelId: request.modelId, pythonPath: request.pythonPath });
  }
  // Freeze only the dispatch copy to the default whose cohort passed the hold
  // check. The retained job's original parameters stay unchanged.
  if (job.videoCohort && (safeParams.modelId === undefined || safeParams.modelId === '')) {
    safeParams.modelId = job.videoCohort.modelId;
  }
  for (const key of ['uploadedTempPath', 'audioFilePath']) {
    const value = safeParams[key];
    if (value && (typeof value !== 'string' || !isUnderUploadsRoot(value))) {
      console.log(`⚠️ media-job [${job.id.slice(0, 8)}] ${key} outside PATHS.uploads — nulled before gen invoke: ${value}`);
      safeParams[key] = null;
    }
  }
  safeParams.uploadedTempPaths = normalizeTempPaths(safeParams.uploadedTempPaths).filter((p) => {
    if (isUnderUploadsRoot(p)) return true;
    console.log(`⚠️ media-job [${job.id.slice(0, 8)}] uploadedTempPaths entry outside PATHS.uploads — rejected before gen invoke: ${p}`);
    return false;
  });
  // Clamp chunks to the same 1-8 bound the route enforces on new submissions.
  // Replayed jobs read params from media-jobs.json which could be hand-edited
  // to an out-of-range value, bypassing the route-layer Zod validation.
  safeParams.chunks = boundedVideoChunks(safeParams.chunks);
  return safeParams;
}

// The dispatch must carry the exact snapshot admitted for this job, and claim
// it (reserved → invoked) before the provider starts. Only a reconciling remote
// recovery may re-dispatch an already-invoked snapshot.
async function assertReviewedReferenceDispatch(job, safeParams) {
  if (safeParams.reviewedReferenceRequest && !safeParams.reviewedReferenceSnapshot) {
    throw new ServerError('Reviewed reference ownership is missing', { status: 409, code: 'REVIEWED_REFERENCE_CHANGED' });
  }
  if (!safeParams.reviewedReferenceSnapshot) return;
  const { readOwnedSnapshot, markSnapshotState, withReviewedSnapshotLock, isReviewedReferenceList } = await import('../imageGen/reviewedReference.js');
  const snapshot = safeParams.reviewedReferenceSnapshot;
  const { path, record } = await readOwnedSnapshot(snapshot);
  const remoteAssets = safeParams.remoteMedia?.inputAssets;
  const remoteMismatch = isRemoteMediaJob(job) && (safeParams.remoteMedia?.wireVersion !== 2
    || JSON.stringify(safeParams.remoteMedia.reviewedReferenceSnapshot) !== JSON.stringify(snapshot)
    || !Array.isArray(remoteAssets) || remoteAssets.some(asset => asset?.role !== 'referenceImages')
    || !isReviewedReferenceList(remoteAssets.map(asset => asset.path), path));
  if (snapshot.jobId !== job.id || safeParams.initImagePath || !isReviewedReferenceList(safeParams.referenceImagePaths, path) || remoteMismatch) {
    throw new ServerError('Reviewed reference ownership does not match the queued job', { status: 409, code: 'REVIEWED_REFERENCE_CHANGED' });
  }
  if (record.state === 'reserved') await withReviewedSnapshotLock(() => markSnapshotState(snapshot, 'invoked'));
  else if (!(record.state === 'invoked' && isRemoteMediaJob(job) && safeParams.remoteMedia?.reconcile === true)) {
    throw new ServerError('Reviewed reference is not available for dispatch', { status: 409, code: 'REVIEWED_REFERENCE_CHANGED' });
  }
}

async function runJobLifecycle(job, markDispatched, permit, finalizeLane) {
  const sseEntry = ensureSseEntry(job.id);
  let resolveTerminalState;
  const terminalState = new Promise((resolve) => { resolveTerminalState = resolve; });
  let resolveProviderSettlement;
  const providerSettlement = new Promise(resolve => { resolveProviderSettlement = resolve; });
  let resolveDeferredCompletion;
  const deferredCompletion = new Promise(resolve => { resolveDeferredCompletion = resolve; });
  let watchdogNeedsProviderSettlement = false;
  // Transient: returned to the lane finalizer, never persisted or projected.
  const recovery = createRecoveryEvidence();
  let inputCleanupAttempted = false;
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
    await persist().catch((e) => console.error(`❌ media-job [${job.id.slice(0, 8)}] mediaJobQueue persist on progress failed: ${e.message}`));
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

  let watchdogTimer;
  async function releaseRemoteAudioInputs(disposable) {
    if (!disposable || !isRemoteMediaJob(job)) return;
    if (job.params?.remotePeerReservation === true) {
      job.params = { ...job.params, remotePeerReservation: false };
      try { await persist(); }
      catch (_error) {
        job.params = { ...job.params, remotePeerReservation: true };
        maintenance.markResourceUnsettled('media', job.id);
        return;
      }
    }
    if (inputCleanupAttempted) return;
    inputCleanupAttempted = true;
    try {
      // withResource deliberately skips unsettled operations. Cleanup must
      // execute under this exact captured permit so a new error stamps it.
      await permit.run(async () => {
        const { discardSourceAudioWindow } = await import('../federatedMedia/sourceAudio.js');
        const owned = normalizeTempPaths(job.params?.uploadedTempPaths);
        const cleaned = new Set();
        for (const asset of job.params?.remoteMedia?.inputAssets || []) {
          if (asset.role === 'sourceAudio') {
            if (!owned.includes(asset.path) || !(await discardSourceAudioWindow(asset.path)).ok) {
              throw new Error('Remote source audio has no verified owned cleanup binding');
            }
            cleaned.add(asset.path);
          }
        }
        // This recovery certifies the feature's owned WAV windows. Other
        // staged multipart inputs have no equivalent cleanup receipt here.
        recordOwnedInputCleanup(recovery, [...owned, job.params?.uploadedTempPath, job.params?.audioFilePath]
          .filter(Boolean).every(path => cleaned.has(path)));
      });
    } catch (error) {
      maintenance.markResourceUnsettled('media', job.id);
      console.error(`❌ Remote video input cleanup needs recovery for ${job.id}: ${error.message}`);
    }
  }
  // All terminal paths compete for one outcome. claimTerminalOutcome sets the
  // transient job.terminating flag synchronously, so cancelJob also sees the
  // claim while status is still running during the async progress drain.
  async function terminate(state, apply, remoteInputsDisposable = false) {
    if (!claimTerminalOutcome(job)) return;
    clearInterval(watchdogTimer);
    emitter.off?.('activity', onActivity);
    emitter.off?.('progress', onActivity);
    await drainProgressPersist();
    let publicationStarted = false;
    try {
      await admitCompletion(state, () => {
        publicationStarted = true;
        return publishTerminalTransition(state, apply, remoteInputsDisposable);
      });
    } catch (error) {
      if (publicationStarted || state !== 'completed') throw error;
      console.warn(`⏸️ media-job [${job.id.slice(0, 8)}] completion retained for publication recovery: ${error.message}`);
      // The provider finished, but admission never opened. Persist a pending
      // receipt without publishing completion, so recovery can finish it even
      // after a restart. Do not replay a callback that already started.
      try {
        await publishTerminalTransition(state, apply, remoteInputsDisposable);
      } finally {
        resolveDeferredCompletion();
      }
    }
  }

  async function publishTerminalTransition(state, apply, remoteInputsDisposable) {
    if (remoteInputsDisposable === true && isRemoteMediaJob(job)) {
      job.params = { ...job.params, remotePeerReservation: false };
    }
    stageTerminalTransition(job, (job) => {
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
    }, async () => {
      // The terminal snapshot is durable now; a restart no longer rebuilds
      // this request. Absence of the executor verdict retains all inputs.
      recordTerminalDurable(recovery);
      // A shared persist can acknowledge another job: restore THAT job's
      // maintenance context, and never let cleanup failure lose this callback.
      await releaseRemoteAudioInputs(remoteInputsDisposable);
      await announceTerminalTransition(job, resolveTerminalState);
    });
    await persistTerminalTransition(job);
  }

  const handlers = {
    progress: (payload) => {
      if (!canReceiveProgress(job)) return;
      let didUpdatePersistedProgress = false;
      if (payload.type === 'progress' && typeof payload.progress === 'number' && Number.isFinite(payload.progress)) {
        job.progress = Math.max(0, Math.min(1, payload.progress));
        didUpdatePersistedProgress = true;
      }
      if (typeof payload.message === 'string' && payload.message.length > 0) {
        job.statusMsg = payload.message;
        didUpdatePersistedProgress = true;
      }
      // Retain the render ETA (#3801) on the job so a browser that reloads
      // mid-render gets it back from GET /api/media-jobs/:id instead of
      // waiting minutes for the next progress frame to re-deliver it.
      if (typeof payload.etaMs === 'number' && payload.etaMs !== job.etaMs) {
        job.etaMs = payload.etaMs;
        didUpdatePersistedProgress = true;
      }
      if (didUpdatePersistedProgress) scheduleProgressPersist();
      broadcastSse(sseEntry, payload);
    },
    completed: (payload) => {
      const { remoteInputsDisposable, remoteRecoverySettlement, ...result } = payload;
      if (job.kind === 'image' && job.params?.visualProfile) {
        if (job.visualProfileFinishing || !canRequestCancellation(job)) return;
        const controller = new AbortController();
        job.visualProfileFinishing = controller;
        const finishWatchdog = setTimeout(() => {
          controller.abort(new Error('Film finishing exceeded its 3-minute deadline'));
        }, VISUAL_PROFILE_FINISH_TIMEOUT_MS);
        finishWatchdog.unref?.();
        if (job.cancelRequested) controller.abort(new Error('Canceled during film finishing'));
        clearInterval(watchdogTimer);
        handlers.progress({ type: 'progress', progress: 0.95, message: 'Saving universe visual profile and film finish' });
        trackTerminalOperation((async () => {
          try {
            // Retry resumes only the local finish. Persist the completed source
            // before opening a browser so a failed finish cannot buy another image.
            job.params = { ...job.params, visualProfileSource: result };
            await persist();
            controller.signal.throwIfAborted();
            const { finishVisualProfileImage } = await import('../imageGen/finishVisualProfile.js');
            const finished = await finishVisualProfileImage({ result, profile: job.params.visualProfile,
              revision: job.params.visualProfileRevision, signal: controller.signal, onCleanupFailure: () => permit.markUnsettled() });
            controller.signal.throwIfAborted();
            await terminate('completed', j => { j.result = finished; }, remoteInputsDisposable === true);
          } catch (error) {
            await terminate(job.cancelRequested ? 'canceled' : 'failed', j => {
              j.result = result;
              j.error = job.cancelRequested ? 'Canceled during film finishing; original image retained' : `Film finishing failed; original image retained: ${error.message}`;
            }, remoteInputsDisposable === true);
          } finally { clearTimeout(finishWatchdog); delete job.visualProfileFinishing; }
        })().catch(e => console.error(`❌ media-job [${job.id.slice(0, 8)}] film finishing handler failed: ${e.message}`)));
        return;
      }
      trackTerminalOperation(
        terminate('completed', (j) => { j.result = result; }, remoteInputsDisposable === true)
          .catch((e) => console.error(`❌ media-job [${job.id.slice(0, 8)}] terminal handler failed: ${e.message}`)),
      );
    },
    failed: (payload) => {
      if (job.visualProfileFinishing) {
        job.visualProfileFinishing.abort(new Error(payload.error || 'Image finishing interrupted'));
        return;
      }
      // If cancelJob() flagged this job before the underlying gen reported
      // failure, treat the SIGTERM-induced failure as a clean cancel rather
      // than an error so /api/media-jobs?status=canceled works.
      if (job.cancelRequested && !(isTopazUpscale(job) && payload.remoteCancellationConfirmed !== true)) {
        trackTerminalOperation(
          terminate('canceled', (j) => {
            // Persist the reason so a late SSE reconnect after the live entry
            // is cleaned up still gets a meaningful terminal frame from the
            // archived state, rather than the generic "Canceled" fallback.
            if (j.kind === 'image' && j.params?.visualProfileSource) {
              j.result = j.params.visualProfileSource;
              j.error = 'Canceled during film finishing; original image retained';
            } else j.error = 'Canceled while running';
          }, payload.remoteInputsDisposable === true).catch((e) => console.error(`❌ media-job [${job.id.slice(0, 8)}] terminal handler failed: ${e.message}`)),
        );
        return;
      }
      trackTerminalOperation(
        terminate('failed', (j) => {
          j.error = payload.error || 'unknown error';
          // Evidence only — this job still fails through the normal terminal
          // path. What it buys is every job queued BEHIND it: they hold for the
          // provider's stated reset instead of dispatching into the same 429.
          recordQuotaCooldown(j, j.error);
          videoHolds.captureFailure(j, j.error, payload);
        }, payload.remoteInputsDisposable === true)
          .catch((e) => console.error(`❌ media-job [${job.id.slice(0, 8)}] terminal handler failed: ${e.message}`)),
      );
    },
  };

  const safeParams = buildDispatchParams(job);

  await resolveLiveParams(job, safeParams);

  const runtime = MEDIA_JOB_RUNTIME[job.kind];
  const emitter = runtime?.events ?? imageGenEvents;
  // A watchdog outcome records why the job failed; it does not prove that
  // cancellation has reached physical exit and provider cleanup. Only a real
  // provider terminal event can release that additional wait.
  const observeProviderSettlement = payload => {
    observeProviderTerminal(recovery, job, payload);
    if (payload.inputProcessSettled === true || (isRemoteMediaJob(job) && payload.remoteInputsDisposable === true)) recovery.snapshotProcessSettled = true;
    resolveProviderSettlement();
  };
  const dispatcher = makeGenDispatcher(emitter, job, {
    ...handlers,
    completed: payload => { observeProviderSettlement(payload); handlers.completed(payload); },
    failed: payload => { observeProviderSettlement(payload); handlers.failed(payload); },
  });
  dispatcher.attach();

  // Thread #2: per-job idle watchdog — fires when the gen has been silent
  // for the configured window. Switched from "max wall time" to "max idle"
  // because first-run downloads of multi-GB models (Z-Image-Turbo ~13 GB,
  // ERNIE-Image ~16 GB) routinely exceed any sensible total-time bound,
  // but the runner emits stderr lines (tqdm / STAGE markers / status
  // prose) regularly while it's actually working. Any non-noise line in
  // imageGen/videoGen/local.js#handleLine emits 'activity' which resets
  // lastActivityAt; only true hangs (process wedged, no output) trip it.
  // Cloud check first: a grok VIDEO job must take the cloud watchdog, not the
  // chunk-scaled local-video one (the provider emits 'activity' on stdout so a
  // long-but-active render never trips the idle cap).
  const idleTimeoutMs = isCloudImageJob(job) ? WATCHDOG_CODEX_MS : (runtime?.watchdogMs ?? flatWatchdog(WATCHDOG_IMAGE_MS))(safeParams);
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
    if (!canRequestCancellation(job)) return;
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
      if (!canRequestCancellation(job)) return;
      console.log(`⏱️ media-job [${job.id.slice(0, 8)}] watchdog fired after ${idleFor}ms idle (limit ${idleTimeoutMs}ms) — marking failed`);
      watchdogNeedsProviderSettlement ||= job.providerInvoked === true;
      if (mod?.cancel) await mod.cancel(job.id);
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

  let abandonForTests;
  const abandoned = new Promise(resolve => { abandonForTests = () => {
    job.terminating = true;
    resolve();
  }; });
  testLifecycleDisposals.add(abandonForTests);
  try {
    try {
      // A restored remote submission must reach its adapter to deliver an
      // already-recorded cancellation, even after its project narrows or is deleted.
      const recoveringRemoteCancellation = isRemoteMediaJob(job) && job.cancelRequested
        && job.params?.remoteMedia?.reconcile === true && job.params.remoteMedia.cancelRequested === true;
      if (!recoveringRemoteCancellation) await assertMusicVideoJobPolicy(job.kind, job.params);
      const mod = await getGenModuleForJob(job);
      if (job.params?.videoProduction) {
        const { assertVideoAttemptDispatch } = await import('../creativeDirector/videoExecution.js');
        await assertVideoAttemptDispatch(job.params.videoProduction.projectId, job.params.videoProduction.attemptId, { jobId: job.id });
      }
      if (job.params?.shotInstruction?.repair && job.params?.musicVideo) {
        const { assertPerformanceRepairDispatch } = await import('../musicVideo/revisionService.js');
        await assertPerformanceRepairDispatch(job.params.musicVideo);
      }
      if (!mod) throw new Error(`Unknown job kind: ${job.kind}`);
      // A cancel that arrived while this job was still queued lives on the
      // persisted marker, not on any in-memory adapter state. Re-stamp it for
      // every remote kind so the adapter starts already knowing it must recover
      // the provider job and cancel it rather than import its result.
      if (isRemoteMediaJob(job)) {
        safeParams.remoteMedia = {
          ...(safeParams.remoteMedia && typeof safeParams.remoteMedia === 'object'
            ? safeParams.remoteMedia : {}),
          cancelRequested: job.params?.remoteMedia?.cancelRequested === true,
        };
      }
      if (job.params?.musicVideo?.sceneId && !(job.cancelRequested && isRemoteMediaJob(job))) {
        const { assertMusicVideoSceneReview } = await import('../musicVideo/productionReviewService.js');
        await assertMusicVideoSceneReview(job.params.musicVideo, job.kind, { storyboardGuided: Boolean(job.params.guidanceImagePath) });
      }
      // The user may edit a referenced file while this job waits in the queue.
      // Recheck the captured bytes and request at the last provider boundary;
      // recovery/finish replays must not start another render.
      if (job.kind === 'image' && safeParams.fableLoom && !isLocalFinishReplay(job)
        && !isRemoteReconcile(job)) {
        const { assertFableLoomDispatchInputs } = await import('../fableLoom/requestInputs.js');
        await assertFableLoomDispatchInputs(safeParams);
      }
      await assertReviewedReferenceDispatch(job, safeParams);
      // Remote recovery must still reach its adapter to cancel an existing render.
      // Local cancellation before dispatch owns no provider process to stop.
      if (job.cancelRequested && !isRemoteMediaJob(job) && !(isTopazUpscale(job) && job.params?.topazRecovery)) {
        throw new Error('Canceled before provider dispatch');
      }
      // A watchdog can win during the awaited policy/module preparation above.
      // Its terminal outcome must prevent that delayed provider from starting.
      if (!canRequestCancellation(job)) throw new Error('Provider dispatch stopped after the job reached a terminal outcome');
      if (isLocalFinishReplay(job)) {
        handlers.completed(safeParams.visualProfileSource);
        markDispatched();
      } else {
        // Transient, like terminating: no await between this flag and invocation.
        job.providerInvoked = true;
        const request = { ...safeParams, jobId: job.id,
          ...(isTopazUpscale(job) ? { topazCancelRequested: job.cancelRequested === true } : {}),
          ...(job.kind === 'video' && jobLane(job) === 'gpu' && Number(safeParams.chunks) > 1 ? { executionQueueJobId: job.id } : {}) };
        const kickoff = (runtime?.invoke ?? MEDIA_JOB_RUNTIME.image.invoke)(mod, request, safeParams);
        markDispatched();
        await Promise.race([kickoff, abandoned]);
      }
      if (resettingForTests) return null;
    } catch (err) {
      // Policy/auth refusal still stands, but it cannot prove a previously
      // admitted peer render finished before this recovery attempt.
      if (isRemoteReconcile(job)) maintenance.markCurrentUnsettled();
      // generateVideo / generateChainedVideo / generateImage threw before
      // reaching their proc.on cleanup hooks (e.g. PYTHON not configured,
      // validation fail). Clean up multipart upload temp files the route
      // handed us so they don't leak under data/uploads.
      // safeUnlinkUpload constrains the delete to PATHS.uploads as
      // defense-in-depth against corrupted persisted params. audioFilePath
      // is the same kind of staged upload (a2v jobs) — clean it up too.
      // Tracked from the first microtask of the rejection, so a drain that saw
      // the dispatch window close cannot miss this failure (#9029).
      await trackTerminalOperation((async () => {
        if (!isRemoteReconcile(job)) await releaseStagedUploads(job.params);
        handlers.failed({ error: err.message, code: err.code,
          remoteInputsDisposable: isRemoteMediaJob(job) && job.providerInvoked !== true && job.params?.remoteMedia?.reconcile !== true });
      })());
    }

    // The gen modules emit completed/failed asynchronously after kickoff. Await
    // the explicit terminal signal rather than polling every 100ms; this makes
    // lane release immediate and gives tests a deterministic lifecycle to drain.
    // Only release the execution lane after the provider invocation has settled.
    // Keep maintenance ownership until the admitted completion is durable.
    await Promise.race([terminalState, deferredCompletion, abandoned]);
    if (resettingForTests) return null;
    if (job.durabilityPending) finalizeLane();
    await Promise.race([terminalState, abandoned]);
    if (resettingForTests) return null;
    if (watchdogNeedsProviderSettlement) await Promise.race([providerSettlement, abandoned]);
    if (resettingForTests) return null;
    // A watchdog can win the terminal row before the real provider responds.
    // Keep its later trusted verdict through physical settlement, then release
    // inputs under the still-owned lane after that row is durable.
    await releaseRemoteAudioInputs(recovery.inputsDisposable);
    // The lane finalizer combines this with its final flush before releasing.
    return recovery;
  } finally {
    testLifecycleDisposals.delete(abandonForTests);
    clearInterval(watchdogTimer);
    emitter.off('activity', onActivity);
    emitter.off('progress', onActivity);
    dispatcher.detach();
    await drainProgressPersist();
  }
}

/**
 * Refuse up front when `count` more jobs would not fit under the pending-job
 * ceiling (#8326). enqueueJob calls it with 1; a batch producer calls it with
 * its size before creating records, so an oversized batch is refused whole
 * instead of landing half-queued. Advisory for batches — other producers can
 * still fill the queue before the batch finishes enqueueing, which each
 * enqueueJob call re-checks.
 *
 * `queue` holds exactly the waiting jobs (including ones mid-admission):
 * running jobs sit in the lane slots, so the ceiling never counts them.
 */
export function assertMediaQueueRoom(count = 1) {
  if (queue.length + count <= MAX_PENDING_MEDIA_JOBS) return;
  // The caller gets the 4xx; this is the queue's backpressure answering, not a fault.
  console.log(`🚫 media queue full — refused ${count} job(s) with ${queue.length} waiting (limit ${MAX_PENDING_MEDIA_JOBS})`);
  throw mediaQueueFullError({ pending: queue.length, requested: count });
}

// Admission is durable (#8325): the job is acknowledged — and made eligible for
// dispatch — only after a snapshot containing it has been written. Until then it
// sits in the queue flagged `admitting` (a transient, unserialized field) so the
// snapshot includes it while drainLoop/runJobNow leave it alone. A failed write
// withdraws the job and throws, so a caller never holds a job id that a restart
// would not restore, and no provider work starts for it.
// Exception: under the #4115 latch (an unreadable snapshot preserved for repair)
// nothing is written by design and the queue deliberately keeps working in
// memory, so admission succeeds without durability; boot already reported it.
//
// Bounded (#8326): at MAX_PENDING_MEDIA_JOBS waiting jobs the submission is
// refused (429 MEDIA_QUEUE_FULL) before ANY state changes — no id, no queue
// entry, no SSE entry, no snapshot write. The check and the push below run in
// one synchronous stretch, so concurrent submissions cannot overshoot it.
async function assertMusicVideoJobPolicy(kind, params) {
  // Release cover art is not footage in the video, so the media mode (what the
  // video itself may contain) does not govern it.
  if (params?.musicVideo?.projectId && !params.musicVideo.coverArt && ['image', 'video'].includes(kind)) {
    const { getProject } = await import('../musicVideo/projects.js');
    const { assertMusicVideoMedia } = await import('../../lib/musicVideoMediaPolicy.js');
    const project = await getProject(params.musicVideo.projectId);
    if (!project) throw new Error('Music Video project not found');
    assertMusicVideoMedia(project, kind, 'generation');
  }
}

export async function enqueueJob(job) {
  const params = job.params || {};
  const inputs = [params.initImagePath, params.sourceImagePath, params.sourceImageFile, params.lastImagePath, params.lastImageFile,
    ...(Array.isArray(params.referenceImagePaths) ? params.referenceImagePaths : []),
    ...(Array.isArray(params.remoteMedia?.inputAssets) ? params.remoteMedia.inputAssets.map(asset => asset?.path) : [])];
  if (!params.reviewedReferenceDigest && !inputs.some(path => typeof path === 'string' && path.includes('snapshot-'))) return enqueueJobLocked(job);
  const { withReviewedSnapshotLock } = await import('../imageGen/reviewedReference.js');
  return withReviewedSnapshotLock(() => enqueueJobLocked(job));
}

async function enqueueJobLocked({ kind, params, owner = null }) {
  installVideoExecutionRecorder();
  if (kind === 'training') refuseRetiredTraining();
  await assertMusicVideoJobPolicy(kind, params);
  if (params?.musicVideo?.sceneId) {
    const { assertMusicVideoSceneReview } = await import('../musicVideo/productionReviewService.js');
    await assertMusicVideoSceneReview(params.musicVideo, kind, { storyboardGuided: Boolean(params.guidanceImagePath) });
  }
  if (!JOB_KINDS.includes(kind)) {
    throw new Error(`enqueueJob: invalid kind '${kind}'`);
  }
  assertMediaQueueRoom(1);
  const id = randomUUID();
  let preparedParams = params;
  if (kind === 'image' && params?.reviewedReferenceDigest) {
    if (persistBlocked) throw new ServerError('Reviewed edits require a writable media queue', { status: 503, code: MEDIA_QUEUE_PERSIST_FAILED });
    if (params.initImagePath || !params.referenceImagePaths?.length) {
      throw new ServerError('Reviewed quick edit requires a local reference', { status: 400, code: 'REVIEWED_REFERENCE_UNSUPPORTED' });
    }
    const { stageReviewedReference } = await import('../imageGen/reviewedReference.js');
    const snapshot = await stageReviewedReference(id, params.referenceImagePaths[0], params.reviewedReferenceDigest);
    const snapshotPath = join(PATHS.imageRefs, snapshot.filename);
    // The edited image is replaced by its snapshot; further references follow it unchanged.
    const referenceImagePaths = [snapshotPath, ...params.referenceImagePaths.slice(1)];
    let remoteMedia = params.remoteMedia;
    if (isRemoteMediaJob({ kind, params })) {
      const assets = remoteMedia?.inputAssets;
      if (!Array.isArray(assets) || assets.length !== params.referenceImagePaths.length
        || assets.some((asset, index) => asset.role !== 'referenceImages' || asset.path !== params.referenceImagePaths[index])) {
        throw new ServerError('Reviewed reference does not match the remote input', { status: 400, code: 'REVIEWED_REFERENCE_UNSUPPORTED' });
      }
      // Marker v2 is a local downgrade gate: older adapters refuse it instead
      // of replaying the snapshot path without the ownership check. The peer's
      // independent image wire request remains on its negotiated version.
      remoteMedia = { ...remoteMedia, wireVersion: 2, reviewedReferenceSnapshot: snapshot, inputAssets: [{ ...assets[0], path: snapshotPath }, ...assets.slice(1)] };
    }
    preparedParams = { ...params, ...(remoteMedia ? { remoteMedia } : {}), reviewedReferenceSnapshot: snapshot, referenceImagePaths };
    if (!remoteMedia) {
      // Older queue workers know nothing about snapshot proof. Keep their
      // top-level request unrenderable, as routed jobs already do, and restore
      // these fields only in the current verified dispatcher.
      preparedParams.reviewedReferenceRequest = {
        prompt: params.prompt, modelId: params.modelId, pythonPath: params.pythonPath,
        referenceImagePaths,
      };
      Object.assign(preparedParams, { prompt: '', modelId: null, pythonPath: null, referenceImagePaths: [] });
    }
    assertMediaQueueRoom(1);
  }
  // Every routed job is normalized HERE rather than at each caller (#4683): the
  // downgrade contract only holds if it is unbypassable, and a future enqueue
  // site that forgets the helper would ship a job a rolled-back build renders
  // locally for real. See services/federatedMedia/routedJobParams.js.
  const safeParams = isRemoteMediaJob({ kind, params: preparedParams })
    ? routedJobParams({ params: preparedParams })
    : preparedParams;
  const job = {
    id,
    kind,
    owner,
    status: 'queued',
    queuedAt: new Date().toISOString(),
    params: safeParams,
    // position counts "where you sit in your swim lane" — running and queued
    // work in the same swim lane come first.
    position: (() => {
      const key = jobSwimlane({ kind, params: safeParams });
      return [...runningJobs(), ...queue].filter((j) => jobSwimlane(j) === key).length + 1;
    })(),
  };
  assertRetiredDataAvailable();
  job.admitting = true;
  queue.push(job);
  try {
    await persist();
  } catch (err) {
    // Withdraw before the next snapshot so the rejected job never lands on disk.
    const idx = queue.indexOf(job);
    if (idx >= 0) queue.splice(idx, 1);
    recomputeQueuePositions();
    // An unrelated write may have landed the admitting job on disk before ours
    // failed; best-effort rewrite so a restart cannot resurrect a refused job.
    persist().catch(() => {});
    console.error(`❌ media-job [${id.slice(0, 8)}] ${kind} not queued — snapshot write failed: ${err.message}`);
    throw new ServerError(`Could not save the ${kind} job to the media queue: ${err.message}`, {
      status: 503,
      code: MEDIA_QUEUE_PERSIST_FAILED,
    });
  }
  delete job.admitting;
  // A bulk cancel can reach the job while its snapshot is in flight; cancelJob
  // already withdrew it, so report its staged or durable terminal status.
  if (job.durabilityPending || job.status !== 'queued') {
    return { jobId: id, position: job.position, status: job.durabilityPending?.status ?? job.status };
  }
  broadcastSse(ensureSseEntry(id), { type: 'queued', position: job.position });
  mediaJobEvents.emit('enqueued', job);
  startWorker();
  console.log(`📥 media-job [${id.slice(0, 8)}] ${kind} queued (position ${job.position})`);
  return { jobId: id, position: job.position, status: 'queued' };
}

// Admission can query a cohort even after its last retained job is canceled.
export function listVideoHolds() {
  videoHolds.updateQueued(queue);
  const counts = new Map();
  for (const job of queue) {
    if (job.hold) counts.set(job.hold.id, (counts.get(job.hold.id) || 0) + 1);
  }
  return videoHolds.snapshot().map((hold) => ({ ...hold, heldJobCount: counts.get(hold.id) || 0 }));
}

export function isVideoModelHeld(modelId, runtime) {
  return videoHolds.has({ modelId, runtime: runtime || 'mlx_video' });
}

// Resume retained work only; failed jobs are never re-enqueued.
export async function resumeVideoHold(holdId) {
  if (!videoHolds.resume(holdId)) return false;
  videoHolds.updateQueued(queue);
  await persist();
  return true;
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
    if (r?.ok && r.status === 'canceled') canceled += 1;
  }
  return { canceled };
}

// Cancel: drops a queued job, or sends SIGTERM to a running gen process.
export async function cancelJob(jobId) {
  const pending = findJob(jobId);
  if (pending?.durabilityPending) {
    await admitCompletion(pending.durabilityPending.status, () => persistTerminalTransition(pending));
    return pending.status === 'canceled' ? { ok: true, status: 'canceled' }
      : { ok: false, code: 'ALREADY_TERMINAL', status: pending.status, error: 'Job is already finishing' };
  }
  const queueIdx = queue.findIndex((j) => j.id === jobId);
  if (queueIdx >= 0) {
    const job = queue[queueIdx];
    if (isTopazUpscale(job) && job.params?.topazRecovery) {
      job.cancelRequested = true;
      await persist();
      return { ok: true, status: 'canceling' };
    }
    await settleQueuedJob(job, { status: 'canceled', error: 'Canceled before start' });
    return { ok: true, status: 'canceled' };
  }
  // Cancel-while-running — check every lane.
  const runningJob = (running?.id === jobId ? running : null)
    ?? cloudRunning.find((j) => j.id === jobId)
    ?? remoteRunning.find((j) => j.id === jobId)
    ?? null;
  if (runningJob) {
    // A terminal transition already started (completed/failed/watchdog): its
    // async progress-drain leaves job.status === 'running' for a beat, but the
    // outcome is decided. Don't fire a redundant provider cancel or report
    // 'canceling' — treat it like an already-terminal job (route maps to 409).
    if (!canRequestCancellation(runningJob)) {
      return { ok: false, code: 'ALREADY_TERMINAL', status: runningJob.status, error: 'Job is already finishing' };
    }
    const mod = await getGenModuleForJob(runningJob);
    // Completion may claim the outcome while provider resolution yields.
    if (!canRequestCancellation(runningJob)) {
      return { ok: false, code: 'ALREADY_TERMINAL', status: runningJob.status, error: 'Job is already finishing' };
    }
    const previousIntent = snapshotCancellationIntent(runningJob);
    // Set intent before a provider can emit failure synchronously.
    applyCancellationIntent(runningJob);
    if (runningJob.visualProfileFinishing) {
      runningJob.visualProfileFinishing.abort(new Error('Canceled during film finishing'));
      // The finish handler may not settle before a crash. Persist both the
      // local intent and any remote cancellation marker before acknowledging it.
      await persist();
      return { ok: true, status: 'canceling' };
    }
    if (isRemoteMediaJob(runningJob) || isTopazUpscale(runningJob)) {
      // Durable intent precedes the adapter call so boot recovery resumes
      // cancellation rather than silently resurrecting the remote render.
      await persist();
    }
    // Provider contract: `true` = child signalled, `'pending'` = the provider owns
    // the job but is still preparing (it aborts at its spawn gate and emits
    // `failed`), `false` = nothing cancelable, i.e. finalization already began.
    if (mod?.cancel && mod.cancel(jobId) === false
      && (runningJob.providerInvoked || isRemoteMediaJob(runningJob))) {
      // A provider may have crossed its durable finalization boundary before
      // its completed event reaches the queue. Refusal must not turn a later
      // finalization failure into a cancellation or leave retry markers set.
      restoreCancellationIntent(runningJob, previousIntent);
      if (isRemoteMediaJob(runningJob)) await persist();
      return { ok: false, code: 'ALREADY_TERMINAL', status: runningJob.status, error: 'Job is already finishing' };
    }
    if (runningJob.params?.videoProduction && ['reactor', 'fal', 'grok', 'runway'].includes(runningJob.params.mode)) {
      runningJob.params.videoProduction = { ...runningJob.params.videoProduction, submissionUncertain: true };
      await persist();
    }
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
  if (sseJobs.has(jobId)) return attachSse(sseJobs, jobId, res);
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

export const MEDIA_QUEUE_FLUSH_TIMEOUT_MS = 2000;

// Join the actual persistence work. A live lane retains its maintenance permit
// until this completes, even when a separate shutdown caller exhausts its budget.
async function drainMediaJobQueue() {
  return (async () => {
    await persist();
    while (terminalOperations.size > 0) {
      await Promise.allSettled([...terminalOperations]);
    }
    // The lane finalizer schedules its archive snapshot a few microtasks after
    // the terminal operation settles; yield so most land ahead of our persist.
    await Promise.resolve();
    await persist();
    // A finalizer that still slipped in behind us wrote a newer snapshot.
    await persistChain;
    return { ok: true };
  })().catch((err) => ({ ok: false, error: err.message }));
}

// Graceful-shutdown flush (#8325): let in-flight terminal transitions settle,
// then write one fresh snapshot — it captures the latest in-memory progress,
// so a debounced progress write still pending in runJob is not lost — and wait
// for the whole persist chain behind it. Bounded so a stalled disk cannot eat
// the shutdown budget; never rejects, reporting the outcome instead.
export async function flushMediaJobQueue({ timeoutMs = MEDIA_QUEUE_FLUSH_TIMEOUT_MS } = {}) {
  const drain = drainMediaJobQueue();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, timedOut: true, error: `timed out after ${timeoutMs}ms` }), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([drain, timeout]).finally(() => clearTimeout(timer));
}

// Test-only reset hook. Real callers go through enqueueJob/cancelJob.
export async function __resetForTests() {
  quiesceMediaJobQueue();
  await workerOperation;
  await __drainForTests();
  // Tests simulate crashes with provider stubs that never resolve. Detach those
  // waits without publishing a fabricated terminal outcome or releasing ownership.
  resettingForTests = true;
  for (const abandon of testLifecycleDisposals) abandon();
  await __drainForTests({ settleLanes: true });
  queue.length = 0;
  running = null;
  // `cloudRunning` is a const array — clear it in place rather than reassigning,
  // which would throw TypeError and break `findJob()` (.find on null).
  cloudRunning.length = 0;
  remoteRunning.length = 0;
  archive.length = 0;
  pendingTransitions.clear();
  videoHolds.clear();
  sseJobs.clear();
  quotaCooldowns.clear();
  recoveringJobs.clear();
  workerStarted = false;
  workerOperation = null;
  dispatchQuiesced = false;
  resettingForTests = false;
  initPromise = null;
  // Reset the lane limit too — a test that called setCodexParallelLimit(N)
  // otherwise leaks N into subsequent tests and makes ordering matter.
  codexParallelLimit = CODEX_PARALLEL_DEFAULT;
  // Reset the persist chain so a leftover rejection from a previous test's
  // ENOENT writes doesn't poison subsequent persist() calls.
  persistChain = Promise.resolve();
  // Un-latch the persistence block (#4115) — a test that booted on an unreadable
  // jobs file would otherwise leave every later test's queue unable to persist.
  persistBlocked = false;
  completionRecovery = null;
  completionRecoveryDeferred = false;
}

// Test-only deterministic settle hook. EventEmitter terminal handlers and
// persistence are intentionally fire-and-forget in production; tests use this
// instead of sleeping for an arbitrary wall-clock window before inspecting or
// removing their temporary data directory. settleLanes also joins archive and
// maintenance-release tails; use it only after terminal events or test disposal.
export async function __drainForTests({ settleLanes = false } = {}) {
  // Include open dispatches: a started job reaches its provider (or a pre-dispatch
  // failure, which becomes a terminal operation) only after real I/O that
  // neither fake timers nor a microtask yield cover (#9029).
  while (dispatchOperations.size > 0 || terminalOperations.size > 0 || (settleLanes && laneOperations.size > 0)) {
    await Promise.allSettled([...dispatchOperations, ...terminalOperations, ...(settleLanes ? laneOperations : [])]);
  }
  await persistChain.catch(() => {});
  // A settled terminal operation can schedule the archive snapshot in the
  // lane-finalizer microtask. Yield once and capture that tail as well.
  await Promise.resolve();
  await persistChain.catch(() => {});
}
