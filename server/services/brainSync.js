/**
 * Brain Sync Service
 *
 * Applies remote brain changes from peer PortOS instances.
 * Uses last-writer-wins conflict resolution by updatedAt timestamp.
 * Writes directly to storage without triggering brainEvents.
 * Logs applied changes to the local sync log so they relay to other peers
 * and sync status counts reflect received data. Echo prevention is handled
 * by the LWW dedup in applyRemoteRecord (same updatedAt = skip).
 */

import * as brainStorage from './brainStorage.js';
import * as brainSyncLog from './brainSyncLog.js';

// Entity types stored as JSON (have records with IDs)
const ENTITY_TYPES = ['people', 'projects', 'ideas', 'admin', 'memories', 'links'];

/**
 * Apply remote changes from a peer instance.
 * Batches relay sync-log appends to reduce lock contention and fs calls.
 * @param {Array} changes - Array of change objects from brainSyncLog
 * @returns {Promise<{inserted: number, updated: number, deleted: number, skipped: number}>}
 */
export async function applyRemoteChanges(changes) {
  let inserted = 0, updated = 0, deleted = 0, skipped = 0;
  const relayBatch = [];

  for (const change of changes) {
    const { op, type, id, record, originInstanceId } = change;

    if (!ENTITY_TYPES.includes(type)) {
      skipped++;
      continue;
    }

    if (op === 'delete') {
      const result = await brainStorage.applyRemoteRecord(type, id, record, 'delete');
      if (result.applied) {
        deleted++;
        relayBatch.push({ op, type, id, record, originInstanceId });
      } else {
        skipped++;
      }
    } else if (op === 'create' || op === 'update') {
      if (!record) { skipped++; continue; }
      const result = await brainStorage.applyRemoteRecord(type, id, record, op);
      if (result.applied) {
        if (op === 'create') inserted++;
        else updated++;
        relayBatch.push({ op, type, id, record, originInstanceId });
      } else {
        skipped++;
      }
    } else {
      skipped++;
    }
  }

  // Batch-append all applied changes to the sync log in a single lock acquisition
  if (relayBatch.length > 0) {
    await brainSyncLog.appendChanges(relayBatch)
      .catch(err => console.error(`⚠️ Sync log batch append failed (${relayBatch.length} entries): ${err.message}`));
  }

  console.log(`🔄 Brain sync applied: ${inserted} inserted, ${updated} updated, ${deleted} deleted, ${skipped} skipped`);
  return { inserted, updated, deleted, skipped };
}
