/** Provision sync secrets on registered peer pairs. */
import crypto from 'crypto';
import { PROBE_TIMEOUT_MS } from './peerRecord.js';
import { probePeer } from './peerProbing.js';
import { emitPeerAuthRevoked, getPeers, updatePeer } from './peerCrud.js';
import { disconnectFromPeer } from '../peerSocketRelay.js';
import { UNKNOWN_INSTANCE_ID, getInstanceId, withData } from '../instanceIdentity.js';
import { instanceEvents } from '../instanceEvents.js';
import { peerBaseUrl } from '../../lib/peerUrl.js';
import { isPairedPeer } from '../../lib/peerPairing.js';
import { PEER_AUTH_HEADER, peerAuthHeaders, peerFetch, readPeerBody } from '../../lib/peerHttpClient.js';
import { ServerError } from '../../lib/errorHandler.js';
import { createKeyCachedQueue } from '../../lib/createKeyCachedQueue.js';
import { withAbortTimeout } from '../../lib/abortTimeout.js';

/**
 * Generate and provision the same pair secret on both ends of a peer link.
 * The peer's saved instance password is used only for this one setup request;
 * subsequent federation requests use the scoped pair token.
 */
const peerPairingQueue = createKeyCachedQueue();

export function pairPeerSyncSecret(id) {
  return peerPairingQueue(id, () => pairPeerSyncSecretNow(id));
}

async function pairPeerSyncSecretNow(id) {
  const peer = (await getPeers()).find((item) => item.id === id);
  if (!peer) throw new ServerError('Peer not found', { status: 404 });
  if (!peer.instanceId || peer.instanceId === UNKNOWN_INSTANCE_ID) {
    throw new ServerError('Probe or connect this peer before pairing sync.', { status: 409, code: 'PEER_IDENTITY_REQUIRED' });
  }
  if (typeof peer.auth?.password !== 'string' || !peer.auth.password) {
    throw new ServerError('Save this peer’s instance password before pairing automatically.', {
      status: 400, code: 'PEER_PAIR_CREDENTIAL_REQUIRED',
    });
  }

  const selfInstanceId = await getInstanceId();
  if (!selfInstanceId || selfInstanceId === UNKNOWN_INSTANCE_ID) {
    throw new ServerError('This instance identity is not ready for peer pairing.', { status: 409, code: 'INSTANCE_IDENTITY_REQUIRED' });
  }
  const syncSecret = isPairedPeer(peer) && peer.peerAuthAccepted !== true
    ? peer.syncSecret
    : crypto.randomBytes(32).toString('base64url');
  const headers = {
    'Content-Type': 'application/json',
    // Force this one-time bootstrap to use the saved instance password, even
    // if a stale pair token is cached locally. The receiver rejects peer-token
    // authority on this operator-scoped setup route.
    [PEER_AUTH_HEADER]: '',
    ...peerAuthHeaders(peer),
  };
  let response;
  try {
    response = await withAbortTimeout(PROBE_TIMEOUT_MS, (signal) => peerFetch(
      `${peerBaseUrl(peer)}/api/instances/peers/pair-secret`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ syncSecret }),
        redirect: 'error',
        signal,
        maxBytes: 64 * 1024,
      },
      peer,
    ));
  } catch {
    throw new ServerError('Couldn’t reach this peer to pair the sync secret. Retry when it is online.', {
      status: 502, code: 'PEER_PAIR_UNREACHABLE',
    });
  }

  if (!response.ok) {
    const message = response.status === 401
      ? 'The peer rejected its saved instance password. Update the peer credential, then retry.'
      : response.status === 404
        ? 'The peer could not pair this instance. Upgrade both peers and make sure they are connected.'
        : response.status === 403
          ? 'The peer requires its instance password for automatic pairing. Save that password on this peer, then retry.'
          : `The peer could not pair the sync secret (HTTP ${response.status}).`;
    throw new ServerError(message, { status: 502, code: 'PEER_PAIR_REJECTED' });
  }
  const body = await readPeerBody(response, 'json', { maxBytes: 64 * 1024, idleTimeoutMs: PROBE_TIMEOUT_MS }).catch(() => null);
  if (body?.paired !== true) {
    throw new ServerError('The peer did not confirm sync-secret pairing.', { status: 502, code: 'PEER_PAIR_UNCONFIRMED' });
  }

  const updated = await updatePeer(id, { syncSecret }, { probe: false });
  if (!updated) throw new ServerError('Peer not found', { status: 404 });
  if (updated.enabled !== false) return (await probePeer(updated).catch(() => null)) || updated;
  return updated;
}

/** Save a pair secret only for the already-registered peer named by its identity header. */
export async function acceptPeerSyncSecretFromPeer(instanceId, syncSecret) {
  let changed = false;
  const peer = await withData(async (data, afterCommit) => {
    const matches = data.peers.filter((item) => item.instanceId === instanceId);
    if (matches.length !== 1) return null;
    const entry = matches[0];
    if (entry.syncSecret !== syncSecret) {
      entry.syncSecret = syncSecret;
      entry.peerAuthAccepted = false;
      changed = true;
    }
    // Pairing also records this machine's choice to accept inbound pushes;
    // sync/category flags still decide which records may be written.
    if (entry.syncSecret && !entry.directions?.includes('inbound')) {
      const directions = Array.isArray(entry.directions) && entry.directions.length ? entry.directions : ['outbound'];
      entry.directions = [...directions, 'inbound'];
      changed = true;
    }
    afterCommit(() => instanceEvents.emit('peers:updated', data.peers));
    return entry;
  });
  if (changed && peer) {
    disconnectFromPeer(peer.id);
    emitPeerAuthRevoked(peer);
  }
  return peer;
}
