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
 * and the second write silently clobbers the first. Built on
 * `createFileWriteQueue()` in `server/lib/fileWriteQueue.js`.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, atomicWrite, readJSONFile, ensureDir } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { ITEM_KIND, REF_MAX_LENGTH, itemKey } from '../lib/mediaItemKey.js';
import { sanitizeOrigin } from '../lib/sharingOrigin.js';
import { emitRecordUpdated, emitRecordDeleted } from './sharing/recordEvents.js';

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
  // Path-traversal defense in depth. Refs persist to wire-syncable state
  // (peer pushes carry collections via `linkedCollection`, snapshot sync
  // carries the whole file), and downstream code joins the ref onto a
  // PATHS dir to hash / pull the asset. A peer-supplied ref like
  // `../etc/passwd` would otherwise let one peer make another peer hash
  // (and leak the hash of) arbitrary local files.
  //
  // Reject separators and parent-directory PATH SEGMENTS (exact `.` or
  // `..` between slashes, or as the whole basename). Do NOT reject the
  // substring `..` in general — gallery filenames like `my..render.png`
  // are valid basenames that the rest of the system stores and serves,
  // and dropping them would silently disappear existing collection items.
  if (ref.includes('/') || ref.includes('\\')) return null;
  if (ref === '.' || ref === '..') return null;
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
const SERIES_ID_MAX = 80;

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
  // Mutually exclusive with universeId on read — a hand-edited record
  // carrying both is resolved to the universe link (older, established
  // relationship) so a single collection can't drive two subscriptions.
  const seriesId = !universeId && typeof raw.seriesId === 'string' && raw.seriesId
    ? raw.seriesId.slice(0, SERIES_ID_MAX)
    : null;
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString();
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : createdAt;
  const deleted = raw.deleted === true;
  // When a tombstone is missing its explicit deletedAt, fall back to updatedAt
  // (the most-recent timestamp we have) rather than createdAt — the deletion
  // happened at or after the last edit, so createdAt would make the tombstone
  // look far older than it is and skew LWW merges + the GC cutoff window.
  const deletedAt = deleted && typeof raw.deletedAt === 'string' ? raw.deletedAt : (deleted ? updatedAt : null);
  return { id: raw.id, name, description, coverKey, universeId, seriesId, items, createdAt, updatedAt, deleted, deletedAt };
};

export async function listCollections({ includeDeleted = false } = {}) {
  await ensureDir(PATHS.data);
  const raw = await readJSONFile(statePath(), DEFAULT_STATE, { logError: false });
  if (!Array.isArray(raw.collections)) return [];
  const seen = new Set();
  const out = [];
  for (const c of raw.collections) {
    const s = sanitizeCollection(c);
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    if (!includeDeleted && s.deleted === true) continue;
    out.push(s);
  }
  return out;
}

export async function getCollection(id, { includeDeleted = false } = {}) {
  const all = await listCollections({ includeDeleted });
  const c = all.find((x) => x.id === id);
  if (!c) throw makeErr(`Collection not found: ${id}`, ERR_NOT_FOUND);
  return c;
}

// Every public mutator wraps its read-modify-write in `serializeFileWrite`
// so the read always sees the freshest persisted state and the write
// completes before the next task's read begins. `writeAll` is the only
// persistence call and must only be invoked from inside a serialized task.
const serializeFileWrite = createFileWriteQueue();
const writeAll = async (collections) => {
  await atomicWrite(statePath(), { collections });
  return collections;
};

