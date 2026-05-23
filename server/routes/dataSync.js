/**
 * Data Sync Routes
 *
 * Endpoints for snapshot-based data sync between PortOS peer instances.
 * Each category returns its full data + checksum for merge-based sync.
 */

import { Router } from 'express';
import { z } from 'zod';
import * as dataSync from '../services/dataSync.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';

const router = Router();

const categoryParam = z.enum(['goals', 'character', 'digitalTwin', 'meatspace', 'universe', 'pipeline', 'mediaCollections']);

// GET /api/sync/:category/checksum — return checksum only (lightweight)
router.get('/:category/checksum', asyncHandler(async (req, res) => {
  const category = categoryParam.parse(req.params.category);
  const result = await dataSync.getChecksum(category);
  if (!result) throw new ServerError('Category not found', { status: 404 });
  res.json(result);
}));

// GET /api/sync/:category/snapshot — return category data + checksum
router.get('/:category/snapshot', asyncHandler(async (req, res) => {
  const category = categoryParam.parse(req.params.category);
  const snapshot = await dataSync.getSnapshot(category);
  if (!snapshot) throw new ServerError('Category not found', { status: 404 });
  res.json(snapshot);
}));

// POST /api/sync/:category/apply — apply remote data with merge
router.post('/:category/apply', asyncHandler(async (req, res) => {
  const category = categoryParam.parse(req.params.category);
  const { data } = req.body;
  if (!data) throw new ServerError('Missing data field', { status: 400 });
  const result = await dataSync.applyRemote(category, data);
  res.json(result);
}));

// GET /api/sync/categories — list supported sync categories
router.get('/', asyncHandler(async (req, res) => {
  res.json({ categories: dataSync.getSupportedCategories() });
}));

export default router;
