/**
 * Brain Tombstone GC
 *
 * Brain entity deletes leave a tombstone in place (see brainStorage.remove /
 * applyRemoteRecord) so the LWW sync guard can reject a stale `create` echoed
 * from a peer. Tombstones can't live forever, so this sweep hard-prunes any
 * older than a grace period.
 *
 * Grace-period (not cursor-watermark) pruning is sufficient under the
 * single-user trust model: by the time the grace window elapses, every healthy
 * peer has long since received and applied the delete (the sync log is
 * compacted below the minimum peer cursor), so there is no live `create` left
 * in circulation to resurrect the id. A peer offline longer than the grace
 * window is effectively a fresh re-sync — an acceptable trade-off.
 *
 * Mirrors the sharing-side tombstoneGc.js pattern; runs on the sync
 * orchestrator's existing 60s interval.
 */

import * as brainStorage from './brainStorage.js';

/**
 * Prune brain tombstones older than the grace period.
 * @param {{ now?: number, graceMs?: number }} [opts]
 * @returns {Promise<{ pruned: number }>}
 */
export async function sweepBrainTombstones({ now = Date.now(), graceMs = brainStorage.BRAIN_TOMBSTONE_GRACE_MS } = {}) {
  const cutoff = now - graceMs;
  let pruned = 0;
  for (const type of brainStorage.BRAIN_ENTITY_TYPES) {
    pruned += await brainStorage.pruneTombstones(type, cutoff);
  }
  return { pruned };
}
