/** Lane promotion, worker polling, and shutdown for the media queue. */

import { ServerError } from '../../lib/errorHandler.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { broadcastSse } from '../../lib/sseUtils.js';
import { isRemoteMediaJob } from './remoteMediaJob.js';
import { jobScheduleState, scheduledWaitMessage, SCHEDULED_WAIT_PATTERN, SCHEDULE_EXPIRED_ERROR } from './jobSchedule.js';
import {
  isCloudImageJob, jobLane, jobSwimlane, laneTotalLimits, getEffectiveParallelLimit, getRateLimitCooldown,
  rateLimitWaitMessage, quotaCooldownResumeAt, QUOTA_WAIT_PATTERN, quotaWaitMessage,
} from './limits.js';
import {
  queue, cloudRunning, remoteRunning, archive, videoHolds, mediaJobEvents, recoveringJobs, getRunningJob,
  setRunningJob, runningJobs, trackOperation, trackTerminalOperation, isRemoteReconcile, isTopazUpscale,
  dispatchOperations, laneOperations, workerState,
} from './state.js';
import {
  restoredParams, stageTerminalTransition, persistTerminalTransition, persist, releaseStagedUploads, drainMediaJobQueue,
} from './persistence.js';
import { ensureSseEntry, broadcastTerminalSse, replaceSseEntry, recomputeQueuePositions } from './sse.js';
import { decideOwnershipRelease, OWNERSHIP_RELEASE } from './recoverySettlement.js';
import { runJob } from './execution.js';

// A reservation row whose own reconcile attempt failed again is retried when a
// later job to the same peer is blocked behind it, but no faster than this.
const RESERVATION_RECONCILE_RETRY_MS = 30_000;

export const MEDIA_QUEUE_SHUTTING_DOWN = 'MEDIA_QUEUE_SHUTTING_DOWN';

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
  const lane = jobLane(job);
  if (lane === 'gpu' || lane === 'remote') return 1;
  return getEffectiveParallelLimit(job);
}

export function startWorker(enqueueJob) {
  if (workerState.started || workerState.quiesced) return;
  workerState.started = true;
  // Detach from awaiting so init can return; the loop runs until shutdown quiesces it.
  workerState.operation = drainLoop(enqueueJob).catch((err) => {
    console.error(`❌ mediaJobQueue worker crashed: ${err.message}`, err.stack || '');
  }).finally(() => { workerState.started = false; });
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
  replaceSseEntry(id, { type: 'queued', position: reconciled.position });
  console.log(`🔁 media-job [${entry.id.slice(0, 8)}] remote ${entry.kind} ended without a terminal peer report — re-enqueued for reconciliation`);
  return true;
}

