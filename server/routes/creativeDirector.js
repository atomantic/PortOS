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
import { startCreativeDirectorProject } from '../services/creativeDirector/completionHook.js';

const router = Router();

router.get('/', asyncHandler(async (_req, res) => {
  res.json(await listProjects());
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const p = await getProject(req.params.id);
  if (!p) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  res.json(p);
}));

router.post('/', asyncHandler(async (req, res) => {
  const data = validateRequest(creativeDirectorProjectCreateSchema, req.body);
  const project = await createProject(data);
  res.status(201).json(project);
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

// Agent-callable: write the treatment doc.
router.patch('/:id/treatment', asyncHandler(async (req, res) => {
  const treatment = validateRequest(creativeDirectorTreatmentSchema, req.body);
  const updated = await setTreatment(req.params.id, treatment);
  res.json(updated);
}));

// Agent-callable: update a single scene's status / evaluation / retry count.
router.patch('/:id/scene/:sceneId', asyncHandler(async (req, res) => {
  const data = validateRequest(creativeDirectorSceneUpdateSchema, req.body);
  const updated = await updateScene(req.params.id, req.params.sceneId, data);
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
    await updateProject(project.id, { status: project.treatment ? 'rendering' : 'planning' });
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
