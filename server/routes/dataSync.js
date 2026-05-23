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

// POST /api/sync/:category/apply — apply remote data with merge.
// Forwards `portosMeta` to `applyRemote` so the schema-version gate fires for
// this transport too. Without the forward, a caller hitting this REST path
// (manual debug, future client transport) would silently bypass the gate
// because `applyRemote` defaults the option object to `{}` and the gate
// reads `options.portosMeta` — absent → comparator skips the ahead check.
// `portosMeta` is intentionally `.passthrough()` so newer-PortOS callers
// adding fields don't get 400'd before the gate has a chance to diagnose.
const applyBodySchema = z.object({
  data: z.unknown(),
  portosMeta: z.object({
    portosVersion: z.string().trim().min(1).max(40).optional(),
    schemaVersions: z.record(z.string().min(1).max(60), z.number().int().min(0).max(1_000_000)).optional(),
  }).passthrough().optional(),
});
router.post('/:category/apply', asyncHandler(async (req, res) => {
  const category = categoryParam.parse(req.params.category);
  const parsed = applyBodySchema.safeParse(req.body || {});
  if (!parsed.success) {
    throw new ServerError(`Validation failed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`, { status: 400, code: 'VALIDATION_ERROR' });
  }
  const { data, portosMeta } = parsed.data;
  if (!data) throw new ServerError('Missing data field', { status: 400 });
  const result = await dataSync.applyRemote(category, data, { portosMeta });
  res.json(result);
}));

// GET /api/sync/categories — list supported sync categories
router.get('/', asyncHandler(async (req, res) => {
  res.json({ categories: dataSync.getSupportedCategories() });
}));

export default router;
