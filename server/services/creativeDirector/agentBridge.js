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
import { fileURLToPath } from 'node:url';
import { addTask, reviveBlockedTask, cosEvents } from '../cos.js';
import { buildTreatmentPrompt, buildEvaluatePrompt, buildPlanPrompt } from '../creativeDirectorPrompts.js';
import { getToolSpecs } from '../creative/toolRegistry.js';
import { getSettings } from '../settings.js';
import { resolveStagePin } from './projectsLogic.js';
import { llmRoutePinNamesProvider, pickLlmRoutePinLayer } from '../../lib/llmRoutePin.js';
import { recordRun } from './local.js';
import { DELIVERABLE_KINDS, deliverableMark } from './deliverableGate.js';

// Treatment and production planning are CoS tasks, so unlike scene evaluation
// they need a CLI/TUI provider with an agent harness. Resolution order:
//
//   1. The project's OWN `modelOverrides.<kind>` pin — a deliberate per-project
//      choice the user made in the CD models drawer. Most specific, so it wins.
//   2. The OWNING CREATIVE COMMISSION's current pin, read live. A commission is a
//      standing job definition and its project is one execution of it, so an edit
//      to the commission has to reach the executions still running. Snapshotting
//      the pin onto the project at fire time (what this used to do) froze it: the
//      user could switch the commission to a different provider and watch the
//      wedged project keep handing its planner task to the old one forever — AND
//      it occupied tier 1, so a later drawer edit could never be distinguished
//      from the machine-written snapshot. The fire no longer writes that snapshot
//      (and the boot backfill clears the ones it already wrote), so a value in
//      tier 1 now means "the user chose this", nothing else.
//   3. The global `settings.creativeDirector.<kind>` AI Assignment.
//
// Only adds a pin when one is set, preserving the system-default behavior for
// existing installations. A commission lookup failure falls through rather than
// stalling the dispatch.
export async function getStageAssignment(kind, project) {
  if (project.workspace === 'video' && project.videoExecution?.choices) {
    const choice = project.videoExecution.choices[kind === 'evaluate' ? 'evaluation' : kind];
    return { provider: choice.providerId, providerId: choice.providerId, model: choice.model, ...(choice.effort ? { effort: choice.effort } : {}) };
  }
  // Scene evaluation is a direct vision API call (apiProviderTypes) resolved
  // separately, NOT a CoS agent pin — injecting its api-type provider into the
  // agent task metadata would trip the harness-boundary guard. Never pin it
  // here. (This also documents that `kind === 'evaluate'` intentionally has no
  // `creativeDirector.evaluate` settings key; the eval pin lives under
  // `creativeDirector.evaluation`.)
  if (kind === 'evaluate') return {};
  // Only consult the commission when the project does NOT carry its own pin for
  // this stage — a drawer choice is the user's explicit override and must win.
  // Shares `llmRoutePinNamesProvider` with `resolveStagePin`'s own layer test, so
  // "what counts as a pin" can't drift between the skip check and the resolve.
  const projectPinsStage = llmRoutePinNamesProvider(project?.modelOverrides?.[kind]);
  const [settings, commissionPin] = await Promise.all([
    getSettings().catch(() => ({})),
    // Lazy + only for a commission-owned project, so the CD graph doesn't take a
    // static dependency on the commission store for the common bare project.
    (!projectPinsStage && project?.commissionId)
      ? import('../creativeCommissions/projectControl.js')
        .then(({ commissionStagePin }) => commissionStagePin(project.commissionId))
        .catch(() => null)
      : null,
  ]);
  // The commission is the outermost layer of the same whole-layer ladder
  // `resolveStagePin` resolves (commission → project override → global
  // assignment); `commissionStagePin` returns null unless it names a usable
  // provider, so it only ever wins by naming one.
  const assignment = pickLlmRoutePinLayer(commissionPin, resolveStagePin(kind, project, settings));
  if (!assignment.providerId && !assignment.model) return {};
  return {
    ...(assignment.providerId ? { provider: assignment.providerId, providerId: assignment.providerId } : {}),
    ...(assignment.model ? { model: assignment.model } : {}),
    ...(assignment.effort ? { effort: assignment.effort } : {}),
  };
}

