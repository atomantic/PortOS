/**
 * Data Sync Routes
 *
 * Endpoints for snapshot-based data sync between PortOS peer instances.
 * Each category returns its full data + checksum for merge-based sync.
 */

import { Router } from 'express';
import { z } from 'zod';
import * as dataSync from '../services/dataSync.js';
import { sweepTombstones, getSweepStatus, TOMBSTONE_GRACE_MS } from '../services/sharing/tombstoneGc.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';

const router = Router();

// MUST stay in sync with dataSync.getSupportedCategories() — a category
// registered in the service but absent here 400s before its snapshot/apply
// handler can run (the latent bug #730 hit for `storyBuilder`).
const categoryParam = z.enum(['goals', 'character', 'digitalTwin', 'meatspace', 'universe', 'pipeline', 'mediaCollections', 'videoHistory', 'storyBuilder']);

// Tombstone GC manual trigger. Declared BEFORE `/:category/*` so the literal
// "tombstones" segment wins Express's first-match lookup (categoryParam's
// Zod enum would otherwise 400 before our handler runs). graceMs is clamped
// to [0, 24h] — the trigger can only SHRINK the grace, never bypass the ack
// horizon; the per-kind null-cutoff refusal still fires regardless.
const tombstoneSweepBodySchema = z.object({
  graceMs: z.number().int().min(0).max(TOMBSTONE_GRACE_MS).optional(),
}).strict();

router.get('/tombstones/status', asyncHandler(async (req, res) => {
  const status = await getSweepStatus();
  res.json(status);
}));

router.post('/tombstones/sweep', asyncHandler(async (req, res) => {
  const parsed = tombstoneSweepBodySchema.safeParse(req.body || {});
  if (!parsed.success) {
    throw new ServerError(
      `Validation failed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
      { status: 400, code: 'VALIDATION_ERROR' },
    );
  }
  const result = await sweepTombstones(parsed.data);
  res.json(result);
}));

// Optional `?forPeer=<instanceId>` — the REQUESTING peer's instanceId. When
// present, the snapshot/checksum is scoped to EXCLUDE records that peer
// already receives from us per-record via the push pipeline (its inbound
// coverage), so the snapshot carries only un-subscribed records + tombstones
// for torn-down subs. Absent (older peers, non-peer callers) → full snapshot,
// applied idempotently by the receiver. Express returns an array for repeated
// query keys; the `typeof === 'string'` guard drops those so only a single
// scalar instanceId scopes the request. Trim + length-cap the value (matching
// the defensive id handling in the peerSync routes) so stray whitespace or a
// malformed/oversized client value can't become a junk cache key.
const forPeerOf = (req) => {
  if (typeof req.query.forPeer !== 'string') return undefined;
  const trimmed = req.query.forPeer.trim().slice(0, 128);
  return trimmed.length > 0 ? trimmed : undefined;
};

// GET /api/sync/:category/checksum — return checksum only (lightweight)
router.get('/:category/checksum', asyncHandler(async (req, res) => {
  const category = categoryParam.parse(req.params.category);
  const result = await dataSync.getChecksum(category, { forPeerId: forPeerOf(req) });
  if (!result) throw new ServerError('Category not found', { status: 404 });
  res.json(result);
}));

// GET /api/sync/:category/snapshot — return category data + checksum
router.get('/:category/snapshot', asyncHandler(async (req, res) => {
  const category = categoryParam.parse(req.params.category);
  const snapshot = await dataSync.getSnapshot(category, { forPeerId: forPeerOf(req) });
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
  // `z.unknown()` accepts falsy-but-present payloads (0, false, ''); only
  // reject genuinely missing/null so we don't 400 a valid empty-ish snapshot.
  if (data == null) throw new ServerError('Missing data field', { status: 400 });
  const result = await dataSync.applyRemote(category, data, { portosMeta });
  res.json(result);
}));

// GET /api/sync/categories — list supported sync categories
router.get('/', asyncHandler(async (req, res) => {
  res.json({ categories: dataSync.getSupportedCategories() });
}));

export default router;
