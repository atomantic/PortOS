/** Create, edit and join media collections and their items. */

import {
  NAME_MAX_LENGTH, ERR_VALIDATION, COLLECTION_SOURCES, DESCRIPTION_MAX_LENGTH, store,
  announceNewCollection, getCollection, ITEMS_MAX, assertCollectionId, sanitizePrimaryInstanceId,
  ERR_NOT_FOUND, ERR_DUPLICATE, stampAfter, sanitizeRemovedItems, listCollections,
} from './collectionStore.js';
import { codedError } from '../../lib/codedError.js';
import { randomUUID } from 'crypto';
import { itemKey, ITEM_KIND, REF_MAX_LENGTH } from '../../lib/mediaItemKey.js';
import { compareEarlierWins } from '../../lib/lwwTimestamp.js';
import { emitRecordUpdated, emitRecordDeleted } from '../sharing/recordEvents.js';

// `source` defaults to 'user' because the HTTP POST route is the only caller
// that doesn't pass it — a person clicking "New collection". Machine flows
// (Creative Director, Writers Room) pass `source: 'auto'` explicitly. The route
// schema doesn't accept `source`, so a client can't claim either stamp.
export function createCollection(input) {
  return persistNewCollection(input, []);
}

async function persistNewCollection({ name, description = '', source = 'user' }, items) {
  // Service-layer guards mirror sanitizeCollection so a direct caller
  // (tests, future internal usage) can't persist a record that the next
  // listCollections() read would silently drop.
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (!trimmedName || trimmedName.length > NAME_MAX_LENGTH) {
    throw codedError('Collection name is required (1..' + NAME_MAX_LENGTH + ' chars)', ERR_VALIDATION);
  }
  if (!COLLECTION_SOURCES.includes(source)) {
    throw codedError(`source must be one of ${COLLECTION_SOURCES.join('|')}`, ERR_VALIDATION);
  }
  const trimmedDescription = typeof description === 'string'
    ? description.trim().slice(0, DESCRIPTION_MAX_LENGTH)
    : '';
  const id = randomUUID();
  const created = await store().queueRecordWrite(id, async () => {
    const now = new Date().toISOString();
    const next = {
      id,
      name: trimmedName,
      description: trimmedDescription,
      coverKey: null,
      source,
      items,
      createdAt: now,
      updatedAt: now,
    };
    await store().saveOneNow(id, next);
    return next;
  });
  announceNewCollection(created.id);
  return created;
}

// An owner-managed collection has a deterministic id (mood board, music video,
// deck, commission, …) or a universe/series link: its owner finds it by that id,
// so a join copies its items but never retires it.
// The shape of randomUUID(); fileCore's UUID_RE would pull its child-process
// imports into every suite that loads collections.
const RANDOM_COLLECTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isOwnerManaged = (collection) => !RANDOM_COLLECTION_ID.test(collection.id)
  || Boolean(collection.universeId) || Boolean(collection.seriesId);

// Point every record that files renders into one of `fromIds` at `toId`, so
// retiring them does not make an owner mint a fresh bucket on its next render.
// Random-id collections are minted only by Creative Director projects and
// Writers Room works.
async function retargetCollectionOwners(fromIds, toId) {
  const [{ repointProjectCollections }, { repointWorkMediaCollections }] = await Promise.all([
    import('../creativeDirector/local.js'),
    import('../writersRoom/local.js'),
  ]);
  await Promise.all([repointProjectCollections(fromIds, toId), repointWorkMediaCollections(fromIds, toId)]);
}

/**
 * Merge several collections into one. The destination is the selected
 * collection already carrying `name` (an owner-managed one first), else a new
 * collection. Unless `keepOriginals`, every other selected collection is then
 * retired: its owners are re-pointed at the destination and it is tombstoned,
 * so the merge propagates to peers. Owner-managed sources are kept.
 */
