/**
 * Creative Director — task-completion hook.
 *
 * Called from agentLifecycle.handleAgentCompletion when a finished agent
 * task carries `metadata.creativeDirector`. The hook decides what (if
 * anything) happens next based on the project's current state.
 *
 * Flow under the new architecture:
 *   - treatment task done → kick off render for scene 1 (server-side, no
 *     agent task) via sceneRunner.runSceneRender.
 *   - evaluate task done  → look at the scene's verdict:
 *       * `accepted`  → run the next pending scene, OR if all done, run
 *                       the stitch (server-side, no agent task).
 *       * `pending`   → the agent requested a re-render with a new
 *                       prompt; run scene render again.
 *       * `failed`    → continue on to the next scene (one bad render
 *                       shouldn't kill the whole project) OR mark project
 *                       failed if NO scene was ever accepted.
 *
 * `advanceAfterSceneSettled` is also exported for sceneRunner to call
 * directly when a render fails terminally (no evaluate task is spawned in
 * that case).
 */

import { getProject, updateProject, updateRun, recordRun } from './local.js';
import { enqueueTreatmentTask } from './agentBridge.js';
import { runSceneRender } from './sceneRunner.js';
import { runStitch } from './stitchRunner.js';

export async function handleCreativeDirectorCompletion(task, agentId, success) {
  const meta = task?.metadata?.creativeDirector;
  if (!meta?.projectId) return;
  const project = await getProject(meta.projectId).catch(() => null);
  if (!project) {
    console.log(`⚠️ CD completion hook: project ${meta.projectId} not found`);
    return;
  }

  // Update / create the run record so the Runs tab reflects this agent run.
  const completedAt = new Date().toISOString();
  const runId = meta.runId;
  const updatedExisting = runId
    ? await updateRun(project.id, runId, {
        agentId,
        status: success ? 'completed' : 'failed',
        completedAt,
        kind: meta.kind,
        sceneId: meta.sceneId || null,
        taskId: task.id,
      })
    : null;
  if (!updatedExisting) {
    await recordRun(project.id, {
      runId: runId || undefined,
      agentId,
      taskId: task.id,
      kind: meta.kind,
      sceneId: meta.sceneId || null,
      status: success ? 'completed' : 'failed',
      completedAt,
    }).catch((err) => console.log(`⚠️ CD recordRun failed: ${err.message}`));
  }

  if (!success) {
    // Surface a concrete reason on the project so the UI's failure banner
    // has actionable context. Without this, a project flips to 'failed'
    // with whatever stale failureReason it had before (often null), and
    // the user has no idea what happened.
    const reason = `${meta.kind} agent task failed (taskId=${task.id || '?'}, agent=${agentId || '?'})`;
    await updateProject(project.id, { status: 'failed', failureReason: reason })
      .catch((e) => console.log(`⚠️ CD updateProject(failed) for ${project.id} failed: ${e.message}`));
    console.log(`❌ CD project ${project.id} marked failed (task ${meta.kind} failed)`);
    return;
  }

  const fresh = await getProject(project.id);
  if (!fresh) return;
  if (fresh.status === 'paused' || fresh.status === 'failed') return;

  // Always advance — advanceAfterSceneSettled is idempotent and inspects
  // project state to decide what comes next. Calling it for unknown kinds
  // (e.g. legacy 'scene' tasks from before the treatment/evaluate split)
  // makes the system self-healing rather than silently getting stuck.
  return advanceAfterSceneSettled(fresh.id);
}

/**
 * Look at the project's scene state and decide what to do next.
 * Called from:
 *   - completionHook on `treatment` and `evaluate` task completion.
 *   - sceneRunner when a render fails terminally (no evaluate task spawned).
 */
export async function advanceAfterSceneSettled(projectId) {
  const project = await getProject(projectId);
  if (!project) return;
  if (project.status === 'paused' || project.status === 'failed') return;

  // No treatment yet → enqueue treatment task.
  if (!project.treatment) {
    await updateProject(project.id, { status: 'planning' });
    const fresh = await getProject(project.id);
    await enqueueTreatmentTask(fresh);
    return;
  }

  // Find next pending scene. nextPendingScene returns the lowest-order
  // scene whose status is pending/rendering/evaluating — but since
  // sceneRunner sets status='rendering' the moment it kicks off, and
  // 'evaluating' once the render completes, we want the lowest-order scene
  // whose status is exactly 'pending' (i.e. not yet started OR
  // re-requested by the evaluator).
  const scenes = (project.treatment.scenes || []).slice().sort((a, b) => a.order - b.order);
  const nextPending = scenes.find((s) => s.status === 'pending');
  if (nextPending) {
    if (project.status !== 'rendering') {
      await updateProject(project.id, { status: 'rendering' });
    }
    const updated = await getProject(project.id);
    const sceneFresh = updated.treatment.scenes.find((s) => s.sceneId === nextPending.sceneId);
    await runSceneRender(updated, sceneFresh);
    return;
  }

  // No pending scenes — but maybe one is mid-flight (rendering / evaluating)?
  // Don't double-trigger; just wait for it to settle and re-fire this hook.
  const inflight = scenes.find((s) => s.status === 'rendering' || s.status === 'evaluating');
  if (inflight) {
    console.log(`⏳ CD project ${projectId}: scene ${inflight.sceneId} is ${inflight.status} — waiting for it to settle`);
    return;
  }

  // All scenes terminal. If at least one was accepted, stitch; else fail.
  const accepted = scenes.filter((s) => s.status === 'accepted');
  if (!accepted.length) {
    await updateProject(project.id, { status: 'failed' })
      .catch((e) => console.log(`⚠️ CD updateProject(failed) for ${projectId} failed: ${e.message}`));
    console.log(`❌ CD project ${projectId}: every scene failed — marking project failed`);
    return;
  }
  if (project.finalVideoId) {
    if (project.status !== 'complete') {
      await updateProject(project.id, { status: 'complete' });
    }
    return;
  }
  // Run stitch (programmatic, no agent task).
  await runStitch(projectId);
}

/**
 * Convenience: kick off the project from the user's "Start" button. Skips
 * straight to advancing.
 */
export async function startCreativeDirectorProject(projectId) {
  return advanceAfterSceneSettled(projectId);
}
