/**
 * Meatspace Alcohol Routes
 *
 * Drink logging, rolling-average summaries, and custom quick-add drink buttons.
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  drinkLogSchema,
  drinkUpdateSchema,
  customDrinkSchema,
  customDrinkUpdateSchema,
} from '../lib/meatspaceValidation.js';
import * as alcoholService from '../services/meatspaceAlcohol.js';

const router = Router();

// =============================================================================
// ALCOHOL
// =============================================================================

/**
 * GET /api/meatspace/alcohol
 * Alcohol summary with rolling averages
 */
router.get('/alcohol', asyncHandler(async (req, res) => {
  const summary = await alcoholService.getAlcoholSummary();
  res.json(summary);
}));

/**
 * GET /api/meatspace/alcohol/daily
 * Daily alcohol entries with optional date range
 */
router.get('/alcohol/daily', asyncHandler(async (req, res) => {
  const entries = await alcoholService.getDailyAlcohol(req.query.from, req.query.to);
  res.json(entries);
}));

/**
 * POST /api/meatspace/alcohol/log
 * Log a drink
 */
router.post('/alcohol/log', asyncHandler(async (req, res) => {
  const data = validateRequest(drinkLogSchema, req.body);
  const result = await alcoholService.logDrink(data);
  res.status(201).json(result);
}));

/**
 * PUT /api/meatspace/alcohol/log/:date/:index
 * Update a specific drink entry
 */
router.put('/alcohol/log/:date/:index', asyncHandler(async (req, res) => {
  const { date, index } = req.params;
  const data = validateRequest(drinkUpdateSchema, req.body);
  const parsedIndex = parseInt(index, 10);
  if (!Number.isInteger(parsedIndex) || parsedIndex < 0) {
    throw new ServerError('Invalid index', { status: 400, code: 'INVALID_INDEX' });
  }
  const result = await alcoholService.updateDrink(date, parsedIndex, data);
  if (!result) {
    throw new ServerError('Drink entry not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(result);
}));

/**
 * DELETE /api/meatspace/alcohol/log/:date/:index
 * Remove a specific drink entry
 */
router.delete('/alcohol/log/:date/:index', asyncHandler(async (req, res) => {
  const { date, index } = req.params;
  const parsedIndex = parseInt(index, 10);
  if (!Number.isInteger(parsedIndex) || parsedIndex < 0) {
    throw new ServerError('Invalid index', { status: 400, code: 'INVALID_INDEX' });
  }
  const removed = await alcoholService.removeDrink(date, parsedIndex);
  if (!removed) {
    throw new ServerError('Drink entry not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(removed);
}));

// =============================================================================
// CUSTOM DRINK BUTTONS
// =============================================================================

/**
 * GET /api/meatspace/alcohol/custom-drinks
 * List custom drink quick-add buttons
 */
router.get('/alcohol/custom-drinks', asyncHandler(async (req, res) => {
  const drinks = await alcoholService.getCustomDrinks();
  res.json(drinks);
}));

/**
 * POST /api/meatspace/alcohol/custom-drinks
 * Add a custom drink button
 */
router.post('/alcohol/custom-drinks', asyncHandler(async (req, res) => {
  const data = validateRequest(customDrinkSchema, req.body);
  const drink = await alcoholService.addCustomDrink(data);
  res.status(201).json(drink);
}));

/**
 * PUT /api/meatspace/alcohol/custom-drinks/:index
 * Update a custom drink button
 */
router.put('/alcohol/custom-drinks/:index', asyncHandler(async (req, res) => {
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) {
    throw new ServerError('Invalid index', { status: 400, code: 'INVALID_INDEX' });
  }
  const data = validateRequest(customDrinkUpdateSchema, req.body);
  const drink = await alcoholService.updateCustomDrink(index, data);
  if (!drink) {
    throw new ServerError('Custom drink not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(drink);
}));

/**
 * DELETE /api/meatspace/alcohol/custom-drinks/:index
 * Remove a custom drink button
 */
router.delete('/alcohol/custom-drinks/:index', asyncHandler(async (req, res) => {
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) {
    throw new ServerError('Invalid index', { status: 400, code: 'INVALID_INDEX' });
  }
  const removed = await alcoholService.removeCustomDrink(index);
  if (!removed) {
    throw new ServerError('Custom drink not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(removed);
}));

export default router;
