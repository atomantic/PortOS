/**
 * Realtime peer sync — the emit half. A local mutation calls one of the
 * `announce*`/`emit*` helpers after its write commits; socket.js forwards the
 * bus to (a) relay sockets in the `peer-sync` room whose peer this install
 * shares the frame's category with, and (b) local browser views as an
 * invalidation. Kept free of the sync merge graph so history writers can load
 * it cheaply. Fire-and-forget: nothing here throws, and a dropped frame is
 * repaired by the snapshot loop.
 */
import { EventEmitter } from 'events';
import { peerSyncEventSchema, PEER_SYNC_EVENT_VERSION } from '../lib/peerSyncEventSchema.js';
import { PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';

export const PEER_SYNC_ROOM = 'peer-sync';
export const peerSyncBus = new EventEmitter();

// Frame category → who may receive it: the gate of the pull that carries the
// same change. Video rows ride the `videoHistory` snapshot; gallery images ride
// the library manifest, served to every peer this install shares outbound with.
const RECEIVER_GATE_FOR_EVENT = Object.freeze({
  videoHistory: (shared, peer) => shared.peerAllowsCategoryPull(peer, 'videoHistory'),
  imageHistory: (shared, peer) => shared.peerAllowsOutbound(peer),
});

// Per-machine row fields that never cross the wire (see getVideoHistorySnapshot).
export function stripMachineLocalFields(record) {
  const { hidden, suppliedByInstanceId, pendingDelete, ...rest } = record;
  return rest;
}

const safeEmit = (event, payload) => {
  try {
    peerSyncBus.emit(event, payload);
  } catch (err) {
    console.error(`❌ Peer sync bus ${event} listener failed: ${err.message}`);
  }
};

/** Validate and publish one frame. Returns false (with a ⏭️ log) when it is dropped. */
export function emitPeerSyncEvent(event) {
  const candidate = event?.record && typeof event.record === 'object'
    ? { ...event, record: stripMachineLocalFields(event.record) }
    : event;
  const parsed = peerSyncEventSchema.safeParse(candidate);
  if (!parsed.success) {
    const reason = parsed.error.issues.map((i) => `${i.path.join('.') || 'frame'}: ${i.message}`).join(', ');
    console.log(`⏭️ Peer sync ${event?.category}/${event?.op} ${event?.id} not emitted: ${reason}`);
    return false;
  }
  safeEmit('event', parsed.data);
  return true;
}

/** Local-only invalidation for open history views: `{ kind, op, ids }`. */
export function emitMediaHistoryChanged({ kind, op, ids }) {
  const list = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id);
  if (list.length === 0) return;
  safeEmit('media-history-changed', { kind, op, ids: list });
}

/** Local-only invalidation for open holder views (services/mediaHolders.js). */
export function emitMediaHoldersChanged() {
  safeEmit('media-holders-changed', {});
}

async function localInstanceId() {
  const identity = await import('./instanceIdentity.js');
  const id = await identity.getInstanceId().catch(() => null);
  return typeof id === 'string' && id && id !== identity.UNKNOWN_INSTANCE_ID ? id : null;
}

/** Announce rows this machine just added; only rows it originated go to peers. */
export function announceLocalVideoRows(rows, localOrigin) {
  const added = (Array.isArray(rows) ? rows : []).filter((r) => typeof r?.id === 'string' && r.id);
  if (added.length === 0) return;
  for (const row of added) {
    if (!localOrigin || row.originInstanceId !== localOrigin) continue;
    emitPeerSyncEvent({ v: PEER_SYNC_EVENT_VERSION, category: 'videoHistory', op: 'upsert', id: row.id, record: row, originInstanceId: localOrigin });
  }
  emitMediaHistoryChanged({ kind: 'video', op: 'upsert', ids: added.map((r) => r.id) });
}

/** Announce a committed delete; the tombstone goes to peers only for a row this machine owns. */
export async function announceLocalVideoDelete(item, tombstone) {
  try {
    const local = await localInstanceId();
    if (tombstone && local && item?.originInstanceId === local) {
      emitPeerSyncEvent({ v: PEER_SYNC_EVENT_VERSION, category: 'videoHistory', op: 'delete', id: item.id, tombstone, originInstanceId: local });
    }
  } catch (err) {
    console.error(`❌ Peer sync delete announce failed for ${item?.id}: ${err.message}`);
  }
}

/** Announce a committed gallery image delete; the tombstone goes to peers only for an image this machine owns. */
export async function announceLocalImageDelete(record, tombstone) {
  try {
    const local = await localInstanceId();
    if (tombstone && local && record?.originInstanceId === local) {
      emitPeerSyncEvent({ v: PEER_SYNC_EVENT_VERSION, category: 'imageHistory', op: 'delete', id: record.filename, tombstone, originInstanceId: local });
    }
  } catch (err) {
    console.error(`❌ Peer sync delete announce failed for ${record?.filename}: ${err.message}`);
  }
}

/** Tell peers this machine now holds (or no longer holds) a media file's bytes. Never rejects. */
export async function announceLocalHolding(kind, filename, held) {
  try {
    const local = await localInstanceId();
    if (!local) return;
    const category = kind === 'image' ? 'imageHistory' : 'videoHistory';
    emitPeerSyncEvent({ v: PEER_SYNC_EVENT_VERSION, category, op: 'holding', id: filename, holding: { held: held === true }, originInstanceId: local });
  } catch (err) {
    console.error(`❌ Peer sync holding announce failed for ${filename}: ${err.message}`);
  }
}

// Literal rather than imported: instanceIdentity loads the file store, which
// history writers that load this module must not pull in.
const UNKNOWN_INSTANCE_ID = 'unknown';

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
    const instanceId = handshakeInstanceId(socket.handshake?.headers);
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
    const receives = RECEIVER_GATE_FOR_EVENT[event?.category];
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
