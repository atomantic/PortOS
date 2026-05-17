/**
 * Media Collections
 *
 * User-named buckets for image filenames + video ids. Many-to-many: the same
 * media item can live in any number of collections at once. Persisted to
 * data/media-collections.json as a single { collections: [...] } document.
 *
 * An item is identified by `{ kind: 'image'|'video', ref: <filename|videoId> }`.
 * A collection's `coverKey` is `null` (auto: newest item) or `"<kind>:<ref>"`
 * to pin a specific item as the cover thumbnail.
 *
 * **Concurrency.** Every public mutator routes through `serializeFileWrite`
 * (a single-tail queue keyed on the shared media-collections.json file).
 * Without it, parallel write paths — e.g. the pipeline cover filer's
 * `addItem` running alongside Universe Builder's completion-hook `addItem`,
 * or a `deleteUniverse` unlink racing with an in-flight cover completion —
 * each do a `listCollections → modify → atomicWrite(entire array)` round
 * and the second write silently clobbers the first. Mirrors the
 * `issueWriteTail` pattern in `server/services/pipeline/issues.js`.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, atomicWrite, readJSONFile, ensureDir } from '../lib/fileUtils.js';
import { ITEM_KIND, REF_MAX_LENGTH, itemKey } from '../lib/mediaItemKey.js';
import { sanitizeOrigin } from '../lib/sharingOrigin.js';
import { emitRecordUpdated } from './sharing/recordEvents.js';

// Lazy resolution — PATHS.data may not be available at module-load time
// (e.g. tests that swap it through a Proxy mock so different cases get
// different temp roots). See universeBuilder.js for the same pattern.
const statePath = () => join(PATHS.data, 'media-collections.json');

export const ERR_NOT_FOUND = 'NOT_FOUND';
export const ERR_DUPLICATE = 'DUPLICATE';
export const ERR_VALIDATION = 'VALIDATION_ERROR';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

export const NAME_MAX_LENGTH = 80;
export const DESCRIPTION_MAX_LENGTH = 500;
export const ITEMS_MAX = 5000;

export { REF_MAX_LENGTH, itemKey };

const DEFAULT_STATE = { collections: [] };

const sanitizeItem = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  if (!ITEM_KIND.has(raw.kind)) return null;
  if (typeof raw.ref !== 'string') return null;
  const ref = raw.ref.trim();
  if (!ref || ref.length > REF_MAX_LENGTH) return null;
  // The DELETE-item route key is `<kind>:<ref>` split on the first `:`. A
  // ref that contains `:` would be unambiguously persisted but ambiguously
  // addressable via the REST surface — reject it here so persisted data
  // always round-trips.
  if (ref.includes(':')) return null;
  // A hand-edited or corrupted `addedAt` would feed NaN into the cover
  // resolver's Date sort — replace anything unparseable with now().
  const parsed = typeof raw.addedAt === 'string' ? Date.parse(raw.addedAt) : NaN;
  const addedAt = Number.isFinite(parsed) ? raw.addedAt : new Date().toISOString();
  const out = { kind: raw.kind, ref, addedAt };
  const origin = sanitizeOrigin(raw.origin);
  if (origin) out.origin = origin;
  return out;
};

const UNIVERSE_ID_MAX = 80;

const sanitizeCollection = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.name !== 'string') return null;
  const name = raw.name.trim().slice(0, NAME_MAX_LENGTH);
  if (!name) return null;
  const description = typeof raw.description === 'string'
    ? raw.description.trim().slice(0, DESCRIPTION_MAX_LENGTH)
    : '';
  const seen = new Set();
  const items = [];
  if (Array.isArray(raw.items)) {
    for (const it of raw.items) {
      const s = sanitizeItem(it);
      if (!s) continue;
      const key = itemKey(s);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(s);
      if (items.length >= ITEMS_MAX) break;
    }
  }
  // Cover key is only meaningful when it points at an item that's in the
  // collection; otherwise drop it back to auto so the UI doesn't render a
  // dangling thumbnail reference.
  const coverKey = typeof raw.coverKey === 'string' && seen.has(raw.coverKey)
    ? raw.coverKey
    : null;
  // Optional link to a universe — used by share-bucket subscriptions to
  // know which universe-record's subscription should re-export when this
  // collection's items change.
  const universeId = typeof raw.universeId === 'string' && raw.universeId
    ? raw.universeId.slice(0, UNIVERSE_ID_MAX)
    : null;
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString();
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : createdAt;
  return { id: raw.id, name, description, coverKey, universeId, items, createdAt, updatedAt };
};

export async function listCollections() {
  await ensureDir(PATHS.data);
  const raw = await readJSONFile(statePath(), DEFAULT_STATE, { logError: false });
  if (!Array.isArray(raw.collections)) return [];
  const seen = new Set();
  const out = [];
  for (const c of raw.collections) {
    const s = sanitizeCollection(c);
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

export async function getCollection(id) {
  const all = await listCollections();
  const c = all.find((x) => x.id === id);
  if (!c) throw makeErr(`Collection not found: ${id}`, ERR_NOT_FOUND);
  return c;
}

// File-level write tail. Every public mutator wraps its read-modify-write
// in `serializeFileWrite` so the read always sees the freshest persisted
// state and the write completes before the next task's read begins.
// `writeAll` is the only persistence call and must only be invoked from
// inside a serialized task.
let fileWriteTail = Promise.resolve();
const serializeFileWrite = (task) => {
  const next = fileWriteTail.then(task, task);
  // Silence the tail so a rejection doesn't poison subsequent waiters.
  // Mirror the issueWriteTail / seriesWriteTail pattern: when this write
  // is still the tail after it settles, reset to a fresh Promise.resolve()
  // so the chain doesn't retain settled promises (and their resolved
  // payloads) for the life of the process. If another write enqueues
  // first, it becomes the tail and we drop our reference.
  const silenced = next.catch(() => {});
  fileWriteTail = silenced;
  silenced.finally(() => {
    if (fileWriteTail === silenced) fileWriteTail = Promise.resolve();
  });
  return next;
};
const writeAll = async (collections) => {
  await atomicWrite(statePath(), { collections });
  return collections;
};

export async function createCollection({ name, description = '' }) {
  // Service-layer guards mirror sanitizeCollection so a direct caller
  // (tests, future internal usage) can't persist a record that the next
  // listCollections() read would silently drop.
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (!trimmedName || trimmedName.length > NAME_MAX_LENGTH) {
    throw makeErr('Collection name is required (1..' + NAME_MAX_LENGTH + ' chars)', ERR_VALIDATION);
  }
  const trimmedDescription = typeof description === 'string'
    ? description.trim().slice(0, DESCRIPTION_MAX_LENGTH)
    : '';
  return serializeFileWrite(async () => {
    const all = await listCollections();
    const now = new Date().toISOString();
    const next = {
      id: randomUUID(),
      name: trimmedName,
      description: trimmedDescription,
      coverKey: null,
      items: [],
      createdAt: now,
      updatedAt: now,
    };
    await writeAll([...all, next]);
    return next;
  });
}

// Find an existing collection by case-insensitive trimmed name, else create
// a fresh one. The non-universe-aware upsert — used by user-driven flows
// where the bucket is identified by visible name (e.g. tests, ad-hoc CLI
// scripts).
//
// **Universe-owned paths must use `findOrCreateUniverseCollection`.**
// This helper is name-first and will return any same-name collection,
// including one already linked to a different universe, so it can route
// renders into the wrong bucket when two universes share a display name.
// The legacy `universeId` parameter remains for callers that need the
// best-effort backfill of an unlinked legacy bucket, but new code should
// prefer the universeId-first helper.
export async function findOrCreateCollectionByName({ name, description = '', universeId = null }) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed || trimmed.length > NAME_MAX_LENGTH) {
    throw makeErr('Collection name is required (1..' + NAME_MAX_LENGTH + ' chars)', ERR_VALIDATION);
  }
  const trimmedDescription = typeof description === 'string'
    ? description.trim().slice(0, DESCRIPTION_MAX_LENGTH)
    : '';
  return serializeFileWrite(async () => {
    const all = await listCollections();
    const needle = trimmed.toLowerCase();
    const existing = all.find((c) => c.name.toLowerCase() === needle);
    if (existing) {
      if (universeId && !existing.universeId) {
        // Lazy backfill so legacy "Universe: <name>" collections gain the
        // link the first time a universe-builder render references them.
        const idx = all.findIndex((c) => c.id === existing.id);
        all[idx] = { ...existing, universeId, updatedAt: new Date().toISOString() };
        await writeAll(all);
        return all[idx];
      }
      return existing;
    }
    const now = new Date().toISOString();
    const next = {
      id: randomUUID(),
      name: trimmed,
      description: trimmedDescription,
      coverKey: null,
      universeId: universeId || null,
      items: [],
      createdAt: now,
      updatedAt: now,
    };
    await writeAll([...all, next]);
    return next;
  });
}

// Naming convention for the auto-managed universe collection. Single source
// of truth so the upsert path, the rename cascade (updateUniverse), and any
// caller that needs to display the name stay aligned. Truncated to
// NAME_MAX_LENGTH because long universe names would otherwise overflow
// sanitizeCollection's slice and silently mismatch.
export const universeCollectionNameFor = (universeName) =>
  `Universe: ${typeof universeName === 'string' ? universeName : ''}`.slice(0, NAME_MAX_LENGTH);

// Look up an existing collection by its universeId stamp. Returns null if no
// collection has ever been linked to this universe — callers fall back to
// `findOrCreateUniverseCollection` (the universeId-first upsert) to provision
// on first use. Do NOT fall back to `findOrCreateCollectionByName` here —
// that path is name-first and would adopt a same-named foreign-universe
// bucket. The argument is sliced to the same limit storage uses so passing
// an overlong id (e.g. from a malformed share manifest) matches whatever
// the upsert helper would have persisted.
export async function findCollectionByUniverseId(universeId) {
  if (typeof universeId !== 'string' || !universeId) return null;
  const needle = universeId.slice(0, UNIVERSE_ID_MAX);
  const all = await listCollections();
  return all.find((c) => c.universeId === needle) || null;
}

/**
 * Atomic universeId-first upsert for a universe's auto-managed collection.
 *
 * Resolution order (serialized via the shared file write tail):
 *   1. universeId stamp wins. Returned as-is — the caller's `universeName`
 *      can be stale (it was a snapshot taken before this call entered the
 *      write tail), so reconciling the name here could ping-pong a fresh
 *      cascade rename back to an old name. `renameCollectionForUniverse`
 *      is the canonical path for name changes; if its best-effort cascade
 *      fails, the surviving stale name is acceptable until the user
 *      retriggers it (the lock blocks `updateCollection` but the cascade
 *      itself is unrestricted).
 *   2. Otherwise a fresh collection is created and stamped with `universeId`,
 *      even when the canonical name is already taken by another collection
 *      (a different universe's bucket, OR a previously-unlinked orphan from
 *      a deleted universe). Adopting either would silently mix renders
 *      across universes; two same-named collections is the user-correctable
 *      case.
 *
 * Callers (pipeline cover filer, Universe Builder render route) all funnel
 * through this so the universe → collection identity stays consistent across
 * both auto-filing and explicit-render paths.
 */
