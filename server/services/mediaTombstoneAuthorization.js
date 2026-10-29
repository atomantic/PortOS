/**
 * The one admission rule for a media tombstone that arrives from a peer, shared
 * by the snapshot paths (dataSync.js for video rows, the library manifest for
 * gallery images), realtime delete frames (peerSyncEvents.js) and remote-delete
 * acks. A tombstone deletes the user's media, so it is accepted only from a
 * registered, paired peer that may delete media here, and only for a row (a
 * video history row, or a gallery image keyed by filename) that peer owns or
 * holds. A refused tombstone is never recorded.
 */
import { parseTsMs } from '../lib/lwwTimestamp.js';
import { rowOwnerCandidates } from '../lib/mediaRowOwners.js';
import { peerMayDeleteMedia } from './instances.js';

// A delete stamped further ahead than clock skew explains would outlive any
// re-create, so it is refused rather than allowed to pin the row deleted.
export const TOMBSTONE_FUTURE_SKEW_MS = 5 * 60 * 1000;

const peerIsPaired = (peer) => typeof peer?.syncSecret === 'string' && peer.syncSecret.length >= 32;
const deny = (reason) => ({ allowed: false, reason });

/**
 * `peer` is the sender's registry record (null when unknown); `localRow` the
 * row held here under `tombstone.key` (null when absent; an image's row is
 * imageRecords.readHeldImage); `hostedIndex` the
 * peer-hosted media entries. `via` is 'snapshot' or 'event'; an event's
 * `eventOriginInstanceId` lets the origin record a delete for a row this
 * machine has not received yet. Returns `{ allowed, reason }`.
 */
export function authorizeRemoteMediaTombstone({ peer, tombstone, localRow, hostedIndex, via, eventOriginInstanceId = null, nowMs = Date.now() }) {
  if (typeof tombstone?.key !== 'string' || !tombstone.key) return deny('invalid-key');
  const deletedMs = parseTsMs(tombstone.deletedAt);
  if (deletedMs === null || deletedMs > nowMs + TOMBSTONE_FUTURE_SKEW_MS) return deny('future-or-invalid-deletedAt');
  if (!peer?.instanceId || peer.enabled === false || !peerIsPaired(peer)) return deny('unpaired-sender');
  if (!peerMayDeleteMedia(peer)) return deny('media-delete-off');
  if (localRow) {
    return rowOwnerCandidates(localRow, hostedIndex).includes(peer.instanceId)
      ? { allowed: true, reason: null }
      : deny('not-owner');
  }
  if (via === 'event' && eventOriginInstanceId === peer.instanceId) return { allowed: true, reason: 'not-held' };
  return deny('row-not-held');
}
