/**
 * Sprite local-render completion hook (#4876).
 *
 * The local lane queues ONE media job per animation clip and then has to be
 * told when it settles. Awaiting that in the request that started it — a promise
 * held in the enqueueing process — cannot survive the thing it most needs to
 * survive: a restart. `initMediaJobQueue` re-enqueues jobs that were merely
 * `queued` at shutdown, so a per-call awaiter meant an H3 render could run for
 * HOURS after the restart, write its MP4, and have nothing file it — the run sat
 * at `rendering` (blocking regeneration the whole time) and then reported itself
 * interrupted, burning the render the user waited for.
 *
 * So this hook holds NO in-memory state about in-flight work. It decodes each
 * job from its own persisted `params.spriteAnimation` tag, exactly like the
 * other durable media-job hooks (`mediaJobImageHook`, `universeBuilderCollectionHook`).
 * Two halves, and both are needed:
 *
 *  1. A live subscription to every TERMINAL event, so a job that settles while
 *     this process is up is filed immediately.
 *  2. A boot reconcile, because a job that settled while the process was DOWN
 *     emits nothing — it is simply sitting in the restored archive. Without this
 *     pass those runs would only ever be resolved by the walk lane's wall-clock
 *     backstop (a day later, as an error), and never at all on the track lane.
 *
 * It listens for `failed`/`canceled` as well as `completed` on purpose: the
 * attach treats "no clip on disk" as a terminal, user-visible error, so routing
 * every outcome through it is what guarantees a run always leaves `rendering`.
 */

import { join } from 'path';
import { mediaJobEvents, listJobs } from '../mediaJobQueue/index.js';
import { readJSONFile, atomicWrite } from '../../lib/fileUtils.js';
import { spriteDir, runRelPath, SOURCE_CLIP_NAME, RUN_RECORD_NAME } from './paths.js';
import { WALK_TRACK } from './animationTargets.js';

import { withAnimationWriteTail } from './animationWorkflow.js';
import { collectLocalAnimationClip } from './localAnimationRender.js';
import { attachTuiWalkResult } from './walk.js';
import { attachTrackTuiResult } from './animationTrackWorkflow.js';

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
 * Stage the clip (when there is one) and run the track's attach.
 *
 * The attach is the single place a run leaves `rendering`, on either outcome:
 * it packages the clip into a candidate when the MP4 is there, and writes a
 * terminal error naming the Render Queue when it is not. So the outcome is
 * decided by WHAT IS ON DISK, not by the job's status — which is what lets a
 * render interrupted after it wrote its MP4 still be recovered, and makes a
 * genuinely failed or clip-less job converge on the same honest error.
 *
 * Both the staging and the attach run INSIDE the per-record write tail: the
 * clip lands at the same path a user-triggered Reprocess reads, and a copy racing
 * that read would hand ffmpeg a truncated MP4 and error a previously-good run.
 */
async function settleSpriteAnimationJob(job) {
  const decoded = decodeSpriteAnimationJob(job);
  if (!decoded) return false;
  const { recordId, runId, track, direction } = decoded;
  const label = `sprite ${track} ${recordId}/${direction || 'row-0'}`;
  const runRel = runRelPath(runId);
  const videoAbs = join(spriteDir(recordId), runRel, 'generated', SOURCE_CLIP_NAME);
  return withAnimationWriteTail(recordId, async () => {
    // Settle a run ONCE. Neither attach looks at `run.status` — they guard only
    // frozen evidence (a finalized set, an approved run) — so re-entering here
    // for a run that is already `candidate` would re-stage the clip and re-run
    // the whole postprocess: minutes of frame decoding, and a manifest restamped
    // with TODAY's anchor for a clip rendered from a previous one. That is not
    // hypothetical, because the boot pass sweeps the archive unconditionally and
    // a job outlives the run it filed by the archive's whole TTL.
    //
    // The ONE exception is a Render Queue retry: it re-enqueues the same params
    // (tag included) under a NEW job id, so its completion lands on a run this
    // hook already filed as `error`. Skipping that would waste the multi-hour
    // render the user explicitly asked for. A different job id is exactly what
    // separates it from the boot sweep re-seeing the job that PRODUCED the
    // error — so the new id is stamped on the run before the attach, and a later
    // sweep of that same job then reads as already-filed.
    const recordPath = join(spriteDir(recordId), runRel, RUN_RECORD_NAME);
    const record = await readJSONFile(recordPath, null, { strict: true });
    const isRetryOfFiledRun = record?.status === 'error'
      && typeof job.id === 'string' && job.id !== record.jobId;
    if (record?.status !== 'rendering' && !isRetryOfFiledRun) return false;
    if (isRetryOfFiledRun) {
      console.log(`🎞️ ${label} retried as job ${job.id.slice(0, 8)} — re-filing the run`);
      await atomicWrite(recordPath, { ...record, jobId: job.id });
    }
    // Try to stage the clip for a FAILED job too, not just a completed one. The
    // queue stamps `interrupted by restart` on anything that was running when
    // the process died — and the H3 child may well have written its final MP4
    // before that happened, since the job only flips to `completed` once the
    // queue persists the runner's event. Skipping collection there would file an
    // error over a render that exists and orphan the clip under data/videos.
    // `canceled` is excluded on purpose: a user who stopped a render must not
    // get a candidate out of it, even if the file happened to land.
    if (job.status === 'canceled') {
      console.log(`🎞️ ${label} local render canceled — filing the run as errored`);
    } else {
      await collectLocalAnimationClip({ jobId: job.id, videoAbs, label });
    }
    await (track === WALK_TRACK
      ? attachTuiWalkResult(recordId, runId, videoAbs)
      : attachTrackTuiResult(track, recordId, runId, videoAbs));
    return true;
  });
}

let terminalHandler = null;

/**
 * Reconcile jobs that reached a terminal state while this process was down.
 *
 * An unconditional sweep of the restored archive — every already-filed job in it
 * is a no-op, because `settleSpriteAnimationJob` refuses any run that is not
 * still `rendering`. That is what keeps this pass safe to run on every boot for
 * the archive's whole retention window.
 */
async function reconcileSettledSpriteJobs() {
  const jobs = listJobs({ kind: 'video', owner: 'sprites' })
    .filter((job) => ['completed', 'failed', 'canceled'].includes(job.status))
    .filter(decodeSpriteAnimationJob);
  if (!jobs.length) return 0;
  let settled = 0;
  for (const job of jobs) {
    // Serialized on purpose: these share the per-record write tail anyway, and a
    // boot sweep has no reason to contend with the requests now arriving.
    // eslint-disable-next-line no-await-in-loop
    await settleSpriteAnimationJob(job).then(() => { settled += 1; }).catch((err) => (
      console.error(`❌ sprite local render boot reconcile failed for job ${job.id.slice(0, 8)}: ${err?.message || err}`)
    ));
  }
  console.log(`🎞️ sprite local renders: reconciled ${settled} settled job(s) on boot`);
  return settled;
}

/**
 * Mount the hook. Idempotent — a double init would otherwise file every
 * completed clip twice.
 */
export function initSpriteLocalAnimationHook() {
  if (terminalHandler) return;
  terminalHandler = (job) => {
    // Outside the request lifecycle, so a throw here would take the process
    // down rather than reaching error middleware (AGENTS.md boundary exception).
    void settleSpriteAnimationJob(job).catch((err) => (
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
