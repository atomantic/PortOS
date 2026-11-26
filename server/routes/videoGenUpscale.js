/** Plan and run local and Topaz video upscales. */

import { Router } from 'express';
import { asyncHandler, failValidation } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { upscaleHistoryItem, planUpscaleHistoryItem } from '../services/videoGen/local.js';
import { enqueueLtxUpscale } from '../services/videoGen/upscaleJob.js';
import { enqueueFalSeedvr2Upscale } from '../services/videoGen/falUpscaleJob.js';
import { quoteTopaz } from '../services/videoGen/topazQuote.js';
import { assertNoPendingTopaz, enqueueTopazUpscale, reconcileTopazStatus, recoverTopazResult } from '../services/videoGen/topazJob.js';
import { historyIdSchema, topazJobParamsSchema, topazQuoteBodySchema, topazTokenBodySchema, upscaleMethodSchema } from '../lib/videoGenValidation.js';

const router = Router();

router.post('/upscale/:id/topaz/quote', asyncHandler(async (req, res) => {
  const parsed = historyIdSchema.safeParse(req.params.id);
  if (!parsed.success) failValidation(parsed);
  const body = validateRequest(topazQuoteBodySchema, req.body ?? {});
  assertNoPendingTopaz(parsed.data);
  res.json({ ok: true, quote: await quoteTopaz(parsed.data, body.model) });
}));

router.get('/upscale/topaz/jobs/:jobId/status', asyncHandler(async (req, res) => {
  const { jobId } = validateRequest(topazJobParamsSchema, req.params);
  res.json({ ok: true, ...await reconcileTopazStatus(jobId) });
}));

router.post('/upscale/topaz/jobs/:jobId/cancel', asyncHandler(async (req, res) => {
  const { jobId } = validateRequest(topazJobParamsSchema, req.params);
  res.json({ ok: true, ...await reconcileTopazStatus(jobId, { cancelRemote: true }) });
}));

router.post('/upscale/topaz/jobs/:jobId/recover', asyncHandler(async (req, res) => {
  const { jobId } = validateRequest(topazJobParamsSchema, req.params);
  res.json({ ok: true, job: await recoverTopazResult(jobId) });
}));

router.post('/upscale/:id/topaz', asyncHandler(async (req, res) => {
  const parsed = historyIdSchema.safeParse(req.params.id);
  if (!parsed.success) failValidation(parsed);
  const body = validateRequest(topazTokenBodySchema, req.body ?? {});
  res.json({ ok: true, job: await enqueueTopazUpscale(parsed.data, body.token) });
}));

// What the user must see BEFORE submitting (#6509): source geometry, the target
// the method would produce, the padding the model grid needs, and whether this
// machine can actually run the method. Read-only — it queues no job and pulls
// no weight.
router.get('/upscale/:id/plan', asyncHandler(async (req, res) => {
  const parsed = historyIdSchema.safeParse(req.params.id);
  if (!parsed.success) failValidation(parsed);
  const query = upscaleMethodSchema.safeParse(req.query ?? {});
  if (!query.success) failValidation(query);
  res.json({ ok: true, plan: await planUpscaleHistoryItem(parsed.data, query.data) });
}));

// The two methods answer with materially different things, so they answer with
// different KEYS rather than one overloaded field. Lanczos is an inline ffmpeg
// pass that returns the finished row; the generative method is a multi-minute
// GPU render, so it returns the queued job to watch and the row appears in
// history when it lands (#6511). Every pre-#6511 client omits `method`, gets
// Lanczos, and still reads `video` exactly as before.
router.post('/upscale/:id', asyncHandler(async (req, res) => {
  const parsed = historyIdSchema.safeParse(req.params.id);
  if (!parsed.success) failValidation(parsed);
  const body = upscaleMethodSchema.safeParse(req.body ?? {});
  if (!body.success) failValidation(body);
  if (body.data.method === 'ltx') {
    res.json({ ok: true, job: await enqueueLtxUpscale(parsed.data) });
    return;
  }
  if (body.data.method === 'fal-seedvr2') {
    res.json({ ok: true, job: await enqueueFalSeedvr2Upscale(parsed.data, body.data) });
    return;
  }
  const entry = await upscaleHistoryItem(parsed.data, body.data);
  res.json({ ok: true, video: entry });
}));

export default router;
