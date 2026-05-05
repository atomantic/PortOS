/**
 * Creative Director — boot-time recovery.
 *
 * Server restarts (deploys, watchers, OOM kills) abort any in-flight render
 * and tear down the in-memory listeners that runSceneRender attaches. Without
 * recovery the project sits in `rendering` / `stitching` forever — its scene
 * status fields point at jobs that the queue already reclassified as
 * 'failed (interrupted by restart)' but nothing fires advanceAfterSceneSettled
 * to push the project forward.
 *
 * On boot, after the media-job queue reloads its persisted state, we:
 *   1. Find every project that's mid-flight (status in planning/rendering/
 *      stitching).
 *   2. Reset any scenes stuck in `rendering` or `evaluating` back to `pending`
 *      — their listeners are gone, the render is dead, the only sane next
 *      action is to redo them.
 *   3. Mark any persisted `runs[]` row in `running` state as failed —
 *      the agent task behind it died with the previous process. Without
 *      this, advanceAfterSceneSettled's persisted-runs guard (which treats
 *      any non-terminal `treatment` run as "another worker is on it")
 *      would silently refuse to enqueue a replacement and the project
 *      would stay stuck in `planning` forever.
 *   4. Call `advanceAfterSceneSettled` to resume each project. It picks up
 *      from wherever the project stopped: re-renders pending scenes, fires a
 *      fresh evaluate task, runs the stitch, etc.
 */

import { listProjects, updateScene, updateRun } from './local.js';
import { listJobs, cancelJob } from '../mediaJobQueue/index.js';
import { updateTask } from '../cos.js';

// Projects that should be auto-advanced on boot — the user expects them to
// keep running.
const RECOVERABLE_STATUSES = new Set(['planning', 'rendering', 'stitching']);
// Projects whose stale state still needs cleanup but should NOT auto-advance
// on boot. `paused` is here because the user pressed Pause; we still need to
// wipe the dead in-flight state behind the pause so Resume picks up cleanly,
// but we don't want to fire a fresh agent task before the user clicks
// Resume themselves.
const CLEANUP_ONLY_STATUSES = new Set(['paused']);
const STUCK_SCENE_STATUSES = new Set(['rendering', 'evaluating']);

export async function recoverInFlightProjects() {
  const projects = await listProjects();
  const needsCleanup = projects.filter(
    (p) => RECOVERABLE_STATUSES.has(p.status) || CLEANUP_ONLY_STATUSES.has(p.status),
  );
  if (!needsCleanup.length) return { resumed: 0 };

  const { advanceAfterSceneSettled } = await import('./completionHook.js');
  let resumed = 0;
  const completedAt = new Date().toISOString();
  for (const project of needsCleanup) {
    const scenes = project.treatment?.scenes || [];
    const stuck = scenes.filter((s) => STUCK_SCENE_STATUSES.has(s.status));
    for (const scene of stuck) {
      await updateScene(project.id, scene.sceneId, { status: 'pending' })
        .catch((e) => console.log(`⚠️ CD recovery: reset scene ${scene.sceneId} of ${project.id} failed: ${e.message}`));
    }
    if (stuck.length) {
      console.log(`🔄 CD recovery: ${project.id} reset ${stuck.length} stuck scene(s) to pending`);
    }
    // Reap stale `running` agent-run rows AND retire the underlying CoS
    // task. The agent task behind each run died with the previous process,
    // but cos.js#resetOrphanedTasks would otherwise see `in_progress` task
    // rows on boot and respawn them — racing the fresh treatment/evaluate
    // task this recovery path will cause to enqueue. Mark the CoS task
    // failed first so the orphan-task reset finds nothing to retry.
    const staleRuns = (project.runs || []).filter((r) => r.status === 'running');
    for (const run of staleRuns) {
      if (run.taskId) {
        await updateTask(run.taskId, { status: 'failed' }, 'cos')
          .catch((e) => console.log(`⚠️ CD recovery: retire CoS task ${run.taskId} for ${project.id} failed: ${e.message}`));
      }
      await updateRun(project.id, run.runId, {
        status: 'failed',
        completedAt,
        failureReason: 'interrupted by restart',
      }).catch((e) => console.log(`⚠️ CD recovery: reap run ${run.runId} of ${project.id} failed: ${e.message}`));
    }
    if (staleRuns.length) {
      console.log(`🔄 CD recovery: ${project.id} reaped ${staleRuns.length} stale running run(s)`);
    }
    // Cancel any media-queue jobs owned by this project that
    // initMediaJobQueue() restored from disk in `queued` state. Two
    // reasons: (1) For paused projects the user explicitly stopped, the
    // queued render shouldn't burn GPU on resume. (2) For recovering
    // projects (planning/rendering/stitching) the recovery path resets
    // their scenes to `pending` and advance() will enqueue a fresh render
    // — leaving the prior queued job alive would race two completions for
    // the same `cd:<projectId>:<sceneId>` owner. Always cancel BEFORE the
    // advance call below so the new enqueue can't collide. (Running jobs
    // were already reclassified failed by the queue's own boot recovery,
    // so we only need to handle queued here.)
    const orphaned = listJobs({ status: 'queued' })
      .filter((j) => typeof j.owner === 'string' && j.owner.startsWith(`cd:${project.id}:`));
    for (const job of orphaned) {
      await cancelJob(job.id)
        .catch((e) => console.log(`⚠️ CD recovery: cancel orphaned queued job ${job.id} for ${project.id} failed: ${e.message}`));
    }
    if (orphaned.length) {
      console.log(`🔄 CD recovery: ${project.id} canceled ${orphaned.length} orphaned queued job(s)`);
    }
    // Only auto-advance projects the user expects to still be running.
    // `paused` projects skip this — the cleanup above is enough to make a
    // future Resume click work.
    if (RECOVERABLE_STATUSES.has(project.status)) {
      advanceAfterSceneSettled(project.id)
        .catch((e) => console.log(`⚠️ CD recovery: advance for ${project.id} failed: ${e.message}`));
      resumed += 1;
    }
  }
  console.log(`🔄 CD recovery: resumed ${resumed} in-flight project(s)`);
  return { resumed };
}
