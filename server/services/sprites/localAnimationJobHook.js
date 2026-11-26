import { maintenance } from '../../lib/maintenanceAdmission.js';
/**
 * Sprite local-render completion hook (#4876).
 *
 * The local lane queues ONE media job per animation clip. A per-call awaiter
 * cannot survive a restart (`initMediaJobQueue` re-enqueues `queued` jobs, so an
 * H3 render could finish hours later with nothing to file it), so this hook holds
 * NO in-memory state: it decodes each job from its persisted
 * `params.spriteAnimation` tag, like `mediaJobImageHook` and
 * `universeBuilderCollectionHook`. Both halves are needed:
 *
 *  1. A live subscription to every TERMINAL event.
 *  2. A boot reconcile, because a job that settled while the process was DOWN
 *     emits nothing; without it only the walk lane's wall-clock backstop (as an
 *     error) would resolve it, and nothing on the track lane.
 *
 * `failed`/`canceled` are handled too: the attach treats "no clip on disk" as a
 * terminal user-visible error, so every outcome leaves `rendering`.
 */

import { join } from 'path';
import { mediaJobEvents, listJobs } from '../mediaJobQueue/index.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { readJSONFile, atomicWrite } from '../../lib/fileUtils.js';
import { spriteDir, runRelPath, SOURCE_CLIP_NAME, RUN_RECORD_NAME } from './paths.js';
import { WALK_TRACK } from './animationTargets.js';

import { withAnimationWriteTail } from './animationWorkflow.js';

/** The tag a sprite-animation job carries, or null for every other media job. */
const decodeSpriteAnimationJob = (job) => {
  if (job?.kind !== 'video') return null;
  const tag = job.params?.spriteAnimation;
  if (!tag || typeof tag !== 'object') return null;
  const { recordId, runId, track, direction } = tag;
  if (typeof recordId !== 'string' || !recordId) return null;
  if (typeof runId !== 'string' || !runId) return null;
  if (typeof track !== 'string' || !track) return null;
  return { recordId, runId, track, direction: typeof direction === 'string' ? direction : null };
};

/**
 * Stage the clip (when there is one) and run the track's attach, the single place
 * a run leaves `rendering`. The outcome is decided by WHAT IS ON DISK, not the
 * job's status, so a render interrupted after writing its MP4 is still recovered
 * and a clip-less job converges on an honest error.
 *
 * Staging and attach run INSIDE the per-record write tail: the clip lands where
 * Reprocess reads, and a racing copy would hand ffmpeg a truncated MP4.
 *
 * The settle also holds backup admission (#9982): clip, frames, manifest and run
 * record are one publication. The lease is taken BEFORE the tail and
 * synchronously (the queue's fan-out contract requires it before the first await,
 * so a cut draining for the job's completion waits for this filing). No sprite
 * workflow takes the lease while holding the tail; one that does must take it
 * first. A settle queued behind a long Reprocess can stretch a cut's drain.
 */
