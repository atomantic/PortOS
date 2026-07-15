/**
 * Model Personality API routes (issue #2610).
 *
 * LLM personality self-profile testing with optional digital-twin alignment
 * scoring. Kept out of digital-twin.js so that router doesn't keep growing
 * (aligned with the #2533 route-thinning direction).
 *
 * AI policy: POST /run is the ONLY path that triggers LLM calls, and it is an
 * explicit user action naming the provider/model — no boot-time or background
 * invocation exists.
 */

import { Router } from 'express';
import * as modelPersonality from '../services/modelPersonality.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  runPersonalityTestInputSchema,
  personalityHistoryQuerySchema,
  personalitySettingsUpdateSchema
} from '../lib/modelPersonalityValidation.js';

const router = Router();

// POST /api/model-personality/run — run the self-profile test (1 LLM call,
// or 2 when the alignment check is included).
router.post('/run', asyncHandler(async (req, res) => {
  const { providerId, model, includeAlignment, personaId } = validateRequest(
    runPersonalityTestInputSchema,
    req.body
  );
  const result = await modelPersonality.runPersonalityTest({ providerId, model, includeAlignment, personaId });
  res.json(result);
}));

// GET /api/model-personality/history?limit=N — most-recent-first run records.
router.get('/history', asyncHandler(async (req, res) => {
  const { limit } = validateRequest(personalityHistoryQuerySchema, req.query);
  res.json(await modelPersonality.getHistory(limit));
}));

// DELETE /api/model-personality/history/:runId
router.delete('/history/:runId', asyncHandler(async (req, res) => {
  const removed = await modelPersonality.deleteResult(req.params.runId);
  if (!removed) throw new ServerError('Result not found', { status: 404, code: 'NOT_FOUND' });
  res.status(204).end();
}));

// GET /api/model-personality/settings
router.get('/settings', asyncHandler(async (req, res) => {
  res.json(await modelPersonality.getSettings());
}));

// PUT /api/model-personality/settings — partial update (scorer provider/model,
// history cap, default alignment toggle).
router.put('/settings', asyncHandler(async (req, res) => {
  const patch = validateRequest(personalitySettingsUpdateSchema, req.body ?? {});
  res.json(await modelPersonality.updateSettings(patch));
}));

export default router;