export async function joinCollections({ name, collectionIds, keepOriginals = false }) {
  const ids = [...new Set(collectionIds)];
  if (ids.length < 2) throw codedError('Select at least two collections to join', ERR_VALIDATION);

  // Read each source before writing the destination so a stale selection or
  // oversized union leaves no empty or partially populated collection behind.
  const sources = [];
  const itemsByKey = new Map();
  for (const id of ids) {
    const collection = await getCollection(id);
    sources.push(collection);
    for (const item of collection.items) {
      const key = itemKey(item);
      const existing = itemsByKey.get(key);
      if (!existing || compareEarlierWins(item.addedAt, existing.addedAt) < 0) itemsByKey.set(key, item);
    }
    if (itemsByKey.size > ITEMS_MAX) {
      throw codedError(`Joined collection exceeds the limit of ${ITEMS_MAX} items`, ERR_VALIDATION);
    }
  }
  const union = [...itemsByKey.values()];
  const needle = name.trim().toLowerCase();
  const named = sources.filter((c) => c.name.trim().toLowerCase() === needle);
  const target = named.find(isOwnerManaged) ?? named[0] ?? null;
  const joined = target
    ? (await bulkUpdateCollectionItems(target.id, { add: union.map(({ kind, ref }) => ({ kind, ref })) })).collection
    : await persistNewCollection({ name }, union);

  const others = sources.filter((source) => source.id !== joined.id);
  const retire = keepOriginals ? [] : others.filter((source) => !isOwnerManaged(source)).map((source) => source.id);
  const keptCollectionIds = others.map((source) => source.id).filter((id) => !retire.includes(id));
  if (retire.length) await retargetCollectionOwners(retire, joined.id);
  for (const id of retire) {
    // A render filed into a source after it was read above moves too, so the
    // tombstone (which empties the record) loses nothing.
    const latest = await getCollection(id).catch(() => null);
    const late = (latest?.items || []).filter((item) => !itemsByKey.has(itemKey(item)));
    if (late.length) await bulkUpdateCollectionItems(joined.id, { add: late.map(({ kind, ref }) => ({ kind, ref })) });
    await deleteCollection(id);
  }
  return { ...joined, removedCollectionIds: retire, keptCollectionIds };
}

// The `updateCollection` patch keys that peers can actually observe. Anything
// outside this list is local-only and must not advance `updatedAt` (the LWW
// clock every peer compares against) — see the `source` note below.
const WIRE_VISIBLE_PATCH_FIELDS = ['name', 'description', 'coverKey'];

// The selected machine is an operator preference for this install. Peers sync
// each asset's primary through the existing media records.
export async function setCollectionPrimaryMachine(id, instanceId) {
  assertCollectionId(id);
  if (!sanitizePrimaryInstanceId(instanceId)) throw codedError('Invalid primary machine', ERR_VALIDATION);
  return store().queueRecordWrite(id, async () => {
    const current = await getCollection(id);
    if (current.primaryInstanceId === instanceId) return current;
    const next = { ...current, primaryInstanceId: instanceId };
    await store().saveOneNow(id, next);
    return next;
  });
}

export async function updateCollection(id, patch) {
  assertCollectionId(id);
  const merged = await store().queueRecordWrite(id, async () => {
    const cur = await store().loadOne(id);
    if (!cur) throw codedError(`Collection not found: ${id}`, ERR_NOT_FOUND);
    if (cur.deleted === true) throw codedError(`Collection not found: ${id}`, ERR_NOT_FOUND);
    // Product/UI constraint: universe-linked collections own their visible
    // name. The name is the user-facing identity of a universe's bucket, so
    // renaming it independent of the universe is confusing — the supported
    // workflow is renaming the universe (which cascades down via
    // renameCollectionForUniverse). Routing is by `universeId` regardless;
    // this lock exists to keep what the user sees consistent with the
    // universe's name, not to prevent routing forks.
    if ('name' in patch && cur.universeId && patch.name !== cur.name) {
      throw codedError(
        'This collection is linked to a Universe — rename the universe to rename it.',
        ERR_VALIDATION,
      );
    }
    if ('name' in patch && cur.seriesId && patch.name !== cur.name) {
      throw codedError(
        'This collection is linked to a Series — rename the series to rename it.',
        ERR_VALIDATION,
      );
    }
    // Cover key validation is deferred to sanitizeCollection on read, but we
    // also reject up-front so the API gives a clear error rather than silently
    // dropping the cover.
    if (patch.coverKey != null && !cur.items.find((it) => itemKey(it) === patch.coverKey)) {
      throw codedError('coverKey must reference an item in this collection', ERR_VALIDATION);
    }
    const merged = {
      ...cur,
      ...('name' in patch ? { name: patch.name } : {}),
      ...('description' in patch ? { description: patch.description } : {}),
      ...('coverKey' in patch ? { coverKey: patch.coverKey } : {}),
      // Provenance is correctable (#3311). The migration classifies legacy
      // records from markers a user could in principle have typed themselves
      // (a description starting `Auto-created for project …`), so "the stamp is
      // wrong and I can't fix it" must not be a dead end. Local-only like the
      // rest of the field — this edit never leaves the install.
      ...('source' in patch ? { source: patch.source } : {}),
      // A source-only edit changes nothing a peer can see (the field is
      // stripped from the wire), so it must NOT advance the shared LWW clock —
      // same reasoning as migration 220 leaving `updatedAt` alone. Otherwise
      // correcting a badge locally would out-race a peer's real edit.
      updatedAt: WIRE_VISIBLE_PATCH_FIELDS.some((k) => k in patch)
        ? new Date().toISOString()
        : cur.updatedAt,
    };
    await store().saveOneNow(id, merged);
    return merged;
  });
  // A standalone collection (no universe/series link) reaches peers ONLY via a
  // direct per-record mediaCollection subscription — without this emit a
  // rename/description/cover edit never propagates. For linked collections the
  // universe/series emit nudges the share-bucket re-export. Emit outside the
  // serialized critical section so subscribers' own reads don't deadlock the tail.
  emitRecordUpdated('mediaCollection', merged.id);
  if (merged.universeId) emitRecordUpdated('universe', merged.universeId);
  if (merged.seriesId) emitRecordUpdated('series', merged.seriesId);
  return merged;
}

