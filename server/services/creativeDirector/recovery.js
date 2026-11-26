/**
 * Creative Director — boot-time recovery.
 *
 * A restart aborts in-flight renders and drops runSceneRender's listeners, leaving
 * projects in `rendering` / `stitching` forever. After the media-job queue reloads, for
 * each mid-flight project (planning/rendering/stitching) we:
 *   1. Reset scenes stuck in `rendering` / `evaluating` to `pending`.
 *   2. Fail persisted `running` runs[] rows: advanceAfterSceneSettled's guard treats
 *      any non-terminal run as "another worker is on it" and would refuse to resume.
 *   3. Call `advanceAfterSceneSettled` to resume from wherever the project stopped.
 */

import { listProjects, updateScene, updatePlanStep, updateProject } from './local.js';
import { listJobs, cancelJob } from '../mediaJobQueue/index.js';
import { inflightRuns, ownedLiveJobs, retireRuns } from './stopProject.js';
import { logFailureWithStack } from '../../lib/failureLogging.js';

// cos.start() awaits this before resetOrphanedTasks(), which would otherwise respawn
// stale CD tasks before recoverInFlightProjects() retires them (two agents, one project).
let resolveRecoveryDone;
export const cdRecoveryDone = new Promise((resolve) => {
  resolveRecoveryDone = resolve;
});

// Auto-advanced on boot: the user expects them to keep running.
const RECOVERABLE_STATUSES = new Set(['planning', 'rendering', 'stitching']);
// Stale state is cleaned but not auto-advanced: `paused` means the user pressed Pause.
const CLEANUP_ONLY_STATUSES = new Set(['paused']);
const STUCK_SCENE_STATUSES = new Set(['rendering', 'evaluating']);

async function recoverLegacyProject(project, { recoveryStartedAt, completedAt, advanceAfterSceneSettled, advanceAfterPlanStepSettled }) {
  // CDO Phase 2 (#2184): plan steps stuck in `running` lost their listener; reset to
  // `pending` for re-dispatch (their `plan-step` run rows are reaped by staleRuns below).
  const planSteps = Array.isArray(project.plan?.steps) ? project.plan.steps : [];
  const stuckPlanSteps = planSteps.filter((s) => s.status === 'running');
  for (const step of stuckPlanSteps) {
    await updatePlanStep(project.id, step.stepId, { status: 'pending' })
      .catch((e) => console.log(`⚠️ CD recovery: reset plan step ${step.stepId} of ${project.id} failed: ${e.message}`));
  }
  if (stuckPlanSteps.length) {
    console.log(`🔄 CD recovery: ${project.id} reset ${stuckPlanSteps.length} stuck plan step(s) to pending`);
  }

  const scenes = project.treatment?.scenes || [];
  const stuck = scenes.filter((s) => STUCK_SCENE_STATUSES.has(s.status));
  for (const scene of stuck) {
    // A paused project's finished render keeps `evaluating` so resume re-evaluates the existing clip.
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
  // Reap stale `running` runs AND retire their CoS tasks: resetOrphanedTasks would
  // otherwise respawn them, racing the fresh task recovery enqueues. `retireRuns` owns
  // that contract; nothing can be alive to kill, since this runs at boot.
  const staleRuns = inflightRuns(project).filter((r) => r.status === 'running');
  if (staleRuns.length) {
    await retireRuns(project.id, {
      runs: staleRuns,
      reason: 'interrupted by restart',
      taskMetadata: { interruptedByRestart: 'true', recoveredAt: completedAt },
    });
    console.log(`🔄 CD recovery: ${project.id} reaped ${staleRuns.length} stale running run(s)`);
  }
  // Cancel media-queue jobs this project owns that initMediaJobQueue() restored, so a
  // doomed render neither burns GPU nor races the fresh render for the same owner.
  // Cancel BOTH queued AND running: the queue worker dequeues restored jobs at once, so
  // a disk-`queued` job may already be `running`. Only jobs queued BEFORE recovery
  // started: recovery is fire-and-forget, so a later queuedAt is the user's own
  // Resume and must not be canceled. (Jobs the queue already marked failed are terminal.)
  const orphaned = ownedLiveJobs(listJobs(), project.id)
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
  // Only auto-advance projects the user expects to be running; `paused` ones just needed the cleanup.
  if (RECOVERABLE_STATUSES.has(project.status)) {
    // CDO Phase 2 (#2184): a directive-driven project resumes via the plan advance loop; legacy video projects use the scene loop.
    if (project.directive) {
      advanceAfterPlanStepSettled(project.id)
        .catch((e) => logFailureWithStack(`❌ CD recovery: plan advance for ${project.id} failed`, e));
      return true;
    }
    // A mid-stitch project still has status='stitching', which advanceAfterSceneSettled's
    // dedup guard exits on; flip to 'rendering' so it re-evaluates and re-fires runStitch.
    if (project.status === 'stitching' && !project.finalVideoId) {
      await updateProject(project.id, { status: 'rendering' })
        .catch((e) => console.log(`⚠️ CD recovery: reset stitching→rendering for ${project.id} failed: ${e.message}`));
    }
    advanceAfterSceneSettled(project.id)
      .catch((e) => logFailureWithStack(`❌ CD recovery: advance for ${project.id} failed`, e));
    return true;
  }
  return false;
}

export async function recoverInFlightProjects() {
  try {
    // Jobs the user enqueues after this snapshot must survive boot recovery.
    const recoveryStartedAt = Date.now();
    const projects = await listProjects();
    const needsCleanup = projects.filter(
      (p) => RECOVERABLE_STATUSES.has(p.status) || CLEANUP_ONLY_STATUSES.has(p.status),
    );
    if (!needsCleanup.length) return { resumed: 0 };

    const { advanceAfterSceneSettled } = await import('./completionHook.js');
    const { advanceAfterPlanStepSettled } = await import('./planAdvance.js');
    const completedAt = new Date().toISOString();
    let localInstanceIdPromise;
    let resumed = 0;
    for (const project of needsCleanup) {
      try {
        if (project.workspace === 'video') {
          if (project.videoReplica || !project.videoOwnerInstanceId) continue;
          localInstanceIdPromise ??= import('../instanceIdentity.js').then(({ getInstanceId }) => getInstanceId());
          if (project.videoOwnerInstanceId !== await localInstanceIdPromise) continue;

          const { reconcileVideoExecution } = await import('./videoExecution.js');
          await retireRuns(project.id, { runs: inflightRuns(project), reason: 'Video production paused after restart', taskMetadata: { interruptedByRestart: 'true' } });
          await reconcileVideoExecution(project.id, { restarting: true });
          continue;
        }
        // A peer replica carries another install's run state.
        if (project.peerReplica) continue;
        const didResume = await recoverLegacyProject(project, {
          recoveryStartedAt, completedAt, advanceAfterSceneSettled, advanceAfterPlanStepSettled,
        });
        if (didResume) resumed += 1;
      } catch (error) {
        logFailureWithStack(`❌ CD recovery: project ${project.id} failed`, error);
      }
    }
    console.log(`🔄 CD recovery: resumed ${resumed} in-flight project(s)`);
    return { resumed };
  } finally {
    resolveRecoveryDone();
  }
}

// Resolves the gate for callers that never run recoverInFlightProjects (tests, scripts). Idempotent.
export function markRecoveryDone() {
  resolveRecoveryDone();
}
