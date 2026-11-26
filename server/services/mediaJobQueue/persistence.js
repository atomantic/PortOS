/**
 * Media queue persistence: the data/media-jobs.json snapshot, durable terminal
 * transitions, boot restore, archive pruning and the shutdown flush. Owns the
 * write chain and its blocked latch; the queue reaches them through these
 * functions.
 *
 * Persistence: data/media-jobs.json holds queued + running + recently-finished
 * jobs. On boot, local child-process jobs fail as interrupted; detached
 * training and idempotent remote jobs reconcile against their surviving work.
 * Completed/failed/canceled entries older than 24h or beyond the 500-most-
 * recent are pruned to keep the file small.
 *
 * Storage: `ephemeral-file` — machine-local dispatch state, never federated or
 * sent in peer capability/status payloads; covered by the filesystem backup.
 * Admission is durable (a job resolves only once a snapshot holding it is
 * written) and an unreadable snapshot latches persistence off to preserve it.
 * `videoHolds`, `videoExecution(s)` receipts and `durabilityPending` live in
 * this same envelope; job history and lineage are the `db-primary` target.
 */

import { unlink } from 'fs/promises';
import { join, resolve as pathResolve, sep as PATH_SEP } from 'path';
import { PATHS, readJSONFileStrict, atomicWrite, sleep } from '../../lib/fileUtils.js';
import { FINISHED_OUTPUT_ADMISSION_MS } from '../../lib/backupPublicationWait.js';
import { holdsBackupAssetPublication, runOutsideBackupAssetPublication, withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { ServerError } from '../../lib/errorHandler.js';
import { reapAndCleanDetachedDirs } from '../../lib/detachedSpawn.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { TRAINING_RETIRED_MESSAGE } from '../../lib/retiredLoraTraining.js';
import { routedJobParams } from '../federatedMedia/routedJobParams.js';
import { isRemoteMediaJob } from './remoteMediaJob.js';
import { MEDIA_QUEUE_PERSIST_FAILED } from './admission.js';
import { snapshotQuotaCooldowns, restoreQuotaCooldowns } from './limits.js';
import {
  queue, cloudRunning, remoteRunning, archive, videoHolds, mediaJobEvents, recoveringJobs, terminalOperations,
  getRunningJob, findJob, listJobs, swimlanePositions, trackTerminalOperation, isTopazUpscale,
} from './state.js';
import { wakeWorker } from './workerSignal.js';
import { broadcastTerminalSse, closeArchivedJobSse } from './sse.js';
import { loadMediaRuntimeModule } from '../bootHookRegistry.js';

// Boot restoration is the second way a job enters the queue, so it needs the
// same routed-job normalization enqueueJob applies (#4683). A job written by a
// build older than that fix still carries the top-level model id a legacy
// dispatcher would render from; re-normalizing on restore (and letting the boot
// persist write the safe shape back) means upgrading and then rolling back
// cannot resurrect a locally-renderable routed job.
export const restoredParams = (job) => (isRemoteMediaJob(job)
  ? routedJobParams({ params: job.params })
  : job.params);

const JOBS_FILE = join(PATHS.data, 'media-jobs.json');
const COMPLETED_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PERSISTED_ARCHIVE = 500;
// Share-bucket re-render records outlive the 24h TTL (they are old by nature) but
// stay bounded; the oldest imports drop first.
const MAX_IMPORTED_ARCHIVE = 2000;

// Returns true if `p` resolves strictly under PATHS.uploads. Shared by
// safeUnlinkUpload (cleanup) and the pre-gen sanitizer (Thread #1 guard).
export function isUnderUploadsRoot(p) {
  if (typeof p !== 'string') return false;
  const uploadsRoot = `${pathResolve(PATHS.uploads)}${PATH_SEP}`;
  return pathResolve(p).startsWith(uploadsRoot);
}

// Normalize `uploadedTempPaths` to an array regardless of how it arrived
// in persisted params. Handles three cases:
//   - Array  → use as-is (normal path)
//   - string → wrap in array (legacy/corrupt single-string serialization)
//   - other  → treat as empty (null, undefined, corrupt non-string)
export function normalizeTempPaths(p) {
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

// #1332: probe (via loraTraining, which owns the run's on-disk layout) whether
// a training run's detached trainer survived the restart and is worth
// re-attaching to. Loaded through the runtime registry because loraTraining
// imports the queue (#17499). Never throws — a missing module / probe error reads
// as "not reattachable" so the reconcile falls back to the fail path.
async function jobHasSurvivingTrainer(runId) {
  const mod = await loadMediaRuntimeModule('training').catch(() => null);
  if (!mod?.hasSurvivingTrainer) return false;
  return mod.hasSurvivingTrainer(runId).catch(() => false);
}

// Completion hooks may attach a generated artifact to a domain record after
// the audio worker has emitted its result. Persist that attachment on the job
// too so a remounted client can discover the created track without guessing.
const resultUpdates = new Map();
export async function updateJobResult(jobId, patch) {
  if (!patch || typeof patch !== 'object') return false;
  const prior = resultUpdates.get(jobId) ?? Promise.resolve();
  const pending = prior.catch(() => {}).then(async () => {
    const job = findJob(jobId);
    if (!job) return false;
    const archiveIndex = archive.indexOf(job);
    const previous = job.result;
    const next = { ...(previous || {}), ...patch };
    job.result = next;
    try { await persist(); return true; }
    catch (error) {
      if (job.result === next) {
        job.result = previous;
        if (archiveIndex >= 0 && !archive.includes(job)) archive.splice(Math.min(archiveIndex, archive.length), 0, job);
      }
      throw error;
    }
  });
  resultUpdates.set(jobId, pending);
  try { return await pending; }
  finally { if (resultUpdates.get(jobId) === pending) resultUpdates.delete(jobId); }
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
let prepareHooks = null;
// Only a completion publishes durable output. Its commit holds backup admission
// from staging the terminal row through the hook fan-out, never while rendering
// or waiting in the queue; failures and cancellations stay unadmitted so a
// backup never delays them.
// The output is already rendered, so the commit waits out a whole backup cut
// rather than stranding a finished job half-terminated.
export const admitCompletion = (state, commit) => (state === 'completed'
  ? withBackupAssetPublication(commit, { timeoutMs: FINISHED_OUTPUT_ADMISSION_MS, onWait: () => console.log('⏸️ media-job completion waiting for the backup to finish') })
  : commit());
export function stageTerminalTransition(job, apply, acknowledge) {
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
export async function persistTerminalTransition(job) {
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
    if (error?.code === 'MEDIA_JOB_HOOK_LOAD_FAILED') throw error;
    if (!isTransientPersistError(error)) throw storageRecovery();
  }
  await sleep(TERMINAL_PERSIST_RETRY_MS);
  try {
    await persist();
  } catch (error) {
    noteFailure();
    if (error?.code === 'MEDIA_JOB_HOOK_LOAD_FAILED') throw error;
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
function notifyQueueChanged() {
  try { mediaJobEvents.emit('changed', {}); }
  catch (error) { console.error(`❌ media-job queue change notification failed: ${error.message}`); }
}
function queuePersist(operation) {
  // A blocked writer cannot satisfy admission or transition durability.
  if (persistBlocked) {
    notifyQueueChanged();
    return Promise.reject(new Error('Media queue storage is blocked until its snapshot is repaired and the server restarts'));
  }
  // Invalidate after a durable mutation's write settles so readers see the
  // final in-memory state even when persistence is unavailable.
  persistChain = persistChain.then(operation, operation).finally(() => {
    notifyQueueChanged();
  });
  return persistChain;
}
export function persist() {
  return queuePersist(() => persistImpl());
}
async function persistImpl({ onSnapshotWritten, trimArchive = true } = {}) {
  if (trimArchive) trimArchiveForSnapshot();
  const snapshot = captureQueueSnapshot();
  const payload = JSON.stringify(snapshot.data);
  // Prepare listeners for exactly the rows this write acknowledges. This is
  // before disk publication so even the first (or replayed) event is delivered
  // under the original backup lease. An import failure leaves the row staged.
  if (prepareHooks && snapshot.transitions.length) {
    await Promise.all(snapshot.transitions.map(([job]) => prepareHooks(job)));
  }
  await atomicWrite(JOBS_FILE, payload);
  onSnapshotWritten?.();
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

function captureQueueSnapshot() {
  const live = [
    ...(getRunningJob() ? [getRunningJob()] : []),
    ...cloudRunning,
    ...remoteRunning,
    ...queue,
    ...archive,
  ];
  // A completion's terminal row and its `completed` fan-out publish together,
  // so only a snapshot written inside a backup admission lease commits one. Any
  // other write (enqueue, the shutdown flush, or one landing after a
  // completion's own retries gave up) keeps it `running` on disk and leaves it
  // to an admitted recovery commit, never publishing it in the middle of a cut.
  const completionAdmitted = !completionRecoveryDeferred && holdsBackupAssetPublication();
  const canWriteOutcome = (job) => completionAdmitted || job.durabilityPending?.status !== 'completed';
  const hasDeferredCompletion = [...pendingTransitions.keys()].some((job) => !canWriteOutcome(job));
  // Strip non-serializable bits.
  const serializable = live.map((job) => (canWriteOutcome(job) ? { ...job, ...job.durabilityPending } : job)).map(({ id, kind, owner, status, queuedAt, startedAt, completedAt, params, result, error, position, progress, statusMsg, etaMs, durabilityPending, imported, referenceImageFilenames, videoExecution, videoExecutions, cancelRequested, visualProfileFinishing }) =>
    ({ id, kind, owner, status, queuedAt, startedAt, completedAt, params, result, error, position, progress, statusMsg, etaMs,
      ...((status === 'running' && visualProfileFinishing || kind === 'video-upscale' && params?.mode === 'topaz') && cancelRequested === true ? { cancelRequested: true } : {}),
      ...(imported === true ? { imported } : {}),
      ...(Array.isArray(referenceImageFilenames) ? { referenceImageFilenames } : {}),
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
    if (job.params?.remotePeerReservation === true) wakeWorker();
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

export async function announceTerminalTransition(job, onDurable = () => {}) {
  if (job.params?.videoProduction) {
    const tag = job.params.videoProduction;
    const { settleVideoAttempt } = await loadMediaRuntimeModule('creativeDirectorVideoExecution');
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
  broadcastTerminalSse(job.id, ssePayload);
  // Hooks that publish files or rows acquire their own admission; see
  // runOutsideBackupAssetPublication.
  runOutsideBackupAssetPublication(() => mediaJobEvents.emit(job.status, job));
}

// Staged multipart inputs a job owns under data/uploads. safeUnlinkUpload
// constrains each delete to PATHS.uploads, so a corrupted path never removes a
// file the job merely referenced. audioFilePath is the same kind of upload.
export async function releaseStagedUploads(params) {
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
  const manualUpdate = maintenance.status().hold?.owner === 'manual-update';
  if (j.status === 'running' && maintenance.held() && !manualUpdate) {
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
    if (maintenance.held()) {
      maintenance.recoverOwned('media', j.id);
      recoveringJobs.add(j.id);
    }
    console.log(`🔁 media-job [${j.id.slice(0, 8)}] training survived restart — re-enqueued for re-attach`);
    return { reattach };
  }
  if (j.kind === 'video-sharing') {
    const { cleanupInterruptedSharingCopy } = await loadMediaRuntimeModule('sharingCopy');
    await cleanupInterruptedSharingCopy(j.id).catch(err => console.error(`❌ Interrupted sharing copy cleanup failed: ${err.message}`));
  }
  archive.push({ ...j, status: 'failed', error: 'interrupted by restart', completedAt: new Date().toISOString() });
  // The failed job never reaches the worker's cleanup, so its staged uploads would leak.
  void releaseStagedUploads(j.params);
  return { failedId: j.id };
}

// Read the snapshot and rebuild the queue and archive from it, latching
// persistence off when any part is unreadable. Returns the ids whose restart
// outcome the caller announces over SSE once the queue is prepared.
export async function restoreQueueSnapshot() {
  // Strict (#4115). A swallowed unreadable jobs file boots an empty queue and
  // the `await persist()` at the end of initMediaJobQueue writes that emptiness
  // over the real snapshot — losing the archive and orphaning every job the
  // reload below would have reconciled. Init is an awaited step of
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
  if (ok && !Array.isArray(data?.jobs)) {
    persistBlocked = true;
    console.error('❌ media-job queue: invalid jobs snapshot — preserving it for recovery');
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
  // Acknowledged manual updates use normal restart recovery: owned orphan
  // videos are reaped and interrupted jobs fail honestly; queues survive.
  const videoReap = maintenance.held() && maintenance.status().hold?.owner !== 'manual-update' ? { reaped: 0 }
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
    const { cleanupOrphanTopazStaging } = await loadMediaRuntimeModule('topazStaging');
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
  return { restartedFailedIds, restartedCanceled };
}

function canRemoveArchivedJob(job) {
  return !resultUpdates.has(job.id) && !job.durabilityPending
    && job.params?.remotePeerReservation !== true && job.result?.topazUncertain !== true;
}

// Drop an eligible archived row after deletion or a successful retry.
export function removeArchivedJob(jobId) {
  const idx = archive.findIndex((j) => j.id === jobId);
  if (idx < 0 || !canRemoveArchivedJob(archive[idx])) return false;
  archive.splice(idx, 1);
  closeArchivedJobSse(jobId);
  persist().catch((e) => console.error(`❌ media-job [${jobId.slice(0, 8)}] mediaJobQueue persist on archive prune failed: ${e.message}`));
  return true;
}

export function removeFailedCanceledJobs({ kind }) {
  if (!['image', 'video', 'video-upscale'].includes(kind)) throw new TypeError('An image, video or video-upscale kind is required');
  // Remove inside the persistence chain: earlier snapshots must not observe an
  // uncommitted prune, and later snapshots must wait for success or rollback.
  return queuePersist(async () => {
    const matches = archive.map((job, index) => ({ job, index }))
      .filter(({ job }) => job.kind === kind && (job.status === 'failed' || job.status === 'canceled'));
    // Production attempts may still need their queue receipt during recovery,
    // even when the provider submission itself is known to have failed.
    const removed = matches.filter(({ job }) => canRemoveArchivedJob(job)
      && job.result?.topazRecoveryAvailable !== true && !job.params?.videoProduction);
    const skipped = matches.length - removed.length;
    if (!removed.length) return { deletedIds: [], skipped };

    const removedIds = new Set(removed.map(({ job }) => job.id));
    for (let i = archive.length - 1; i >= 0; i -= 1) {
      if (removedIds.has(archive[i].id)) archive.splice(i, 1);
    }
    let snapshotWritten = false;
    let warning;
    try {
      await persistImpl({ trimArchive: false, onSnapshotWritten: () => { snapshotWritten = true; } });
    } catch (error) {
      if (!snapshotWritten) {
        for (const { job, index } of removed) {
          if (!archive.includes(job)) archive.splice(Math.min(index, archive.length), 0, job);
        }
        throw new ServerError(`Could not remove jobs from the media queue: ${error.message}`, {
          status: 503, code: MEDIA_QUEUE_PERSIST_FAILED,
        });
      }
      console.error(`❌ media-job queue archive prune saved but another queue update failed: ${error.message}`);
      warning = 'Another queue update could not finish. Check the queue.';
    }
    for (const { job } of removed) closeArchivedJobSse(job.id);
    return { deletedIds: [...removedIds], skipped, ...(warning ? { warning } : {}) };
  }).catch((error) => {
    if (error.code === MEDIA_QUEUE_PERSIST_FAILED) throw error;
    throw new ServerError(`Could not remove jobs from the media queue: ${error.message}`, {
      status: 503, code: MEDIA_QUEUE_PERSIST_FAILED,
    });
  });
}

export const MEDIA_QUEUE_FLUSH_TIMEOUT_MS = 2000;

// Join the actual persistence work. A live lane retains its maintenance permit
// until this completes, even when a separate shutdown caller exhausts its budget.
export async function drainMediaJobQueue() {
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
// then write one fresh snapshot, including the latest in-memory progress, and wait
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

export const isPersistBlocked = () => persistBlocked;
export const hasPendingTransitions = () => pendingTransitions.size > 0;
// Boot defers completion recovery until the domain hooks are wired.
export function configureTerminalTransitions({ deferCompletionRecovery, prepareTerminalHooks }) {
  completionRecoveryDeferred = deferCompletionRecovery;
  prepareHooks = prepareTerminalHooks;
}
// Settles with whatever write is last in the chain when called.
export const settlePersistChain = () => persistChain.catch(() => {});

export function resetPersistenceForTests() {
  prepareHooks = null;
  pendingTransitions.clear();
  // A leftover rejection from a previous test's ENOENT writes must not poison
  // later persist() calls.
  persistChain = Promise.resolve();
  // Un-latch the #4115 block: a test that booted on an unreadable jobs file
  // would otherwise leave every later test's queue unable to persist.
  persistBlocked = false;
  completionRecovery = null;
  completionRecoveryDeferred = false;
}
