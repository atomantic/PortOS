/**
 * Brain Digest & Review Routes
 *
 * Daily digest and weekly review generation + history.
 */

import { Router } from 'express';
import * as brainService from '../services/brain.js';
import { asyncHandler } from '../lib/errorHandler.js';

const router = Router();

/**
 * GET /api/brain/digest/latest
 * Get the most recent daily digest
 */
router.get('/digest/latest', asyncHandler(async (req, res) => {
  const digest = await brainService.getLatestDigest();
  res.json(digest);
}));

/**
 * GET /api/brain/digests
 * Get digest history
 */
router.get('/digests', asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 10;
  const digests = await brainService.getDigests(limit);
  res.json(digests);
}));

/**
 * POST /api/brain/digest/run
 * Manually trigger daily digest generation
 */
router.post('/digest/run', asyncHandler(async (req, res) => {
  const { providerOverride, modelOverride } = req.body || {};
  const digest = await brainService.runDailyDigest(providerOverride, modelOverride);
  res.json(digest);
}));

/**
 * GET /api/brain/review/latest
 * Get the most recent weekly review
 */
router.get('/review/latest', asyncHandler(async (req, res) => {
  const review = await brainService.getLatestReview();
  res.json(review);
}));

/**
 * GET /api/brain/reviews
 * Get review history
 */
router.get('/reviews', asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 10;
  const reviews = await brainService.getReviews(limit);
  res.json(reviews);
}));

/**
 * POST /api/brain/review/run
 * Manually trigger weekly review generation
 */
router.post('/review/run', asyncHandler(async (req, res) => {
  const { providerOverride, modelOverride } = req.body || {};
  const review = await brainService.runWeeklyReview(providerOverride, modelOverride);
  res.json(review);
}));

export default router;