// Every lane uses fire-and-forget so the poll loop is never blocked by a
// running job in another lane.
function startLaneJob(job, { lane }, enqueueJob) {
  // The one promotion boundary every dispatch path crosses, so the shutdown
  // latch holds here even for a caller that raced past its own check.
  if (workerState.quiesced) return false;
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
  if (QUOTA_WAIT_PATTERN.test(job.statusMsg || '') || SCHEDULED_WAIT_PATTERN.test(job.statusMsg || '')
    || /^Rate-limited \(429\)/.test(job.statusMsg || '')) job.statusMsg = '';
  job.statusMsg = job.statusMsg || 'Starting';
  if (lane === 'cloud') {
    cloudRunning.push(job);
  } else if (lane === 'remote') {
    remoteRunning.push(job);
  } else {
    setRunningJob(job);
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
      setRunningJob(null);
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
      const lifecycle = runJob(job, permit, finalizeLane, enqueueJob);
      markRunning();
      lifecycleEvidence = await lifecycle;
      if (workerState.resettingForTests) return;
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
          broadcastTerminalSse(job.id, job.cancelRequested
            ? { type: 'canceled', reason: job.error } : { type: 'error', error: job.error });
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
export async function settleQueuedJob(job, { status, error }) {
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
        const { cleanupTopazStaging } = await import('../videoGen/topazStaging.js');
        await cleanupTopazStaging(job.params.preparedId);
      }
      broadcastTerminalSse(job.id, status === 'canceled'
        ? { type: 'canceled', reason: error } : { type: 'error', error });
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

export async function prepareQueuedVideos(jobs = queue.filter((job) => !job.admitting)) {
  // An admission still waiting for its durable snapshot is not eligible for
  // preparation or failure. Re-check after every await before withdrawing it.
  const results = await videoHolds.resolveCohorts(jobs);
  for (const { job, error } of results) {
    if (workerState.quiesced) break;
    if (!error || job.admitting) continue;
    await settleQueuedJob(job, { status: 'failed',
      error: `Could not prepare local video model: ${error.message || String(error)}` })
      .catch((failure) => console.error(`❌ media preparation outcome awaiting storage: ${failure.message}`));
  }
}


// Quiescing wakes the idle wait even under fake timers, so joining the worker
// never depends on another clock tick. Preparation already in flight still joins.
function waitForWorker() {
  return new Promise(resolve => {
    const timer = setTimeout(() => { workerState.wake = null; resolve(); }, 150);
    workerState.wake = () => { clearTimeout(timer); workerState.wake = null; resolve(); };
  });
}

async function drainLoop(enqueueJob) {
  while (!workerState.quiesced) {
    const held = maintenance.held();
    const candidates = queue.filter((job) => !job.admitting && (!held || recoveringJobs.has(job.id)));
    if (held && !candidates.length) { await waitForWorker(); continue; }
    await prepareQueuedVideos(candidates);
    // Shutdown may have begun while cohorts resolved; exit without promoting.
    if (workerState.quiesced) break;
    videoHolds.updateQueued(queue);
    // Single queue scan, promoting work independently into each open lane.
    // Each swim lane has its own slots, and each lane its own total bound, so
    // a full swim lane only skips its own work.
    const totals = laneTotalLimits();
    const laneSlots = {
      gpu: totals.gpu - Number(Boolean(getRunningJob())),
      cloud: totals.cloud - cloudRunning.length,
      remote: totals.remote - remoteRunning.length,
    };
    const swimSlots = new Map();
    const freeSwimSlots = (job) => {
      const key = jobSwimlane(job);
      const lane = jobLane(job);
      const limit = (lane === 'gpu' || lane === 'remote') ? 1 : getEffectiveParallelLimit(job);
      return swimSlots.get(key) ?? limit;
    };
    for (const active of runningJobs()) swimSlots.set(jobSwimlane(active), freeSwimSlots(active) - 1);
    let quotaWaitChanged = false;
    const expired = [];
    for (const job of candidates) {
      if (job.status !== 'queued' || job.hold || job.admitting) continue;
      const scheduled = jobScheduleState(job);
      if (scheduled?.expired) { expired.push(job); continue; }
      if (scheduled) {
        const waiting = scheduledWaitMessage(scheduled.startAt);
        if (job.statusMsg !== waiting) {
          job.statusMsg = waiting;
          quotaWaitChanged = true;
        }
        continue;
      }
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
      const rlCooldown = getRateLimitCooldown(job);
      if (rlCooldown) {
        const free = freeSwimSlots(job);
        if (free <= 0) {
          const waiting = rateLimitWaitMessage(rlCooldown.effectiveLimit, rlCooldown.expiresAt);
          if (job.statusMsg !== waiting) {
            job.statusMsg = waiting;
            quotaWaitChanged = true;
          }
        }
      }
      const lane = jobLane(job);
      const free = freeSwimSlots(job);
      if (laneSlots[lane] <= 0 || free <= 0) continue;
      // Reconciliation occupies a peer's slot until settled (startLaneJob).
      if (!startLaneJob(job, { lane }, enqueueJob)) continue;
      laneSlots[lane] -= 1;
      swimSlots.set(jobSwimlane(job), free - 1);
    }
    for (const job of expired) {
      await settleQueuedJob(job, { status: 'canceled', error: SCHEDULE_EXPIRED_ERROR })
        .catch((e) => console.error(`❌ media-job ${job.id} stop-by cancel failed: ${e.message}`));
    }
    // One snapshot for every hold this scan changed, not one per job.
    if (quotaWaitChanged) {
      persist().catch((e) => console.error(`❌ media-job mediaJobQueue persist on quota hold failed: ${e.message}`));
    }
    if (!workerState.quiesced) await waitForWorker();
  }
}

// Stop dispatch for server shutdown (#8691). Synchronous and idempotent so the
// signal handler can call it before its first await. Waiting jobs are neither
// canceled nor failed — they persist as queued and the next boot restores
// them; already-running jobs keep their normal completion path, which the
// shutdown flush then captures. Returns true on the call that latched it.
export function quiesceMediaJobQueue() {
  if (workerState.quiesced) return false;
  workerState.quiesced = true;
  workerState.wake?.();
  console.log(`⏸️  mediaJobQueue dispatch stopped for shutdown (${queue.length} waiting job(s) kept queued)`);
  return true;
}

// "Run now" bypass — start a queued cloud-CLI image job immediately
// even if the lane is at its limit. GPU jobs are rejected (single MLX runtime
// would OOM). The rejection code stays 'NOT_CODEX' for client back-compat.
export function runJobNow(jobId, enqueueJob) {
  const job = queue.find((j) => j.id === jobId && !j.admitting);
  if (!job) return { ok: false, code: 'NOT_FOUND', error: 'Job not found in queue' };
  if (!isCloudImageJob(job)) {
    return { ok: false, code: 'NOT_CODEX', error: 'Only cloud-CLI image jobs can be run now; GPU jobs serialize on the MLX runtime' };
  }
  if (workerState.quiesced) {
    return { ok: false, code: MEDIA_QUEUE_SHUTTING_DOWN, error: 'The server is shutting down; the job stays queued and resumes after restart' };
  }
  if (!startLaneJob(job, { lane: 'cloud' }, enqueueJob)) {
    return { ok: false, code: 'MAINTENANCE_HELD', error: 'Maintenance is holding new renders; this job stays queued' };
  }
  return { ok: true, status: 'running' };
}
