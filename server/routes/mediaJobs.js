/**
 * Media Job Queue Routes — read + cancel access to the unified image/video
 * render queue. The actual enqueueing happens in /api/video-gen and
 * /api/image-gen routes; this surface lets the UI show what's pending and
 * cancel something without going through provider-specific endpoints.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { listJobs, getJob, cancelJob, JOB_KINDS, JOB_STATUSES } from '../services/mediaJobQueue/index.js';

const router = Router();

const listQuerySchema = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  kind: z.enum(JOB_KINDS).optional(),
  owner: z.string().max(256).optional(),
});

router.get('/', asyncHandler(async (req, res) => {
  const filters = validateRequest(listQuerySchema, req.query);
  // Most-recent activity first across all statuses. Live (queued/running)
  // jobs land at the top by virtue of having the freshest `startedAt` /
  // `queuedAt`. The fallback chain is `startedAt → completedAt → queuedAt`
  // so terminal jobs that never started (queued→canceled, or failed by
  // boot recovery) sort by their cancel/finish time, not the original
  // enqueue time.
  const sorted = [...listJobs(filters)].sort((a, b) => {
    const ta = new Date(a.startedAt || a.completedAt || a.queuedAt || 0).getTime();
    const tb = new Date(b.startedAt || b.completedAt || b.queuedAt || 0).getTime();
    return tb - ta;
  });
  res.json(sorted);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) throw new ServerError('Not found', { status: 404, code: 'NOT_FOUND' });
  res.json(job);
}));

router.post('/:id/cancel', asyncHandler(async (req, res) => {
  const result = await cancelJob(req.params.id);
  if (!result.ok) throw new ServerError(result.error || 'Not found', { status: 404, code: 'NOT_FOUND' });
  res.json(result);
}));

export default router;
