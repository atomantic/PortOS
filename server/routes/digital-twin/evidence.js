/**
 * Twin enrichment — observed taste + chronotype evidence (Phase 7, #2156).
 *
 * Read/recompute are LLM-free; interpret is an EXPLICIT user action only (per
 * the AI-provider policy).
 */

import { Router } from 'express';
import * as twinEnrichment from '../../services/twinEnrichment.js';
import { asyncHandler } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validation.js';
import {
  twinEvidenceRecomputeInputSchema,
  twinEvidenceInterpretInputSchema,
} from '../../lib/digitalTwinValidation.js';

const router = Router();

/**
 * GET /api/digital-twin/twin-evidence
 * Observed taste + chronotype evidence, plus the stated-vs-observed chronotype
 * divergence flag. Read-only, LLM-free. `taste`/`chronotype` are null until the
 * first aggregation runs (sentinel: null = never computed, not empty).
 */
router.get('/twin-evidence', asyncHandler(async (req, res) => {
  const evidence = await twinEnrichment.getObservedEvidence();
  res.json(evidence);
}));

/**
 * POST /api/digital-twin/twin-evidence/recompute
 * Recompute the LLM-free rollups from the activity timeline. No provider calls.
 */
router.post('/twin-evidence/recompute', asyncHandler(async (req, res) => {
  validateRequest(twinEvidenceRecomputeInputSchema, req.body ?? {});
  const summary = await twinEnrichment.aggregateTwinEvidence();
  const evidence = await twinEnrichment.getObservedEvidence();
  res.json({ summary, evidence });
}));

/**
 * POST /api/digital-twin/twin-evidence/interpret
 * Generate an AI interpretation of the observed evidence — EXPLICIT user action
 * only (per the AI-provider policy). Persists the narrative onto the taste
 * evidence record.
 */
router.post('/twin-evidence/interpret', asyncHandler(async (req, res) => {
  const { providerId, model } = validateRequest(twinEvidenceInterpretInputSchema, req.body);
  const interpretation = await twinEnrichment.interpretConsumption({ providerId, model });
  res.json({ interpretation });
}));

export default router;
