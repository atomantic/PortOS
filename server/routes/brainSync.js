/**
 * Brain Sync (Federation) Routes
 *
 * The CoS memory bridge (embeddings) plus the cross-machine federation delta
 * log and anti-entropy reconcile (checksum + snapshot).
 */

import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import {
  brainSyncQuerySchema,
  brainBridgeSyncSchema,
  brainParityCheckSchema
} from '../lib/brainValidation.js';
import { syncAllBrainData, getEmbeddingCoverage } from '../services/brainMemoryBridge.js';
import * as brainSyncLog from '../services/brainSyncLog.js';
import * as brainReconcile from '../services/brainReconcile.js';
import * as brainParity from '../services/brainParity.js';

const router = Router();

// Peers pull these (PEER_API_SURFACE). Gate them on the per-peer `brain`
// category like the /api/sync snapshot reads (#5663); a checksum or manifest
// fingerprints the same records, so it must not become the weaker door.
const authorizeBrainPull = async (req, route) => {
  const { authorizePeerPull } = await import('../services/sharing/peerPullAuthorization.js');
  return authorizePeerPull(req, { syncCategory: 'brain', alwaysEnforce: true, allowOperator: true, route });
};

/**
 * POST /api/brain/bridge-sync
 * Sync all brain data to CoS memory (generates embeddings). Body: { refresh?: boolean };
 * refresh:true re-embeds already-mapped records to heal diverged memory entries.
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
  await authorizeBrainPull(req, 'brain sync');
  const result = await brainSyncLog.getChangesSince(since, limit);
  res.json(result);
}));

/**
 * GET /api/brain/reconcile/checksum
 * Anti-entropy checksum over ALL brain records (incl. tombstones); a mismatch makes the peer
 * pull the snapshot below.
 */
router.get('/reconcile/checksum', asyncHandler(async (req, res) => {
  await authorizeBrainPull(req, 'brain checksum');
  const checksum = await brainReconcile.getBrainChecksum();
  res.json({ checksum });
}));

/**
 * GET /api/brain/reconcile/snapshot
 * Full snapshot (raw record map incl. tombstones + checksum) for a peer to LWW-merge; unscoped,
 * the receiver applies it idempotently via applyRemoteRecord.
 */
router.get('/reconcile/snapshot', asyncHandler(async (req, res) => {
  await authorizeBrainPull(req, 'brain snapshot');
  const snapshot = await brainReconcile.getBrainSnapshot();
  res.json(snapshot);
}));

/**
 * GET /api/brain/reconcile/manifest
 * Per-record parity manifest `{ id, updatedAt, deleted }` incl. tombstones. Ids and LWW clocks
 * ONLY, no record bodies; far cheaper than /reconcile/snapshot, which older peers fall back to.
 */
router.get('/reconcile/manifest', asyncHandler(async (req, res) => {
  await authorizeBrainPull(req, 'brain manifest');
  res.json(await brainParity.buildBrainManifest());
}));

/** GET /api/brain/reconcile/parity — last stored parity report per peer instanceId (local file, no peer I/O). */
router.get('/reconcile/parity', asyncHandler(async (_req, res) => {
  res.json({ reports: await brainParity.getBrainParityReports() });
}));

/** POST /api/brain/reconcile/parity — record-level audit of `{ peerId? }` or every federating peer; kept apart from the sync cycle so routine sync never pays for a manifest exchange. */
router.post('/reconcile/parity', asyncHandler(async (req, res) => {
  const { peerId } = validateRequest(brainParityCheckSchema, req.body ?? {});
  res.json(await brainParity.runBrainParityCheck({ peerId }));
}));

export default router;