export async function deleteCollection(id) {
  assertCollectionId(id);
  const { universeId: deletedUniverseId, seriesId: deletedSeriesId, alreadyDeleted } = await store().queueRecordWrite(id, async () => {
    const target = await store().loadOne(id);
    if (!target) throw codedError(`Collection not found: ${id}`, ERR_NOT_FOUND);
    // Idempotent on an already-tombstoned record: re-stamping deletedAt/
    // updatedAt would make an old tombstone look "newer" to a peer's LWW (and
    // re-emitting churns the sync pipeline). Return without rewriting or
    // re-emitting.
    if (target.deleted === true) return { universeId: null, seriesId: null, alreadyDeleted: true };
    const now = new Date().toISOString();
    // Soft-delete: keep the record on disk as a tombstone (NOT deleteOne) so it
    // still syncs to peers as a deletion. Clear coverKey/items too — with items
    // emptied the cover would otherwise dangle and leak into the wire payload.
    // Item removal records go too: a tombstone holds no items to protect.
    const { removedItems: _removedItems, ...live } = target;
    const tombstone = { ...live, deleted: true, deletedAt: now, updatedAt: now, items: [], coverKey: null, universeId: null, seriesId: null };
    await store().saveOneNow(id, tombstone);
    return { universeId: target.universeId || null, seriesId: target.seriesId || null, alreadyDeleted: false };
  });
  if (alreadyDeleted) return { id };
  // Mirror addItem/removeItem/bulkUpdateCollectionItems — universe-linked
  // shares need to know membership changed so the subscriber doesn't keep
  // publishing the deleted collection's contents until an unrelated edit
  // fires. Emit outside the serialized critical section so subscribers'
  // own reads don't deadlock the tail.
  if (deletedUniverseId) emitRecordUpdated('universe', deletedUniverseId);
  if (deletedSeriesId) emitRecordUpdated('series', deletedSeriesId);
  emitRecordDeleted('mediaCollection', id);
  return { id };
}

// Mirror sanitizeItem so direct callers (addItem + bulkUpdateCollectionItems)
// can't write a record that the next listCollections() would drop (silent add).
// Returns a normalized `{ kind, ref }` so callers don't re-trim.
const validateItemInput = (item) => {
  if (!item || !ITEM_KIND.has(item.kind)) {
    throw codedError('item.kind must be "image" or "video"', ERR_VALIDATION);
  }
  const ref = typeof item.ref === 'string' ? item.ref.trim() : '';
  if (!ref || ref.length > REF_MAX_LENGTH || ref.includes(':')) {
    throw codedError('item.ref invalid (empty, too long, or contains ":")', ERR_VALIDATION);
  }
  // Mirror sanitizeItem's path-traversal rejection so the write path can't
  // persist a ref that the next listCollections() read would silently drop
  // (which would also churn coverKey/updatedAt for the dangling-cover guard).
  // Reject separators and exact `.`/`..` segments only — `..` inside a
  // basename (`my..render.png`) is a legitimate gallery filename. Must
  // mirror sanitizeItem exactly or local addItem rejects refs that peer
  // sync would accept (and vice versa).
  if (ref.includes('/') || ref.includes('\\')) {
    throw codedError('item.ref invalid (contains path separators)', ERR_VALIDATION);
  }
  if (ref === '.' || ref === '..') {
    throw codedError('item.ref invalid (parent-directory segment)', ERR_VALIDATION);
  }
  return { kind: item.kind, ref };
};

