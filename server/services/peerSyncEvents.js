/**
 * Realtime peer sync — the apply half. The relay (peerSocketRelay.js) hands
 * every `peer:sync:event` frame from a connected peer here. The sender is the
 * peer the relay connected to, never anything the frame claims. Frames are
 * untrusted: validated, gated on this install's per-peer category config, and
 * applied through the same merge the snapshot path uses. Every refusal is a
 * ⏭️ log, never a throw.
 */
import { peerSyncEventSchema } from '../lib/peerSyncEventSchema.js';
import { rowOwnerCandidates } from '../lib/mediaRowOwners.js';
import { getPeers, peerMayDeleteMedia, resolveEffectiveCategories } from './instances.js';
import { mergeVideoRows, applyRemoteVideoTombstones } from './dataSync.js';
import { mergeMediaTombstones } from './mediaTombstones.js';
import { getHistoryItem } from './videoGen/history.js';
import { listHostedEntries } from './peerHostedMedia.js';
import { stripMachineLocalFields } from './peerSyncEventBus.js';

export { emitPeerSyncEvent } from './peerSyncEventBus.js';

const peerIsPaired = (peer) => typeof peer?.syncSecret === 'string' && peer.syncSecret.length >= 32;

const ignored = (label, reason) => {
  console.log(`⏭️ Peer sync event from ${label} ignored: ${reason}`);
  return { applied: false, reason };
};

async function applyVideoUpsert(peer, event, label) {
  const record = stripMachineLocalFields(event.record);
  if (record.originInstanceId && record.originInstanceId !== event.originInstanceId) {
    return ignored(label, `origin mismatch on ${event.id}`);
  }
  const { count } = await mergeVideoRows([{ ...record, originInstanceId: event.originInstanceId }], { via: 'event', peerId: peer.instanceId });
  if (count > 0) console.log(`🔄 VideoHistory event from ${label}: upserted ${event.id}`);
  return { applied: count > 0, reason: count > 0 ? null : 'unchanged' };
}

// Only a paired peer allowed to delete media here, and only for a row it owns or
// holds (origin, hosted index, or the peer that supplied it). An unknown row just
// records the tombstone so the row cannot arrive later.
async function applyVideoDelete(peer, event, label) {
  if (!peerIsPaired(peer)) return ignored(label, `delete ${event.id} from an unpaired peer`);
  if (!peerMayDeleteMedia(peer)) return ignored(label, `media delete is off for this peer (${event.id})`);
  const row = await getHistoryItem(event.id);
  if (!row) {
    await mergeMediaTombstones('video', [event.tombstone]);
    return { applied: true, reason: 'tombstone-only' };
  }
  if (!rowOwnerCandidates(row, await listHostedEntries()).includes(peer.instanceId)) {
    return ignored(label, `not an owner of ${event.id}`);
  }
  const removed = await applyRemoteVideoTombstones([event.tombstone]);
  if (removed > 0) console.log(`🗑️ VideoHistory event from ${label}: deleted ${event.id}`);
  return { applied: removed > 0, reason: removed > 0 ? null : 'not-removed' };
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
    // imageHistory frames are accepted on the wire but not applied yet.
    if (event.category !== 'videoHistory') return ignored(label, `unsupported category ${event.category}`);
    const peer = (await getPeers()).find((p) => p.id === peerRef?.id);
    if (!peer?.instanceId || peer.enabled === false) return ignored(label, 'unknown or disabled peer');
    if (!resolveEffectiveCategories(peer).videoHistory) return ignored(label, 'videoHistory sync is off for this peer');
    return event.op === 'upsert'
      ? await applyVideoUpsert(peer, event, label)
      : await applyVideoDelete(peer, event, label);
  } catch (err) {
    console.error(`❌ Peer sync event from ${label} failed: ${err.message}`);
    return { applied: false, reason: 'error' };
  }
}
