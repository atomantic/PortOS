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

// Sanitize a job before serialization. The internal job record carries
// worker-only data (the python interpreter path, absolute filesystem paths
// to multipart uploads / source images) that the UI doesn't need and that
// shouldn't ride out over the API. Only surface the user-visible params
// the Render Queue UI actually renders (prompt, owner-supplied settings).
const PARAM_ALLOWLIST = new Set([
  'prompt', 'negativePrompt', 'modelId',
  'width', 'height', 'numFrames', 'fps', 'steps', 'guidanceScale',
  'seed', 'tiling', 'disableAudio', 'mode', 'imageStrength',
  'cfgScale', 'guidance', 'quantize',
]);
function sanitizeJob(job) {
  if (!job) return job;
  const safeParams = job.params
    ? Object.fromEntries(Object.entries(job.params).filter(([k]) => PARAM_ALLOWLIST.has(k)))
    : undefined;
  return {
    id: job.id,
    kind: job.kind,
    owner: job.owner,
    status: job.status,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    position: job.position,
    error: job.error,
    result: job.result,
    params: safeParams,
  };
}

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
  res.json(sorted.map(sanitizeJob));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) throw new ServerError('Not found', { status: 404, code: 'NOT_FOUND' });
  res.json(sanitizeJob(job));
}));

router.post('/:id/cancel', asyncHandler(async (req, res) => {
  const result = await cancelJob(req.params.id);
  if (!result.ok) {
    // Distinguish "no such id" (404) from "exists but already terminal"
    // (409) so consumers can react appropriately — e.g. the UI doesn't
    // need to display "Not found" when the user just clicked Cancel
    // again on a job that already finished.
    const status = result.code === 'ALREADY_TERMINAL' ? 409 : 404;
    throw new ServerError(result.error || 'Cancel failed', { status, code: result.code || 'NOT_FOUND' });
  }
  res.json(result);
}));

export default router;
