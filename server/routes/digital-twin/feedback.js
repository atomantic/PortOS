/**
 * Behavioral feedback loop (M34 P3) — "sounds like me" validations, stats,
 * weight recalculation, and recent-feedback listing.
 */

import { Router } from 'express';
import * as feedbackService from '../../services/feedbackLoop.js';
import { asyncHandler } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validation.js';
import { feedbackInputSchema } from '../../lib/digitalTwinValidation.js';

const router = Router();

/**
 * POST /api/digital-twin/feedback
 * Submit a "sounds like me" / "doesn't sound like me" validation
 */
router.post('/feedback', asyncHandler(async (req, res) => {
  const data = validateRequest(feedbackInputSchema, req.body);
  const entry = await feedbackService.submitFeedback(data);
  res.json(entry);
}));

/**
 * GET /api/digital-twin/feedback/stats
 * Get feedback statistics and analysis
 */
router.get('/feedback/stats', asyncHandler(async (req, res) => {
  const stats = await feedbackService.getFeedbackStats();
  res.json(stats);
}));

/**
 * POST /api/digital-twin/feedback/recalculate
 * Recalculate document weight adjustments from feedback history
 */
router.post('/feedback/recalculate', asyncHandler(async (req, res) => {
  const result = await feedbackService.recalculateWeights();
  res.json(result);
}));

/**
 * GET /api/digital-twin/feedback/recent
 * Get recent feedback entries (optionally filtered by content type)
 */
router.get('/feedback/recent', asyncHandler(async (req, res) => {
  const contentType = req.query.contentType || null;
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
  const entries = await feedbackService.getRecentFeedback(contentType, limit);
  res.json(entries);
}));

export default router;
