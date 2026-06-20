/**
 * Pipeline continuity-bible routes (#1305) — established-facts ledger for a
 * series, auto-seeded from canon and learned from prose. Read the stored
 * ledger, kick off a (re)generation with SSE progress, probe/cancel a run.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validation.js';
import * as seriesSvc from '../../services/pipeline/series.js';
import * as continuityBible from '../../services/pipeline/continuityBible.js';
import { mapServiceError } from './shared.js';

const router = Router();

// Generation params — provider/model optional (falls through to the active or
// stage-pinned provider); `force` re-extracts even when the inputs are
// unchanged. Mirrors the reverse-outline schema.
const continuityBibleGenerateSchema = z.object({
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
  force: z.boolean().optional(),
});

// The stored ledger (facts) with a `stale` flag.
router.get('/series/:id/continuity-bible', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(await continuityBible.getContinuityBible(req.params.id));
}));

// (Re)generate — seed from canon + extract from the whole manuscript, progress via SSE.
router.post('/series/:id/continuity-bible/generate', asyncHandler(async (req, res) => {
  const body = validateRequest(continuityBibleGenerateSchema, req.body ?? {});
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const result = continuityBible.startContinuityBibleRun(req.params.id, body);
  res.json({
    ...result,
    sseUrl: `/api/pipeline/series/${req.params.id}/continuity-bible/generate/progress`,
  });
}));

router.get('/series/:id/continuity-bible/generate/progress', (req, res) => {
  const attached = continuityBible.attachClient(req.params.id, res);
  if (!attached) {
    throw new ServerError('No active continuity-bible run for this series', { status: 404 });
  }
});

// Lightweight probe so a (re)mounting client can re-attach to an in-flight run.
router.get('/series/:id/continuity-bible/generate/status', (req, res) => {
  res.json({ active: continuityBible.isContinuityBibleActive(req.params.id) });
});

router.post('/series/:id/continuity-bible/generate/cancel', asyncHandler(async (req, res) => {
  res.json({ canceled: continuityBible.cancelContinuityBible(req.params.id) });
}));

export default router;
