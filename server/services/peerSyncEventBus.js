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
import { getPeers } from './instances.js';
import { peerAllowsCategoryPull } from './sharing/peerSyncShared.js';
import { getInstanceId, UNKNOWN_INSTANCE_ID } from './instanceIdentity.js';

export const PEER_SYNC_ROOM = 'peer-sync';
export const peerSyncBus = new EventEmitter();

// Frame category → the per-peer sync category that governs who may receive it.
// imageHistory has no sync category yet, so its frames reach nobody.
const SYNC_CATEGORY_FOR_EVENT = Object.freeze({ videoHistory: 'videoHistory' });

// Per-machine row fields that never cross the wire (see getVideoHistorySnapshot).
export function stripMachineLocalFields(record) {
  const { hidden, suppliedByInstanceId, ...rest } = record; // eslint-disable-line no-unused-vars
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

async function localInstanceId() {
  const id = await getInstanceId().catch(() => null);
  return typeof id === 'string' && id && id !== UNKNOWN_INSTANCE_ID ? id : null;
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

/**
 * Send a frame to every subscribed relay socket whose peer this install shares
 * the frame's category with (the same predicate the snapshot pull gate uses).
 * A socket with no identified, known peer gets nothing.
 */
export async function deliverPeerSyncEvent(io, event) {
  try {
    const category = SYNC_CATEGORY_FOR_EVENT[event?.category];
    if (!io || !category) return 0;
    const sockets = await io.in(PEER_SYNC_ROOM).fetchSockets();
    if (sockets.length === 0) return 0;
    const peers = await getPeers();
    let sent = 0;
    for (const socket of sockets) {
      const instanceId = socket.data?.peerSyncInstanceId;
      const peer = instanceId ? peers.find((p) => p.instanceId === instanceId) : null;
      if (!peer || !peerAllowsCategoryPull(peer, category)) continue;
      socket.emit('peer:sync:event', event);
      sent++;
    }
    return sent;
  } catch (err) {
    console.error(`❌ Peer sync event delivery failed: ${err.message}`);
    return 0;
  }
}
