/**
 * Federated peer-sync API wrappers.
 *
 * Sibling of `apiSharing.js` (which targets cloud-synced share buckets); this
 * module targets *other PortOS instances over Tailnet*. The route surface is
 * a thin wrapper over `server/routes/peerSync.js`:
 *
 *   GET    /peer-sync/subscriptions[?peerId=…&recordKind=…&recordId=…]
 *   POST   /peer-sync/subscriptions  → { peerId, recordKind, recordId }
 *   DELETE /peer-sync/subscriptions/:id
 *
 * The receiver-side `POST /peer-sync/push` endpoint exists only for peer-to-
 * peer traffic — the browser never calls it — so it's intentionally absent
 * from this client wrapper.
 */

import { request } from './apiCore.js';

export const PEER_SUBSCRIBABLE_KINDS = Object.freeze(['universe', 'series']);

export const listPeerSubscriptions = (filter = {}, options) => {
  const qs = new URLSearchParams();
  if (filter.peerId) qs.set('peerId', filter.peerId);
  if (filter.recordKind) qs.set('recordKind', filter.recordKind);
  if (filter.recordId) qs.set('recordId', filter.recordId);
  const query = qs.toString();
  return request(`/peer-sync/subscriptions${query ? `?${query}` : ''}`, options);
};

export const subscribeToPeer = ({ peerId, recordKind, recordId }, options) =>
  request('/peer-sync/subscriptions', {
    method: 'POST',
    body: JSON.stringify({ peerId, recordKind, recordId }),
    ...options,
  });

export const unsubscribeFromPeer = (subscriptionId, options) =>
  request(`/peer-sync/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'DELETE',
    ...options,
  });

// Tombstone GC manual-trigger endpoints. The ack horizon used to decide
// what's safe to prune comes from the per-record subscription cursors that
// the rest of this file already manages — hence the colocation.

export const getTombstoneSweepStatus = (options) =>
  request('/sync/tombstones/status', options);

export const sweepTombstonesNow = ({ graceMs } = {}, options) =>
  request('/sync/tombstones/sweep', {
    method: 'POST',
    body: JSON.stringify(graceMs !== undefined ? { graceMs } : {}),
    ...options,
  });

// ---------------------------------------------------------------------------
// Integrity checking + manual sync (Group 4 — federated media sync integrity)
// ---------------------------------------------------------------------------

/**
 * Fetch integrity diff for a single kind against a specific peer.
 * Uses `silent: true` because the hook caller owns the failure UI (it just
 * marks the peer as unavailable rather than toasting on every poll tick).
 */
export const fetchSyncIntegrity = (peerId, kind) =>
  request(
    `/peer-sync/integrity?peerId=${encodeURIComponent(peerId)}&kind=${encodeURIComponent(kind)}`,
    { silent: true },
  );

/**
 * Trigger a one-record sync push to a specific peer.
 * Accepts an optional `options` spread so callers that own their error UI can
 * pass `{ silent: true }`; defaults to letting the helper toast on failure.
 */
export const syncRecordToPeer = (peerId, recordKind, recordId, options = {}) =>
  request('/peer-sync/sync-record', {
    method: 'POST',
    body: JSON.stringify({ peerId, recordKind, recordId }),
    ...options,
  });

/**
 * Trigger a full sync-now for all subscribed records to a peer.
 * Same silent-capable pattern as `syncRecordToPeer`.
 */
export const syncNowForPeer = (peerId, options = {}) =>
  request('/peer-sync/sync-now', {
    method: 'POST',
    body: JSON.stringify({ peerId }),
    ...options,
  });

/**
 * Request the server to pull metadata for a list of filenames from peers.
 * Same silent-capable pattern.
 */
export const pullMissingMetadata = (filenames, options = {}) =>
  request('/peer-sync/pull-metadata', {
    method: 'POST',
    body: JSON.stringify({ filenames }),
    ...options,
  });
