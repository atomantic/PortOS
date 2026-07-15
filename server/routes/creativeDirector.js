/**
 * Creative Director Routes — REST surface for project CRUD + agent bridge.
 *
 * The agent (running as a CoS task) calls into here to: read a project's
 * state, write a treatment, mark a scene accepted/failed, and update the
 * project status. The user's UI calls in to: list/create/delete projects
 * and start/pause/resume the agent pipeline.
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import {
  validateRequest,
  creativeDirectorProjectCreateSchema,
  creativeDirectorProjectUpdateSchema,
  creativeDirectorTreatmentSchema,
  creativeDirectorPlanSchema,
  creativeDirectorPlanStepActionSchema,
  creativeDirectorDirectiveSchema,
  creativeDirectorSceneUpdateSchema,
  creativeDirectorAutoCastSuggestSchema,
  creativeDirectorAutoCastApplySchema,
  isPaginationRequested,
  paginateArray,
} from '../lib/validation.js';
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  setTreatment,
  setPlan,
  updatePlanStep,
  updateScene,
} from '../services/creativeDirector/local.js';
import { suggestCastForBrief, applyAutoCastToProject, toSuggestionView } from '../services/creativeDirector/autoCast.js';
import { enqueueFirstPassPortraits } from '../services/creativeDirector/firstPassGen.js';
import { enqueueFirstPassMusicBed } from '../services/creativeDirector/firstPassMusicGen.js';
import { startCreativeDirectorProject } from '../services/creativeDirector/completionHook.js';
import { createSmokeTestProject } from '../services/creativeDirector/smokeTest.js';

const router = Router();

// Backward-compatible by default: returns the full projects array. When a client
// passes `limit`/`offset`, the response becomes the bounded
// `{ items, total, limit, offset }` envelope every paginated PortOS list shares.
router.get('/', asyncHandler(async (req, res) => {
  const projects = await listProjects();
  if (!isPaginationRequested(req.query)) {
    return res.json(projects);
  }
  res.json(paginateArray(projects, req.query, { defaultLimit: 50, maxLimit: 500 }));
}));

// Creative tool catalog (CDO Phase 4, #2186) — the studio Plan board + directive
// composer hydrate per-step cost-class badges + approval affordances from this
// (mirrors the palette hydrating from the voice-tool registry). Also returns the
// current `creative` autonomy mode (off | dry-run | execute) and the shared cos
// action-budget status so the board can render a dry-run banner and flag steps
// the gate would block (over budget). Registered before `/:id` so the literal
// path can't be shadowed by the param route. Pure read — no LLM, no mutation.
router.get('/tools', asyncHandler(async (_req, res) => {
  // Dynamic-imported (like the /plan advance-loop nudge below) so the heavy tool
  // graph + cos state modules aren't pulled at route module-load — keeps the
  // route unit test fast and free of those services' import-time side effects.
  const [{ getAllCreativeToolMetadata }, { getCreativeAutonomyMode }, { getDomainBudgetStatus }, { loadState }] = await Promise.all([
    import('../services/creative/toolRegistry.js'),
    import('../lib/domainAutonomy.js'),
    import('../services/domainUsage.js'),
    import('../services/cosState.js'),
  ]);
  const state = await loadState().catch(() => ({ config: {} }));
  const mode = getCreativeAutonomyMode(state.config);
  const budget = await getDomainBudgetStatus('cos').catch(() => ({ withinBudget: true, exceeded: null }));
  res.json({
    tools: getAllCreativeToolMetadata(),
    mode,
    budget: { withinBudget: budget.withinBudget, exceeded: budget.exceeded },
  });
}));

// Slim projection of a project for polling consumers (pipeline EpisodeVideoStage
// polls every 4s; the full project carries `runs[]` history and the full
// treatment text the poll doesn't need). The shape covers exactly what the
// polling UI consumes: status, updatedAt (change-detect key), per-scene
// sceneId/order/status, finalVideoId, failureReason. `sceneId` (not `id`) is
// the canonical scene identifier per services/creativeDirector/local.js.
function slimProject(p) {
  return {
    id: p.id,
    status: p.status,
    updatedAt: p.updatedAt,
    finalVideoId: p.finalVideoId || null,
    failureReason: p.failureReason || null,
    treatment: {
      scenes: (p.treatment?.scenes || []).map((s) => ({
        sceneId: s.sceneId,
        order: s.order,
        status: s.status,
      })),
    },
  };
}

router.get('/:id', asyncHandler(async (req, res) => {
  const p = await getProject(req.params.id);
  if (!p) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  res.json(req.query.slim === '1' ? slimProject(p) : p);
}));

router.post('/', asyncHandler(async (req, res) => {
  const data = validateRequest(creativeDirectorProjectCreateSchema, req.body);
  const project = await createProject(data);
  res.status(201).json(project);
}));

// Autonomous auto-cast (#1810) — preview only: given a free-text brief, return the
// catalog ingredients the director would propose (hybrid FTS + pgvector search),
// without mutating anything. Registered before `/:id/auto-cast` so the literal
// path can't be shadowed by the param route.
router.post('/auto-cast/suggest', asyncHandler(async (req, res) => {
  const { brief, types, limit } = validateRequest(creativeDirectorAutoCastSuggestSchema, req.body);
  const hits = await suggestCastForBrief({ brief, types, limit });
  res.json({ suggestions: hits.map(toSuggestionView).filter(Boolean) });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(creativeDirectorProjectUpdateSchema, req.body);
  const updated = await updateProject(req.params.id, data);
  res.json(updated);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  await deleteProject(req.params.id);
  res.json({ ok: true });
}));

// Autonomous auto-cast (#1810) — apply to a project: derive a brief from the
// project (or accept an explicit one), search the catalog, APPEND the fresh
// candidates to the project cast, and link them as creative-director refs.
// Returns the updated project plus what was added/considered.
//
// Auto-compose (#1817): with `compose: true`, once the cast is seeded the
// director autonomously writes a treatment + scene plan grounded in that cast.
// We only kick off when the project ends up with a non-empty cast and has no
// treatment yet — never clobber an existing treatment or trip the render/stitch
// path. Fire-and-forget like /start; the UI's polling reflects the agent run +
// treatment as they land. The response carries `composing` so the UI can tell
// the user the director took over.
router.post('/:id/auto-cast', asyncHandler(async (req, res) => {
  const { brief, types, limit, compose, generateFirstPass, generateFirstPassMusicBed } = validateRequest(creativeDirectorAutoCastApplySchema, req.body);
  // Scene reference frames (#1867) depend on a treatment existing, which may
  // land well after THIS request — either because `compose` kicks it off
  // asynchronously below, or because the user opted into `generateFirstPass`
  // without `compose` and only starts the project later via a separate
  // `/:id/start` call (the OverviewTab toggles are independent, per its own
  // "Independent of the treatment toggle" copy). Persist the user's opt-in on
  // the project record — NOT gated on `composing` — so the `/:id/treatment`
  // handler (the only place the agent's scene plan actually lands) can find it
  // regardless of which path triggered composition. Folded into the auto-cast
  // write itself (#1938) so this is one read-modify-write, not two; because it
  // resolves before the compose kickoff below, there's no ordering ambiguity
  // between this write and a same-request compose's first read.
  const result = await applyAutoCastToProject(req.params.id, { brief, types, limit, generateFirstPass });
  const project = result.project;
  const cast = project?.cast;
  // `advanceAfterSceneSettled` (what startCreativeDirectorProject calls) bails
  // immediately for paused/failed projects, so kicking off there would no-op
  // while we falsely report `composing` to the UI. Auto-compose deliberately
  // does NOT do /start's failed-scene recovery — it's only the first-pass
  // treatment path — so we simply skip those statuses.
  const composable = project && project.status !== 'paused' && project.status !== 'failed';
  const composing = Boolean(compose) && composable && Array.isArray(cast) && cast.length > 0 && !project.treatment;
  if (composing) {
    startCreativeDirectorProject(req.params.id).catch((e) => console.log(`⚠️ CD auto-compose failed: ${e.message}`));
  }
  // First-pass gen (#1818): when opted in, kick off a catalog portrait render
  // for each member auto-cast just added that has no portrait yet. The renders
  // are enqueued onto the media-job queue and land via the durable catalog
  // attach hook (#1359). We await the enqueue (which resolves each member's
  // render decision concurrently, then queues synchronously) so the response can
  // report how many were queued; the renders themselves run in the background.
  let firstPass = null;
  if (generateFirstPass && Array.isArray(result.added) && result.added.length > 0) {
    firstPass = await enqueueFirstPassPortraits(result.added)
      .catch((e) => {
        console.log(`⚠️ CD first-pass portraits failed: ${e.message}`);
        return null;
      });
  }
  // First-pass music bed (#1928, split from #1867): optional sibling step —
  // enqueue one background audio render for the project itself (not a catalog
  // ingredient, see firstPassMusicGen.js doc comment). Gated only on the
  // project existing (unlike portraits, it doesn't depend on auto-cast having
  // added new members — a re-running director may want a bed even when the
  // cast was already seeded).
  let firstPassMusicBed = null;
  if (generateFirstPassMusicBed && project) {
    firstPassMusicBed = await enqueueFirstPassMusicBed(project)
      .catch((e) => {
        console.log(`⚠️ CD first-pass music bed failed: ${e.message}`);
        return null;
      });
  }
  res.json({
    ...result,
    composing,
    ...(firstPass ? { firstPass } : {}),
    ...(firstPassMusicBed ? { firstPassMusicBed } : {}),
  });
}));

// Agent-callable: write the treatment doc.
router.patch('/:id/treatment', asyncHandler(async (req, res) => {
  const treatment = validateRequest(creativeDirectorTreatmentSchema, req.body);
  // Scene reference frames (#1867): seeding a first reference frame per scene
  // when the project opted into first-pass gen now fires from `setTreatment`
  // itself (#1938) — the domain write — so every treatment path honors the
  // opt-in, not just this route.
  const updated = await setTreatment(req.params.id, treatment);
  res.json(updated);
}));

// Agent-callable (CDO Phase 2, #2184): write the production plan. The planner
// agent (cd-plan) PATCHes a validated step list here; the server then executes
// it step-by-step through the gated tool registry. Idempotent re-PATCH (a
// re-plan) preserves already-completed steps by stepId (see applyPlan). Nudges
// the plan advance loop so execution begins on the returned plan.
router.patch('/:id/plan', asyncHandler(async (req, res) => {
  const plan = validateRequest(creativeDirectorPlanSchema, req.body);
  const updated = await setPlan(req.params.id, plan);
  const { advanceAfterPlanStepSettled } = await import('../services/creativeDirector/planAdvance.js');
  advanceAfterPlanStepSettled(req.params.id)
    .catch((e) => console.log(`⚠️ CD plan advance failed: ${e.message}`));
  res.json(updated);
}));

// User-callable (CDO Phase 4, #2186): attach a directive to an EXISTING project
// ("convert to directive") or replace one. Validates the directive, clears any
// prior plan so the planner re-derives one from the new brief, flips the project
// to `planning`, and nudges the generalized advance loop — which enqueues the
// planner agent (the project now has a directive but no plan). A paused/failed
// project is left parked (the user re-runs it explicitly). Reactive: returns the
// updated project so the UI swaps state without a refetch.
router.post('/:id/directive', asyncHandler(async (req, res) => {
  const directive = validateRequest(creativeDirectorDirectiveSchema, req.body);
  const project = await getProject(req.params.id);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const parked = project.status === 'paused' || project.status === 'failed';
  const updated = await updateProject(req.params.id, {
    directive,
    plan: null,
    ...(parked ? {} : { status: 'planning', failureReason: null }),
  });
  if (!parked) {
    const { advanceAfterPlanStepSettled } = await import('../services/creativeDirector/planAdvance.js');
    advanceAfterPlanStepSettled(req.params.id)
      .catch((e) => console.log(`⚠️ CD directive advance failed: ${e.message}`));
  }
  res.json(updated);
}));

// User-callable (CDO Phase 4, #2186): request a fresh plan. Drops the current
// plan (preserving the directive) and re-runs the planner via the advance loop.
// Blocked-step triage "re-plan" action. No-op on a project without a directive.
router.post('/:id/replan', asyncHandler(async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  if (!project.directive) throw new ServerError('Project has no directive to re-plan', { status: 400, code: 'NO_DIRECTIVE' });
  const updated = await updateProject(req.params.id, { plan: null, status: 'planning', failureReason: null });
  const { advanceAfterPlanStepSettled } = await import('../services/creativeDirector/planAdvance.js');
  advanceAfterPlanStepSettled(req.params.id)
    .catch((e) => console.log(`⚠️ CD replan advance failed: ${e.message}`));
  res.json(updated);
}));

// User-callable (CDO Phase 4, #2186): blocked-step triage. `skip` marks a step
// `skipped` (terminal-success — unblocks dependents); `retry` resets a
// blocked/failed step to `pending` (clearing its result + retryCount) so the
// advance loop re-dispatches it — also the "approve" affordance for a gate-blocked
// step. Either way we clear a plan-level pause (paused → rendering) and nudge the
// advance loop. Returns the updated project for reactive state swap; 404 when the
// step is unknown (updatePlanStep returns the project unchanged).
router.post('/:id/plan/step/:stepId', asyncHandler(async (req, res) => {
  const { action } = validateRequest(creativeDirectorPlanStepActionSchema, req.body);
  const project = await getProject(req.params.id);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const step = (project.plan?.steps || []).find((s) => s.stepId === req.params.stepId);
  if (!step) throw new ServerError('Plan step not found', { status: 404, code: 'NOT_FOUND' });
  const patch = action === 'skip'
    ? { status: 'skipped', result: { skippedByUser: true } }
    : { status: 'pending', retryCount: 0, result: null };
  await updatePlanStep(req.params.id, req.params.stepId, patch);
  // Clear a plan-level pause so the advance loop isn't short-circuited by the
  // paused guard; a still-blocked project stays parked otherwise.
  if (project.status === 'paused') {
    await updateProject(req.params.id, { status: 'rendering', failureReason: null });
  }
  const { advanceAfterPlanStepSettled } = await import('../services/creativeDirector/planAdvance.js');
  advanceAfterPlanStepSettled(req.params.id)
    .catch((e) => console.log(`⚠️ CD plan step ${action} advance failed: ${e.message}`));
  res.json(await getProject(req.params.id));
}));

// Agent-callable: update a single scene's status / evaluation / retry count.
router.patch('/:id/scene/:sceneId', asyncHandler(async (req, res) => {
  const data = validateRequest(creativeDirectorSceneUpdateSchema, req.body);
  const updated = await updateScene(req.params.id, req.params.sceneId, data);
  if (data.status === 'accepted' || data.status === 'failed') {
    // Fire-and-forget — agent or user just settled a scene; nudge the
    // orchestrator so the next scene (or stitch) starts.
    const { advanceAfterSceneSettled } = await import('../services/creativeDirector/completionHook.js');
    advanceAfterSceneSettled(req.params.id).catch((e) => console.log(`⚠️ CD scene advance failed: ${e.message}`));
  }
  res.json(updated);
}));

// User-callable: kick off (or resume) the agent pipeline. Server inspects
// project state, decides what kind of task is next, and enqueues it via the
// CoS task queue. Idempotent — calling start on an already-running project
// just enqueues whatever the next-task-kind is, which may be nothing.
//
// Failed projects are recoverable: any failed scenes are reset to pending so
// the orchestrator can retry them, and the project status flips back to
// planning/rendering. This matches the PR's "you can resume from the UI"
// promise — without it, a single failed scene would leave Start a no-op.
router.post('/:id/start', asyncHandler(async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  if (project.status === 'failed') {
    // Reset every failed scene back to pending so the orchestrator picks
    // them up. Without this, a single failed scene would leave Start a no-op.
    const scenes = project.treatment?.scenes || [];
    for (const s of scenes) {
      if (s.status === 'failed') {
        await updateScene(project.id, s.sceneId, { status: 'pending', retryCount: 0 });
      }
    }
    // Clear the prior failure banner — restart implies the user has
    // accepted the previous failure and wants a fresh attempt.
    await updateProject(project.id, { status: project.treatment ? 'rendering' : 'planning', failureReason: null });
  } else if (project.status === 'paused') {
    await updateProject(project.id, { status: project.treatment ? 'rendering' : 'planning' });
  } else if (project.status === 'draft') {
    await updateProject(project.id, { status: 'planning' });
  }
  // Fire-and-forget — the orchestrator runs server-side and may spawn an
  // agent (treatment / evaluate) or kick off a render directly. The route
  // returns immediately; the UI's polling reflects state changes.
  startCreativeDirectorProject(project.id).catch((e) => console.log(`⚠️ CD start failed: ${e.message}`));
  res.json({ ok: true });
}));

// User-callable: pause. Stops the server from auto-enqueueing follow-up
// work. The currently running render (if any) keeps going to completion —
// canceling that is a separate gesture (POST /api/media-jobs/:id/cancel).
router.post('/:id/pause', asyncHandler(async (req, res) => {
  const updated = await updateProject(req.params.id, { status: 'paused' });
  res.json(updated);
}));

// Dev/test fixture: create a deterministic 3-scene "colored ball" project
// (autoAcceptScenes + disableAudio) and immediately kick it off. Used as
// the fast E2E health check after pipeline changes — completes in render
// time only, no Claude in the loop.
router.post('/smoke-test', asyncHandler(async (_req, res) => {
  const project = await createSmokeTestProject();
  startCreativeDirectorProject(project.id).catch((e) => console.log(`⚠️ CD smoke start failed: ${e.message}`));
  res.status(201).json(project);
}));

router.post('/:id/resume', asyncHandler(async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  if (project.status !== 'paused') {
    throw new ServerError('Project is not paused', { status: 400, code: 'INVALID_STATE' });
  }
  const restored = project.treatment ? 'rendering' : 'planning';
  await updateProject(project.id, { status: restored });
  startCreativeDirectorProject(project.id).catch((e) => console.log(`⚠️ CD resume failed: ${e.message}`));
  res.json({ ok: true });
}));

export default router;
