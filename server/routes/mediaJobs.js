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
import { listJobs, getJob, cancelJob, cancelQueuedJobs, enqueueJob, removeArchivedJob, runJobNow, JOB_KINDS, JOB_STATUSES } from '../services/mediaJobQueue/index.js';

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

// Params that point at multipart-staged temp files under PATHS.uploads. The
// gen modules unlink these on completion/failure, so a job that ran is no
// longer retryable from the persisted params alone (the files are gone, or
// — worse — could collide with a fresh upload at the same path).
const TEMP_UPLOAD_PARAMS = ['uploadedTempPath', 'uploadedTempPaths', 'audioFilePath'];
function hasTempUploadParam(params) {
  if (!params) return false;
  return TEMP_UPLOAD_PARAMS.some((k) => {
    const v = params[k];
    if (Array.isArray(v)) return v.length > 0;
    return typeof v === 'string' && v.length > 0;
  });
}

// Re-enqueue a terminal job with the same kind/params/owner. Uses the
// server-side params (not the UI-sanitized version) so paths stripped for
// transport still ride into the new job.
router.post('/:id/retry', asyncHandler(async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) throw new ServerError('Not found', { status: 404, code: 'NOT_FOUND' });
  if (job.status === 'queued' || job.status === 'running') {
    throw new ServerError(
      `Job is still ${job.status} — cancel it before retrying`,
      { status: 409, code: 'JOB_NOT_TERMINAL' },
    );
  }
  // Reject retry when the original job referenced a multipart-staged upload —
  // the gen modules unlink those files on completion/failure, so re-enqueueing
  // would either fail with a missing-file error or, worse, act on a stale path
  // that's since been reused by a different upload.
  if (hasTempUploadParam(job.params)) {
    throw new ServerError(
      'Job referenced an uploaded file that has since been cleaned up — re-submit the original request with the file attached instead of retrying',
      { status: 409, code: 'JOB_RETRY_TEMP_UPLOAD' },
    );
  }
  const result = enqueueJob({ kind: job.kind, params: job.params, owner: job.owner });
  // Drop the original failed/canceled row from archive — the new job inherits
  // its work, and leaving both visible just lets users keep clicking Retry on
  // the dead row and stacking duplicate jobs.
  removeArchivedJob(job.id);
  res.json({ ...result, retriedFrom: job.id });
}));

// Promote a queued Codex job past the lane's parallel limit. GPU jobs are
// rejected — they serialize on the single MLX runtime.
router.post('/:id/run-now', asyncHandler(async (req, res) => {
  const result = runJobNow(req.params.id);
  if (!result.ok) {
    const status = result.code === 'NOT_FOUND' ? 404 : 400;
    throw new ServerError(result.error || 'Run-now failed', { status, code: result.code });
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