export async function findOrCreateUniverseCollection({ universeId, universeName, description = '' }) {
  if (!universeId || typeof universeId !== 'string') {
    throw makeErr('universeId is required', ERR_VALIDATION);
  }
  if (typeof universeName !== 'string' || !universeName.trim()) {
    throw makeErr('universeName is required', ERR_VALIDATION);
  }
  // Normalize the universeId once so lookup and storage both key on the
  // same string. Without this, an overlong id (e.g. from a malformed
  // share manifest) would not match the row it just created — the lookup
  // compares the raw value but persistence sliced — and retries would
  // pile up duplicate stamped collections.
  const normalizedUniverseId = universeId.slice(0, UNIVERSE_ID_MAX);
  const desiredName = universeCollectionNameFor(universeName);
  const trimmedDescription = typeof description === 'string'
    ? description.trim().slice(0, DESCRIPTION_MAX_LENGTH)
    : '';
  return serializeFileWrite(async () => {
    const all = await listCollections();
    const linked = all.find((c) => c.universeId === normalizedUniverseId);
    if (linked) return linked;
    // No universeId match — always create fresh. The runtime intentionally
    // does NOT adopt a same-named unlinked collection here: it can't tell
    // a true pre-link legacy bucket apart from a post-`deleteUniverse`
    // orphan, and adopting the orphan would silently mix the deleted
    // universe's renders into the new same-named universe.
    //
    // Upgrade path for pre-link installs: migration 021
    // (`scripts/migrations/021-link-orphan-universe-collections.js`) does
    // a one-shot name-match link at boot — safe because at install/upgrade
    // time the orphan case doesn't exist yet. New collisions after the
    // migration belong to "ambiguous, leave it" rather than "auto-adopt."
    const now = new Date().toISOString();
    const next = {
      id: randomUUID(),
      name: desiredName,
      description: trimmedDescription,
      coverKey: null,
      universeId: normalizedUniverseId,
      items: [],
      createdAt: now,
      updatedAt: now,
    };
    await writeAll([...all, next]);
    return next;
  });
}

