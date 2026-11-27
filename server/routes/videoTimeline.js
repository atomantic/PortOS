/**
 * Video Timeline Routes — non-linear editor backend.
 *
 * Project CRUD + render pipeline. Render emits SSE progress on the same
 * pattern as videoGen so the client can reuse EventSource wiring. Output
 * lands in the existing video-history.json with a `timelineProjectId` flag.
 */

import { createBodySchema, updateBodySchema } from '../lib/videoTimelineValidation.js';
import { Router } from 'express';
import { emptyQuerySchema, paginationQuerySchema, isPaginationRequested, paginateArray } from '../lib/queryValidation.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { assertCancelResult } from '../lib/cancelResponse.js';
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  renderProject,
  cancelRender,
  attachSseClient,
} from '../services/videoTimeline/local.js';

const router = Router();

// Backward-compatible by default: returns the full projects array. When a client
// passes `limit`/`offset`, the response becomes the bounded
// `{ items, total, limit, offset }` envelope every paginated PortOS list shares.
router.get('/projects', asyncHandler(async (req, res) => {
  const page = validateRequest(paginationQuerySchema, req.query);
  const projects = await listProjects();
  if (!isPaginationRequested(page)) {
    return res.json(projects);
  }
  res.json(paginateArray(projects, page, { defaultLimit: 50, maxLimit: 500 }));
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

router.post('/:jobId/cancel', (req, res) => {
  validateRequest(emptyQuerySchema, req.query);
  res.json(assertCancelResult(cancelRender(req.params.jobId)));
});

router.get('/:jobId/events', (req, res) => {
  const ok = attachSseClient(req.params.jobId, res);
  if (!ok) throw new ServerError('Job not found or expired', { status: 404 });
});

export default router;
