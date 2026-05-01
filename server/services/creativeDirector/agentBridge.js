/**
 * Creative Director — CoS task bridge.
 *
 * The orchestrator decides what task kind comes next; this module knows how
 * to encode that as a CoS task (description, priority, metadata) and push it
 * onto the task queue. Mirrors the pattern used by handlePipelineProgression
 * in services/agentLifecycle.js — addTask(..., 'internal', { raw: true })
 * followed by cosEvents.emit('task:ready', task) so subAgentSpawner picks it
 * up.
 *
 * Tasks set `useWorktree: false` because render work is file-based, not
 * git-based — there's nothing for a worktree to isolate.
 */

import { randomUUID } from 'crypto';
import { addTask, cosEvents } from '../cos.js';
import { buildTreatmentPrompt, buildScenePrompt, buildStitchPrompt } from '../../lib/creativeDirectorPrompts.js';
import { nextPendingScene } from './orchestrator.js';
import { recordRun } from './local.js';

function buildTask(project, kind) {
  const taskId = `cd-${project.id}-${kind}-${Date.now().toString(36)}`;
  const runId = randomUUID();
  let context;
  let sceneId = null;
  if (kind === 'treatment') {
    context = buildTreatmentPrompt(project);
  } else if (kind === 'scene') {
    const scene = nextPendingScene(project);
    if (!scene) throw new Error('agentBridge: no pending scene to enqueue');
    sceneId = scene.sceneId;
    context = buildScenePrompt(project, scene);
  } else if (kind === 'stitch') {
    context = buildStitchPrompt(project);
  } else {
    throw new Error(`agentBridge: unknown kind '${kind}'`);
  }

  return {
    id: taskId,
    status: 'pending',
    priority: 'MEDIUM',
    priorityValue: 2,
    description: `Creative Director — ${kind} for "${project.name}"`,
    metadata: {
      creativeDirector: { projectId: project.id, kind, sceneId, runId },
      context,
      useWorktree: false,
      readOnly: false,
    },
    approvalRequired: false,
    autoApproved: true,
    section: 'pending',
  };
}

export async function enqueueCreativeDirectorTask(project, kind) {
  const task = buildTask(project, kind);
  // Record the run as `running` up-front so the Runs tab shows in-flight
  // state immediately. completionHook updates the same runId on finish via
  // updateRun (matched by runId stored in task metadata).
  const meta = task.metadata.creativeDirector;
  await recordRun(project.id, {
    runId: meta.runId,
    taskId: task.id,
    kind: meta.kind,
    sceneId: meta.sceneId || null,
    status: 'running',
  }).catch((err) => console.log(`⚠️ CD recordRun(running) failed: ${err.message}`));
  await addTask(task, 'internal', { raw: true });
  cosEvents.emit('task:ready', task);
  console.log(`📤 CD task enqueued: ${task.id} (${kind} for ${project.id})`);
  return task;
}
