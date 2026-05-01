/**
 * Creative Director — task-completion hook.
 *
 * Called from agentLifecycle.handleAgentCompletion when a finished task
 * carries `metadata.creativeDirector`. Decides what (if anything) to enqueue
 * next based on the project's current state.
 *
 * Pattern mirrors handlePipelineProgression — read fresh state, decide,
 * either mark the project failed (on failure) or enqueue the next task kind.
 */

import { getProject, updateProject, updateRun, recordRun } from './local.js';
import { nextTaskKind } from './orchestrator.js';
import { enqueueCreativeDirectorTask } from './agentBridge.js';

export async function handleCreativeDirectorCompletion(task, agentId, success) {
  const meta = task?.metadata?.creativeDirector;
  if (!meta?.projectId) return;
  const project = await getProject(meta.projectId).catch(() => null);
  if (!project) {
    console.log(`⚠️ CD completion hook: project ${meta.projectId} not found`);
    return;
  }

  // Persist a run entry for visibility in the Runs tab. We use the runId
  // from the original task metadata if present (so a run record may already
  // exist) — otherwise record a fresh one.
  const runId = meta.runId;
  const completedAt = new Date().toISOString();
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
    await updateProject(project.id, { status: 'failed' }).catch(() => {});
    console.log(`❌ CD project ${project.id} marked failed (task ${meta.kind} failed)`);
    return;
  }

  // Re-read post-success: the agent may have just written the treatment or
  // marked a scene accepted. The orchestrator needs the latest state.
  const fresh = await getProject(project.id);
  if (!fresh) return;
  if (fresh.status === 'paused' || fresh.status === 'failed') return;

  const kind = nextTaskKind(fresh);
  if (!kind) {
    // Nothing more to do. If we just finished a stitch task and the agent
    // updated finalVideoId, the project is already 'complete'. Otherwise
    // mark it complete here as a fallback (e.g. all scenes accepted but
    // somehow no stitch needed).
    if (fresh.status !== 'complete') {
      await updateProject(project.id, { status: 'complete' }).catch(() => {});
    }
    console.log(`✅ CD project ${project.id} pipeline complete`);
    return;
  }

  if (kind === 'stitch' && fresh.status !== 'stitching') {
    await updateProject(project.id, { status: 'stitching' });
  }
  // Re-fetch one more time so the prompt builder gets accurate status.
  const final = await getProject(project.id);
  await enqueueCreativeDirectorTask(final, kind);
}
