/**
 * Brain Sync Service
 *
 * Applies remote brain changes from peer PortOS instances.
 * Uses last-writer-wins conflict resolution by updatedAt timestamp.
 * Writes directly to storage without triggering brainEvents.
 * Logs applied changes to the local sync log so they relay to other peers
 * and sync status counts reflect received data. Echo prevention is handled
 * by the LWW dedup in applyRemoteRecord (same updatedAt = skip) plus the
 * sync log's operation dedup (a relay the log already carries is dropped).
 *
 * Crash safety (#8316): the record save and the relay append are two writes,
 * so a crash (or a rejected append) between them leaves a record that is
 * accepted here but absent from our outgoing log — invisible forever to a
 * delta-only peer. Two rules close that gap:
 *   - A failed relay append THROWS, so the caller never advances its source
 *     cursor past a change it hasn't relayed; the source re-serves it.
 *   - A re-served change our state already reflects (`local_current`) is
 *     relayed again, deduplicated against the log — so the retry relays a
 *     change the crash stranded, and never mints a second entry for one that
 *     did land.
 * The source cursor is therefore the durable receipt of an inbound change:
 * it only moves once the relay is on disk.
 */

import * as brainStorage from './brainStorage.js';
import { brainEvents } from './brainStorage.js';
import * as brainSyncLog from './brainSyncLog.js';

const { BRAIN_ENTITY_TYPES } = brainStorage;

/**
 * Apply remote changes from a peer instance.
 * Batches relay sync-log appends to reduce lock contention and fs calls.
 * @param {Array} changes - Array of change objects from brainSyncLog
 * @returns {Promise<{inserted: number, updated: number, deleted: number, skipped: number}>}
 */
export async function applyRemoteChanges(changes) {
  let inserted = 0, updated = 0, deleted = 0, skipped = 0;
  const relayBatch = [];
  const appliedRecords = [];
  // An op our state already reflects: relay OUR copy (the state a pulling peer
  // should converge to). The skipLogged append drops it when the log already
  // carries it — the common echo case — so this never amplifies.
  const relayIfCurrent = (result, op, type, id) => {
    if (result.reason !== 'local_current') return;
    const { current } = result;
    relayBatch.push({ op, type, id, record: current, originInstanceId: current.originInstanceId });
  };

  for (const change of changes) {
    let { op, type, id, record, originInstanceId } = change;

    if (!BRAIN_ENTITY_TYPES.includes(type)) {
      skipped++;
      continue;
    }

    // Forward-compat: a future peer might ship a tombstone record as a
    // create/update (`record._deleted === true`). Route it through the delete
    // path with the wire-shape delete record so we tombstone it locally rather
    // than writing a resurrectable live record. Older peers never do this.
    if ((op === 'create' || op === 'update') && record?._deleted === true) {
      op = 'delete';
      record = { updatedAt: record.updatedAt, originInstanceId: record.originInstanceId ?? originInstanceId };
    }

    if (op === 'delete') {
      const result = await brainStorage.applyRemoteRecord(type, id, record, 'delete');
      if (result.applied) {
        deleted++;
        // Relay only applied (or already-reflected, below) changes — a stale
        // (local_newer) op is NOT re-appended, which is what stops the
        // cross-peer echo amplification.
        relayBatch.push({ op, type, id, record, originInstanceId });
        appliedRecords.push({ type, id });
      } else {
        skipped++;
        relayIfCurrent(result, op, type, id);
      }
    } else if (op === 'create' || op === 'update') {
      if (!record) { skipped++; continue; }
      const result = await brainStorage.applyRemoteRecord(type, id, record, op);
      if (result.applied) {
        if (op === 'create') inserted++;
        else updated++;
        relayBatch.push({ op, type, id, record, originInstanceId });
        appliedRecords.push({ type, id });
      } else {
        skipped++;
        relayIfCurrent(result, op, type, id);
      }
    } else {
      skipped++;
    }
  }

  // Batch-append all relays to the sync log in a single lock acquisition.
  // skipLogged makes the append idempotent: a retried delta can't mint a second
  // entry for an op the log already carries.
  let appendError = null;
  if (relayBatch.length > 0) {
    await brainSyncLog.appendChanges(relayBatch, { skipLogged: true }).catch((err) => {
      appendError = err;
      console.error(`❌ Brain sync relay append failed (${relayBatch.length} entries): ${err.message}`);
    });
  }
  if (appliedRecords.length > 0) {
    // Local-only signal so the memory bridge re-vectorizes synced-in records
    // (issue #1080). applyRemoteRecord is event-silent to prevent cross-peer
    // echo (#1077); this event drives ONLY local embedding and never feeds the
    // sync log, so it can't amplify. Carries just {type, id} — the bridge
    // re-reads canonical state. Emitted for newly applied changes only, so
    // a rejected or already-reflected op doesn't trigger a needless re-embed.
    brainEvents.emit('sync:applied', { records: appliedRecords });
  }
  // The records are saved either way (and re-embedded above), but the relay is
  // not — fail the call so the caller keeps its cursor and the source re-serves
  // these changes; the retry relays them through the local_current path.
  if (appendError) throw appendError;

  console.log(`🔄 Brain sync applied: ${inserted} inserted, ${updated} updated, ${deleted} deleted, ${skipped} skipped`);
  return { inserted, updated, deleted, skipped };
}
