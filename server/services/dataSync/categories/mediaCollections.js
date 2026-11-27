/** Projects and merges media collections while respecting parent privacy and deletion. */

import { join } from 'path';
import { PATHS } from '../../../lib/fileUtils.js';
import { listUniverses } from '../../universeBuilder.js';
import { listSeries } from '../../pipeline/series.js';
import { mergeMediaCollectionsFromSync, listCollections, itemKey } from '../../mediaCollections.js';
import { sanitizeStateForWire } from '../../../lib/syncWire.js';
import { computeChecksum, toExcludeSet } from '../snapshotHelpers.js';
import {
  UNIVERSE_DIR,
  PIPELINE_SERIES_DIR,
  PEER_SUBSCRIPTIONS_FILE,
  UNIVERSE_CHECKSUM_EPOCH,
  PIPELINE_CHECKSUM_EPOCH,
} from '../recordChecksumSources.js';

// A parent changing its ephemeral state affects both collection snapshots and inventories.
export const mediaCollectionsChecksumSources = {
  checksumPaths: [join(PATHS.data, 'media-collections'), UNIVERSE_DIR, PIPELINE_SERIES_DIR, PEER_SUBSCRIPTIONS_FILE],
  checksumEpochs: { ...UNIVERSE_CHECKSUM_EPOCH, ...PIPELINE_CHECKSUM_EPOCH },
};

// Per-universe / per-series buckets of image + video refs. The collection
// records carry the linkage (universeId / seriesId) and an items[] array of
// `{ kind, ref, addedAt }` rows. We sync the JSON itself here (union of items
// + LWW on scalars) so collection edits propagate even when the linked
// universe / series record itself didn't move. The per-record push pipeline
// (peerSync.js) ALSO bundles a record's linked collection in its push payload
// so image bytes flow via the existing asset-pull worker — the snapshot path
// covers the JSON, the push path covers the image bytes.

