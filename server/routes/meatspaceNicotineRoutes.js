/**
 * Meatspace Nicotine Routes
 *
 * Nicotine logging, rolling-average summaries, and custom quick-add product buttons.
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  nicotineLogSchema,
  nicotineUpdateSchema,
  customNicotineProductSchema,
  customNicotineProductUpdateSchema,
} from '../lib/meatspaceValidation.js';
import * as nicotineService from '../services/meatspaceNicotine.js';

const router = Router();

// =============================================================================
// NICOTINE
// =============================================================================

/**
 * GET /api/meatspace/nicotine
 * Nicotine summary with rolling averages
 */
router.get('/nicotine', asyncHandler(async (req, res) => {
  const summary = await nicotineService.getNicotineSummary();
  res.json(summary);
}));

/**
 * GET /api/meatspace/nicotine/daily
 * Daily nicotine entries with optional date range
 */
router.get('/nicotine/daily', asyncHandler(async (req, res) => {
  const entries = await nicotineService.getDailyNicotine(req.query.from, req.query.to);
  res.json(entries);
}));

/**
 * POST /api/meatspace/nicotine/log
 * Log nicotine consumption
 */
router.post('/nicotine/log', asyncHandler(async (req, res) => {
  const data = validateRequest(nicotineLogSchema, req.body);
  const result = await nicotineService.logNicotine(data);
  res.status(201).json(result);
}));

/**
 * PUT /api/meatspace/nicotine/log/:date/:index
 * Update a specific nicotine entry
 */
router.put('/nicotine/log/:date/:index', asyncHandler(async (req, res) => {
  const { date, index } = req.params;
  const data = validateRequest(nicotineUpdateSchema, req.body);
  const parsedIndex = parseInt(index, 10);
  if (!Number.isInteger(parsedIndex) || parsedIndex < 0) {
    throw new ServerError('Invalid index', { status: 400, code: 'INVALID_INDEX' });
  }
  const result = await nicotineService.updateNicotine(date, parsedIndex, data);
  if (!result) {
    throw new ServerError('Nicotine entry not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(result);
}));

/**
 * DELETE /api/meatspace/nicotine/log/:date/:index
 * Remove a specific nicotine entry
 */
router.delete('/nicotine/log/:date/:index', asyncHandler(async (req, res) => {
  const { date, index } = req.params;
  const parsedIndex = parseInt(index, 10);
  if (!Number.isInteger(parsedIndex) || parsedIndex < 0) {
    throw new ServerError('Invalid index', { status: 400, code: 'INVALID_INDEX' });
  }
  const removed = await nicotineService.removeNicotine(date, parsedIndex);
  if (!removed) {
    throw new ServerError('Nicotine entry not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(removed);
}));

// =============================================================================
// CUSTOM NICOTINE PRODUCTS
// =============================================================================

/**
 * GET /api/meatspace/nicotine/custom-products
 * List custom nicotine product quick-add buttons
 */
router.get('/nicotine/custom-products', asyncHandler(async (req, res) => {
  const products = await nicotineService.getCustomProducts();
  res.json(products);
}));

/**
 * POST /api/meatspace/nicotine/custom-products
 * Add a custom nicotine product button
 */
router.post('/nicotine/custom-products', asyncHandler(async (req, res) => {
  const data = validateRequest(customNicotineProductSchema, req.body);
  const product = await nicotineService.addCustomProduct(data);
  res.status(201).json(product);
}));

/**
 * PUT /api/meatspace/nicotine/custom-products/:index
 * Update a custom nicotine product button
 */
router.put('/nicotine/custom-products/:index', asyncHandler(async (req, res) => {
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) {
    throw new ServerError('Invalid index', { status: 400, code: 'INVALID_INDEX' });
  }
  const data = validateRequest(customNicotineProductUpdateSchema, req.body);
  const product = await nicotineService.updateCustomProduct(index, data);
  if (!product) {
    throw new ServerError('Custom product not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(product);
}));

/**
 * DELETE /api/meatspace/nicotine/custom-products/:index
 * Remove a custom nicotine product button
 */
router.delete('/nicotine/custom-products/:index', asyncHandler(async (req, res) => {
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) {
    throw new ServerError('Invalid index', { status: 400, code: 'INVALID_INDEX' });
  }
  const removed = await nicotineService.removeCustomProduct(index);
  if (!removed) {
    throw new ServerError('Custom product not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(removed);
}));

export default router;