// Announce a newly-created collection to the per-record peer-sync pipeline:
// emit the 'updated' event so any existing subscription pushes it, AND
// auto-subscribe every mediaCollections-enabled peer so brand-new collections
// (and their later tombstones) propagate even when that peer has universe/series
// sync disabled. Dynamic import avoids a module cycle — peerSync imports
// mergeMediaCollectionsFromSync from here, so a static import would close one.
// Call ONLY when a brand-new record was persisted — never on a find-existing
// hit, or every render would re-announce and churn the pipeline.
const announceNewCollection = (id) => {
  emitRecordUpdated('mediaCollection', id);
  import('./sharing/peerSync.js')
    .then(({ autoSubscribeRecordToAllPeers }) => autoSubscribeRecordToAllPeers('mediaCollection', id))
    .catch(() => {});
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
  const created = await serializeFileWrite(async () => {
    const all = await listCollections({ includeDeleted: true });
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
  announceNewCollection(created.id);
  return created;
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
  // Normalize the universe id (trim whitespace, then cap length) so the
  // presence guard and the stored/derived value operate on the SAME string —
  // a padded id can't yield `uc- u1 ` while the guard saw a non-empty value.
  // Whitespace-only is treated as "no universe". Keeps the derived deterministic
  // id under the peer-sync id length cap.
  const normalizedUniverseId = typeof universeId === 'string' && universeId.trim()
    ? universeId.trim().slice(0, UNIVERSE_ID_MAX)
    : null;
  let createdId = null;
  const result = await serializeFileWrite(async () => {
    const all = await listCollections({ includeDeleted: true });
    const needle = trimmed.toLowerCase();
    // Do not match (or reuse) tombstoned records — a deleted collection
    // should not be resurrected by name.
    const existing = all.find((c) => !c.deleted && c.name.toLowerCase() === needle);
    if (existing) {
      if (normalizedUniverseId && !existing.universeId) {
        // Lazy backfill so legacy "Universe: <name>" collections gain the link
        // the first time a universe-builder render references them. Adopt the
        // DETERMINISTIC id at the same time — keeping the old random id would
        // leave a universe-linked collection that can't converge across peers
        // (the very bug deterministic ids fix).
        const canonId = linkedCollectionId({ universeId: normalizedUniverseId });
        // If the universe ALREADY has its canonical collection, don't promote a
        // same-named orphan over it (that would clobber the canonical record's
        // items) — return the canonical one; the orphan is a duplicate the merge
        // / migration 038 reconciles.
        const liveCanonical = all.find((c) => c.id === canonId && !c.deleted);
        if (liveCanonical) return liveCanonical;
        // No live canonical — rename the orphan to the deterministic id,
        // reclaiming a tombstone at that id if one exists.
        const linked = { ...existing, id: canonId, universeId: normalizedUniverseId, updatedAt: new Date().toISOString() };
        await writeAll([...all.filter((c) => c.id !== existing.id && c.id !== canonId), linked]);
        if (canonId !== existing.id) createdId = canonId; // announce the newly-linked record
        return linked;
      }
      return existing;
    }
    const now = new Date().toISOString();
    const next = {
      // Deterministic id when universe-linked (cross-machine convergence);
      // standalone (no link) keeps a random id. See linkedCollectionId.
      id: linkedCollectionId({ universeId: normalizedUniverseId }) || randomUUID(),
      name: trimmed,
      description: trimmedDescription,
      coverKey: null,
      universeId: normalizedUniverseId,
      items: [],
      createdAt: now,
      updatedAt: now,
    };
    createdId = next.id;
    // Reclaim the deterministic id if a tombstone already holds it (re-creating
    // a previously-deleted universe/series collection). A plain append would
    // leave two records at the same id and listCollections' dedup keeps the
    // tombstone (it's first), silently dropping this fresh live record.
    await writeAll([...all.filter((c) => c.id !== next.id), next]);
    return next;
  });
  if (createdId) announceNewCollection(createdId);
  return result;
}

// Naming convention for the auto-managed universe collection. Single source
// of truth so the upsert path, the rename cascade (updateUniverse), and any
// caller that needs to display the name stay aligned. Truncated to
// NAME_MAX_LENGTH because long universe names would otherwise overflow
// sanitizeCollection's slice and silently mismatch.
export const universeCollectionNameFor = (universeName) =>
  `Universe: ${typeof universeName === 'string' ? universeName : ''}`.slice(0, NAME_MAX_LENGTH);

// Deterministic id for a universe/series-LINKED collection. Every federated
// machine derives the SAME id from the same universe/series id — so per-record
// collection sync (which keys on `id`) treats both machines' copies as ONE
// record and converges, instead of each minting a random UUID and duplicating
// the collection on every peer. Standalone (unlinked) collections keep a random
// id — they have no stable cross-machine identity. Migration 038 canonicalizes
// existing linked-collection ids to this scheme. Mirror any change here in that
// migration. `uc-`/`sc-` prefixes keep linked ids visually distinct from the
// random UUIDs of standalone collections. The owner id is sliced to the same cap
// storage uses so the derived id is bounded by construction — callers can pass a
// raw owner id without first slicing it and still converge on the canonical id
// (and stay under the peer-sync id length cap).
export const linkedCollectionId = ({ universeId = null, seriesId = null } = {}) => {
  if (universeId) return `uc-${String(universeId).slice(0, UNIVERSE_ID_MAX)}`;
  if (seriesId) return `sc-${String(seriesId).slice(0, SERIES_ID_MAX)}`;
  return null;
};

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
  let createdId = null;
  const result = await serializeFileWrite(async () => {
    const all = await listCollections({ includeDeleted: true });
    // Do not adopt a tombstoned universe-linked collection — deleted means gone.
    const linked = all.find((c) => !c.deleted && c.universeId === normalizedUniverseId);
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
      // Deterministic id so this universe's collection has the SAME id on every
      // peer (per-record sync keys on id) — see linkedCollectionId.
      id: linkedCollectionId({ universeId: normalizedUniverseId }),
      name: desiredName,
      description: trimmedDescription,
      coverKey: null,
      universeId: normalizedUniverseId,
      items: [],
      createdAt: now,
      updatedAt: now,
    };
    createdId = next.id;
    // Reclaim the deterministic id if a tombstone already holds it (re-creating
    // a previously-deleted universe/series collection). A plain append would
    // leave two records at the same id and listCollections' dedup keeps the
    // tombstone (it's first), silently dropping this fresh live record.
    await writeAll([...all.filter((c) => c.id !== next.id), next]);
    return next;
  });
  // Announce only when a NEW record was persisted (not a find-existing hit), so
  // a mediaCollections-enabled peer receives universe-linked collections even
  // with universe sync off.
  if (createdId) announceNewCollection(createdId);
  return result;
}

