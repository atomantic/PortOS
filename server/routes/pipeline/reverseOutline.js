/**
 * Pipeline reverse-outline routes (#1286) — scene segmentation + plotline
 * tagging for a series' drafted manuscript. Read the stored outline, kick off a
 * (re)generation with SSE progress, probe/cancel an in-flight run.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validation.js';
import * as seriesSvc from '../../services/pipeline/series.js';
import * as reverseOutline from '../../services/pipeline/reverseOutline.js';
import { mapServiceError } from './shared.js';

const router = Router();

// Generation params — provider/model optional (falls through to the active or
// stage-pinned provider); `force` re-segments even when the manuscript is
// unchanged. Mirrors the editorial-analyze schema.
const reverseOutlineGenerateSchema = z.object({
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
  force: z.boolean().optional(),
});

// The stored outline (scenes + plotlines) with a `stale` flag.
router.get('/series/:id/reverse-outline', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(await reverseOutline.getReverseOutline(req.params.id));
}));

// (Re)generate — batch over the whole manuscript, progress via SSE.
router.post('/series/:id/reverse-outline/generate', asyncHandler(async (req, res) => {
  const body = validateRequest(reverseOutlineGenerateSchema, req.body ?? {});
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const result = reverseOutline.startReverseOutlineRun(req.params.id, body);
  res.json({
    ...result,
    sseUrl: `/api/pipeline/series/${req.params.id}/reverse-outline/generate/progress`,
  });
}));

router.get('/series/:id/reverse-outline/generate/progress', (req, res) => {
  const attached = reverseOutline.attachClient(req.params.id, res);
  if (!attached) {
    throw new ServerError('No active reverse-outline run for this series', { status: 404 });
  }
});

// Lightweight probe so a (re)mounting client can re-attach to an in-flight run.
router.get('/series/:id/reverse-outline/generate/status', (req, res) => {
  res.json({ active: reverseOutline.isReverseOutlineActive(req.params.id) });
});

router.post('/series/:id/reverse-outline/generate/cancel', asyncHandler(async (req, res) => {
  res.json({ canceled: reverseOutline.cancelReverseOutline(req.params.id) });
}));

export default router;
