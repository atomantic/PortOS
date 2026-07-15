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
import { addTask, updateTask, cosEvents } from '../cos.js';
import { buildTreatmentPrompt, buildEvaluatePrompt, buildPlanPrompt } from '../../lib/creativeDirectorPrompts.js';
import { getToolSpecs } from '../creative/toolRegistry.js';
import { getSettings } from '../settings.js';
import { resolveStagePin } from './projectsLogic.js';
import { recordRun } from './local.js';

// Treatment and production planning are CoS tasks, so unlike scene evaluation
// they need a CLI/TUI provider with an agent harness. Resolution prefers the
// project's own `modelOverrides.<kind>` pin (per-project CD provider/model
// pins) and falls back to the global `settings.creativeDirector.<kind>` AI
// Assignment — only adding a pin when one is set, preserving the system-default
// behavior for existing installations.
async function getStageAssignment(kind, project) {
  // Scene evaluation is a direct vision API call (apiProviderTypes) resolved
  // separately, NOT a CoS agent pin — injecting its api-type provider into the
  // agent task metadata would trip the harness-boundary guard. Never pin it
  // here. (This also documents that `kind === 'evaluate'` intentionally has no
  // `creativeDirector.evaluate` settings key; the eval pin lives under
  // `creativeDirector.evaluation`.)
  if (kind === 'evaluate') return {};
  const settings = await getSettings().catch(() => ({}));
  const assignment = resolveStagePin(kind, project, settings);
  if (!assignment.providerId && !assignment.model) return {};
  return {
    ...(assignment.providerId ? { provider: assignment.providerId, providerId: assignment.providerId } : {}),
    ...(assignment.model ? { model: assignment.model } : {}),
  };
}

async function buildTaskRecord(project, kind, scene, context) {
  const taskId = `cd-${project.id}-${kind}-${Date.now().toString(36)}`;
  const runId = randomUUID();
  const assignment = await getStageAssignment(kind, project);
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
        ...assignment,
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
  // The [cd:…] suffix makes the first line unique per project: addTask's
  // duplicate scan keys on first-line + metadata.app, and CD tasks carry no
  // app — without a project discriminator, two projects sharing a name would
  // dedup against each other's tasks (#2614).
  const tag = `[cd:${String(project.id).slice(0, 8)}]`;
  if (kind === 'treatment') {
    return `Creative Director — Treatment for "${project.name}" ${tag}`;
  }
  if (kind === 'plan') {
    return `Creative Director — Production Plan for "${project.name}" ${tag}`;
  }
  if (kind === 'evaluate' && scene) {
    const total = project.treatment?.scenes?.length || '?';
    const intent = (scene.intent || '').slice(0, 60);
    return `Creative Director — Evaluate Scene ${scene.order + 1}/${total}: "${intent}" (${project.name}) ${tag}`;
  }
  return `Creative Director — ${kind} for "${project.name}" ${tag}`;
}

async function persistAndEmit({ id, runId, record }, project, kind, sceneId) {
  // Persist FIRST and resolve the effective task before recording the run or
  // emitting `task:ready`. CD descriptions are deterministic per project+kind,
  // so addTask's dedup (which also matches blocked tasks, #2614) can return an
  // existing task instead of persisting this record — emitting `task:ready`
  // for a never-persisted record spawns a ghost agent whose task doesn't
  // exist (every state transition then fails with "Task not found").
  const persisted = await addTask(record, 'internal', { raw: true });
  let effective = record;
  if (persisted?.duplicate) {
    // Belt-and-braces: the [cd:…] description tag should make a cross-project
    // match impossible, but never revive/adopt another project's task — that
    // would rewrite its metadata to target this project.
    if (persisted.metadata?.creativeDirector?.projectId !== project.id) {
      console.log(`⚠️ CD ${kind} enqueue for ${project.id} collided with unrelated task ${persisted.id} — not enqueued`);
      return persisted;
    }
    if (persisted.status === 'blocked') {
      // A CD enqueue is an explicit user re-trigger — revive the blocked
      // duplicate with the fresh payload (updateTask clears the blocked
      // metadata on the status transition) instead of wedging forever.
      await updateTask(persisted.id, {
        status: 'pending',
        priority: record.priority,
        metadata: record.metadata
      }, 'internal');
      effective = { ...record, id: persisted.id };
      console.log(`📤 CD ${kind} task revived blocked duplicate ${persisted.id} on ${project.id}`);
    } else {
      // An identical CD task is already pending/in_progress — it will run and
      // report through its own runId; don't spawn a second agent for it.
      console.log(`⚠️ CD ${kind} task already queued as ${persisted.id} (${persisted.status}) — skipping duplicate enqueue`);
      return persisted;
    }
  }
  // Record the run as `running` so the Runs tab shows in-flight state.
  // completionHook updates the same runId on finish.
  await recordRun(project.id, {
    runId,
    taskId: effective.id,
    kind,
    sceneId: sceneId || null,
    status: 'running',
  }).catch((err) => console.log(`⚠️ CD recordRun(running) failed: ${err.message}`));
  cosEvents.emit('task:ready', effective);
  console.log(`📤 CD task enqueued: ${effective.id} (${kind}${sceneId ? ` for ${sceneId}` : ''} on ${project.id})`);
  return effective;
}

export async function enqueueTreatmentTask(project) {
  const context = await buildTreatmentPrompt(project);
  const built = await buildTaskRecord(project, 'treatment', null, context);
  return persistAndEmit(built, project, 'treatment', null);
}

// CDO Phase 2 (#2184) — the planner. Mirrors enqueueTreatmentTask: an internal
// CoS task whose prompt (cd-plan) receives the directive + the resolved creative
// tool registry specs + the current plan (on a re-plan), and PATCHes a validated
// plan back via /:id/plan. `getToolSpecs()` runs here (services) so lib's prompt
// builder never imports the registry. Malformed plan output retries like the
// treatment stage — the agent reads the 4xx error body and re-PATCHes.
export async function enqueuePlanTask(project) {
  const context = await buildPlanPrompt(project, { toolSpecs: getToolSpecs() });
  const built = await buildTaskRecord(project, 'plan', null, context);
  return persistAndEmit(built, project, 'plan', null);
}

export async function enqueueEvaluateTask(project, scene) {
  if (!scene) throw new Error('enqueueEvaluateTask: scene is required');
  const context = await buildEvaluatePrompt(project, scene);
  const built = await buildTaskRecord(project, 'evaluate', scene, context);
  return persistAndEmit(built, project, 'evaluate', scene.sceneId);
}
