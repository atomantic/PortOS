/** Projects video history snapshots and applies video rows and authorized tombstones. */

import { join } from 'path';
import { readJSONFile, PATHS } from '../../../lib/fileUtils.js';
import { parseTsMs } from '../../../lib/lwwTimestamp.js';
import { isTombstoned } from '../../../lib/tombstones.js';
import { getPeers } from '../../instances.js';
import { mutateVideoHistory, HISTORY_UNCHANGED, videoRowLiveStamp } from '../../videoGen/history.js';
import { listHostedEntries } from '../../peerHostedMedia.js';
import { authorizeRemoteMediaTombstone } from '../../mediaTombstoneAuthorization.js';
import { rowOwnerCandidates } from '../../../lib/mediaRowOwners.js';
import {
  listMediaTombstones,
  listExportableMediaTombstones,
  mergeMediaTombstones,
  clearMediaTombstone,
} from '../../mediaTombstones.js';
import { emitMediaHistoryChanged } from '../../peerSyncEventBus.js';
import { omitHostedDeletedStamps } from '../../../lib/renderTiming.js';
import { mergeArraysByKey } from '../mergeByKey.js';
import { computeChecksum } from '../snapshotHelpers.js';

export const VIDEO_HISTORY_FILE = join(PATHS.data, 'video-history.json');
// Video tombstones ride the videoHistory snapshot (getVideoHistorySnapshot
// folds them in), so their file must fingerprint the videoHistory cache too.
export const MEDIA_TOMBSTONES_FILE = join(PATHS.data, 'media-tombstones.json');

// `data/video-history.json` is a FLAT array of video-generation rows
// (`{ id, prompt, filename, createdAt, thumbnail, ... }`). MediaCollectionDetail's
// `hydrate()` looks every `{ kind:'video', ref }` collection item up in a
// `videosById` map built from this list — so a synced collection's video items
// are silently filtered out as "missing" on the receiver until the matching row
// arrives. This category rides the same 60s snapshot loop as mediaCollections
// so the rows propagate alongside the collection JSON.
//
// **No exclude-set / `{forPeerId}` filtering applies.** Unlike mediaCollections
// (whose getter drops rows linked to an ephemeral universe/series), video rows
// carry no ephemeral linkage — a video is identified by its bare id, with no
// parent record to opt out of sync. The whole flat list is union-merged.
// (The `.mp4` bytes themselves still flow via the per-record asset-pull worker
// in peerSync.js — this category carries only the JSON metadata row.)

// Read/write the flat history array directly (matching the goals/character
// categories' `readJSONFile`+`atomicWrite` pattern) rather than importing
// videoGen/local.js — that module drags in ffmpeg/spawn machinery we don't
// need on the sync read path, and the on-disk shape is a plain array.
// A video-history row is syncable only if it carries a non-empty string `id`.
// Shared by the snapshot (wire) side and the apply (merge) side so the two can
// never disagree on which rows are keyable — see the convergence note below.
const hasVideoRowId = (r) => typeof r?.id === 'string' && r.id;

export async function readSyncableVideoRows() {
  // STRICT (#4115): an unreadable history would publish a valid CHECKSUM over an
  // empty set — peers conclude this machine holds no videos and the category
  // thrashes forever. Absent is a real empty; unreadable must not go on the wire.
  const raw = await readJSONFile(VIDEO_HISTORY_FILE, [], { strict: true });
  // Exclude rows without a string `id`: applyVideoHistoryRemote can only merge
  // id-keyed rows, so an id-less row in the wire snapshot/checksum would be
  // un-appliable on the receiver — its recomputed checksum would never match the
  // sender's and the two peers would re-download this category forever. Treat
  // id-less rows as strictly local-only on BOTH sides.
  return (Array.isArray(raw) ? raw : []).filter(hasVideoRowId);
}

