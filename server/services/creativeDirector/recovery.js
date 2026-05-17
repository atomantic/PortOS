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

import { listProjects, updateScene, updateRun, updateProject } from './local.js';
import { listJobs, cancelJob } from '../mediaJobQueue/index.js';
import { updateTask } from '../cos.js';

// Boot-time coordination: cos.start() (entered from cos.init() when
// alwaysOn/autoStart is configured) calls resetOrphanedTasks(), which
// would respawn stale CD treatment/evaluate tasks BEFORE
// recoverInFlightProjects() has had a chance to retire them via updateTask.
// Two concurrent agents would then race on the same project. Expose a
// promise that cos.start() awaits before its resetOrphanedTasks call,
// so the order is always:
//   1. recoverInFlightProjects retires stale CD tasks (status='completed').
//   2. resetOrphanedTasks runs and finds nothing CD-related to respawn.
let resolveRecoveryDone;
export const cdRecoveryDone = new Promise((resolve) => {
  resolveRecoveryDone = resolve;
});

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
  // Stamp the recovery start so we can distinguish boot-snapshot jobs
  // (queued by the dead worker before restart, must be canceled) from
  // jobs the user enqueued AFTER recovery began (e.g. clicked Resume
  // mid-recovery — the new job must NOT be canceled as an "orphan").
  // recoverInFlightProjects runs fire-and-forget from index.js and the
  // user can interact during that window.
  const recoveryStartedAt = Date.now();
  const projects = await listProjects();
  const needsCleanup = projects.filter(
    (p) => RECOVERABLE_STATUSES.has(p.status) || CLEANUP_ONLY_STATUSES.has(p.status),
  );
  if (!needsCleanup.length) {
    // Must resolve the gate even on the no-op path or cos.start's
    // resetOrphanedTasks await would sit on its 60s timeout for nothing
    // every daemon start/auto-start.
    resolveRecoveryDone();
    return { resumed: 0 };
  }

  const { advanceAfterSceneSettled } = await import('./completionHook.js');
  let resumed = 0;
  const completedAt = new Date().toISOString();
  for (const project of needsCleanup) {
    const scenes = project.treatment?.scenes || [];
    const stuck = scenes.filter((s) => STUCK_SCENE_STATUSES.has(s.status));
    for (const scene of stuck) {
      // Paused projects with a completed render (renderedJobId set) retain their
      // `evaluating` status so completionHook's resume path can re-fire the
      // evaluator against the existing clip instead of forcing a full re-render.
      // Resetting these to `pending` would discard the already-rendered video.
      if (project.status === 'paused' && scene.renderedJobId) continue;
      await updateScene(project.id, scene.sceneId, { status: 'pending' })
        .catch((e) => console.log(`⚠️ CD recovery: reset scene ${scene.sceneId} of ${project.id} failed: ${e.message}`));
    }
    const resetCount = stuck.filter(
      (s) => !(project.status === 'paused' && s.renderedJobId),
    ).length;
    if (resetCount) {
      console.log(`🔄 CD recovery: ${project.id} reset ${resetCount} stuck scene(s) to pending`);
    }
    // Reap stale `running` agent-run rows AND retire the underlying CoS
    // task. The agent task behind each run died with the previous process,
    // but cos.js#resetOrphanedTasks would otherwise see `in_progress` task
    // rows on boot and respawn them — racing the fresh treatment/evaluate
    // task this recovery path will cause to enqueue. Mark the task failed
    // first so the orphan-task reset finds nothing to retry.
    //
    // taskType MUST be 'internal' here — CD treatment/evaluate tasks are
    // added by agentBridge#persistAndEmit via `addTask(record, 'internal',
    // …)`. Passing 'cos' would write to the wrong file AND, per
    // cos.js#updateTask, strip approval flags from internal task entries
    // (only 'internal' preserves them), silently auto-approving unrelated
    // internal tasks across a CD recovery cycle.
    //
    // status MUST be one of generateTasksMarkdown's supported terminal
    // values (pending/in_progress/blocked/completed) — writing 'failed'
    // would make the parser drop the task from COS-TASKS.md entirely on
    // the next write. Use 'completed' with a metadata audit note so the
    // task is properly retired (preventing orphan re-spawn) without
    // being silently deleted.
    const staleRuns = (project.runs || []).filter((r) => r.status === 'running');
    for (const run of staleRuns) {
      if (run.taskId) {
        await updateTask(run.taskId, {
          status: 'completed',
          metadata: { interruptedByRestart: 'true', recoveredAt: completedAt },
        }, 'internal')
          .catch((e) => console.log(`⚠️ CD recovery: retire internal task ${run.taskId} for ${project.id} failed: ${e.message}`));
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
    // initMediaJobQueue() restored from disk. Two reasons: (1) For paused
    // projects the user explicitly stopped, the queued render shouldn't
    // burn GPU on resume. (2) For recovering projects (planning/rendering/
    // stitching) the recovery path resets their scenes to `pending` and
    // advance() will enqueue a fresh render — leaving the prior job alive
    // would race two completions for the same `cd:<projectId>:<sceneId>`
    // owner.
    //
    // We must cancel BOTH queued AND running, not just queued. The queue
    // worker is started by initMediaJobQueue() (see server/index.js boot
    // order) and dequeues restored jobs immediately — by the time this
    // recovery path runs, what was `queued` on disk may already have
    // transitioned to `running` in memory. Cancelling running CD jobs
    // here SIGTERMs the gen process so the freshly-enqueued render
    // doesn't have to compete for GPU memory with a doomed sibling.
    // (Jobs reclassified `failed (interrupted by restart)` by the queue's
    // own boot recovery are already terminal and listJobs returns them
    // archived — they won't match either filter.)
    //
    // Filter to jobs queued BEFORE recovery started — recoverInFlightProjects
    // runs fire-and-forget from index.js, so the user can have already
    // clicked Resume on a paused project and enqueued a fresh render
    // while we're iterating projects here. queuedAt > recoveryStartedAt
    // means it's a brand-new user-initiated job, not a stale snapshot
    // entry, and canceling it would silently kill the user's action.
    const orphaned = listJobs()
      .filter((j) => typeof j.owner === 'string' && j.owner.startsWith(`cd:${project.id}:`))
      .filter((j) => j.status === 'queued' || j.status === 'running')
      .filter((j) => {
        const qa = new Date(j.queuedAt || 0).getTime();
        return qa > 0 && qa < recoveryStartedAt;
      });
    for (const job of orphaned) {
      await cancelJob(job.id)
        .catch((e) => console.log(`⚠️ CD recovery: cancel orphaned ${job.status} job ${job.id} for ${project.id} failed: ${e.message}`));
    }
    if (orphaned.length) {
      console.log(`🔄 CD recovery: ${project.id} canceled ${orphaned.length} orphaned job(s) (mix of queued + already-dequeued, all from pre-recovery snapshot)`);
    }
    // Only auto-advance projects the user expects to still be running.
    // `paused` projects skip this — the cleanup above is enough to make a
    // future Resume click work.
    if (RECOVERABLE_STATUSES.has(project.status)) {
      // Special case: a project that was mid-stitch when the server died
      // still has status='stitching'. advanceAfterSceneSettled exits
      // early when it sees that status (its stitch dedup guard), so it
      // would never re-fire runStitch. Flip back to 'rendering' so the
      // function re-evaluates from scratch — it'll find all scenes
      // accepted, no inflight, no finalVideoId, and call runStitch
      // (which sets status back to 'stitching' itself before starting).
      if (project.status === 'stitching' && !project.finalVideoId) {
        await updateProject(project.id, { status: 'rendering' })
          .catch((e) => console.log(`⚠️ CD recovery: reset stitching→rendering for ${project.id} failed: ${e.message}`));
      }
      advanceAfterSceneSettled(project.id)
        .catch((e) => console.log(`⚠️ CD recovery: advance for ${project.id} failed: ${e.message}`));
      resumed += 1;
    }
  }
  console.log(`🔄 CD recovery: resumed ${resumed} in-flight project(s)`);
  resolveRecoveryDone();
  return { resumed };
}

// Test/resume helper: callers that don't run recoverInFlightProjects (unit
// tests, scripts) should still resolve the gate so any await on
// cdRecoveryDone in cos.init doesn't hang forever. Idempotent.
export function markRecoveryDone() {
  resolveRecoveryDone();
}
