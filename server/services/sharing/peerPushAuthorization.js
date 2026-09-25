/** Peer-specific admission for inbound record writes; independent of instance auth. */
import { timingSafeEqual } from 'node:crypto';
import { getPeers } from '../instances.js';
import { ServerError } from '../../lib/errorHandler.js';
import { peerAllowsOutbound, peerHasCategory } from './peerSyncShared.js';

function peerSyncTokenMatches(peer, token) {
  const expected = peer?.syncSecret;
  if (typeof expected !== 'string' || expected.length < 32 || typeof token !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function authorizeIncomingPush(payload, { peerToken, pullPeerId } = {}) {
  const peers = await getPeers();
  const peer = peers.find(p => p.instanceId === payload.sourceInstanceId);
  // A local pull already bound the response to the configured destination.
  // No HTTP input can select this context; the pull service alone supplies it.
  const localPull = peer && typeof pullPeerId === 'string' && pullPeerId.length > 0
    && pullPeerId === peer.id && typeof peer.syncSecret === 'string' && peer.syncSecret.length >= 32;
  if (!localPull && !peerSyncTokenMatches(peer, peerToken)) {
    throw new ServerError('Pair this peer from its Instances page before pushing records', {
      status: 401, code: 'PEER_SYNC_AUTH_REQUIRED',
    });
  }
  const directions = Array.isArray(peer?.directions) ? peer.directions : [];
  const directionAllowed = localPull ? peerAllowsOutbound(peer) : directions.includes('inbound');
  if (!peer || peer.enabled === false || peer.syncEnabled !== true || !directionAllowed
    || !peerHasCategory(peer, payload.kind)) {
    throw new ServerError('This peer is not permitted to send this sync category', {
      status: 403, code: 'PEER_SYNC_NOT_ADMITTED',
    });
  }
  return peer;
}
