/**
 * Brain Sync (Federation) Routes
 *
 * The CoS memory bridge (embeddings) plus the cross-machine federation delta
 * log and anti-entropy reconcile (checksum + snapshot).
 */

import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  brainSyncQuerySchema,
  brainSyncPushSchema,
  brainBridgeSyncSchema,
  brainParityCheckSchema
} from '../lib/brainValidation.js';
import { syncAllBrainData, getEmbeddingCoverage } from '../services/brainMemoryBridge.js';
import * as brainSyncLog from '../services/brainSyncLog.js';
import * as brainSync from '../services/brainSync.js';
import * as brainReconcile from '../services/brainReconcile.js';
import * as brainParity from '../services/brainParity.js';

const router = Router();

/**
 * POST /api/brain/bridge-sync
 * Sync all brain data to CoS memory system (generates embeddings).
 * Body: { refresh?: boolean } — refresh:true re-embeds already-mapped records
 * to heal memory entries that diverged before the per-record sync:applied
 * signal existed (issue #1080).
 * (Renamed from /sync to avoid conflict with federation sync)
 */
router.post('/bridge-sync', asyncHandler(async (req, res) => {
  const { refresh, onlyMissing } = validateRequest(brainBridgeSyncSchema, req.body ?? {});
  const stats = await syncAllBrainData({ refresh, onlyMissing });
  const mode = onlyMissing ? ' (missing-only)' : refresh ? ' (refresh)' : '';
  console.log(`🧠🔗 Brain bridge sync complete${mode}: ${stats.synced} synced, ${stats.skipped} skipped, ${stats.archived} archived, ${stats.errors} errors`);
  res.json(stats);
}));

/**
 * GET /api/brain/embeddings/status
 * How many active brain records lack an embedding — powers the
 * "N missing · Embed missing" affordance on the graph.
 */
router.get('/embeddings/status', asyncHandler(async (_req, res) => {
  const coverage = await getEmbeddingCoverage();
  res.json(coverage);
}));

/**
 * GET /api/brain/sync?since={seq}&limit=100
 * Get brain changes since a given sequence number (for peers to pull)
 */
router.get('/sync', asyncHandler(async (req, res) => {
  const { since, limit } = validateRequest(brainSyncQuerySchema, req.query);
  const result = await brainSyncLog.getChangesSince(since, limit);
  res.json(result);
}));

/**
 * POST /api/brain/sync
 * Receive remote brain changes from a peer
 */
router.post('/sync', asyncHandler(async (req, res) => {
  const { changes } = validateRequest(brainSyncPushSchema, req.body);
  const result = await brainSync.applyRemoteChanges(changes);
  res.json(result);
}));

/**
 * GET /api/brain/reconcile/checksum
 * Anti-entropy checksum over ALL brain records (incl. tombstones) — #1077.
 * A peer fetches this after draining the delta log; on a mismatch it pulls the
 * full snapshot below. Lightweight (one hash) so it's cheap to poll each cycle.
 */
router.get('/reconcile/checksum', asyncHandler(async (req, res) => {
  const checksum = await brainReconcile.getBrainChecksum();
  res.json({ checksum });
}));

/**
 * GET /api/brain/reconcile/snapshot
 * Full brain snapshot (raw record map incl. tombstones + checksum) for a peer
 * to LWW-merge. Brain has no per-record push pipeline, so this is unscoped —
 * the receiver applies it idempotently via applyRemoteRecord.
 */
router.get('/reconcile/snapshot', asyncHandler(async (req, res) => {
  const snapshot = await brainReconcile.getBrainSnapshot();
  res.json(snapshot);
}));

/**
 * GET /api/brain/reconcile/manifest
 * Per-record parity manifest for a peer's audit run — #4519. One row per record
 * per entity type, `{ id, updatedAt, deleted }`, tombstones included. Ids and
 * LWW clocks ONLY: no record bodies, no names, so a peer auditing parity never
 * pulls brain content it wouldn't otherwise receive. Far cheaper than
 * /reconcile/snapshot, which older peers fall back to.
 */
router.get('/reconcile/manifest', asyncHandler(async (_req, res) => {
  res.json(await brainParity.buildBrainManifest());
}));

/**
 * GET /api/brain/reconcile/parity
 * The last stored parity report per peer, keyed by peer instanceId. Reads a
 * local file — no peer I/O — so the Instances page can render parity state on
 * load without fanning out to every peer.
 */
router.get('/reconcile/parity', asyncHandler(async (_req, res) => {
  res.json({ reports: await brainParity.getBrainParityReports() });
}));

/**
 * POST /api/brain/reconcile/parity
 * Run a record-level parity audit. Body `{ peerId? }` — one peer, or every
 * federating peer when omitted. Distinct from the sync cycle by design: a
 * routine sync must never pay for a full manifest exchange.
 */
router.post('/reconcile/parity', asyncHandler(async (req, res) => {
  const { peerId } = validateRequest(brainParityCheckSchema, req.body ?? {});
  res.json(await brainParity.runBrainParityCheck({ peerId }));
}));

export default router;