// Clear the `universeId` link on any collection bound to this universe.
// Used by deleteUniverse to release the rename-lock so the orphaned bucket
// becomes a normal user-owned collection (renamable, deletable, etc.). The
// items themselves are preserved — the user may still want the renders.
// Returns the list of unlinked collection ids (empty when none matched).
export async function unlinkCollectionsForUniverse(universeId) {
  if (typeof universeId !== 'string' || !universeId) return [];
  const needle = universeId.slice(0, UNIVERSE_ID_MAX);
  return serializeFileWrite(async () => {
    const all = await listCollections();
    const matches = all
      .map((c, i) => (c.universeId === needle ? i : -1))
      .filter((i) => i >= 0);
    if (!matches.length) return [];
    const now = new Date().toISOString();
    const next = [...all];
    const unlinkedIds = [];
    for (const i of matches) {
      next[i] = { ...all[i], universeId: null, updatedAt: now };
      unlinkedIds.push(all[i].id);
    }
    await writeAll(next);
    return unlinkedIds;
  });
}

// Cascade a universe rename to its linked collection(s). Skips the
// rename-lock guard in updateCollection by writing the name directly — the
// lock exists to block user-driven renames, not system-driven cascades from
// the universe rename itself. Renames EVERY collection linked to this
// universe, not just the first match: hand-edited state or a pre-
// serialization race could have left duplicate linked rows behind, and the
// stragglers would otherwise stay rename-locked under the old name forever.
// Returns the first updated collection (back-compat) — callers that need the
// full list can re-read after.
export async function renameCollectionForUniverse(universeId, newUniverseName) {
  if (typeof universeId !== 'string' || !universeId) return null;
  const needle = universeId.slice(0, UNIVERSE_ID_MAX);
  return serializeFileWrite(async () => {
    const all = await listCollections();
    const matchIdxs = all
      .map((c, i) => (c.universeId === needle ? i : -1))
      .filter((i) => i >= 0);
    if (!matchIdxs.length) return null;
    const desired = universeCollectionNameFor(newUniverseName);
    if (!desired) return all[matchIdxs[0]];
    const now = new Date().toISOString();
    const next = [...all];
    let changed = false;
    for (const i of matchIdxs) {
      if (next[i].name === desired) continue;
      next[i] = { ...next[i], name: desired, updatedAt: now };
      changed = true;
    }
    if (!changed) return all[matchIdxs[0]];
    await writeAll(next);
    return next[matchIdxs[0]];
  });
}