async function buildTaskRecord(project, kind, scene, context) {
  const taskId = `cd-${project.id}-${kind}-${Date.now().toString(36)}`;
  const runId = randomUUID();
  const assignment = await getStageAssignment(kind, project);
  let attempt;
  if (project.workspace === 'video') {
    const { reserveVideoAttempt, assertVideoAttemptDispatch } = await import('./videoExecution.js');
    const audio = project.videoExecution?.choices?.audio || project.videoDraft?.audio || { mode: 'native' };
    context = `${context}\n\nSaved Video audio contract: ${JSON.stringify(audio)}. Native means the audio generated inside each video clip; there is NO separate dialogue, narration, voice casting, or lip-sync pass. Imported/generated means one assembled soundtrack replacing clip audio, not per-character speech synthesis. Silent means no final audio. Never promise an unconfigured later soundtrack or dialogue pass. Each render prompt stands alone: repeat applicable project-wide audio rules there, including any no-music or no-speech rule, rather than leaving them only in script notes. Put every intended audible event in its shot prompt when using native audio, and keep any spoken line short enough for that shot. Speech must finish at least one second before the saved shot duration: put a speaking-time window and quiet closing hold in the prompt, prefer 6-9 words for a six-second shot, and allow fewer words for a slow voice or preceding action. Assembly trims any extra frames returned by the renderer, so never rely on that extra time to finish a sentence. Plan visual storytelling to fit this audio choice. Repeat stable character appearance, wardrobe, and voice descriptions whenever they recur; names alone are not conditioning. Reference images must be existing supplied files, never invented filenames. Shot joins: ${project.videoDraft?.transition || 'cut'}; joins do not overlap or shorten the saved shot timing. Derive act timestamps from the actual summed shot durations. Latest revision requests: ${JSON.stringify(project.videoReview?.revisionRequests || [])}.`;
    attempt = await reserveVideoAttempt(project.id, { kind, expectedProductionRevision: project.videoWorkRevision || 0, key: `${kind}:${scene?.sceneId || 'project'}`, ...(scene ? { sceneId: scene.sceneId, workRevision: scene.workRevision || 0 } : {}) });
    if (!attempt) return null;
    await assertVideoAttemptDispatch(project.id, attempt.id).catch(async error => {
      const { settleVideoAttempt } = await import('./videoExecution.js');
      await settleVideoAttempt(project.id, attempt.id, { status: 'failed' });
      throw error;
    });
    if (kind === 'treatment' || kind === 'plan') {
      const submitScript = fileURLToPath(new URL('../../../scripts/submit-video-artifact.js', import.meta.url));
      context += `\n\nLOCAL VIDEO OUTPUT HANDOFF (replaces the HTTP submission instructions above): Write the specified ${kind} JSON body to a file in your scratch workspace, then run node with these literal arguments: ${JSON.stringify([submitScript, project.id, attempt.id, kind, '<your-json-file>'])}. Use proper shell quoting for each argument. The helper validates the current authorized attempt, production revision, source revision, and artifact schema before persisting. A saved:true result completes the task. No HTTP calls or credentials are needed. Do not search for passwords, tokens, cookies, or sessions. Do not modify application code or project data directly. On a validation error fix the JSON and retry; on a retired attempt stop. All story context is supplied in this prompt.`;
    }
  }
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
        ...(project.workspace === 'video' ? { machineLocal: true, videoProduction: { projectId: project.id, attemptId: attempt.id, kind } } : {}),
        creativeDirector: {
          projectId: project.id,
          ...(project.workspace === 'video' ? { productionRevision: project.videoWorkRevision || 0 } : {}),
          kind,
          sceneId: scene?.sceneId || null,
          runId,
        },
        context,
        ...assignment,
        useWorktree: false,
        readOnly: false,
        // A CD agent's deliverable is the HTTP PATCH its prompt describes (write
        // the plan / update the scene), not a code change — so it must NOT be told
        // to run /do:push/open a PR at the end (there is nothing to push, and it
        // just loads that skill for no reason). Routes the prompt builder to the
        // no-code completion section (agentPromptBuilder#buildActionOutputCompletionSection).
        noCodeOutput: true,
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
  // dedup against each other's tasks (#2614). Full id, not a prefix — CD ids
  // are `cd-<uuid>`, so a short slice keeps too little entropy.
  const tag = `[cd:${project.id}]`;
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

async function persistAndEmit(built, project, kind, sceneId) {
  const marker = built.record.metadata.videoProduction;
  try {
    const result = await persistAndEmitTask(built, project, kind, sceneId);
    if (marker && result?.metadata?.videoProduction?.attemptId !== marker.attemptId) {
      const { settleVideoAttempt } = await import('./videoExecution.js');
      await settleVideoAttempt(project.id, marker.attemptId, { status: 'failed', duplicateTaskId: result?.id });
    }
    return result;
  } catch (error) {
    if (marker) {
      const { settleVideoAttempt, pauseVideoExecution } = await import('./videoExecution.js');
      await settleVideoAttempt(project.id, marker.attemptId, { status: 'failed' });
      await pauseVideoExecution(project.id, `Agent enqueue stopped: ${error.message}. Review and Resume.`);
    }
    throw error;
  }
}

async function persistAndEmitTask({ id, runId, record }, project, kind, sceneId) {
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
      // duplicate with the fresh payload (reviveBlockedTask clears the
      // blocked metadata and retry budgets) instead of wedging forever.
      await reviveBlockedTask(persisted.id, {
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
  //
  // `deliverableMark` is the BASELINE fingerprint of what this stage is supposed
  // to write (#4146). completionHook compares the project's mark against it when
  // the run settles, so an agent that exits 0 having PATCHed nothing is recorded
  // as the failure it is instead of a success the re-dispatch guard skips over.
  // Only stamped for kinds with a verifiable PATCH deliverable — the key is
  // ABSENT (not null) for the rest, which is exactly how `deliverableLanded`
  // recognizes "no baseline recorded" and declines to manufacture a failure.
  await recordRun(project.id, {
    runId,
    taskId: effective.id,
    kind,
    sceneId: sceneId || null,
    status: 'running',
    ...(DELIVERABLE_KINDS.has(kind) ? { deliverableMark: deliverableMark(project, kind) } : {}),
  }).catch((err) => console.log(`⚠️ CD recordRun(running) failed: ${err.message}`));
  if (project.workspace === 'video') {
    const { settleVideoAttempt } = await import('./videoExecution.js');
    await settleVideoAttempt(project.id, record.metadata.videoProduction.attemptId, { status: 'running', taskId: effective.id });
  }
  cosEvents.emit('task:ready', effective);
  console.log(`📤 CD task enqueued: ${effective.id} (${kind}${sceneId ? ` for ${sceneId}` : ''} on ${project.id})`);
  return effective;
}

export async function enqueueTreatmentTask(project) {
  const { prepareVideoPlanningProject } = await import('./videoSources.js');
  project = await prepareVideoPlanningProject(project);
  if (project.workspace === 'video') {
    const { effectiveVideoProject } = await import('./videoExecution.js');
    project = effectiveVideoProject(project);
  }
  const context = await buildTreatmentPrompt(project);
  const built = await buildTaskRecord(project, 'treatment', null, context);
  return built ? persistAndEmit(built, project, 'treatment', null) : null;
}

// CDO Phase 2 (#2184) — the planner. Mirrors enqueueTreatmentTask: an internal
// CoS task whose prompt (cd-plan) receives the directive + the resolved creative
// tool registry specs + the current plan (on a re-plan), and PATCHes a validated
// plan back via /:id/plan. `getToolSpecs()` runs here (services) so lib's prompt
// builder never imports the registry. Malformed plan output retries like the
// treatment stage — the agent reads the 4xx error body and re-PATCHes.
export async function enqueuePlanTask(project) {
  const { prepareVideoPlanningProject } = await import('./videoSources.js');
  project = await prepareVideoPlanningProject(project);
  if (project.workspace === 'video') {
    const { effectiveVideoProject } = await import('./videoExecution.js');
    project = effectiveVideoProject(project);
  }
  const targetAbility = project?.directive?.constraints?.targetAbility || null;
  const context = await buildPlanPrompt(project, { toolSpecs: getToolSpecs({ targetAbility }).filter(tool => project.workspace !== 'video' || tool.function?.name === 'media_enqueueVideoJob').map(tool => project.workspace === 'video' ? { ...tool, function: { ...tool.function, description: `${tool.function.description} Each step renders exactly one clip; set params.durationSeconds between 1 and 10. Match the saved timed shot plan. Do not batch or chain clips.` } } : tool) });
  const built = await buildTaskRecord(project, 'plan', null, context);
  return built ? persistAndEmit(built, project, 'plan', null) : null;
}

export async function enqueueEvaluateTask(project, scene) {
  if (!scene) throw new Error('enqueueEvaluateTask: scene is required');
  const context = await buildEvaluatePrompt(project, scene);
  const built = await buildTaskRecord(project, 'evaluate', scene, context);
  return built ? persistAndEmit(built, project, 'evaluate', scene.sceneId) : null;
}