export async function getVideoHistorySnapshot() {
  const rows = await readSyncableVideoRows();
  // `hidden` is a LOCAL-ONLY visibility flag (e.g. inner chunks of a stitched
  // clip, or a clip the user tucked away). It must NOT influence the wire
  // payload: if the snapshot's content depended on it, two peers that disagree
  // on a row's hidden state would compute different checksums and re-download
  // forever (and a union-merge would never let them converge). So we include
  // the row CONTENT — a shared collection's video still renders on every peer —
  // but strip `hidden` itself so the checksum is hide-state-independent and the
  // flag doesn't propagate (the receiver keeps its own local `hidden` because
  // the immutable-`createdAt` LWW merge keeps the existing row on a tie).
  // `suppliedByInstanceId` is likewise MACHINE-LOCAL (who handed THIS machine the
  // row); stripped so identical row sets hash identically. `originInstanceId` syncs.
  // `pendingDelete` (a delete queued for the row's owner) is this machine's own work.
  // `runwayDeletedAt` / `falDeletedAt` (this machine deleted the provider-hosted copy) are machine-local too.
  // Canonicalize ordering for the wire so two peers holding identical sets
  // produce identical checksums regardless of insertion (newest-first) order.
  // Mirrors getMediaCollectionsSnapshot's sort-by-id rationale.
  const data = {
    videos: rows
      .map(({ hidden, suppliedByInstanceId, pendingDelete, ...rest }) => omitHostedDeletedStamps(rest))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  // Deliberate deletes ride the snapshot so a peer still holding the row can't
  // resurrect it. Sorted by key for a deterministic checksum. The key is OMITTED
  // when empty so a peer with no deletes keeps the exact pre-tombstone checksum
  // (an older peer that ignores `tombstones` would otherwise never converge).
  // A delete still trashing its files is left out until it commits (#14088).
  const tombstones = [...(await listExportableMediaTombstones('video'))].sort((a, b) => a.key.localeCompare(b.key));
  if (tombstones.length > 0) data.tombstones = tombstones;
  return { data, checksum: computeChecksum(data) };
}

export async function applyVideoHistoryRemote(remoteData, source) {
  if (!remoteData) return { applied: false, count: 0 };
  const incomingRows = Array.isArray(remoteData.videos) ? remoteData.videos : [];
  const incomingTombstones = Array.isArray(remoteData.tombstones) ? remoteData.tombstones : [];
  if (incomingRows.length === 0 && incomingTombstones.length === 0) return { applied: false, count: 0 };

  // Tombstones merge first so the row merge below sees the full delete set;
  // only the ones the sender is authorized for ever reach the store.
  const removedCount = await applyRemoteVideoTombstones(await authorizedSnapshotTombstones(incomingTombstones, source));
  const { count } = await mergeVideoRows(incomingRows, source);
  const changedCount = count + removedCount;
  if (changedCount === 0) return { applied: false, count: 0 };
  console.log(`🔄 VideoHistory sync: merged ${changedCount} video row(s)`);
  return { applied: true, count: changedCount };
}

/**
 * The one video-row merge, shared by the snapshot path and realtime
 * `peer:sync:event` upserts. `source.peerId` is the SENDER's instance id.
 * Drops tombstoned rows, then union-merges by id (LWW on `createdAt`) inside the history write queue.
 * Returns `{ count, ids }` for rows actually added or updated.
 */
export async function mergeVideoRows(incomingRows, source) {
  // Only the row's owner may un-delete it: a `restoredAt` from any other
  // sender is dropped, so it can neither pass a delete here nor shield the
  // row from its owner's later delete.
  const fromOwner = (r) => typeof source?.peerId === 'string' && r?.originInstanceId === source.peerId;
  const admitted = (Array.isArray(incomingRows) ? incomingRows : [])
    .map((r) => (r && typeof r === 'object' && 'restoredAt' in r && !fromOwner(r) ? (({ restoredAt, ...rest }) => rest)(r) : r));

  // The whole read/merge/write runs inside the shared history mutation queue so
  // a local completion (videoDownload) or another peer's snapshot can't be
  // overwritten by this merge's stale base. The queue's read is STRICT (#4115):
  // an unreadable file rejects instead of becoming an empty merge base that
  // would delete every local-only row on write-back.
  // Tombstones are read INSIDE the writer: a local delete records its tombstone
  // while holding it, so reading before we queue would miss a delete that commits
  // while we wait and re-add the row it just removed (#14123).
  const changedIds = [];
  let tombstones = [];
  const hostedIndex = await listHostedEntries();
  await mutateVideoHistory(async (local) => {
    tombstones = await listMediaTombstones('video');
    // A row survives a tombstone only when it was (re)created or restored after the delete.
    const incoming = admitted.filter((r) => !(hasVideoRowId(r) && isTombstoned(tombstones, r.id, videoRowLiveStamp(r), 'key')));
    if (incoming.length === 0) return HISTORY_UNCHANGED;
    // Union by `id`, LWW on `createdAt` when both sides know the same row.
    // Video-history rows are append-mostly and immutable once written, so
    // `createdAt` is a sufficient (and the only) freshness signal — there's no
    // `updatedAt`. A row with no string id can't be keyed and is skipped (a
    // hand-edited or corrupt entry shouldn't clobber a real row at key
    // `undefined`); the snapshot side excludes the same rows so checksums agree.
    const hasId = hasVideoRowId;
    // An origin-less copy takes the origin a sender names, but only a sender
    // that already holds delete authority over it (an owner candidate): no peer
    // gains a power it lacked, and the two snapshots' checksums converge.
    const adoptedIds = new Set();
    const keyed = local.filter(hasId).map((row) => {
      if (row.originInstanceId || typeof source?.peerId !== 'string' || !rowOwnerCandidates(row, hostedIndex).includes(source.peerId)) return row;
      const named = incoming.find((r) => hasId(r) && r.id === row.id && typeof r.originInstanceId === 'string' && r.originInstanceId);
      if (!named) return row;
      adoptedIds.add(row.id);
      return { ...row, originInstanceId: named.originInstanceId };
    });
    const before = new Map(keyed.map((r) => [r.id, r]));
    const { merged: lwwMerged, changed: rowsChanged } = mergeArraysByKey(
      keyed,
      // suppliedByInstanceId and pendingDelete are local-only: never trust a sender's value.
      incoming.filter(hasId).map(({ suppliedByInstanceId, pendingDelete, ...rest }) => omitHostedDeletedStamps(rest)),
      'id',
      'createdAt',
    );
    // The Make-primary designation is the one field of a row that moves after
    // creation: the newest valid `primaryAt` of the local and incoming rows wins,
    // whichever side won the row itself (a re-created row must not drop it).
    const incomingById = new Map(incoming.filter(hasId).map((r) => [r.id, r]));
    const designated = (r) => typeof r?.primaryInstanceId === 'string' && r.primaryInstanceId && parseTsMs(r.primaryAt) !== null;
    let primaryChanged = false;
    const rawMerged = lwwMerged.map((row) => {
      const best = [before.get(row.id), incomingById.get(row.id)].filter(designated)
        .reduce((a, b) => (!a || parseTsMs(b.primaryAt) > parseTsMs(a.primaryAt) ? b : a), null);
      if (!best || (row.primaryInstanceId === best.primaryInstanceId && row.primaryAt === best.primaryAt)) return row;
      primaryChanged = true;
      return { ...row, primaryInstanceId: best.primaryInstanceId, primaryAt: best.primaryAt };
    });
    if (!rowsChanged && !primaryChanged && adoptedIds.size === 0) return HISTORY_UNCHANGED;
    // Ownership of a row held here never comes from a sender: its origin and
    // supplier stay the local values, even when absent (an origin-less row stays
    // origin-less, or any peer could claim it and then delete it). Only a row
    // newly added here takes the incoming origin, with this sender as supplier.
    const merged = rawMerged.map((row) => {
      const prev = before.get(row.id);
      if (prev === row) return row;
      const { originInstanceId: incomingOrigin, ...content } = row;
      const originInstanceId = prev ? prev.originInstanceId : incomingOrigin;
      const suppliedByInstanceId = prev ? prev.suppliedByInstanceId : source?.peerId;
      return {
        ...content,
        ...(originInstanceId ? { originInstanceId } : {}),
        ...(suppliedByInstanceId ? { suppliedByInstanceId } : {}),
      };
    });

    // `count` reports rows actually added/updated by this merge (not total
    // post-merge size — that would over-report when callers sum across
    // categories or compare cycle deltas). Matches the pipeline category's
    // `count` contract.
    for (const row of merged) {
      const prev = before.get(row.id);
      if (!prev || prev !== row || adoptedIds.has(row.id)) changedIds.push(row.id);
    }

    // Preserve any local rows that lacked an id (the merge dropped them from its
    // keyed map) — don't let a sync silently delete un-keyable local history.
    const idless = local.filter((r) => !hasId(r));
    // Newest-first to match how generateVideo unshifts new rows + how the
    // Media History grid expects them.
    return [...merged, ...idless].sort((a, b) =>
      String(b?.createdAt ?? '').localeCompare(String(a?.createdAt ?? '')));
  }, { stampOrigin: false });
  // A row admitted past a tombstone held here (re-created or restored by its
  // owner) supersedes it: drop it, or this machine keeps advertising a delete
  // its peers no longer hold and the snapshots never converge.
  const superseded = new Map(tombstones.map((t) => [t.key, t.deletedAt]));
  for (const id of changedIds) {
    if (superseded.has(id)) await clearMediaTombstone('video', id, { deletedAt: superseded.get(id) });
  }
  emitMediaHistoryChanged({ kind: 'video', op: 'upsert', ids: changedIds });
  return { count: changedIds.length, ids: changedIds };
}

// Snapshot tombstones pass the shared admission rule (mediaTombstoneAuthorization.js)
// against the sender's registry record; an unknown sender's are all refused.
async function authorizedSnapshotTombstones(tombstones, source) {
  if (tombstones.length === 0) return [];
  const peer = source?.peerId
    ? (await getPeers().catch(() => [])).find((p) => p.instanceId === source.peerId) ?? null
    : null;
  const local = await readJSONFile(VIDEO_HISTORY_FILE, [], { strict: true });
  const rowsById = new Map((Array.isArray(local) ? local : []).filter(hasVideoRowId).map((r) => [r.id, r]));
  const hostedIndex = await listHostedEntries();
  const accepted = tombstones.filter((tombstone) => authorizeRemoteMediaTombstone({
    peer, tombstone, localRow: rowsById.get(tombstone?.key) ?? null, hostedIndex, via: 'snapshot',
  }).allowed);
  const ignored = tombstones.length - accepted.length;
  if (ignored > 0) console.log(`⏭️ VideoHistory snapshot from ${source?.peerId ?? 'unknown sender'}: ignored ${ignored} tombstone(s)`);
  return accepted;
}

/**
 * Merge an ALREADY AUTHORIZED video tombstone list (authorizeRemoteMediaTombstone)
 * and trash every local row (and its files) it supersedes. Returns the number
 * of local rows removed. `fromRemoteTombstone` keeps deleteHistoryItem from
 * re-recording the tombstone or re-announcing the delete.
 */
export async function applyRemoteVideoTombstones(remoteTombstones, { forgetInMusicVideos = true } = {}) {
  if (!Array.isArray(remoteTombstones) || remoteTombstones.length === 0) return 0;
  await mergeMediaTombstones('video', remoteTombstones);
  const tombstones = await listMediaTombstones('video');
  const local = await readJSONFile(VIDEO_HISTORY_FILE, [], { strict: true });
  // Only the rows these authorized tombstones name: a row another tombstone
  // in the store covers has not been admitted for this sender.
  const keys = new Set(remoteTombstones.map((t) => t?.key).filter((key) => typeof key === 'string'));
  const doomed = (Array.isArray(local) ? local : [])
    .filter((r) => hasVideoRowId(r) && keys.has(r.id) && isTombstoned(tombstones, r.id, videoRowLiveStamp(r), 'key'));
  if (doomed.length === 0) return 0;
  // Lazy import: historyOps pulls in trash/ffmpeg machinery the sync read path avoids.
  const { deleteHistoryItem } = await import('../../videoGen/historyOps.js');
  let removed = 0;
  const failures = [];
  for (const row of doomed) {
    try {
      // Re-checked under the history writer: a replacement row written since the
      // read above carries a newer createdAt and must survive this tombstone.
      const result = await deleteHistoryItem(row.id, {
        fromRemoteTombstone: true,
        forgetInMusicVideos,
        onlyIf: (current) => isTombstoned(tombstones, current.id, videoRowLiveStamp(current), 'key'),
      });
      if (result?.skipped) {
        console.log(`⏭️ VideoHistory tombstone: ${row.id} was re-created since the delete`);
        continue;
      }
      removed++;
    } catch (err) {
      // Row already gone is an expected race with a concurrent local delete.
      if (err?.code === 'NOT_FOUND') {
        console.log(`⏭️ VideoHistory tombstone: ${row.id} already removed`);
        continue;
      }
      console.error(`❌ VideoHistory tombstone removal failed for ${row.id}: ${err.message}`);
      failures.push(row.id);
    }
  }
  // Fail the apply so the caller retries (a snapshot keeps its checksum uncached)
  // instead of leaving a tombstoned row and its files in place.
  if (failures.length > 0) {
    throw new Error(`VideoHistory tombstone removal failed for ${failures.length} row(s): ${failures.join(', ')}`);
  }
  return removed;
}