async function settleSpriteAnimationJob(job) {
  const decoded = decodeSpriteAnimationJob(job);
  if (!decoded) return false;
  const { recordId, runId, track, direction } = decoded;
  const label = `sprite ${track} ${recordId}/${direction || 'row-0'}`;
  const runRel = runRelPath(runId);
  const videoAbs = join(spriteDir(recordId), runRel, 'generated', SOURCE_CLIP_NAME);
  return withBackupAssetPublication(() => withAnimationWriteTail(recordId, async () => {
    // Settle a run ONCE: neither attach checks `run.status`, so re-entering for a
    // `candidate` run would re-stage and re-postprocess it (minutes of decoding,
    // manifest restamped with today's anchor). The boot sweep re-sees every
    // archived job, so this guard is load-bearing.
    //
    // The exception is a Render Queue retry: same params under a NEW job id,
    // landing on a run filed as `error`. A different job id separates it from the
    // sweep re-seeing the job that PRODUCED the error, so the new id is stamped
    // before the attach and a later sweep of that job reads as already-filed.
    const recordPath = join(spriteDir(recordId), runRel, RUN_RECORD_NAME);
    const record = await readJSONFile(recordPath, null, { strict: true });
    const isRetryOfFiledRun = record?.status === 'error'
      && typeof job.id === 'string' && job.id !== record.jobId;
    if (record?.status !== 'rendering' && !isRetryOfFiledRun) return false;
    if (isRetryOfFiledRun) {
      console.log(`🎞️ ${label} retried as job ${job.id.slice(0, 8)} — re-filing the run`);
      await atomicWrite(recordPath, { ...record, jobId: job.id });
    }
    // Stage the clip for a FAILED job too: a job interrupted by restart may have
    // written its final MP4 first, and skipping would file an error over an
    // existing render and orphan the clip. `canceled` is excluded on purpose: a
    // stopped render must not yield a candidate.
    if (job.status === 'canceled') {
      console.log(`🎞️ ${label} local render canceled — filing the run as errored`);
    } else {
      const { collectLocalAnimationClip } = await import('./localAnimationRender.js');
      await collectLocalAnimationClip({ jobId: job.id, videoAbs, label });
    }
    if (track === WALK_TRACK) {
      const { attachTuiWalkResult } = await import('./walkGeneration.js');
      await attachTuiWalkResult(recordId, runId, videoAbs);
    } else {
      const { attachTrackTuiResult } = await import('./animationTrackWorkflow.js');
      await attachTrackTuiResult(track, recordId, runId, videoAbs);
    }
    return true;
  }));
}

let terminalHandler = null;

/**
 * Reconcile jobs that reached a terminal state while this process was down. An
 * unconditional sweep of the restored archive, safe on every boot because
 * `settleSpriteAnimationJob` refuses any run not still `rendering`.
 */
async function reconcileSettledSpriteJobs() {
  const jobs = listJobs({ kind: 'video', owner: 'sprites' })
    .filter((job) => ['completed', 'failed', 'canceled'].includes(job.status))
    .filter(decodeSpriteAnimationJob);
  if (!jobs.length) return 0;
  // Register the whole recovery batch before yielding, so readiness cannot
  // flicker between two archived jobs. Recovery starts no new provider work.
  const pending = jobs.map(job => ({ job, permit: maintenance.recoverOwned('settlement', `sprite:${job.id}`) }));
  let settled = 0;
  for (const { job, permit } of pending) {
    // Serialized on purpose: no reason to contend with arriving requests.
    await permit.run(() => settleSpriteAnimationJob(job)).then(() => { settled += 1; }).catch((err) => {
      permit.markUnsettled();
      console.error(`❌ sprite local render boot reconcile failed for job ${job.id.slice(0, 8)}: ${err?.message || err}`);
    }).finally(() => permit.finish());
  }
  console.log(`🎞️ sprite local renders: reconciled ${settled} settled job(s) on boot`);
  return settled;
}

/** Mount the hook. Idempotent: a double init would file every clip twice. */
export function initSpriteLocalAnimationHook() {
  if (terminalHandler) return;
  terminalHandler = (job) => {
    // Outside the request lifecycle, so a throw here would take the process
    // down rather than reaching error middleware (AGENTS.md boundary exception).
    void maintenance.continueSettlement(() => settleSpriteAnimationJob(job)).catch((err) => (
      console.error(`❌ sprite local render hook failed for job ${job?.id?.slice(0, 8)}: ${err?.message || err}`)
    ));
  };
  mediaJobEvents.on('completed', terminalHandler);
  mediaJobEvents.on('failed', terminalHandler);
  mediaJobEvents.on('canceled', terminalHandler);
  console.log('🎞️ Sprite local-render hook initialized');
  // Fire-and-forget: a boot sweep must not delay the server accepting requests,
  // and every run it would fix is already parked rather than lost.
  void reconcileSettledSpriteJobs().catch((err) => (
    console.error(`❌ sprite local render boot reconcile failed: ${err?.message || err}`)
  ));
}

export const __testing = {
  decodeSpriteAnimationJob,
  settleSpriteAnimationJob,
  reconcileSettledSpriteJobs,
  reset: () => {
    if (!terminalHandler) return;
    mediaJobEvents.off('completed', terminalHandler);
    mediaJobEvents.off('failed', terminalHandler);
    mediaJobEvents.off('canceled', terminalHandler);
    terminalHandler = null;
  },
};
