/**
 * Video Timeline Routes — non-linear editor backend.
 *
 * Project CRUD + render pipeline. Render emits SSE progress on the same
 * pattern as videoGen so the client can reuse EventSource wiring. Output
 * lands in the existing video-history.json with a `timelineProjectId` flag.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  renderProject,
  attachSseClient,
  cancelRender,
} from '../services/videoTimeline/local.js';

const router = Router();

const clipSchema = z.object({
  clipId: z.string().uuid(),
  inSec: z.number().min(0),
  outSec: z.number().min(0),
}).refine((c) => c.outSec > c.inSec, { message: 'outSec must be > inSec', path: ['outSec'] });

const createBodySchema = z.object({
  name: z.string().min(1).max(200),
});

const updateBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  clips: z.array(clipSchema).max(200).optional(),
  expectedUpdatedAt: z.string().optional(),
}).refine((b) => b.name !== undefined || b.clips !== undefined, {
  message: 'PATCH body must include at least name or clips',
});

router.get('/projects', asyncHandler(async (_req, res) => {
  res.json(await listProjects());
}));

router.post('/projects', asyncHandler(async (req, res) => {
  const data = validateRequest(createBodySchema, req.body);
  res.json(await createProject(data.name));
}));

router.get('/projects/:id', asyncHandler(async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  res.json(project);
}));

router.patch('/projects/:id', asyncHandler(async (req, res) => {
  const { expectedUpdatedAt, ...patch } = validateRequest(updateBodySchema, req.body);
  res.json(await updateProject(req.params.id, patch, expectedUpdatedAt));
}));

router.delete('/projects/:id', asyncHandler(async (req, res) => {
  res.json(await deleteProject(req.params.id));
}));

router.post('/projects/:id/render', asyncHandler(async (req, res) => {
  res.json(await renderProject(req.params.id));
}));

router.get('/:jobId/events', (req, res) => {
  const ok = attachSseClient(req.params.jobId, res);
  if (!ok) res.status(404).json({ error: 'Job not found or expired' });
});

router.post('/:jobId/cancel', (req, res) => {
  const cancelled = cancelRender(req.params.jobId);
  res.json({ ok: cancelled });
});

export default router;
