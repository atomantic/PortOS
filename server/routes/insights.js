/**
 * Insights Routes
 *
 * REST API for the cross-domain insights engine:
 *   GET  /api/insights/genome-health       — genome markers + blood correlations
 *   GET  /api/insights/themes              — cached taste-identity themes
 *   POST /api/insights/themes/refresh      — (re)generate taste-identity themes via LLM
 *   GET  /api/insights/narrative           — cached cross-domain narrative
 *   POST /api/insights/narrative/refresh   — (re)generate narrative via LLM
 */

import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest, insightRefreshSchema } from '../lib/validation.js';
import * as insightsService from '../services/insightsService.js';

const router = Router();

// GET /api/insights/genome-health
router.get('/genome-health', asyncHandler(async (req, res) => {
  const result = await insightsService.getGenomeHealthCorrelations();
  res.json(result);
}));

// GET /api/insights/themes
router.get('/themes', asyncHandler(async (req, res) => {
  const result = await insightsService.getThemeAnalysis();
  res.json(result);
}));

// POST /api/insights/themes/refresh
router.post('/themes/refresh', asyncHandler(async (req, res) => {
  const { providerId, model } = validateRequest(insightRefreshSchema, req.body);
  const result = await insightsService.generateThemeAnalysis(providerId, model);
  res.json(result);
}));

// GET /api/insights/narrative
router.get('/narrative', asyncHandler(async (req, res) => {
  const result = await insightsService.getCrossDomainNarrative();
  res.json(result);
}));

// POST /api/insights/narrative/refresh
router.post('/narrative/refresh', asyncHandler(async (req, res) => {
  const { providerId, model } = validateRequest(insightRefreshSchema, req.body);
  const result = await insightsService.refreshCrossDomainNarrative(providerId, model);
  res.json(result);
}));

export default router;
