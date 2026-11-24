/** Socket subscribers and ordered, category-gated delivery for realtime peer sync. */
import { PEER_SYNC_EVENT_VERSION } from '../lib/peerSyncEventSchema.js';
import { PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';
import { UNKNOWN_INSTANCE_ID } from './instanceIdentity.js';

export const PEER_SYNC_ROOM = 'peer-sync';

// Frame category → who may receive it: the gate of the pull that carries the
// same change. Video rows ride the `videoHistory` snapshot; gallery images ride
// the library manifest, served to every peer this install shares outbound with.
const RECEIVER_GATE_FOR_EVENT = Object.freeze({
  videoHistory: (shared, peer) => shared.peerAllowsCategoryPull(peer, 'videoHistory'),
  imageHistory: (shared, peer) => shared.peerAllowsOutbound(peer),
});

// Same reading as peerPullAuthorization's readCallerInstanceId, without its
// settings/registry imports.
function handshakeInstanceId(headers) {
  const header = headers?.[PEER_INSTANCE_HEADER.toLowerCase()];
  const raw = Array.isArray(header) ? header[0] : header;
  const value = typeof raw === 'string' ? raw.split(',')[0].trim() : '';
  // instanceIdentity's UNKNOWN_INSTANCE_ID (pinned by the test) is no identity,
  // as in the snapshot pull check; a stored peer must never match it.
  return value && value !== UNKNOWN_INSTANCE_ID ? value : null;
}

/**
 * Server side of the room, registered per connection by socket.js. Advertised
 * on connect so a relay subscribes only to a server that allows it. The
 * subscriber's identity is the handshake's X-PortOS-Instance-Id (verified by
 * the pair token when a password is set); a socket with no known peer joins
 * but is never sent a frame.
 */
export function registerPeerSyncSubscriber(socket) {
  socket.emit('peer:sync:available', { v: PEER_SYNC_EVENT_VERSION });
  socket.on('peer:sync:subscribe', async () => {
    // A peer-token socket carries the identity the token verified at connect;
    // the raw header is only trusted when no verified identity exists.
    const instanceId = socket.data?.portosAuthMethod === 'peer' && socket.data.portosPeerInstanceId
      ? socket.data.portosPeerInstanceId
      : handshakeInstanceId(socket.handshake?.headers);
    if (socket.data) socket.data.peerSyncInstanceId = instanceId;
    socket.join(PEER_SYNC_ROOM);
    // `deliver`: whether video-history frames will reach this subscriber now
    // (the delivery gate below), so it knows if it may relax its snapshot pulls.
    socket.emit('peer:sync:subscribed', { ok: true, deliver: await receivesFrames(instanceId, 'videoHistory') });
  });
  socket.on('peer:sync:unsubscribe', () => {
    socket.leave(PEER_SYNC_ROOM);
    socket.emit('peer:sync:unsubscribed');
  });
}

async function receivesFrames(instanceId, category) {
  try {
    if (!instanceId) return false;
    const [{ getPeers }, shared] = await Promise.all([
      import('./instances.js'), import('./sharing/peerSyncShared.js'),
    ]);
    const peer = (await getPeers()).find((p) => p.instanceId === instanceId);
    return Boolean(peer && RECEIVER_GATE_FOR_EVENT[category](shared, peer));
  } catch (err) {
    console.error(`❌ Peer sync subscribe gate failed: ${err.message}`);
    return false;
  }
}

/**
 * Send a frame to every subscribed relay socket whose peer this install shares
 * the frame's category with (the same predicate its pull gate uses).
 * A socket with no identified, known peer gets nothing. Deliveries run one at
 * a time in publication order: each awaits socket and registry reads, and the
 * receiver applies frames in arrival order, so a delete must never overtake
 * the upsert published before it.
 */
let deliveryTail = Promise.resolve();
export function deliverPeerSyncEvent(io, event) {
  const run = deliveryTail.then(() => deliverNow(io, event));
  deliveryTail = run;
  return run;
}

async function deliverNow(io, event) {
  try {
    const receives = Object.hasOwn(RECEIVER_GATE_FOR_EVENT, event?.category) ? RECEIVER_GATE_FOR_EVENT[event.category] : null;
    if (!io || !receives) return 0;
    const sockets = await io.in(PEER_SYNC_ROOM).fetchSockets();
    if (sockets.length === 0) return 0;
    const [{ getPeers }, shared] = await Promise.all([
      import('./instances.js'), import('./sharing/peerSyncShared.js'),
    ]);
    const peers = await getPeers();
    let sent = 0;
    for (const socket of sockets) {
      const instanceId = socket.data?.peerSyncInstanceId;
      const peer = instanceId ? peers.find((p) => p.instanceId === instanceId) : null;
      if (!peer || !receives(shared, peer)) continue;
      socket.emit('peer:sync:event', event);
      sent++;
    }
    return sent;
  } catch (err) {
    console.error(`❌ Peer sync event delivery failed: ${err.message}`);
    return 0;
  }
}
