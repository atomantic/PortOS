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
