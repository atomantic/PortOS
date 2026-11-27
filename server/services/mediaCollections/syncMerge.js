/** Reconcile incoming collections and prune acknowledged tombstones. */

import { store, COLLECTION_WRITE_CONCURRENCY, sanitizeCollection, isSupersededByRemoval } from './collectionStore.js';
import {
  withBaseHashFlushBatch, deleteSyncBaseHash, setSyncBaseHash, contentHashForRecord,
  maybeJournalBeforeOverwrite, flushBaseHashes,
} from '../../lib/conflictJournal.js';
import { mapWithConcurrency } from '../../lib/mapWithConcurrency.js';
import { parseTsMs, compareNewerWins, compareEarlierWins } from '../../lib/lwwTimestamp.js';
import { itemKey } from '../../lib/mediaItemKey.js';

// Hard-remove tombstoned collections whose deletedAt is older than the cutoff.
// Called by tombstoneGc once every subscribed peer has acked the deletion.
export async function pruneTombstonedCollections(olderThanMs) {
  if (!Number.isFinite(olderThanMs)) return { pruned: 0 };
  const all = await store().loadAll();
  const candidates = all.filter((c) => {
    if (c.deleted !== true) return false;
    const ms = Date.parse(c.deletedAt || '');
    return Number.isFinite(ms) && ms < olderThanMs;
  });
  // Candidates have distinct ids → distinct per-record queues, so prune them
  // with a bounded fan-out instead of one-at-a-time. Each returns whether it
  // actually pruned; sum after (no shared mutable counter across the workers).
  // Each worker catches its own error so mapWithConcurrency never rejects mid-
  // flight (which would let the OTHER in-flight workers keep writing in the
  // background past our return); we rethrow the first error after every worker
  // has settled, preserving the throw-on-failure contract without leaking
  // background writes.
  let firstError = null;
  const outcomes = await withBaseHashFlushBatch(() =>
    mapWithConcurrency(candidates, COLLECTION_WRITE_CONCURRENCY, (c) =>
      store().queueRecordWrite(c.id, async () => {
        // Re-check inside the queue (deleteOneNow spans the load→delete boundary)
        // so a concurrent re-create at the same id isn't blown away.
        const cur = await store().loadOne(c.id);
        if (!cur || cur.deleted !== true) return false;
        const ms = Date.parse(cur.deletedAt || '');
        if (!(Number.isFinite(ms) && ms < olderThanMs)) return false;
        await store().deleteOneNow(c.id);
        // Evict the conflict-journal base hash so the side store doesn't grow
        // dead keys (mirrors pruneTombstonedUniverses / pruneTombstonedSeries).
        await deleteSyncBaseHash('mediaCollection', c.id);
        return true;
      }).catch((err) => { if (!firstError) firstError = err; return false; })));
  if (firstError) throw firstError;
  return { pruned: outcomes.filter(Boolean).length };
}

// Drop item removal records older than the cutoff from live collections.
// Called by tombstoneGc with a cutoff every subscribed peer has acknowledged,
// so no peer still holds a pre-removal copy the record would have to defeat.
// Housekeeping, not an edit: `updatedAt` is left alone so the prune can't win
// LWW over a peer's real scalar change. Returns the number of records dropped.
export async function pruneCollectionItemRemovals(olderThanMs) {
  if (!Number.isFinite(olderThanMs)) return { pruned: 0 };
  const isExpired = (removedAt) => parseTsMs(removedAt) < olderThanMs;
  const candidates = (await store().loadAll()).filter((c) =>
    c.deleted !== true && Object.values(c.removedItems || {}).some(isExpired));
  let firstError = null;
  const outcomes = await mapWithConcurrency(candidates, COLLECTION_WRITE_CONCURRENCY, (c) =>
    store().queueRecordWrite(c.id, async () => {
      const cur = await store().loadOne(c.id);
      if (!cur || cur.deleted === true || !cur.removedItems) return 0;
      const kept = Object.entries(cur.removedItems).filter(([, removedAt]) => !isExpired(removedAt));
      const dropped = Object.keys(cur.removedItems).length - kept.length;
      if (dropped === 0) return 0;
      const { removedItems: _removedItems, ...rest } = cur;
      await store().saveOneNow(c.id, kept.length ? { ...rest, removedItems: Object.fromEntries(kept) } : rest);
      return dropped;
    }).catch((err) => { if (!firstError) firstError = err; return 0; }));
  if (firstError) throw firstError;
  return { pruned: outcomes.reduce((sum, n) => sum + n, 0) };
}

