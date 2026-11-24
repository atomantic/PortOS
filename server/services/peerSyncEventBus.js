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
import { omitHostedDeletedStamps } from '../lib/renderTiming.js';

export const peerSyncBus = new EventEmitter();

// Per-machine row fields that never cross the wire (see getVideoHistorySnapshot).
export function stripMachineLocalFields(record) {
  const { hidden, suppliedByInstanceId, pendingDelete, ...rest } = record;
  return omitHostedDeletedStamps(rest);
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

/**
 * Local-only "this kind's whole list may have changed" invalidation, for a bulk
 * pass that does not track which rows moved (the post-listen media index sweep).
 * Open list views refetch on any event of their kind; per-record views match on
 * `ids`, so the empty list leaves them alone.
 */
export function emitMediaListChanged(kind) {
  safeEmit('media-history-changed', { kind, op: 'reconcile', ids: [] });
}

/** Local-only invalidation for open holder views (services/mediaHolders.js). */
export function emitMediaHoldersChanged() {
  safeEmit('media-holders-changed', {});
}

export function emitCollectionPrimaryChanged(id) {
  safeEmit('collection-primary-changed', { id });
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
