/** Plan and run local (Lanczos, LTX, Real-ESRGAN) and cloud (fal SeedVR2, Topaz) video upscales. */

import { Router } from 'express';
import { asyncHandler, failValidation, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { upscaleHistoryItem, planUpscaleHistoryItem } from '../services/videoGen/local.js';
import { enqueueLtxUpscale } from '../services/videoGen/upscaleJob.js';
import { enqueueFalSeedvr2Upscale } from '../services/videoGen/falUpscaleJob.js';
import { enqueueRealesrganUpscale } from '../services/videoGen/realesrganUpscaleJob.js';
import { streamRealesrganInstall } from '../services/videoGen/realesrganRuntime.js';
import { openSseStream, onClientDisconnect } from '../lib/sseDownload.js';
import { quoteTopaz } from '../services/videoGen/topazQuote.js';
import { assertNoPendingTopaz, enqueueTopazUpscale, reconcileTopazStatus, recoverTopazResult } from '../services/videoGen/topazJob.js';
import { historyIdSchema, topazJobParamsSchema, topazQuoteBodySchema, topazTokenBodySchema, upscaleMethodSchema } from '../lib/videoGenValidation.js';

const router = Router();

async function upscaleShot(historyId, { musicVideoProjectId, sceneId, ...options }) {
  if (!musicVideoProjectId) throw new ServerError('A Music Video project is required for a shot upscale.', { status: 400, code: 'VALIDATION_ERROR' });
  const { submitShotUpscale } = await import('../services/musicVideo/shotUpscale.js');
  return submitShotUpscale(musicVideoProjectId, sceneId, historyId, options);
}

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
  const result = body.sceneId
    ? await upscaleShot(parsed.data, { ...body, method: 'fal-topaz', topazToken: body.token })
    : { job: await enqueueTopazUpscale(parsed.data, body.token) };
  res.json({ ok: true, ...result });
}));

// The explicit Real-ESRGAN setup (#19985): the only request that downloads the
// pinned release, unpacks it and checks every weight on this GPU. The plan
// endpoint below reports readiness without ever reaching this.
router.post('/upscale/realesrgan/install', asyncHandler(async (req, res) => {
  const { send, safeEnd } = openSseStream(res);
  await streamRealesrganInstall({ send, safeEnd, onDisconnect: (handler) => onClientDisconnect(req, res, handler) });
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
  if (body.data.sceneId) {
    const method = body.data.method === 'ltx' ? 'local-ltx25' : body.data.method;
    res.json({ ok: true, ...await upscaleShot(parsed.data, { ...body.data, method }) });
    return;
  }
  if (body.data.method === 'ltx') {
    res.json({ ok: true, job: await enqueueLtxUpscale(parsed.data) });
    return;
  }
  if (body.data.method === 'fal-seedvr2') {
    res.json({ ok: true, job: await enqueueFalSeedvr2Upscale(parsed.data, body.data) });
    return;
  }
  if (body.data.method === 'realesrgan') {
    const { realesrganModel, musicVideoProjectId, sceneId } = body.data;
    res.json({ ok: true, job: await enqueueRealesrganUpscale(parsed.data, { realesrganModel, musicVideoProjectId, sceneId }) });
    return;
  }
  const entry = await upscaleHistoryItem(parsed.data, body.data);
  res.json({ ok: true, video: entry });
}));

export default router;
