/**
 * Shots from the storyboard, kept in sync: a music video's shots made from its
 * linked board one per panel at the panel's own time, and kept 1:1 with it
 * (lib/storyboardShotSync.js, the plan the Storyboard step previews).
 *
 * Sync shots (`syncMusicVideoShots`) runs on the user's tap and turns on
 * `project.storyboardSync`; from then on every board edit (a panel added,
 * moved, retimed, reworded or deleted) runs the same sync for each video
 * keeping that board in sync (`syncShotsAfterBoardEdit`). A shot's own work
 * (prompts, takes, transitions, effects) is kept; locks hold as the plan says.
 * An automatic sync never removes a locked shot. No model call.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { createKeyCachedQueue } from '../../lib/createKeyCachedQueue.js';
import { storyboardFitSong } from '../../lib/storyboardFit.js';
import { storyboardShotSyncPlan } from '../../lib/storyboardShotSync.js';
import { getStoryboard } from './index.js';

async function syncDeps() {
  const [projects, logic, review] = await Promise.all([
    import('../musicVideo/projects.js'), import('../musicVideo/projectsLogic.js'), import('../musicVideo/productionReview.js'),
  ]);
  return { ...projects, ...logic, ...review };
}

/** The plan for a video record against a board, with the record's own locks. */
function planFor(board, project, deps, { removeLocked = false } = {}) {
  const locks = deps.shotLocks(project);
  return storyboardShotSyncPlan(board, project, {
    song: storyboardFitSong(project), locks, clipLocks: locks ? deps.clipLocks(project, locks) : null, removeLocked,
  });
}

/** Run the plan under the video's write lock; locks carry onto the synced shots. */
async function writeSync(projectId, board, deps, { removeLocked = false, enable = false, expectedUpdatedAt = null } = {}) {
  return deps.mutateProjectRecord(projectId, (current) => {
    if (current.storyboardId !== board.id) {
      throw new ServerError('This video was linked to another storyboard meanwhile.', { status: 409, code: 'STORYBOARD_CHANGED' });
    }
    if (expectedUpdatedAt && current.updatedAt !== expectedUpdatedAt) {
      throw new ServerError('The shots changed since this sync was shown. Check it again.', { status: 409, code: 'SHOTS_CHANGED' });
    }
    const plan = planFor(board, current, deps, { removeLocked });
    if (plan.problem) throw new ServerError(plan.problem, { status: 409, code: 'STORYBOARD_SYNC_UNFIT' });
    const flagged = enable && current.storyboardSync !== true ? { ...current, storyboardSync: true } : current;
    if (plan.inSync) return { project: flagged, plan, changed: flagged !== current };
    const outcome = deps.applyStoryboardShotSync(flagged, plan);
    return { ...outcome, project: deps.carryShotLocks(current, outcome.project), plan, changed: true };
  });
}

/**
 * Sync shots: the video's shots written from its linked board as previewed
 * (`boardUpdatedAt` and `projectUpdatedAt` are what the preview read), then
 * kept in sync. `removeLocked` also removes locked shots no panel keeps.
 */
export async function syncMusicVideoShots(projectId, { boardUpdatedAt, projectUpdatedAt = null, removeLocked = false } = {}) {
  const deps = await syncDeps();
  const linked = await deps.getProject(projectId);
  if (!linked) throw new ServerError('Music video not found', { status: 404, code: 'NOT_FOUND' });
  if (!linked.storyboardId) throw new ServerError('Link a storyboard first.', { status: 409, code: 'STORYBOARD_NOT_LINKED' });
  const board = await getStoryboard(linked.storyboardId);
  if (board.updatedAt !== boardUpdatedAt) {
    throw new ServerError('The storyboard changed since this sync was shown. Check it again.', { status: 409, code: 'STORYBOARD_CHANGED' });
  }
  const outcome = await writeSync(projectId, board, deps, { removeLocked, enable: true, expectedUpdatedAt: projectUpdatedAt });
  const { counts } = outcome.plan;
  console.log(`🎬 Synced music video ${projectId} shots to storyboard ${board.id}: ${counts.linked} linked, ${counts.added} new, ${counts.removed} removed, ${counts.blocked} held`);
  return { project: outcome.project, counts };
}

/** Stop (or start) keeping a video's shots in sync with its board; starting syncs once. */
export async function setMusicVideoShotSync(projectId, on) {
  const deps = await syncDeps();
  if (!on) {
    const { project } = await deps.mutateProjectRecord(projectId, (current) => ({ project: { ...current, storyboardSync: false } }));
    return { project };
  }
  const linked = await deps.getProject(projectId);
  if (!linked?.storyboardId) throw new ServerError('Link a storyboard first.', { status: 409, code: 'STORYBOARD_NOT_LINKED' });
  const board = await getStoryboard(linked.storyboardId);
  const outcome = await writeSync(projectId, board, deps, { enable: true });
  return { project: outcome.project, counts: outcome.plan.counts };
}

// Board edits release their write lock before this runs, so two edits' syncs can overlap.
// One sync per board at a time, each from the board as it is now, so an older edit's
// snapshot never lands after a newer one.
const boardSyncs = createKeyCachedQueue();

/**
 * After a board edit: each live video linked to the board with sync on takes
 * the edit. A video whose sync cannot run (the board runs past the song, a
 * locked video) keeps its shots; the Storyboard step shows why.
 */
export function syncShotsAfterBoardEdit(edited) {
  if (!edited?.id || edited.deleted) return Promise.resolve();
  return boardSyncs(edited.id, async () => {
    const board = await getStoryboard(edited.id).catch((err) => (err?.status === 404 ? null : Promise.reject(err)));
    if (board && !board.deleted) await syncBoard(board);
  });
}

async function syncBoard(board) {
  const deps = await syncDeps();
  const videos = (await deps.listProjects()).filter((p) => p && !p.deleted && p.storyboardId === board.id && p.storyboardSync === true);
  for (const video of videos) {
    // Most edits (a drawing's progress, a note) leave the shots as they are: no write then.
    const plan = planFor(board, video, deps);
    if (plan.problem || plan.inSync) continue;
    const outcome = await writeSync(video.id, board, deps).catch((err) => {
      if (err?.code !== 'STORYBOARD_SYNC_UNFIT' && err?.code !== 'STORYBOARD_CHANGED') console.error(`❌ Storyboard sync for ${video.id}: ${err.message}`);
      return null;
    });
    if (outcome?.changed) {
      const { counts } = outcome.plan;
      console.log(`🎬 Storyboard ${board.id} edit → music video ${video.id} shots (${counts.retimed} moved, ${counts.added} new, ${counts.removed} removed, ${counts.updated} updated)`);
    }
  }
}
