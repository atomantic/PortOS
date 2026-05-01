/**
 * Creative Director — CoS agent task bridge.
 *
 * Only spawns agents for the COGNITIVE steps in the pipeline:
 *   - `treatment`: write the story + scene plan (one per project)
 *   - `evaluate` : read a rendered scene's thumbnail and judge it against
 *                  the style spec + scene intent (one per scene render)
 *
 * The mechanical steps (per-scene render orchestration, concat stitch) run
 * server-side via sceneRunner / stitchRunner — they don't need an LLM.
 * That cuts agent runtime from ~3 minutes per scene down to ~30 seconds.
 *
 * Tasks set `useWorktree: false` because render evaluation is file-based,
 * not git-based.
 */

import { randomUUID } from 'crypto';
import { addTask, cosEvents } from '../cos.js';
import { buildTreatmentPrompt, buildEvaluatePrompt } from '../../lib/creativeDirectorPrompts.js';
import { recordRun } from './local.js';

function buildTaskRecord(project, kind, scene, context) {
  const taskId = `cd-${project.id}-${kind}-${Date.now().toString(36)}`;
  const runId = randomUUID();
  return {
    id: taskId,
    runId,
    record: {
      id: taskId,
      status: 'pending',
      priority: 'MEDIUM',
      priorityValue: 2,
      description: buildDescription(project, kind, scene),
      metadata: {
        creativeDirector: {
          projectId: project.id,
          kind,
          sceneId: scene?.sceneId || null,
          runId,
        },
        context,
        useWorktree: false,
        readOnly: false,
      },
      approvalRequired: false,
      autoApproved: true,
      section: 'pending',
    },
  };
}

function buildDescription(project, kind, scene) {
  if (kind === 'treatment') {
    return `Creative Director — Treatment for "${project.name}"`;
  }
  if (kind === 'evaluate' && scene) {
    const total = project.treatment?.scenes?.length || '?';
    const intent = (scene.intent || '').slice(0, 60);
    return `Creative Director — Evaluate Scene ${scene.order + 1}/${total}: "${intent}" (${project.name})`;
  }
  return `Creative Director — ${kind} for "${project.name}"`;
}

async function persistAndEmit({ id, runId, record }, project, kind, sceneId) {
  // Record the run as `running` up-front so the Runs tab shows in-flight
  // state immediately. completionHook updates the same runId on finish.
  await recordRun(project.id, {
    runId,
    taskId: id,
    kind,
    sceneId: sceneId || null,
    status: 'running',
  }).catch((err) => console.log(`⚠️ CD recordRun(running) failed: ${err.message}`));
  await addTask(record, 'internal', { raw: true });
  cosEvents.emit('task:ready', record);
  console.log(`📤 CD task enqueued: ${id} (${kind}${sceneId ? ` for ${sceneId}` : ''} on ${project.id})`);
  return record;
}

export async function enqueueTreatmentTask(project) {
  const context = buildTreatmentPrompt(project);
  const built = buildTaskRecord(project, 'treatment', null, context);
  return persistAndEmit(built, project, 'treatment', null);
}

export async function enqueueEvaluateTask(project, scene) {
  if (!scene) throw new Error('enqueueEvaluateTask: scene is required');
  const context = buildEvaluatePrompt(project, scene);
  const built = buildTaskRecord(project, 'evaluate', scene, context);
  return persistAndEmit(built, project, 'evaluate', scene.sceneId);
}