export async function getWireCollections(exclude, { strictParents = false } = {}) {
  // includeDeleted:true so tombstones cross the wire — matches getUniverseSnapshot
  // / getPipelineSnapshot. Without it, a peer that missed the live delete push
  // (offline/unsubscribed at delete time) never learns the collection was deleted
  // and keeps it live; the receiver (mergeMediaCollectionsFromSync) already LWWs
  // the incoming tombstone so this converges deletes without resurrecting them.
  const collections = await listCollections({ includeDeleted: true });
  // Filter out collections whose linked record (universe or series) is marked
  // ephemeral. Mirrors the per-record push pipeline's local-ephemeral guard
  // (see peerSync.js applyIncomingPush) — without this filter, the
  // mediaCollections snapshot category would still leak the collection name +
  // item refs for records the user explicitly opted out of sync. Tombstoned
  // ephemeral parents also drop their collection (sender wouldn't bundle them
  // anyway, but the snapshot path is independent).
  // Independent reads — fetch the universe and series lists concurrently.
  const [allUniversesForEphemeral, allSeriesForEphemeral] = await Promise.all([
    listUniverses({ includeDeleted: true }).catch((error) => {
      if (strictParents) throw error;
      return [];
    }),
    listSeries({ includeDeleted: true }).catch((error) => {
      if (strictParents) throw error;
      return [];
    }),
  ]);
  const ephemeralUniverseIds = new Set(
    allUniversesForEphemeral.filter((u) => u?.ephemeral === true).map((u) => u.id),
  );
  const ephemeralSeriesIds = new Set(
    allSeriesForEphemeral.filter((s) => s?.ephemeral === true).map((s) => s.id),
  );
  // Exclude collections the requesting peer already receives per-record via
  // the push pipeline (its INBOUND coverage). Keyed on the collection's own
  // id — `mediaCollection` subscriptions target the collection record itself.
  // Un-subscribed collections + tombstones for torn-down subs still ride.
  const excludeSet = toExcludeSet(exclude);
  const filtered = collections.filter((c) => {
    if (excludeSet.has(c?.id)) return false;
    if (c.universeId && ephemeralUniverseIds.has(c.universeId)) return false;
    if (c.seriesId && ephemeralSeriesIds.has(c.seriesId)) return false;
    return true;
  });
  // Canonicalize ordering for the wire so two peers holding identical sets
  // produce identical checksums regardless of write history. Without this
  // sort, on-disk order is insertion-order — peer A and peer B can land the
  // same items in different orders and end up with permanently different
  // checksums, which the UI's cursor-vs-remote comparison reads as "behind"
  // forever. Sort collections by id (stable, unique) and each collection's
  // items by `<kind>:<ref>` (the same key used for set membership in
  // `mergeCollectionItems`).
  // Project through the SHARED wire sanitizer before canonicalizing, so this
  // snapshot and the per-record push agree on which fields cross the wire
  // instead of each deciding for itself (see `sanitizeRecordForWire` — it
  // normalizes the soft-delete pair to tail position, which service-sanitized
  // records already satisfy, and drops the local-only `source` provenance stamp
  // added in #3311 so an upgraded peer's checksum stays byte-stable against a
  // not-yet-upgraded one).
  const { data: wire } = sanitizeStateForWire('mediaCollections', { collections: filtered });
  return wire.collections
    .map((c) => ({
      ...c,
      items: [...(c.items || [])].sort((a, b) => itemKey(a).localeCompare(itemKey(b))),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function getMediaCollectionsSnapshot({ exclude } = {}) {
  const data = { collections: await getWireCollections(exclude) };
  return { data, checksum: computeChecksum(data) };
}

export async function applyMediaCollectionsRemote(remoteData, source) {
  if (!remoteData) return { applied: false, count: 0 };
  // Symmetric receiver-side guard. The sender filters collections linked
  // to local-ephemeral parents in getMediaCollectionsSnapshot, but a
  // peer running an older PortOS (or any non-conformant client) could
  // still ship them. Without this filter, an incoming snapshot could
  // mutate item refs or scalars on a collection whose universe/series
  // the user explicitly marked private.
  const incoming = Array.isArray(remoteData.collections) ? remoteData.collections : [];
  // Build two filter sets per kind: ephemeral parents (privacy) AND
  // tombstoned parents (cleanup integrity). The delete cascade unlinks
  // its collection by clearing the parent id — a peer that still has
  // the parent live could otherwise ship a newer collection snapshot
  // with the old parent id and re-link the collection to our tombstone,
  // undoing the cleanup.
  const [allUniverses, allSeries] = await Promise.all([
    listUniverses({ includeDeleted: true }).catch(() => []),
    listSeries({ includeDeleted: true }).catch(() => []),
  ]);
  const refusedUniverseIds = new Set(
    allUniverses.filter((u) => u?.ephemeral === true || u?.deleted === true).map((u) => u.id),
  );
  const refusedSeriesIds = new Set(
    allSeries.filter((s) => s?.ephemeral === true || s?.deleted === true).map((s) => s.id),
  );
  const filtered = incoming.filter((c) => {
    if (c?.universeId && refusedUniverseIds.has(c.universeId)) return false;
    if (c?.seriesId && refusedSeriesIds.has(c.seriesId)) return false;
    return true;
  });
  // Routes through `mergeMediaCollectionsFromSync` so the read-modify-write
  // runs INSIDE `serializeFileWrite` (same tail as addItem / removeItem /
  // bulkUpdateCollectionItems) — a sync-driven write can't interleave with a
  // concurrent local mutation on the same JSON file.
  // Unioned references do not prove the sender has bytes. Ownership is
  // reconciled separately from its local-file inventory, even on checksum ties.
  const result = await mergeMediaCollectionsFromSync(filtered, { source });
  if (result.applied) {
    console.log(`🔄 MediaCollections sync: merged ${result.count} collection(s)`);
  }
  return result;
}