export async function updateCollection(id, patch) {
  return serializeFileWrite(async () => {
    const all = await listCollections();
    const idx = all.findIndex((c) => c.id === id);
    if (idx < 0) throw makeErr(`Collection not found: ${id}`, ERR_NOT_FOUND);
    const cur = all[idx];
    // Product/UI constraint: universe-linked collections own their visible
    // name. The name is the user-facing identity of a universe's bucket, so
    // renaming it independent of the universe is confusing — the supported
    // workflow is renaming the universe (which cascades down via
    // renameCollectionForUniverse). Routing is by `universeId` regardless;
    // this lock exists to keep what the user sees consistent with the
    // universe's name, not to prevent routing forks.
    if ('name' in patch && cur.universeId && patch.name !== cur.name) {
      throw makeErr(
        'This collection is linked to a Universe — rename the universe to rename it.',
        ERR_VALIDATION,
      );
    }
    // Cover key validation is deferred to sanitizeCollection on read, but we
    // also reject up-front so the API gives a clear error rather than silently
    // dropping the cover.
    if (patch.coverKey != null && !cur.items.find((it) => itemKey(it) === patch.coverKey)) {
      throw makeErr('coverKey must reference an item in this collection', ERR_VALIDATION);
    }
    const merged = {
      ...cur,
      ...('name' in patch ? { name: patch.name } : {}),
      ...('description' in patch ? { description: patch.description } : {}),
      ...('coverKey' in patch ? { coverKey: patch.coverKey } : {}),
      updatedAt: new Date().toISOString(),
    };
    const next = [...all];
    next[idx] = merged;
    await writeAll(next);
    return merged;
  });
}

