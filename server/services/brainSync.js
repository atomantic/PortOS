/**
 * Brain Sync Service
 *
 * Applies remote brain changes from peer PortOS instances.
 * Uses last-writer-wins conflict resolution by updatedAt timestamp.
 * Writes directly to storage without triggering brainEvents or sync log
 * to prevent echo loops.
 */

import * as brainStorage from './brainStorage.js';

// Entity types stored as JSON (have records with IDs)
const ENTITY_TYPES = ['people', 'projects', 'ideas', 'admin', 'memories', 'links'];

/**
 * Apply remote changes from a peer instance.
 * @param {Array} changes - Array of change objects from brainSyncLog
 * @returns {Promise<{inserted: number, updated: number, deleted: number, skipped: number}>}
 */
export async function applyRemoteChanges(changes) {
  let inserted = 0, updated = 0, deleted = 0, skipped = 0;

  for (const change of changes) {
    const { op, type, id, record } = change;

    if (!ENTITY_TYPES.includes(type)) {
      skipped++;
      continue;
    }

    if (op === 'delete') {
      const result = await brainStorage.applyRemoteRecord(type, id, record, 'delete');
      if (result.applied) deleted++;
      else skipped++;
    } else if (op === 'create' || op === 'update') {
      if (!record) { skipped++; continue; }
      const result = await brainStorage.applyRemoteRecord(type, id, record, op);
      if (result.applied) {
        if (op === 'create') inserted++;
        else updated++;
      } else {
        skipped++;
      }
    } else {
      skipped++;
    }
  }

  console.log(`🔄 Brain sync applied: ${inserted} inserted, ${updated} updated, ${deleted} deleted, ${skipped} skipped`);
  return { inserted, updated, deleted, skipped };
}