/**
 * Merge an incoming list of collections from a peer (snapshot sync OR the
 * per-record push payload's `linkedCollection` field). Per-collection
 * semantics:
 *
 *   - New (unseen id): inserted verbatim after sanitization.
 *   - Existing id: top-level scalars (name, description, coverKey, universeId,
 *     seriesId) follow LWW on `updatedAt`. Items[] is **union by `kind:ref`**
 *     minus copies a newer per-item removal record supersedes (see
 *     `mergeCollectionItems`) — a divergence (peer-A added image-X while
 *     peer-B added image-Y to the same collection on the same day) retains
 *     both rather than discarding whichever has the older collection-level
 *     updatedAt, while a deliberate removal sticks against a peer that still
 *     holds the item.
 *
 * Each remote collection's merge runs inside the store's per-record queue
 * (`queueRecordWrite(id)`), so a concurrent local `addItem` and a remote apply
 * against the SAME collection can't interleave, while merges of DIFFERENT
 * collections proceed in parallel.
 */
export async function mergeMediaCollectionsFromSync(remoteCollections, { source = { via: 'sync', peerId: null } } = {}) {
  if (!Array.isArray(remoteCollections)) return { applied: false, count: 0 };
  // Distinct collection ids ride distinct per-record queues, so apply the
  // snapshot batch with a bounded fan-out rather than one-at-a-time. (A duplicate
  // id within the batch still serializes on the same queue, and the merge is
  // LWW so its outcome is order-independent.) The base-hash mutations each
  // record makes accumulate in memory and are persisted by the single
  // `flushBaseHashes()` after the fan-out settles — unchanged from the
  // sequential version.
  //
  // Each worker catches its own error so mapWithConcurrency never rejects mid-
  // flight: an early reject would let the other in-flight workers keep writing
  // (and mutating the in-memory base-hash map) in the background past our return
  // AND skip the flush below, stranding completed writes' base hashes unsaved.
  // We let every worker settle, ALWAYS flush, then rethrow the first error.
  let firstError = null;
  const outcomes = await mapWithConcurrency(remoteCollections, COLLECTION_WRITE_CONCURRENCY, (remote) => {
    const sanitized = sanitizeCollection(remote);
    if (sanitized) delete sanitized.primaryInstanceId;
    if (!sanitized) return false;
    return store().queueRecordWrite(sanitized.id, async () => {
      const local = await store().loadOne(sanitized.id);
      if (!local) {
        await store().saveOneNow(sanitized.id, sanitized);
        // No local counterpart to lose — nothing to journal, but seed the base
        // hash so a FUTURE scalar divergence on this collection is detected.
        await setSyncBaseHash('mediaCollection', sanitized.id, contentHashForRecord('mediaCollection', sanitized));
        return true;
      }
      const { items: mergedItems, removedItems: mergedRemovals } = mergeCollectionItems(local, sanitized);
      // LWW on collection-level scalars. Parse to epoch ms (not lexicographic
      // compare on the raw strings): `sanitizeCollection` accepts any
      // Date.parse-able string for `updatedAt`, so a hand-edit or older peer
      // writing a non-ISO format could otherwise lose to a "newer" string
      // that's actually an older moment in time. Unparseable side LOSES (a
      // corrupted timestamp can't claim to be newer); both unparseable
      // breaks to local-wins (no signal to override). `localTs`/`remoteTs`
      // keep the original strings so the winning side's `updatedAt`
      // round-trips to disk verbatim — only the comparison is numeric.
      const localTs = local.updatedAt || '';
      const remoteTs = sanitized.updatedAt || '';
      const remoteWins = compareNewerWins(remoteTs, localTs);
      if (remoteWins) {
        // Remote's scalars are about to overwrite local's. Non-blocking conflict
        // journal: archive the about-to-be-lost local version when BOTH sides
        // diverged from the last synced base — but only over the SCALAR SUBSET
        // (contentHashForRecord narrows mediaCollection to its overwritable
        // scalars, so an item-only divergence — items and removal records merge
        // per key, never overwritten — does NOT false-positive here). Always
        // advances the base hash (clean or conflict) so the next snapshot cycle
        // doesn't re-journal the same divergence. Never throws into the merge.
        // Skipped when local wins: local scalars are KEPT, so there's nothing to
        // lose (and the base stays put — it advances only on an accepted
        // overwrite, mirroring universe).
        await maybeJournalBeforeOverwrite({ kind: 'mediaCollection', id: sanitized.id, local, remote: sanitized, source });
      }
      const scalarSource = remoteWins ? sanitized : local;
      // Cover key: only adopt the scalar source's coverKey if it points at an
      // item that survives the union — otherwise sanitizeCollection on next
      // read would drop it back to null and we'd churn updatedAt forever.
      const scalarDeleted = scalarSource.deleted === true;
      const presentKeys = new Set(mergedItems.map(itemKey));
      const coverKey = !scalarDeleted && scalarSource.coverKey && presentKeys.has(scalarSource.coverKey)
        ? scalarSource.coverKey
        : null;
      // NOTE — `source` (#3311) is deliberately absent from the scalar list
      // below. It is a LOCAL-ONLY provenance stamp that `sanitizeRecordForWire`
      // strips before sending, so a remote record never carries one and a
      // remote-wins overwrite must not be able to clear ours. The `...local`
      // spread preserves it; a brand-new record inserted above keeps whatever
      // the sanitizer accepted (an offline export/import bundle can legitimately
      // carry it). Do NOT add it to the LWW scalars without also un-stripping it
      // on the wire — and that needs a schemaVersions bump.
      // Re-sanitized so a record that newly gains `removedItems` lands in the
      // canonical key order the equality check and the wire checksum rely on.
      const next = sanitizeCollection({
        ...local,
        name: scalarSource.name,
        description: scalarSource.description,
        coverKey: scalarDeleted ? null : coverKey,
        universeId: scalarDeleted ? null : scalarSource.universeId,
        seriesId: scalarDeleted ? null : scalarSource.seriesId,
        items: scalarDeleted ? [] : mergedItems,
        removedItems: scalarDeleted ? undefined : mergedRemovals,
        updatedAt: remoteWins ? remoteTs : localTs,
        deleted: scalarDeleted,
        deletedAt: scalarDeleted ? (scalarSource.deletedAt || (remoteWins ? remoteTs : localTs)) : null,
      });
      if (collectionsEqual(local, next)) return false;
      await store().saveOneNow(sanitized.id, next);
      return true;
    }).catch((err) => { if (!firstError) firstError = err; return false; });
  });
  const changed = outcomes.filter(Boolean).length;
  // Persist the batched conflict-journal base-hash updates accumulated above in
  // one write (seeds on insert + advances on accepted overwrite). Always runs —
  // even if a worker threw — so completed writes' base hashes aren't stranded.
  await flushBaseHashes();
  if (firstError) throw firstError;
  if (changed === 0) return { applied: false, count: 0 };
  return { applied: true, count: changed };
}

