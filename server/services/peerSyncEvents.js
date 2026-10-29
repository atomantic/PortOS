/**
 * Realtime peer sync — the apply half. The relay (peerSocketRelay.js) hands
 * every `peer:sync:event` frame from a connected peer here. The sender is the
 * peer the relay connected to, never anything the frame claims. Frames are
 * untrusted: validated, gated on this install's per-peer category config, and
 * applied through the same merge the snapshot path uses. Every refusal is a
 * ⏭️ log, never a throw.
 */
import { peerSyncEventSchema } from '../lib/peerSyncEventSchema.js';
import { getPeers, resolveEffectiveCategories } from './instances.js';
import { authorizeRemoteMediaTombstone } from './mediaTombstoneAuthorization.js';
import { mergeVideoRows, applyRemoteVideoTombstones } from './dataSync.js';
import { mergeMediaTombstones } from './mediaTombstones.js';
import { getHistoryItem } from './videoGen/history.js';
import { listHostedEntries } from './peerHostedMedia.js';
import { stripMachineLocalFields } from './peerSyncEventBus.js';

const ignored = (label, reason) => {
  console.log(`⏭️ Peer sync event from ${label} ignored: ${reason}`);
  return { applied: false, reason };
};

// A sender announces only rows it originated, so the frame's origin must be the sender.
async function applyVideoUpsert(peer, event, label) {
  if (event.originInstanceId !== peer.instanceId) return ignored(label, `upsert ${event.id} for a row it does not originate`);
  const record = stripMachineLocalFields(event.record);
  if (record.originInstanceId && record.originInstanceId !== event.originInstanceId) {
    return ignored(label, `origin mismatch on ${event.id}`);
  }
  const { count } = await mergeVideoRows([{ ...record, originInstanceId: event.originInstanceId }], { via: 'event', peerId: peer.instanceId });
  if (count > 0) console.log(`🔄 VideoHistory event from ${label}: upserted ${event.id}`);
  return { applied: count > 0, reason: count > 0 ? null : 'unchanged' };
}

// Admission is the rule the snapshot path shares (mediaTombstoneAuthorization.js).
async function applyVideoDelete(peer, event, label) {
  const row = await getHistoryItem(event.id);
  const verdict = authorizeRemoteMediaTombstone({
    peer, tombstone: event.tombstone, localRow: row, hostedIndex: await listHostedEntries(),
    via: 'event', eventOriginInstanceId: event.originInstanceId,
  });
  if (!verdict.allowed) return ignored(label, `delete ${event.id}: ${verdict.reason}`);
  if (!row) {
    await mergeMediaTombstones('video', [event.tombstone]);
    return { applied: true, reason: 'tombstone-only' };
  }
  const removed = await applyRemoteVideoTombstones([event.tombstone]);
  if (removed > 0) console.log(`🗑️ VideoHistory event from ${label}: deleted ${event.id}`);
  return { applied: removed > 0, reason: removed > 0 ? null : 'not-removed' };
}

// Gallery images ride the library manifest and the per-record asset pull, so
// only deletes travel as frames; a new image reaches peers on their next sweep.
// The admission rule and the delete are the manifest path's (imageRecords.js).
async function applyImageDelete(peer, event, label) {
  const { admitPeerImageTombstones } = await import('./imageGen/imageRecords.js');
  const { removed, recorded, refused } = await admitPeerImageTombstones(peer, [event.tombstone], {
    via: 'event', eventOriginInstanceId: event.originInstanceId,
  });
  if (refused > 0) return ignored(label, `image delete ${event.id}: not authorized`);
  if (removed > 0) console.log(`🗑️ ImageHistory event from ${label}: deleted ${event.id}`);
  if (recorded > 0) return { applied: true, reason: 'tombstone-only' };
  return { applied: removed > 0, reason: removed > 0 ? null : 'not-removed' };
}

// "I hold / no longer hold <file>": a sender speaks only for its own disk.
async function applyHolding(peer, event, label) {
  if (event.originInstanceId !== peer.instanceId) return ignored(label, `holding ${event.id} for another machine`);
  const { notePeerHolding } = await import('./mediaHolders.js');
  const kind = event.category === 'imageHistory' ? 'image' : 'video';
  const changed = await notePeerHolding(peer.instanceId, kind, event.id, event.holding.held);
  return { applied: changed, reason: changed ? null : 'unchanged' };
}

// Which of this install's per-peer settings lets a peer's frames in: the gate of
// the pull that carries the same change (video snapshot, image library/collections).
const sharesCategory = (peer, category) => {
  const categories = resolveEffectiveCategories(peer);
  return category === 'videoHistory' ? categories.videoHistory === true : categories.mediaCollections === true;
};

async function applyImageEvent(peer, event, label) {
  if (event.op === 'upsert') return ignored(label, `image upsert ${event.id}: images arrive through the library sweep`);
  return applyImageDelete(peer, event, label);
}

/**
 * Apply one frame from the peer whose registry id is `peerRef.id`. The live
 * registry record is re-read so a capability or category change applies to
 * the next frame. Resolves `{ applied, reason }`; never rejects.
 */
export async function applyPeerSyncEvent(peerRef, raw) {
  const label = peerRef?.name || peerRef?.id || 'unknown peer';
  try {
    const parsed = peerSyncEventSchema.safeParse(raw);
    if (!parsed.success) return ignored(label, 'malformed frame');
    const event = parsed.data;
    const peer = (await getPeers()).find((p) => p.id === peerRef?.id);
    if (!peer?.instanceId || peer.enabled === false) return ignored(label, 'unknown or disabled peer');
    if (!sharesCategory(peer, event.category)) return ignored(label, `${event.category} sync is off for this peer`);
    if (event.op === 'holding') return await applyHolding(peer, event, label);
    if (event.category === 'imageHistory') return await applyImageEvent(peer, event, label);
    return event.op === 'upsert'
      ? await applyVideoUpsert(peer, event, label)
      : await applyVideoDelete(peer, event, label);
  } catch (err) {
    console.error(`❌ Peer sync event from ${label} failed: ${err.message}`);
    return { applied: false, reason: 'error' };
  }
}
