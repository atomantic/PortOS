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

export const PEER_SUBSCRIBABLE_KINDS = Object.freeze(['universe', 'series', 'mediaCollection']);

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

// The server validates each /pull-metadata request at ≤5000 filenames
// (peerPullMetadataSchema). Chunk larger lists so big libraries don't hard-400.
const PULL_METADATA_BATCH = 5000;

/**
 * Request the server to pull metadata for a list of filenames from peers.
 * Same silent-capable pattern. Transparently batches lists larger than the
 * server's per-request cap and aggregates the `{ attempted, recovered }` counts,
 * so callers can pass an unbounded filename list (e.g. a large Unsorted library).
 */
export const pullMissingMetadata = async (filenames, options = {}) => {
  const list = Array.isArray(filenames) ? filenames : [];
  const postChunk = (chunk) =>
    request('/peer-sync/pull-metadata', {
      method: 'POST',
      body: JSON.stringify({ filenames: chunk }),
      ...options,
    });

  if (list.length <= PULL_METADATA_BATCH) return postChunk(list);

  let attempted = 0;
  let recovered = 0;
  for (let i = 0; i < list.length; i += PULL_METADATA_BATCH) {
    const res = await postChunk(list.slice(i, i + PULL_METADATA_BATCH));
    attempted += res?.attempted ?? 0;
    recovered += res?.recovered ?? 0;
  }
  return { attempted, recovered };
};
