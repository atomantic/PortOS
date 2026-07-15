/**
 * Digital Twin validation & analysis — completeness/contradiction checks,
 * writing-sample and spoken-vs-written style analysis, multi-modal identity
 * image capture, personality traits + confidence scoring, gap recommendations,
 * and pasted-assessment analysis.
 */

import { Router } from 'express';
import * as digitalTwinService from '../../services/digital-twin.js';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validation.js';
import {
  contradictionInputSchema,
  writingAnalysisInputSchema,
  spokenWrittenStyleInputSchema,
  identityImageInputSchema,
  identityImageSaveInputSchema,
  analyzeTraitsInputSchema,
  updateTraitsInputSchema,
  calculateConfidenceInputSchema,
  analyzeAssessmentInputSchema,
} from '../../lib/digitalTwinValidation.js';

const router = Router();

// =============================================================================
// VALIDATION & ANALYSIS
// =============================================================================

/**
 * GET /api/digital-twin/validate/completeness
 * Check digital twin document completeness
 */
router.get('/validate/completeness', asyncHandler(async (req, res) => {
  const result = await digitalTwinService.validateCompleteness();
  res.json(result);
}));

/**
 * POST /api/digital-twin/validate/contradictions
 * Detect contradictions in digital twin documents using AI
 */
router.post('/validate/contradictions', asyncHandler(async (req, res) => {
  const { providerId, model } = validateRequest(contradictionInputSchema, req.body);
  const result = await digitalTwinService.detectContradictions(providerId, model);
  res.json(result);
}));

/**
 * POST /api/digital-twin/analyze-writing
 * Analyze writing samples to extract communication patterns
 */
router.post('/analyze-writing', asyncHandler(async (req, res) => {
  const { samples, providerId, model } = validateRequest(writingAnalysisInputSchema, req.body);
  const result = await digitalTwinService.analyzeWritingSamples(samples, providerId, model);
  res.json(result);
}));

/**
 * POST /api/digital-twin/style/spoken-written
 * Compare the user's spoken style (a transcript) against their written style
 * (pasted samples, or their twin documents) and surface the differences.
 */
router.post('/style/spoken-written', asyncHandler(async (req, res) => {
  const data = validateRequest(spokenWrittenStyleInputSchema, req.body);
  const result = await digitalTwinService.compareSpokenWrittenStyle(data);
  res.json(result);
}));

/**
 * POST /api/digital-twin/identity/image
 * Analyze a photo of the user with a vision model and extract visible
 * appearance / self-presentation descriptors (M34 P5 — multi-modal capture).
 */
router.post('/identity/image', asyncHandler(async (req, res) => {
  const data = validateRequest(identityImageInputSchema, req.body);
  const result = await digitalTwinService.analyzeIdentityImage(data);
  res.json(result);
}));

/**
 * POST /api/digital-twin/identity/image/save
 * Persist the appearance analysis as a Digital Twin identity document
 * (upserts APPEARANCE.md).
 */
router.post('/identity/image/save', asyncHandler(async (req, res) => {
  const data = validateRequest(identityImageSaveInputSchema, req.body);
  const result = await digitalTwinService.saveIdentityImageDocument(data);
  if (result?.error) {
    throw new ServerError(result.error, { status: 400, code: 'VALIDATION_ERROR' });
  }
  res.json(result);
}));

// =============================================================================
// TRAITS & CONFIDENCE (Phase 1 & 2)
// =============================================================================

/**
 * GET /api/digital-twin/traits
 * Get current personality traits
 */
router.get('/traits', asyncHandler(async (req, res) => {
  const traits = await digitalTwinService.getTraits();
  res.json({ traits });
}));

/**
 * POST /api/digital-twin/traits/analyze
 * Analyze documents to extract personality traits using AI
 */
router.post('/traits/analyze', asyncHandler(async (req, res) => {
  const { providerId, model, forceReanalyze } = validateRequest(analyzeTraitsInputSchema, req.body);
  const result = await digitalTwinService.analyzeTraits(providerId, model, forceReanalyze);
  res.json(result);
}));

/**
 * PUT /api/digital-twin/traits
 * Manually update personality traits
 */
router.put('/traits', asyncHandler(async (req, res) => {
  const data = validateRequest(updateTraitsInputSchema, req.body);
  const traits = await digitalTwinService.updateTraits(data);
  res.json({ traits });
}));

/**
 * GET /api/digital-twin/confidence
 * Get current confidence scores
 */
router.get('/confidence', asyncHandler(async (req, res) => {
  const confidence = await digitalTwinService.getConfidence();
  res.json({ confidence });
}));

/**
 * POST /api/digital-twin/confidence/calculate
 * Calculate confidence scores (optionally with AI analysis)
 */
router.post('/confidence/calculate', asyncHandler(async (req, res) => {
  const { providerId, model } = validateRequest(calculateConfidenceInputSchema, req.body);
  const result = await digitalTwinService.calculateConfidence(providerId, model);
  res.json(result);
}));

/**
 * GET /api/digital-twin/gaps
 * Get gap recommendations for personality enrichment
 */
router.get('/gaps', asyncHandler(async (req, res) => {
  const gaps = await digitalTwinService.getGapRecommendations();
  res.json({ gaps });
}));

// =============================================================================
// ASSESSMENT ANALYZER
// =============================================================================

/**
 * POST /api/digital-twin/interview/analyze
 * Analyze a pasted personality assessment and update twin profile
 */
router.post('/interview/analyze', asyncHandler(async (req, res) => {
  const { content, providerId, model } = validateRequest(analyzeAssessmentInputSchema, req.body);
  const result = await digitalTwinService.analyzeAssessment(content, providerId, model);

  if (result.error) {
    throw new ServerError(result.error, {
      status: 400,
      code: 'ANALYSIS_ERROR'
    });
  }

  res.json(result);
}));

export default router;
