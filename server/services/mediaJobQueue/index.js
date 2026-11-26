/**
 * Public media queue API. Waiting jobs preserve submission order across lanes.
 * The local accelerator drains serially, cloud CLI jobs run in parallel, and
 * federated jobs use peer slots without consuming the local accelerator.
 *
 * State, scheduling and provider execution live in their own modules.
 * Persistence owns snapshots and terminal durability, and SSE owns streams.
 */

import { randomUUID } from 'crypto';
import { join } from 'path';
import { PATHS, ensureDir } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { broadcastSse } from '../../lib/sseUtils.js';
import { refuseRetiredTraining, assertRetiredDataAvailable } from '../../lib/retiredLoraTraining.js';
import { assertFlux2InputsCompatible } from '../../lib/flux2Inputs.js';
import { LOCAL_IMAGEGEN_DEFAULT_MODEL } from '../../lib/imageGenCapabilities.js';
import { CLOUD_IMAGE_GEN_MODES, CLOUD_VIDEO_GEN_MODES } from '../../lib/generationModes.js';
import { routedJobParams } from '../federatedMedia/routedJobParams.js';
import { mediaRecoveryPending } from '../../lib/mediaRecoveryActivity.js';
import { isRemoteMediaJob } from './remoteMediaJob.js';
import { importedArchiveRow } from './importedJob.js';
import { canRequestCancellation, snapshotCancellationIntent, applyCancellationIntent, restoreCancellationIntent } from './jobLifecycle.js';
import { MAX_PENDING_MEDIA_JOBS, MEDIA_QUEUE_PERSIST_FAILED, mediaQueueFullError } from './admission.js';
import { jobLane, jobSwimlane, laneLimits, laneTotalLimits, refreshCodexParallelLimit, resetLimitsForTests } from './limits.js';
import {
  queue, cloudRunning, remoteRunning, archive, videoHolds, mediaJobEvents, recoveringJobs, terminalOperations,
  getRunningJob, findJob, runningJobs, listJobs, isTopazUpscale, resetQueueStateForTests,
  dispatchOperations, laneOperations, recoveryState, testLifecycleDisposals,
} from './state.js';
import { workerState } from './workerSignal.js';
import {
  admitCompletion, persistTerminalTransition, persist, restoreQueueSnapshot, isPersistBlocked,
  hasPendingTransitions, configureTerminalTransitions, settlePersistChain, resetPersistenceForTests,
} from './persistence.js';
import { ensureSseEntry, broadcastTerminalSse, recomputeQueuePositions, resetSseForTests } from './sse.js';
import { assertMusicVideoJobPolicy, getGenModuleForJob, installVideoExecutionRecorder, JOB_KINDS } from './execution.js';
import { prepareQueuedVideos, quiesceMediaJobQueue, runJobNow as runScheduledJobNow, settleQueuedJob, startWorker, wakeWorker } from './scheduler.js';
import { loadMediaRuntimeModule } from '../bootHookRegistry.js';

// The admission contract lives in ./admission.js so producers that cannot
// import the queue can still recognize a refusal; re-exported where callers
// have always found the queue's API.
export {
  MAX_PENDING_MEDIA_JOBS, MEDIA_QUEUE_PERSIST_FAILED, MEDIA_QUEUE_FULL, isMediaAdmissionRefusal,
  partialBatchAdmissionError,
} from './admission.js';


// The federated-kind map and its predicate live in ./remoteMediaJob.js so light
// consumers (sanitizeJob, route handlers) can ask "is this routed?" without
// pulling the queue in. Re-exported here because that is where callers have
// always found it.
export { isRemoteMediaJob };
export {
  REMOTE_MEDIA_PARALLEL_LIMIT, CODEX_PARALLEL_MIN, CODEX_PARALLEL_MAX, CODEX_PARALLEL_DEFAULT,
  PARALLEL_LIMIT_MIN, PARALLEL_LIMIT_MAX, PARALLEL_LIMIT_DEFAULT, RATE_LIMIT_COOLDOWN_MS,
  clampParallelLimit, getCodexParallelLimit, setCodexParallelLimit, syncParallelLimits, refreshCodexParallelLimit,
  getParallelLimit, setParallelLimit, getEffectiveParallelLimit, getRateLimitCooldown, recordRateLimitCooldown,
} from './limits.js';
export { mediaJobEvents, getRunningJob, listJobs } from './state.js';
export {
  updateJobResult, resumeMediaJobCompletions, removeArchivedJob, removeFailedCanceledJobs,
  MEDIA_QUEUE_FLUSH_TIMEOUT_MS, flushMediaJobQueue,
} from './persistence.js';
export { attachSseClient } from './sse.js';