export async function deleteCollection(id) {
  const deletedUniverseId = await serializeFileWrite(async () => {
    const all = await listCollections();
    const target = all.find((c) => c.id === id);
    if (!target) throw makeErr(`Collection not found: ${id}`, ERR_NOT_FOUND);
    await writeAll(all.filter((c) => c.id !== id));
    return target.universeId || null;
  });
  // Mirror addItem/removeItem/bulkUpdateCollectionItems — universe-linked
  // shares need to know membership changed so the subscriber doesn't keep
  // publishing the deleted collection's contents until an unrelated edit
  // fires. Emit outside the serialized critical section so subscribers'
  // own reads don't deadlock the tail.
  if (deletedUniverseId) emitRecordUpdated('universe', deletedUniverseId);
  return { id };
}

// Mirror sanitizeItem so direct callers (addItem + bulkUpdateCollectionItems)
// can't write a record that the next listCollections() would drop (silent add).
// Returns a normalized `{ kind, ref }` so callers don't re-trim.
const validateItemInput = (item) => {
  if (!item || !ITEM_KIND.has(item.kind)) {
    throw makeErr('item.kind must be "image" or "video"', ERR_VALIDATION);
  }
  const ref = typeof item.ref === 'string' ? item.ref.trim() : '';
  if (!ref || ref.length > REF_MAX_LENGTH || ref.includes(':')) {
    throw makeErr('item.ref invalid (empty, too long, or contains ":")', ERR_VALIDATION);
  }
  return { kind: item.kind, ref };
};