// Series-side mirror of the universe collection helpers above
// (`universeCollectionNameFor`, `findCollectionByUniverseId`,
// `findOrCreateUniverseCollection`, `unlinkCollectionsForUniverse`,
// `renameCollectionForUniverse`). Same resolution-order + orphan-avoidance
// rules — see those functions' docstrings for the rationale.
export const seriesCollectionNameFor = (seriesName) =>
  `Series: ${typeof seriesName === 'string' ? seriesName : ''}`.slice(0, NAME_MAX_LENGTH);

export async function findCollectionBySeriesId(seriesId) {
  if (typeof seriesId !== 'string' || !seriesId) return null;
  const needle = seriesId.slice(0, SERIES_ID_MAX);
  const all = await listCollections();
  return all.find((c) => c.seriesId === needle) || null;
}

export async function findOrCreateSeriesCollection({ seriesId, seriesName, description = '' }) {
  if (!seriesId || typeof seriesId !== 'string') {
    throw makeErr('seriesId is required', ERR_VALIDATION);
  }
  if (typeof seriesName !== 'string' || !seriesName.trim()) {
    throw makeErr('seriesName is required', ERR_VALIDATION);
  }
  const normalizedSeriesId = seriesId.slice(0, SERIES_ID_MAX);
  const desiredName = seriesCollectionNameFor(seriesName);
  const trimmedDescription = typeof description === 'string'
    ? description.trim().slice(0, DESCRIPTION_MAX_LENGTH)
    : '';
  let createdId = null;
  const result = await serializeFileWrite(async () => {
    const all = await listCollections({ includeDeleted: true });
    // Do not adopt a tombstoned series-linked collection — deleted means gone.
    const linked = all.find((c) => !c.deleted && c.seriesId === normalizedSeriesId);
    if (linked) return linked;
    const now = new Date().toISOString();
    const next = {
      // Deterministic id — same series collection id on every peer (see linkedCollectionId).
      id: linkedCollectionId({ seriesId: normalizedSeriesId }),
      name: desiredName,
      description: trimmedDescription,
      coverKey: null,
      seriesId: normalizedSeriesId,
      items: [],
      createdAt: now,
      updatedAt: now,
    };
    createdId = next.id;
    // Reclaim the deterministic id if a tombstone already holds it (re-creating
    // a previously-deleted universe/series collection). A plain append would
    // leave two records at the same id and listCollections' dedup keeps the
    // tombstone (it's first), silently dropping this fresh live record.
    await writeAll([...all.filter((c) => c.id !== next.id), next]);
    return next;
  });
  if (createdId) announceNewCollection(createdId);
  return result;
}

