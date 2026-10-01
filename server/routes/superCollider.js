/**
 * Music Designer SuperCollider runtime and renders (#9413, epic #9407).
 *
 *   GET  /api/music/supercollider/status                 → readiness verdict (never builds or renders)
 *   POST /api/music/supercollider/setup                  → SSE: build/verify the managed image (explicit action)
 *   POST /api/music/supercollider/render                 → { jobId, position, status } (202, media queue)
 *   GET  /api/music/supercollider/renders/:jobId/events  → SSE progress (shared media-queue stream)
 *   POST /api/music/supercollider/renders/:jobId/cancel  → cancel; the container is force-removed
 *   GET  /api/music/supercollider/renders/:jobId/audio   → the validated preview WAV
 *
 * Source runs only inside the contained runtime (services/superColliderRender.js);
 * nothing here calls an AI provider, and setup/render each need the user's request.
 */

import { Router } from 'express';
import { randomInt } from 'crypto';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { openSseStream } from '../lib/sseDownload.js';
import { SUPERCOLLIDER_RENDER } from '../lib/superColliderRuntime.js';
import { MUSIC_CODE_MAX } from '../services/musicCode.js';
import { getSuperColliderStatus, setupSuperColliderRuntime } from '../services/superColliderRuntime.js';
import { readSuperColliderPreview, superColliderSourceHash } from '../services/superColliderRender.js';
import { attachSseClient, cancelJob, enqueueJob, getJob } from '../services/mediaJobQueue/index.js';

const router = Router();

router.get('/status', asyncHandler(async (_req, res) => {
  res.json(await getSuperColliderStatus());
}));

const setupSchema = z.object({ rebuild: z.boolean().optional().default(false) });

// The build compiles SuperCollider from source (10–30 minutes on first run), so
// progress streams as SSE log lines. Concurrent requests share one run, and the
// run continues if the browser leaves — closing the page does not abort a
// half-built image.
router.post('/setup', asyncHandler(async (req, res) => {
  const { rebuild } = validateRequest(setupSchema, req.body ?? {});
  const { send, safeEnd } = openSseStream(res);
  send({ type: 'log', message: rebuild ? 'Rebuilding the SuperCollider runtime' : 'Setting up the SuperCollider runtime' });
  const result = await setupSuperColliderRuntime({ rebuild, onLine: (line) => send({ type: 'log', message: line }) })
    .catch((err) => ({ outcome: 'error', error: err.message, status: null }));
  send(result.outcome === 'ready'
    ? { type: 'complete', status: result.status, built: result.built, probed: result.probed }
    : { type: 'error', outcome: result.outcome, message: result.error || result.status?.message || 'SuperCollider setup failed', status: result.status });
  safeEnd();
}));

const renderSchema = z.object({
  code: z.string().max(MUSIC_CODE_MAX).refine((code) => code.trim().length > 0, 'code is required'),
  durationSec: z.number().int().min(SUPERCOLLIDER_RENDER.minDurationSec).max(SUPERCOLLIDER_RENDER.maxDurationSec),
  seed: z.number().int().min(0).max(SUPERCOLLIDER_RENDER.maxSeed).optional(),
}).strict();

// Refuse up front when the runtime is not ready, so the user is told what to
// set up instead of queuing a job that can only fail. The job still re-checks
// at dispatch: readiness can change while it waits.
router.post('/render', asyncHandler(async (req, res) => {
  const { code, durationSec, seed } = validateRequest(renderSchema, req.body ?? {});
  const status = await getSuperColliderStatus();
  if (!status.ready) {
    throw new ServerError(`SuperCollider is not available: ${status.message}`, {
      status: 409, code: 'SUPERCOLLIDER_UNAVAILABLE', context: { state: status.state, action: status.action },
    });
  }
  // The job carries its own frozen copy of the source; an explicit seed (or
  // a fresh one) makes the render's randomness part of its provenance.
  const params = { source: code, sourceHash: superColliderSourceHash(code), durationSec, seed: seed ?? randomInt(SUPERCOLLIDER_RENDER.maxSeed) };
  res.status(202).json({ ...await enqueueJob({ kind: 'supercollider', params }), seed: params.seed, sourceHash: params.sourceHash });
}));

const renderJob = (jobId) => {
  const job = getJob(jobId);
  if (job?.kind !== 'supercollider') throw new ServerError('SuperCollider render not found', { status: 404, code: 'NOT_FOUND' });
  return job;
};

router.get('/renders/:jobId/events', (req, res) => {
  renderJob(req.params.jobId);
  if (!attachSseClient(req.params.jobId, res)) throw new ServerError('SuperCollider render not found', { status: 404, code: 'NOT_FOUND' });
});

router.post('/renders/:jobId/cancel', asyncHandler(async (req, res) => {
  renderJob(req.params.jobId);
  const result = await cancelJob(req.params.jobId);
  if (!result.ok) throw new ServerError(result.error, { status: result.code === 'NOT_FOUND' ? 404 : 409, code: result.code });
  res.json(result);
}));

// Served from the host-written preview store only after the render passed
// validation; a failed or canceled render never has one.
router.get('/renders/:jobId/audio', asyncHandler(async (req, res) => {
  const found = await readSuperColliderPreview(req.params.jobId);
  if (!found) throw new ServerError('Preview not found or expired', { status: 404, code: 'NOT_FOUND' });
  res.type('audio/wav');
  res.sendFile(found.wavPath, { dotfiles: 'deny', headers: { 'Cache-Control': 'private, max-age=3600' } });
}));

export default router;