export async function addItem(id, item) {
  const { kind, ref } = validateItemInput(item);
  const merged = await serializeFileWrite(async () => {
    const all = await listCollections();
    const idx = all.findIndex((c) => c.id === id);
    if (idx < 0) throw makeErr(`Collection not found: ${id}`, ERR_NOT_FOUND);
    const cur = all[idx];
    const key = `${kind}:${ref}`;
    if (cur.items.find((it) => itemKey(it) === key)) {
      throw makeErr(`Item already in collection: ${key}`, ERR_DUPLICATE);
    }
    if (cur.items.length >= ITEMS_MAX) {
      throw makeErr(`Collection full (limit ${ITEMS_MAX})`, ERR_VALIDATION);
    }
    const updated = {
      ...cur,
      items: [...cur.items, { kind, ref, addedAt: new Date().toISOString() }],
      updatedAt: new Date().toISOString(),
    };
    const next = [...all];
    next[idx] = updated;
    await writeAll(next);
    return updated;
  });
  // Emit outside the serialized critical section — subscribers may issue
  // their own collection reads and we don't want to deadlock the tail.
  if (merged.universeId) emitRecordUpdated('universe', merged.universeId);
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
export async function bulkUpdateCollectionItems(id, { add = [], remove = [] } = {}) {
  if (!Array.isArray(add)) throw makeErr('add must be an array', ERR_VALIDATION);
  if (!Array.isArray(remove)) throw makeErr('remove must be an array', ERR_VALIDATION);

  // Validate every `add` entry up front so a single bad item doesn't leave
  // a partially-applied batch behind.
  const cleanAdd = add.map(validateItemInput);
  for (const key of remove) {
    if (typeof key !== 'string' || !key) {
      throw makeErr('remove keys must be non-empty strings of the form "<kind>:<ref>"', ERR_VALIDATION);
    }
  }

  const result = await serializeFileWrite(async () => {
    const all = await listCollections();
    const idx = all.findIndex((c) => c.id === id);
    if (idx < 0) throw makeErr(`Collection not found: ${id}`, ERR_NOT_FOUND);
    const cur = all[idx];

    const removeSet = new Set(remove);
    const remainingItems = cur.items.filter((it) => !removeSet.has(itemKey(it)));
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
      if (presentKeys.has(key)) continue;
      presentKeys.add(key);
      additions.push({ kind, ref, addedAt: now });
    }

    const nextItems = [...remainingItems, ...additions];
    if (nextItems.length > ITEMS_MAX) {
      throw makeErr(`Collection full (limit ${ITEMS_MAX})`, ERR_VALIDATION);
    }

    // Drop a cover that pointed at a now-removed item — matches the
    // single-item removeItem path so the cover never dangles after a batch.
    const coverKey = cur.coverKey && removeSet.has(cur.coverKey) ? null : cur.coverKey;

    const merged = {
      ...cur,
      items: nextItems,
      coverKey,
      updatedAt: now,
    };
    const next = [...all];
    next[idx] = merged;
    await writeAll(next);
    return { collection: merged, added: additions.length, removed };
  });
  if (result.collection.universeId && (result.added || result.removed)) {
    emitRecordUpdated('universe', result.collection.universeId);
  }
  return result;
}

export async function removeItem(id, key) {
  const merged = await serializeFileWrite(async () => {
    const all = await listCollections();
    const idx = all.findIndex((c) => c.id === id);
    if (idx < 0) throw makeErr(`Collection not found: ${id}`, ERR_NOT_FOUND);
    const cur = all[idx];
    const before = cur.items.length;
    const items = cur.items.filter((it) => itemKey(it) !== key);
    if (items.length === before) throw makeErr(`Item not in collection: ${key}`, ERR_NOT_FOUND);
    const updated = {
      ...cur,
      items,
      // Drop the cover if it pointed at the removed item — sanitizeCollection
      // would do this on the next read, but doing it here keeps the in-memory
      // return consistent with what's persisted.
      coverKey: cur.coverKey === key ? null : cur.coverKey,
      updatedAt: new Date().toISOString(),
    };
    const next = [...all];
    next[idx] = updated;
    await writeAll(next);
    return updated;
  });
  if (merged.universeId) emitRecordUpdated('universe', merged.universeId);
  return merged;
}
