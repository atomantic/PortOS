/**
 * Media Job Queue Routes — read + cancel access to the unified image/video
 * render queue. The actual enqueueing happens in /api/video-gen and
 * /api/image-gen routes; this surface lets the UI show what's pending and
 * cancel something without going through provider-specific endpoints.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { listJobs, getJob, cancelJob } from '../services/mediaJobQueue/index.js';

const router = Router();

const listQuerySchema = z.object({
  status: z.enum(['queued', 'running', 'completed', 'failed', 'canceled']).optional(),
  kind: z.enum(['video', 'image']).optional(),
  owner: z.string().max(256).optional(),
});

router.get('/', asyncHandler(async (req, res) => {
  const filters = validateRequest(listQuerySchema, req.query);
  // Most-recent first across all statuses. Live (queued/running) jobs land
  // at the top by virtue of having the freshest `queuedAt`/`startedAt`.
  const sorted = [...listJobs(filters)].sort((a, b) => {
    const ta = new Date(a.queuedAt || a.startedAt || a.completedAt || 0).getTime();
    const tb = new Date(b.queuedAt || b.startedAt || b.completedAt || 0).getTime();
    return tb - ta;
  });
  res.json(sorted);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json(job);
}));

router.post('/:id/cancel', asyncHandler(async (req, res) => {
  const result = await cancelJob(req.params.id);
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
}));

export default router;