export async function unlinkCollectionsForSeries(seriesId) {
  if (typeof seriesId !== 'string' || !seriesId) return [];
  const needle = seriesId.slice(0, SERIES_ID_MAX);
  return serializeFileWrite(async () => {
    const all = await listCollections({ includeDeleted: true });
    const matches = all
      .map((c, i) => (c.seriesId === needle ? i : -1))
      .filter((i) => i >= 0);
    if (!matches.length) return [];
    const now = new Date().toISOString();
    const next = [...all];
    const unlinkedIds = [];
    for (const i of matches) {
      next[i] = { ...all[i], seriesId: null, updatedAt: now };
      unlinkedIds.push(all[i].id);
    }
    await writeAll(next);
    return unlinkedIds;
  });
}

export async function renameCollectionForSeries(seriesId, newSeriesName) {
  if (typeof seriesId !== 'string' || !seriesId) return null;
  const needle = seriesId.slice(0, SERIES_ID_MAX);
  return serializeFileWrite(async () => {
    const all = await listCollections({ includeDeleted: true });
    const matchIdxs = all
      .map((c, i) => (c.seriesId === needle ? i : -1))
      .filter((i) => i >= 0);
    if (!matchIdxs.length) return null;
    const desired = seriesCollectionNameFor(newSeriesName);
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

// Clear the `universeId` link on any collection bound to this universe.
// Used by deleteUniverse to release the rename-lock so the orphaned bucket
// becomes a normal user-owned collection (renamable, deletable, etc.). The
// items themselves are preserved — the user may still want the renders.
// Returns the list of unlinked collection ids (empty when none matched).
export async function unlinkCollectionsForUniverse(universeId) {
  if (typeof universeId !== 'string' || !universeId) return [];
  const needle = universeId.slice(0, UNIVERSE_ID_MAX);
  return serializeFileWrite(async () => {
    const all = await listCollections({ includeDeleted: true });
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
    const all = await listCollections({ includeDeleted: true });
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
  const merged = await serializeFileWrite(async () => {
    const all = await listCollections({ includeDeleted: true });
    const idx = all.findIndex((c) => c.id === id);
    if (idx < 0) throw makeErr(`Collection not found: ${id}`, ERR_NOT_FOUND);
    const cur = all[idx];
    if (cur.deleted === true) throw makeErr(`Collection not found: ${id}`, ERR_NOT_FOUND);
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
    if ('name' in patch && cur.seriesId && patch.name !== cur.name) {
      throw makeErr(
        'This collection is linked to a Series — rename the series to rename it.',
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
  const { universeId: deletedUniverseId, seriesId: deletedSeriesId, alreadyDeleted } = await serializeFileWrite(async () => {
    const all = await listCollections({ includeDeleted: true });
    const idx = all.findIndex((c) => c.id === id);
    if (idx < 0) throw makeErr(`Collection not found: ${id}`, ERR_NOT_FOUND);
    const target = all[idx];
    // Idempotent on an already-tombstoned record: re-stamping deletedAt/
    // updatedAt would make an old tombstone look "newer" to a peer's LWW (and
    // re-emitting churns the sync pipeline). Return without rewriting or
    // re-emitting.
    if (target.deleted === true) return { universeId: null, seriesId: null, alreadyDeleted: true };
    const now = new Date().toISOString();
    const next = [...all];
    // Clear coverKey too — with items emptied it would otherwise dangle
    // (point at a non-existent item) and leak into the tombstone's wire payload.
    next[idx] = { ...target, deleted: true, deletedAt: now, updatedAt: now, items: [], coverKey: null, universeId: null, seriesId: null };
    await writeAll(next);
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
    throw makeErr('item.kind must be "image" or "video"', ERR_VALIDATION);
  }
  const ref = typeof item.ref === 'string' ? item.ref.trim() : '';
  if (!ref || ref.length > REF_MAX_LENGTH || ref.includes(':')) {
    throw makeErr('item.ref invalid (empty, too long, or contains ":")', ERR_VALIDATION);
  }
  // Mirror sanitizeItem's path-traversal rejection so the write path can't
  // persist a ref that the next listCollections() read would silently drop
  // (which would also churn coverKey/updatedAt for the dangling-cover guard).
  // Reject separators and exact `.`/`..` segments only — `..` inside a
  // basename (`my..render.png`) is a legitimate gallery filename. Must
  // mirror sanitizeItem exactly or local addItem rejects refs that peer
  // sync would accept (and vice versa).
  if (ref.includes('/') || ref.includes('\\')) {
    throw makeErr('item.ref invalid (contains path separators)', ERR_VALIDATION);
  }
  if (ref === '.' || ref === '..') {
    throw makeErr('item.ref invalid (parent-directory segment)', ERR_VALIDATION);
  }
  return { kind: item.kind, ref };
};

export async function addItem(id, item) {
  const { kind, ref } = validateItemInput(item);
  const merged = await serializeFileWrite(async () => {
    const all = await listCollections({ includeDeleted: true });
    const idx = all.findIndex((c) => c.id === id);
    if (idx < 0) throw makeErr(`Collection not found: ${id}`, ERR_NOT_FOUND);
    const cur = all[idx];
    // A soft-deleted collection behaves as not-found for mutations (matches
    // updateCollection) — never resurrect a tombstone or churn its timestamps.
    if (cur.deleted === true) throw makeErr(`Collection not found: ${id}`, ERR_NOT_FOUND);
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
    const all = await listCollections({ includeDeleted: true });
    const idx = all.findIndex((c) => c.id === id);
    if (idx < 0) throw makeErr(`Collection not found: ${id}`, ERR_NOT_FOUND);
    const cur = all[idx];
    // A soft-deleted collection behaves as not-found for mutations (matches
    // updateCollection) — never resurrect a tombstone or churn its timestamps.
    if (cur.deleted === true) throw makeErr(`Collection not found: ${id}`, ERR_NOT_FOUND);

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
  if (result.added || result.removed) {
    emitRecordUpdated('mediaCollection', result.collection.id);
    if (result.collection.universeId) emitRecordUpdated('universe', result.collection.universeId);
    if (result.collection.seriesId) emitRecordUpdated('series', result.collection.seriesId);
  }
  return result;
}

export async function removeItem(id, key) {
  const merged = await serializeFileWrite(async () => {
    const all = await listCollections({ includeDeleted: true });
    const idx = all.findIndex((c) => c.id === id);
    if (idx < 0) throw makeErr(`Collection not found: ${id}`, ERR_NOT_FOUND);
    const cur = all[idx];
    // A soft-deleted collection behaves as not-found for mutations (matches
    // updateCollection) — never resurrect a tombstone or churn its timestamps.
    if (cur.deleted === true) throw makeErr(`Collection not found: ${id}`, ERR_NOT_FOUND);
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
  emitRecordUpdated('mediaCollection', merged.id);
  if (merged.universeId) emitRecordUpdated('universe', merged.universeId);
  if (merged.seriesId) emitRecordUpdated('series', merged.seriesId);
  return merged;
}

// Hard-remove tombstoned collections whose deletedAt is older than the cutoff.
// Called by tombstoneGc once every subscribed peer has acked the deletion.
export async function pruneTombstonedCollections(olderThanMs) {
  if (!Number.isFinite(olderThanMs)) return { pruned: 0 };
  return serializeFileWrite(async () => {
    const all = await listCollections({ includeDeleted: true });
    const keep = all.filter((c) => {
      if (c.deleted !== true) return true;
      const ms = Date.parse(c.deletedAt || '');
      return !(Number.isFinite(ms) && ms < olderThanMs);
    });
    if (keep.length === all.length) return { pruned: 0 };
    await writeAll(keep);
    return { pruned: all.length - keep.length };
  });
}

/**
 * Merge an incoming list of collections from a peer (snapshot sync OR the
 * per-record push payload's `linkedCollection` field). Per-collection
 * semantics:
 *
 *   - New (unseen id): inserted verbatim after sanitization.
 *   - Existing id: top-level scalars (name, description, coverKey, universeId,
 *     seriesId) follow LWW on `updatedAt`. Items[] is **union by `kind:ref`**
 *     so neither side ever loses a render it knows about — collections are
 *     append-mostly in normal use, and a divergence (peer-A added image-X
 *     while peer-B added image-Y to the same collection on the same day)
 *     should retain both rather than discard whichever has the older
 *     collection-level updatedAt.
 *
 * Mutating writes go through the same `serializeFileWrite` tail as every
 * other mediaCollections mutator so a concurrent local `addItem` and remote
 * apply can't interleave on the JSON file.
 */
export async function mergeMediaCollectionsFromSync(remoteCollections) {
  if (!Array.isArray(remoteCollections)) return { applied: false, count: 0 };
  return serializeFileWrite(async () => {
    const all = await listCollections({ includeDeleted: true });
    const localById = new Map(all.map((c) => [c.id, c]));
    let changed = 0;
    for (const remote of remoteCollections) {
      const sanitized = sanitizeCollection(remote);
      if (!sanitized) continue;
      const local = localById.get(sanitized.id);
      if (!local) {
        localById.set(sanitized.id, sanitized);
        changed++;
        continue;
      }
      const mergedItems = mergeCollectionItems(local.items, sanitized.items);
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
      const scalarSource = remoteWins ? sanitized : local;
      // Cover key: only adopt the scalar source's coverKey if it points at an
      // item that survives the union — otherwise sanitizeCollection on next
      // read would drop it back to null and we'd churn updatedAt forever.
      const scalarDeleted = scalarSource.deleted === true;
      const presentKeys = new Set(mergedItems.map(itemKey));
      const coverKey = !scalarDeleted && scalarSource.coverKey && presentKeys.has(scalarSource.coverKey)
        ? scalarSource.coverKey
        : null;
      const next = {
        ...local,
        name: scalarSource.name,
        description: scalarSource.description,
        coverKey: scalarDeleted ? null : coverKey,
        universeId: scalarDeleted ? null : scalarSource.universeId,
        seriesId: scalarDeleted ? null : scalarSource.seriesId,
        items: scalarDeleted ? [] : mergedItems,
        updatedAt: remoteWins ? remoteTs : localTs,
        deleted: scalarDeleted,
        deletedAt: scalarDeleted ? (scalarSource.deletedAt || (remoteWins ? remoteTs : localTs)) : null,
      };
      if (collectionsEqual(local, next)) continue;
      localById.set(sanitized.id, next);
      changed++;
    }
    if (changed === 0) return { applied: false, count: 0 };
    await writeAll(Array.from(localById.values()));
    return { applied: true, count: changed };
  });
}

function mergeCollectionItems(localItems, remoteItems) {
  const byKey = new Map();
  for (const it of localItems || []) byKey.set(itemKey(it), it);
  for (const it of remoteItems || []) {
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
  return Array.from(byKey.values()).sort((a, b) => itemKey(a).localeCompare(itemKey(b)));
}

// Parse a timestamp string to epoch ms, or null when unparseable. The
// "loses on null" semantics differ between the two LWW directions, so each
// caller handles nulls explicitly rather than baking a polarity into this
// helper (an Infinity / -Infinity fallback would invert behavior between
// "earliest wins" and "newer wins").
function parseTsMs(s) {
  const n = typeof s === 'string' ? Date.parse(s) : NaN;
  return Number.isFinite(n) ? n : null;
}

// "Earliest wins" tiebreak for two records of the same key. Used by
// mergeCollectionItems when both sides claim to know an `addedAt` for the
// same `<kind>:<ref>`. Returns -1 if `a` is earlier (a wins), 1 if `b` is
// earlier, 0 on tie. Unparseable side LOSES — a corrupted timestamp can't
// claim to be earliest; if both are unparseable the caller's default wins.
function compareEarlierWins(a, b) {
  const aMs = parseTsMs(a);
  const bMs = parseTsMs(b);
  if (aMs === null && bMs === null) return 0;
  if (aMs === null) return 1;  // a unparseable → b wins
  if (bMs === null) return -1; // b unparseable → a wins
  if (aMs < bMs) return -1;
  if (aMs > bMs) return 1;
  return 0;
}

// "Newer wins" comparison: returns true iff `candidate` is strictly newer
// than `incumbent`. Used by mergeMediaCollectionsFromSync to decide whether
// remote overrides local on scalar fields. Same null-loses-to-valid rule
// as `compareEarlierWins`. Ties → incumbent (local) wins.
function compareNewerWins(candidate, incumbent) {
  const cMs = parseTsMs(candidate);
  const iMs = parseTsMs(incumbent);
  if (cMs === null) return false;       // candidate unparseable → never overrides
  if (iMs === null) return true;        // incumbent unparseable, candidate valid → take valid
  return cMs > iMs;
}

function collectionsEqual(a, b) {
  // Both sides come through sanitizeCollection so key order is canonical and
  // JSON.stringify is sufficient for "did anything actually move".
  return JSON.stringify(a) === JSON.stringify(b);
}
