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
import { validateRequest, isPaginationRequested, paginateArray } from '../lib/validation.js';
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
  clipId: z.string().guid(),
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

// Backward-compatible by default: returns the full projects array. When a client
// passes `limit`/`offset`, the response becomes the bounded
// `{ items, total, limit, offset }` envelope every paginated PortOS list shares.
router.get('/projects', asyncHandler(async (req, res) => {
  const projects = await listProjects();
  if (!isPaginationRequested(req.query)) {
    return res.json(projects);
  }
  res.json(paginateArray(projects, req.query, { defaultLimit: 50, maxLimit: 500 }));
}));

router.post('/projects', asyncHandler(async (req, res) => {
  const data = validateRequest(createBodySchema, req.body);
  res.status(201).json(await createProject(data.name));
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
  if (!ok) throw new ServerError('Job not found or expired', { status: 404 });
});

router.post('/:jobId/cancel', (req, res) => {
  const cancelled = cancelRender(req.params.jobId);
  res.json({ ok: cancelled });
});

export default router;