export async function addItem(id, item) {
  const { kind, ref } = validateItemInput(item);
  assertCollectionId(id);
  const merged = await store().queueRecordWrite(id, async () => {
    const cur = await store().loadOne(id);
    if (!cur) throw codedError(`Collection not found: ${id}`, ERR_NOT_FOUND);
    // A soft-deleted collection behaves as not-found for mutations (matches
    // updateCollection) — never resurrect a tombstone or churn its timestamps.
    if (cur.deleted === true) throw codedError(`Collection not found: ${id}`, ERR_NOT_FOUND);
    const key = `${kind}:${ref}`;
    if (cur.items.find((it) => itemKey(it) === key)) {
      throw codedError(`Item already in collection: ${key}`, ERR_DUPLICATE);
    }
    if (cur.items.length >= ITEMS_MAX) {
      throw codedError(`Collection full (limit ${ITEMS_MAX})`, ERR_VALIDATION);
    }
    const updated = {
      ...cur,
      items: [...cur.items, { kind, ref, addedAt: stampAfter(cur.removedItems?.[key]) }],
      updatedAt: new Date().toISOString(),
    };
    await store().saveOneNow(id, updated);
    return updated;
  });
  // Emit outside the serialized critical section — subscribers may issue
  // their own collection reads and we don't want to deadlock the tail.
  // mediaCollection covers standalone direct subscriptions; universe/series
  // nudge the bundled share-bucket re-export for linked collections.
  emitRecordUpdated('mediaCollection', merged.id);
  if (merged.universeId) emitRecordUpdated('universe', merged.universeId);
  if (merged.seriesId) emitRecordUpdated('series', merged.seriesId);
  return merged;
}

/**
 * Bulk add/remove items in a single read-modify-write. Halves wall-clock for
 * UI "Move N items" / "select all" flows that would otherwise issue 2N
 * round-trips (one DELETE per source-collection item + one POST per
 * destination-collection item) and dodges the race window where an in-flight
 * AddItem can collide with a parallel RemoveItem on the same collection.
 *
 * `add` items use sanitizeItem rules (kind + ref); duplicates of items
 * already present are skipped silently (idempotent), matching the
 * UI's expectation that "add what isn't already there." `remove` keys
 * are `<kind>:<ref>` strings; unknown keys are silently ignored so a
 * stale UI selection can't 404 the whole batch.
 *
 * Validation rules mirror `addItem`: any invalid `add` entry throws before
 * any mutation lands. `remove` keys that aren't strings throw too.
 *
 * Returns the post-write collection plus counts: `{ collection, added, removed }`.
 */
