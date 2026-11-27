/** Media collection storage, canonical record shapes and inventory reads. */

import { MEDIA_COLLECTION_ITEMS_MAX, REF_MAX_LENGTH, itemKey, ITEM_KIND, parseKey } from '../../lib/mediaItemKey.js';
import { codedError } from '../../lib/codedError.js';
import { sanitizeOrigin } from '../../lib/sharingOrigin.js';
import { parseTsMs } from '../../lib/lwwTimestamp.js';
import { join } from 'path';
import { PATHS } from '../../lib/fileUtils.js';
import { createCollectionStore } from '../../lib/collectionStore.js';
import { emitRecordUpdated, autoSubscribeRecordToAllPeers } from '../sharing/recordEvents.js';

export const ERR_NOT_FOUND = 'NOT_FOUND';
export const ERR_DUPLICATE = 'DUPLICATE';
export const ERR_VALIDATION = 'VALIDATION_ERROR';
export const ERR_INCOMPLETE_INVENTORY = 'MEDIA_COLLECTION_INVENTORY_INCOMPLETE';

export const NAME_MAX_LENGTH = 80;
export const DESCRIPTION_MAX_LENGTH = 500;
export const ITEMS_MAX = MEDIA_COLLECTION_ITEMS_MAX;

// Bounded fan-out for the multi-record snapshot-merge / GC-sweep loops. Distinct
// record ids ride distinct per-record write queues, so these are safe to run
// concurrently; the cap keeps a large snapshot from opening hundreds of file
// descriptors at once. (Same-id writes still serialize inside queueRecordWrite.)
export const COLLECTION_WRITE_CONCURRENCY = 8;

// A collection id is a filesystem path segment (data/media-collections/<id>/).
// The store's idPattern allowlist rejects anything else, so a record whose id
// can't round-trip to its own dir is unrepresentable — `sanitizeCollection`
// drops it here so a malformed/peer-supplied id is skipped at the boundary
// rather than thrown deep inside `queueRecordWrite` (which would abort a whole
// sync batch). Single source of truth: also passed to `createCollectionStore`.
const COLLECTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

// A malformed/overlong id can't name any stored collection (ids are the fixed
// path-segment allowlist above), so map it to NOT_FOUND — the same result the
// pre-split `listCollections` scan gave for an unknown id. Without this, the
// id-accepting write mutators would hand a bad id to `queueRecordWrite`, which
// throws a raw (uncoded) store error that the route mapper surfaces as a 500
// instead of a clean 404. Read paths (`loadOne`) already return null for a bad
// id, so they don't need this; the write paths throw before `loadOne` runs.
export const assertCollectionId = (id) => {
  if (typeof id !== 'string' || !COLLECTION_ID_PATTERN.test(id)) {
    throw codedError(`Collection not found: ${id}`, ERR_NOT_FOUND);
  }
};

export { REF_MAX_LENGTH, itemKey };

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

// Per-item removal records (#12433): `removedItems: { "<kind>:<ref>": removedAt }`.
// Item lists union on merge, so without a marker any peer still holding a removed
// item re-adds it. A copy of an item survives only when its `addedAt` is strictly
// newer than the removal for its key; a re-add supersedes the removal by carrying
// a newer `addedAt`, and the record itself is KEPT (a stale peer copy with the
// original `addedAt` must still lose). Records are pruned only by tombstone GC
// once every subscribed peer has had the chance to apply them
// (`pruneCollectionItemRemovals`). Omitted from the record when empty.
export const sanitizeRemovedItems = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const entries = [];
  for (const [key, removedAt] of Object.entries(raw)) {
    if (parseTsMs(removedAt) === null) continue;
    const parsed = parseKey(key);
    const item = parsed && sanitizeItem({ ...parsed, addedAt: removedAt });
    if (!item || itemKey(item) !== key) continue;
    entries.push([key, removedAt]);
  }
  // Deliberately uncapped: dropping an unacknowledged record would let a stale
  // copy back in. There is at most one record per distinct key, and tombstone
  // GC is what bounds them. Sorted keys keep the wire form and snapshot
  // checksum byte-stable.
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
};

export const isSupersededByRemoval = (item, removedItems) => {
  const removedMs = parseTsMs(removedItems[itemKey(item)]);
  return removedMs !== null && !(parseTsMs(item.addedAt) > removedMs);
};

// A local add/remove must order strictly after the opposite event it replaces,
// even when that event came from a peer whose clock runs ahead of ours.
export const stampAfter = (ts) => new Date(Math.max(Date.now(), (parseTsMs(ts) ?? -Infinity) + 1)).toISOString();

export const UNIVERSE_ID_MAX = 80;
export const SERIES_ID_MAX = 80;

// Provenance stamp (#3311). `'auto'` = minted by a machine flow (Creative
// Director project, Writers Room work, universe/series render bucket);
// `'user'` = the person created it through the API. The grid uses it to sort
// auto-generated empties last and to badge the card.
//
// **LOCAL-ONLY.** `sanitizeRecordForWire` strips it, so provenance never
// crosses to a peer — see the rationale there (an emitted field would leave an
// upgraded peer permanently checksum-mismatched against an older one, and
// gating it behind a `schemaVersions` bump would pause all collection sync).
// Every install derives its own: the creators below stamp at mint time and
// `scripts/migrations/220-backfill-media-collection-source.js` classifies
// whatever was already on disk when the install upgraded.
//
// **Absent is a THIRD state, not a synonym for `'user'`.** A record written
// before this field shipped, or received from a peer after this install's
// migration ran, carries no stamp at all — the client falls back to its marker
// heuristic for those rather than mislabeling them user-made. So the sanitizer
// OMITS the key entirely rather than defaulting it (same posture as
// `sanitizeItem`'s optional `origin`).
export const COLLECTION_SOURCES = Object.freeze(['auto', 'user']);
const sanitizeSource = (raw) => (COLLECTION_SOURCES.includes(raw) ? raw : null);
export const sanitizePrimaryInstanceId = (raw) => typeof raw === 'string' && raw.length > 0 && raw.length <= 128 ? raw : null;

