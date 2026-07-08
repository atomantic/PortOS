/**
 * Insights Routes
 *
 * REST API for the cross-domain insights engine:
 *   GET  /api/insights/genome-health       — genome markers + blood correlations
 *   GET  /api/insights/themes              — cached taste-identity themes
 *   POST /api/insights/themes/refresh      — (re)generate taste-identity themes via LLM
 *   GET  /api/insights/narrative           — cached cross-domain narrative
 *   POST /api/insights/narrative/refresh   — (re)generate narrative via LLM
 *
 * Goal effectiveness scorecard (#2157 — Human Activity Tracking Phase 8):
 *   GET  /api/insights/goal-scorecard          — cached weekly scorecard (disk-only)
 *   POST /api/insights/goal-scorecard/compute  — recompute (deterministic, LLM-free)
 *   POST /api/insights/goal-scorecard/narrative— optional LLM narrative (user-triggered)
 *   GET  /api/insights/goal-scorecard/rules    — effective goal→activity mapping rules
 *   PUT  /api/insights/goal-scorecard/rules    — save per-goal mapping overrides
 *   GET  /api/insights/goal-scorecard/settings — scorecard settings (opt-in narrative)
 *   PUT  /api/insights/goal-scorecard/settings — update scorecard settings
 */

import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import {
  validateRequest,
  insightRefreshSchema,
  scorecardComputeSchema,
  scorecardSettingsSchema,
  scorecardRulesSchema,
} from '../lib/validation.js';
import * as insightsService from '../services/insightsService.js';
import * as goalScorecard from '../services/goalScorecard.js';

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

// ─── Goal effectiveness scorecard (#2157) ────────────────────────────────────

// GET /api/insights/goal-scorecard — cached weekly scorecard (disk-only read).
router.get('/goal-scorecard', asyncHandler(async (_req, res) => {
  res.json(await goalScorecard.getScorecard());
}));

// POST /api/insights/goal-scorecard/compute — recompute (deterministic, LLM-free).
router.post('/goal-scorecard/compute', asyncHandler(async (req, res) => {
  const { weekStart } = validateRequest(scorecardComputeSchema, req.body ?? {});
  res.json(await goalScorecard.computeWeeklyScorecard({ weekStart }));
}));

// POST /api/insights/goal-scorecard/narrative — optional LLM narrative (user-triggered).
router.post('/goal-scorecard/narrative', asyncHandler(async (req, res) => {
  const { providerId, model } = validateRequest(insightRefreshSchema, req.body ?? {});
  res.json(await goalScorecard.refreshScorecardNarrative(providerId, model));
}));

// GET /api/insights/goal-scorecard/rules — effective goal→activity mapping rules.
router.get('/goal-scorecard/rules', asyncHandler(async (_req, res) => {
  res.json(await goalScorecard.getEffectiveRules());
}));

// PUT /api/insights/goal-scorecard/rules — save per-goal mapping overrides.
router.put('/goal-scorecard/rules', asyncHandler(async (req, res) => {
  const overrides = validateRequest(scorecardRulesSchema, req.body ?? {});
  await goalScorecard.saveRuleOverrides(overrides);
  res.json(await goalScorecard.getEffectiveRules());
}));

// GET /api/insights/goal-scorecard/settings — scorecard settings.
router.get('/goal-scorecard/settings', asyncHandler(async (_req, res) => {
  res.json(await goalScorecard.getSettings());
}));

// PUT /api/insights/goal-scorecard/settings — update scorecard settings.
router.put('/goal-scorecard/settings', asyncHandler(async (req, res) => {
  const partial = validateRequest(scorecardSettingsSchema, req.body ?? {});
  res.json(await goalScorecard.updateSettings(partial));
}));

export default router;