export async function bulkUpdateCollectionItems(id, { add = [], remove = [] } = {}, { preserveRemovals = false } = {}) {
  if (!Array.isArray(add)) throw codedError('add must be an array', ERR_VALIDATION);
  if (!Array.isArray(remove)) throw codedError('remove must be an array', ERR_VALIDATION);

  // Validate every `add` entry up front so a single bad item doesn't leave
  // a partially-applied batch behind.
  const cleanAdd = add.map(validateItemInput);
  for (const key of remove) {
    if (typeof key !== 'string' || !key) {
      throw codedError('remove keys must be non-empty strings of the form "<kind>:<ref>"', ERR_VALIDATION);
    }
  }

  assertCollectionId(id);
  const result = await store().queueRecordWrite(id, async () => {
    const cur = await store().loadOne(id);
    if (!cur) throw codedError(`Collection not found: ${id}`, ERR_NOT_FOUND);
    // A soft-deleted collection behaves as not-found for mutations (matches
    // updateCollection) — never resurrect a tombstone or churn its timestamps.
    if (cur.deleted === true) throw codedError(`Collection not found: ${id}`, ERR_NOT_FOUND);

    const removeSet = new Set(remove);
    const removedItems = { ...cur.removedItems };
    const remainingItems = cur.items.filter((it) => {
      if (!removeSet.has(itemKey(it))) return true;
      removedItems[itemKey(it)] = stampAfter(it.addedAt);
      return false;
    });
    const removed = cur.items.length - remainingItems.length;

    // Dedupe `add` against itself AND against items that survived the removal.
    // This is intentionally tolerant — re-adding an existing item is a no-op
    // rather than an error, so a multi-select Move that overlaps with prior
    // membership stays idempotent.
    const presentKeys = new Set(remainingItems.map(itemKey));
    const now = new Date().toISOString();
    const additions = [];
    for (const { kind, ref } of cleanAdd) {
      const key = `${kind}:${ref}`;
      if (presentKeys.has(key) || (preserveRemovals && removedItems[key])) continue;
      presentKeys.add(key);
      // A key removed earlier in this same batch keeps its removal record, so
      // the re-add must postdate it to survive.
      additions.push({ kind, ref, addedAt: removedItems[key] ? stampAfter(removedItems[key]) : now });
    }

    if (!additions.length && !removed) return { collection: cur, added: 0, removed: 0 };

    const nextItems = [...remainingItems, ...additions];
    if (nextItems.length > ITEMS_MAX) {
      throw codedError(`Collection full (limit ${ITEMS_MAX})`, ERR_VALIDATION);
    }

    // Drop a cover that pointed at a now-removed item — matches the
    // single-item removeItem path so the cover never dangles after a batch.
    const coverKey = cur.coverKey && removeSet.has(cur.coverKey) ? null : cur.coverKey;

    const merged = {
      ...cur,
      items: nextItems,
      ...(Object.keys(removedItems).length ? { removedItems: sanitizeRemovedItems(removedItems) } : {}),
      coverKey,
      updatedAt: now,
    };
    await store().saveOneNow(id, merged);
    return { collection: merged, added: additions.length, removed };
  });
  if (result.added || result.removed) {
    emitRecordUpdated('mediaCollection', result.collection.id);
    if (result.collection.universeId) emitRecordUpdated('universe', result.collection.universeId);
    if (result.collection.seriesId) emitRecordUpdated('series', result.collection.seriesId);
  }
  return result;
}

/**
 * Drop one media item from every live collection that holds it — the sweep a
 * deleted asset needs so no collection keeps a dangling row. Goes through
 * `bulkUpdateCollectionItems`, so each touched collection bumps `updatedAt`
 * (the LWW stamp peers sync on) and clears a cover that pointed at the item.
 * Returns the number of collections changed.
 */
export async function removeItemFromAllCollections(kind, ref) {
  const key = `${kind}:${ref}`;
  const holders = (await listCollections()).filter((c) => c.items.some((it) => itemKey(it) === key));
  let changed = 0;
  for (const c of holders) {
    // A collection tombstoned between the listing and the write is not a failure.
    const res = await bulkUpdateCollectionItems(c.id, { remove: [key] }).catch((err) => {
      if (err?.code === ERR_NOT_FOUND) return null;
      throw err;
    });
    if (res?.removed) changed += 1;
  }
  return changed;
}

export async function removeItem(id, key) {
  assertCollectionId(id);
  const merged = await store().queueRecordWrite(id, async () => {
    const cur = await store().loadOne(id);
    if (!cur) throw codedError(`Collection not found: ${id}`, ERR_NOT_FOUND);
    // A soft-deleted collection behaves as not-found for mutations (matches
    // updateCollection) — never resurrect a tombstone or churn its timestamps.
    if (cur.deleted === true) throw codedError(`Collection not found: ${id}`, ERR_NOT_FOUND);
    const target = cur.items.find((it) => itemKey(it) === key);
    if (!target) throw codedError(`Item not in collection: ${key}`, ERR_NOT_FOUND);
    const updated = {
      ...cur,
      items: cur.items.filter((it) => it !== target),
      removedItems: sanitizeRemovedItems({ ...cur.removedItems, [key]: stampAfter(target.addedAt) }),
      // Drop the cover if it pointed at the removed item — sanitizeCollection
      // would do this on the next read, but doing it here keeps the in-memory
      // return consistent with what's persisted.
      coverKey: cur.coverKey === key ? null : cur.coverKey,
      updatedAt: new Date().toISOString(),
    };
    await store().saveOneNow(id, updated);
    return updated;
  });
  emitRecordUpdated('mediaCollection', merged.id);
  if (merged.universeId) emitRecordUpdated('universe', merged.universeId);
  if (merged.seriesId) emitRecordUpdated('series', merged.seriesId);
  return merged;
}