// Union of both sides' items, minus any copy a removal record supersedes. The
// removal maps merge latest-wins per key, and an item is kept when EITHER side
// holds a copy added after the merged removal — so concurrent adds are never
// lost, and a removal wins only over copies that predate it.
function mergeCollectionItems(local, remote) {
  const removedItems = { ...local.removedItems };
  for (const [k, removedAt] of Object.entries(remote.removedItems || {})) {
    if (compareNewerWins(removedAt, removedItems[k])) removedItems[k] = removedAt;
  }
  const byKey = new Map();
  for (const it of [...(local.items || []), ...(remote.items || [])]) {
    if (isSupersededByRemoval(it, removedItems)) continue;
    const k = itemKey(it);
    const existing = byKey.get(k);
    if (!existing) {
      byKey.set(k, it);
      continue;
    }
    // Earliest addedAt wins — a sync replay shouldn't bump the addedAt of
    // an item already in the collection. Parse to epoch ms instead of
    // lexicographic compare: `sanitizeItem` keeps any Date.parse-able
    // string (not strictly ISO-8601), so two parseable-but-different-format
    // timestamps could compare incorrectly as strings. Tie → existing wins
    // (matches the previous `<=` behavior — sync replay shouldn't churn).
    const cmp = compareEarlierWins(existing.addedAt, it.addedAt);
    const earlier = cmp <= 0 ? existing : it;
    byKey.set(k, earlier);
  }
  // Sort by canonical itemKey so the merged output is deterministic
  // regardless of insertion order. Without this, the same set of items
  // arriving in different orders from a peer (or replayed from snapshot
  // vs. push) produces a different array order — and the downstream
  // collectionsEqual() JSON.stringify equality check then sees a diff
  // and triggers a redundant write + checksum churn. The dataSync
  // snapshot path already sorts collections by id and items by key for
  // wire stability; aligning the in-memory merge keeps reads and writes
  // self-consistent.
  const items = Array.from(byKey.values()).sort((a, b) => itemKey(a).localeCompare(itemKey(b)));
  return { items, removedItems };
}

function collectionsEqual(a, b) {
  // Both sides come through sanitizeCollection so key order is canonical and
  // JSON.stringify is sufficient for "did anything actually move".
  return JSON.stringify(a) === JSON.stringify(b);
}