export const sanitizeCollection = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  // Reject ids the store can't persist (path-segment allowlist) so a peer-
  // supplied / hand-edited bogus id is dropped here instead of throwing inside
  // queueRecordWrite and aborting the rest of a merge batch.
  if (typeof raw.id !== 'string' || !COLLECTION_ID_PATTERN.test(raw.id)) return null;
  if (typeof raw.name !== 'string') return null;
  const name = raw.name.trim().slice(0, NAME_MAX_LENGTH);
  if (!name) return null;
  const description = typeof raw.description === 'string'
    ? raw.description.trim().slice(0, DESCRIPTION_MAX_LENGTH)
    : '';
  const removedItems = sanitizeRemovedItems(raw.removedItems);
  const seen = new Set();
  const items = [];
  if (Array.isArray(raw.items)) {
    for (const it of raw.items) {
      const s = sanitizeItem(it);
      if (!s || isSupersededByRemoval(s, removedItems)) continue;
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
  const source = sanitizeSource(raw.source);
  const primaryInstanceId = sanitizePrimaryInstanceId(raw.primaryInstanceId);
  return {
    id: raw.id,
    name,
    description,
    coverKey,
    universeId,
    seriesId,
    ...(source ? { source } : {}),
    ...(primaryInstanceId ? { primaryInstanceId } : {}),
    items,
    ...(Object.keys(removedItems).length ? { removedItems } : {}),
    createdAt,
    updatedAt,
    deleted,
    deletedAt,
  };
};

// Storage-layout (type-level) schema version stamped on
// data/media-collections/index.json. Distinct from the wire schemaVersion in
// server/lib/schemaVersions.js (the on-disk split doesn't change the wire
// payload shape, so that stays at 1). Bump only on a future layout change.
const TYPE_SCHEMA_VERSION = 1;

// Lazy store getter — PATHS.data may not be available at module-load time
// (tests swap it through a Proxy mock so different cases get different temp
// roots). Mirrors universeBuilder.js's `store()` pattern: re-create when the
// resolved dir changes so a remapped data root takes effect.
let _store = null;
export const store = () => {
  const dir = join(PATHS.data, 'media-collections');
  if (_store && _store.dir === dir) return _store;
  _store = createCollectionStore({
    dir,
    type: 'mediaCollections',
    schemaVersion: TYPE_SCHEMA_VERSION,
    // Same allowlist `sanitizeCollection` enforces, so the store and the
    // sanitizer agree on which ids are representable (no drift).
    idPattern: COLLECTION_ID_PATTERN,
    // Runs on every loadOne/loadAll. Tombstones (deleted:true) survive
    // sanitization so the mutators and merge path can see them.
    sanitizeRecord: sanitizeCollection,
  });
  return _store;
};

// Exposed for the boot-time verifier in server/index.js.
export const mediaCollectionStore = () => store();

export async function listCollections({ includeDeleted = false, requireComplete = false } = {}) {
  const { records: all, failedIds } = await store().loadAllResult();
  if (requireComplete && failedIds.length) {
    throw codedError('Some media collections could not be loaded. Unsorted consolidation did not start.', ERR_INCOMPLETE_INVENTORY);
  }
  if (includeDeleted) return all;
  return all.filter((c) => c.deleted !== true);
}

/**
 * Every collection id on disk (live AND tombstoned) — a directory listing, no
 * record hydration. Backs tombstoneGc's ALL_ID_LISTERS.mediaCollection (the
 * orphan peer-subscription sweep); LIVE_ID_LISTERS keeps `listCollections()`
 * because `deleted` lives inside the record file, so there is no cheaper live
 * projection for this file-backed store the way the DB-backed kinds have one.
 */
export async function listCollectionIds() {
  return store().listIds();
}

export async function getCollection(id, { includeDeleted = false } = {}) {
  const c = await store().loadOne(id);
  if (!c) throw codedError(`Collection not found: ${id}`, ERR_NOT_FOUND);
  if (c.deleted === true && !includeDeleted) throw codedError(`Collection not found: ${id}`, ERR_NOT_FOUND);
  return c;
}

// Announce a newly-created collection to the per-record peer-sync pipeline:
// emit the 'updated' event so any existing subscription pushes it, AND
// auto-subscribe every mediaCollections-enabled peer so brand-new collections
// (and their later tombstones) propagate even when that peer has universe/series
// sync disabled. Goes through the recordEvents subscription adapter — peerSync
// imports mergeMediaCollectionsFromSync from here, so importing it back (even
// dynamically) would close a cycle. Call ONLY when a brand-new record was
// persisted — never on a find-existing hit, or every render would re-announce
// and churn the pipeline.
export const announceNewCollection = (id) => {
  emitRecordUpdated('mediaCollection', id);
  autoSubscribeRecordToAllPeers('mediaCollection', id).catch(() => {});
};