export { JOB_KINDS, recordVideoExecution, recordVideoExecutionDiagnostics } from './execution.js';
export { VISUAL_PROFILE_FINISH_TIMEOUT_MS } from './jobLifecycle.js';
export { MEDIA_QUEUE_SHUTTING_DOWN, laneConcurrencyFor, quiesceMediaJobQueue } from './scheduler.js';

export const JOB_STATUSES = Object.freeze(['queued', 'running', 'completed', 'failed', 'canceled']);

export function getJob(jobId) {
  return findJob(jobId);
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
    gpu: { running: getRunningJob() ? 1 : 0, queued: 0, limit: 1, limitReason: 'memory-governed' },
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
    runningKind: getRunningJob()?.kind ?? null,
  };
}


// The render queue displays every live job and only a short recent failure
// reel. Select that reel before sanitization; the archive can hold 500 rows.
export function listQueueJobs({ kind, owner, limit = 10 } = {}) {
  const matches = (job) => (!kind || job.kind === kind) && (!owner || job.owner === owner);
  const live = [
    ...(getRunningJob() ? [getRunningJob()] : []),
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



export async function initMediaJobQueue({ deferCompletionRecovery = false, prepareTerminalHooks = null } = {}) {
  installVideoExecutionRecorder();
  if (recoveryState.initPromise) return recoveryState.initPromise;
  configureTerminalTransitions({ deferCompletionRecovery, prepareTerminalHooks });
  recoveryState.initPromise = (async () => {
    // Once-at-boot: subsequent persist() calls assume the data dir exists.
    await ensureDir(PATHS.data);
    // Read the codex parallel limit before the worker starts so the first
    // drain tick honors the user's configured value, not the default.
    await refreshCodexParallelLimit().catch(() => {});
    const { restartedFailedIds, restartedCanceled } = await restoreQueueSnapshot();
    await prepareQueuedVideos();
    videoHolds.updateQueued(queue);
    // Pre-seed terminal SSE payloads for each restart-failed job so that any
    // client that reconnects to /:jobId/events after a restart (the route
    // attaches via attachSseClient → attachSse, which replays lastPayload)
    // gets an immediate error event instead of a silent stream.
    for (const id of restartedFailedIds) broadcastTerminalSse(id, { type: 'error', error: 'interrupted by restart' });
    for (const { id, error } of restartedCanceled) broadcastTerminalSse(id, { type: 'canceled', reason: error });
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
    if (!isPersistBlocked()) {
      await persist();
      startWorker(enqueueJob);
    }
    recoveryState.inventoryReady = true;
  })();
  return recoveryState.initPromise;
}

// A queued recovery can still own a remote or detached job, and a terminal
// callback can still be publishing after its visible status changed.
export function getMediaRecoveryActivity() {
  const jobs = listJobs();
  const pending = hasPendingTransitions() || terminalOperations.size > 0 || dispatchOperations.size > 0
    || recoveringJobs.size > 0 || jobs.some(mediaRecoveryPending);
  return { trusted: recoveryState.inventoryReady && !isPersistBlocked(), pending };
}

// Share-bucket import entry point. The queue owns media-jobs.json: a writer
// outside it is overwritten by the next persist() (the snapshot is built from
// memory alone), so imported re-render records go through the in-memory archive
// and are saved with the queue's own snapshot. Ids already known to the queue
// win; returns the number of rows added.
export async function importArchivedJobs(records) {
  if (!recoveryState.initPromise) throw new Error('Media queue is not initialized; imported jobs cannot be saved');
  await recoveryState.initPromise;
  if (isPersistBlocked()) throw new Error('Media queue storage is blocked until its snapshot is repaired and the server restarts');
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

export function runJobNow(jobId) {
  return runScheduledJobNow(jobId, enqueueJob);
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
export async function enqueueJob(job) {
  const params = job.params || {};
  const inputs = [params.initImagePath, params.sourceImagePath, params.sourceImageFile, params.lastImagePath, params.lastImageFile,
    ...(Array.isArray(params.referenceImagePaths) ? params.referenceImagePaths : []),
    ...(Array.isArray(params.remoteMedia?.inputAssets) ? params.remoteMedia.inputAssets.map(asset => asset?.path) : [])];
  if (!params.reviewedReferenceDigest && !inputs.some(path => typeof path === 'string' && path.includes('snapshot-'))) return enqueueJobLocked(job);
  const { withReviewedSnapshotLock } = await loadMediaRuntimeModule('reviewedReference');
  return withReviewedSnapshotLock(() => enqueueJobLocked(job));
}

async function enqueueJobLocked({ kind, params, owner = null }) {
  installVideoExecutionRecorder();
  if (kind === 'training') refuseRetiredTraining();
  await assertMusicVideoJobPolicy(kind, params);
  if (params?.musicVideo?.sceneId) {
    const { assertMusicVideoSceneReview } = await loadMediaRuntimeModule('musicVideoProductionReview');
    await assertMusicVideoSceneReview(params.musicVideo, kind);
  }
  if (!JOB_KINDS.includes(kind)) {
    throw new Error(`enqueueJob: invalid kind '${kind}'`);
  }
  if (kind === 'image' && !isRemoteMediaJob({ kind, params }) && !CLOUD_IMAGE_GEN_MODES.includes(params?.mode)
    && params?.referenceImagePaths?.length && (params.initImagePath || params.loraFilenames?.length || params.loraPaths?.length)) {
    const { getImageModels } = await import('../../lib/mediaModels.js');
    const model = getImageModels().find(entry => entry.id === (params.modelId ?? LOCAL_IMAGEGEN_DEFAULT_MODEL));
    assertFlux2InputsCompatible(model, {
      hasInitImage: Boolean(params.initImagePath), referenceCount: params.referenceImagePaths.length,
      loraCount: (params.loraFilenames?.length || 0) + (params.loraPaths?.length || 0),
    });
  }
  assertMediaQueueRoom(1);
  const id = randomUUID();
  let preparedParams = params;
  if (kind === 'image' && params?.reviewedReferenceDigest) {
    if (isPersistBlocked()) throw new ServerError('Reviewed edits require a writable media queue', { status: 503, code: MEDIA_QUEUE_PERSIST_FAILED });
    if (params.initImagePath || !params.referenceImagePaths?.length) {
      throw new ServerError('Reviewed quick edit requires a local reference', { status: 400, code: 'REVIEWED_REFERENCE_UNSUPPORTED' });
    }
    const { stageReviewedReference } = await loadMediaRuntimeModule('reviewedReference');
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
  wakeWorker();
  startWorker(enqueueJob);
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
  // Queue the cleared hold snapshot before dispatching any newly eligible jobs.
  const saved = persist();
  wakeWorker();
  await saved;
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
  const runningJob = (getRunningJob()?.id === jobId ? getRunningJob() : null)
    ?? cloudRunning.find((j) => j.id === jobId)
    ?? remoteRunning.find((j) => j.id === jobId)
    ?? null;
  if (runningJob) {
    // A terminal transition already started (completed/failed/watchdog): its
    // pending publication can leave job.status === 'running', but the
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
      runningJob.visualProfileFinishing.abort(new Error('Canceled during image post-processing'));
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
    if (runningJob.params?.videoProduction && CLOUD_VIDEO_GEN_MODES.includes(runningJob.params.mode)) {
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

// Test-only reset hook. Real callers go through enqueueJob/cancelJob.
export async function __resetForTests() {
  quiesceMediaJobQueue();
  await workerState.operation;
  await __drainForTests();
  // Tests simulate crashes with provider stubs that never resolve. Detach those
  // waits without publishing a fabricated terminal outcome or releasing ownership.
  workerState.resettingForTests = true;
  for (const abandon of testLifecycleDisposals) abandon();
  await __drainForTests({ settleLanes: true });
  resetQueueStateForTests();
  resetPersistenceForTests();
  resetSseForTests();
  resetLimitsForTests();
  workerState.started = false;
  workerState.operation = null;
  workerState.quiesced = false;
  workerState.resettingForTests = false;
  recoveryState.initPromise = null;
  recoveryState.inventoryReady = false;
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
  await settlePersistChain();
  // A settled terminal operation can schedule the archive snapshot in the
  // lane-finalizer microtask. Yield once and capture that tail as well.
  await Promise.resolve();
  await settlePersistChain();
}
