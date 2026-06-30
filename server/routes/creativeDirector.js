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
  creativeDirectorSceneUpdateSchema,
  creativeDirectorAutoCastSuggestSchema,
  creativeDirectorAutoCastApplySchema,
} from '../lib/validation.js';
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  setTreatment,
  updateScene,
} from '../services/creativeDirector/local.js';
import { suggestCastForBrief, applyAutoCastToProject, toSuggestionView } from '../services/creativeDirector/autoCast.js';
import { enqueueFirstPassPortraits, enqueueFirstPassSceneFrames } from '../services/creativeDirector/firstPassGen.js';
import { enqueueFirstPassMusicBed } from '../services/creativeDirector/firstPassMusicGen.js';
import { startCreativeDirectorProject } from '../services/creativeDirector/completionHook.js';
import { createSmokeTestProject } from '../services/creativeDirector/smokeTest.js';

const router = Router();

router.get('/', asyncHandler(async (_req, res) => {
  res.json(await listProjects());
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
  const result = await applyAutoCastToProject(req.params.id, { brief, types, limit });
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
    // Scene reference frames (#1867) depend on a treatment existing, which
    // auto-compose only writes asynchronously above. Persist the user's
    // opt-in on the project record so the `/:id/treatment` handler (where the
    // agent's scene plan actually lands) knows to also seed first-pass frames
    // — there is no other durable hand-off point between this request and
    // that later write.
    if (generateFirstPass) {
      updateProject(req.params.id, { generateFirstPass: true })
        .catch((e) => console.log(`⚠️ CD persist generateFirstPass flag failed: ${e.message}`));
    }
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
  const updated = await setTreatment(req.params.id, treatment);
  // Scene reference frames (#1867): the user opted into first-pass gen back
  // at auto-cast time (persisted as `generateFirstPass` on the project since
  // the treatment lands asynchronously, possibly much later). Now that a
  // scene plan exists, seed a first reference frame per scene the same way
  // first-pass portraits are seeded — fire-and-forget like auto-compose
  // above; the response shouldn't block on render-queue work.
  if (updated?.generateFirstPass) {
    enqueueFirstPassSceneFrames(updated)
      .catch((e) => console.log(`⚠️ CD first-pass scene frames failed: ${e.message}`));
  }
  res.json(updated);
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
