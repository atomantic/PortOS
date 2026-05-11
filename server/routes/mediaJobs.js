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
import { listJobs, getJob, cancelJob, cancelQueuedJobs, JOB_KINDS, JOB_STATUSES } from '../services/mediaJobQueue/index.js';
import { refineMediaPrompt } from '../services/mediaPromptRefiner.js';

const router = Router();

const listQuerySchema = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  kind: z.enum(JOB_KINDS).optional(),
  owner: z.string().max(256).optional(),
});

// renderConfig is inlined into the LLM prompt via JSON.stringify, so an
// unbounded object would inflate token cost / latency. Cap the serialized
// payload at 4 KB — that's well above any legitimate render-config (which
// is typically <500 bytes) but stops a malicious or buggy caller from
// shipping arbitrarily nested objects through the refiner.
const RENDER_CONFIG_MAX_BYTES = 4096;
const refinePromptSchema = z.object({
  kind: z.enum(JOB_KINDS),
  prompt: z.string().min(1).max(8000),
  negativePrompt: z.string().max(8000).optional(),
  feedback: z.string().min(1).max(3000),
  providerId: z.string().min(1).max(128),
  model: z.string().max(256).optional(),
  renderConfig: z.record(z.any())
    .refine((obj) => Buffer.byteLength(JSON.stringify(obj), 'utf8') <= RENDER_CONFIG_MAX_BYTES, {
      message: `renderConfig serialized size must be ≤ ${RENDER_CONFIG_MAX_BYTES} bytes`,
    })
    .optional(),
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
  // Live jobs preserve `listJobs` order — [running, codexRunning, ...queue] —
  // so the UI reads top-to-bottom as "currently rendering, then next in line"
  // (FIFO). A single timestamp DESC sort puts later-queued jobs ahead of an
  // earlier-started running job and confuses the user.
  // Terminal jobs sort by most-recent finish so the "recent" reel surfaces
  // newest-first; the fallback chain handles canceled-while-queued jobs.
  const jobs = listJobs(filters);
  const live = jobs.filter((j) => j.status === 'queued' || j.status === 'running');
  const terminal = jobs.filter((j) => j.status !== 'queued' && j.status !== 'running');
  terminal.sort((a, b) => {
    const ta = new Date(a.completedAt || a.startedAt || a.queuedAt || 0).getTime();
    const tb = new Date(b.completedAt || b.startedAt || b.queuedAt || 0).getTime();
    return tb - ta;
  });
  res.json([...live, ...terminal].map(sanitizeJob));
}));

router.post('/refine-prompt', asyncHandler(async (req, res) => {
  const data = validateRequest(refinePromptSchema, req.body);
  res.json(await refineMediaPrompt(data));
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

// Bulk-cancel every queued job (running jobs are left alone — they need a
// per-id POST to trigger the SIGTERM path). Optional ?kind=image|video filter.
const cancelQueuedSchema = z.object({ kind: z.enum(JOB_KINDS).optional() });
router.post('/cancel-queued', asyncHandler(async (req, res) => {
  const { kind } = validateRequest(cancelQueuedSchema, req.query);
  const result = await cancelQueuedJobs({ kind });
  res.json(result);
}));

export default router;
