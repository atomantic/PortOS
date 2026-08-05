/**
 * Brain Search Index
 *
 * In-memory field projections of the brain entity stores, so unified search
 * (`server/services/search.js`) can answer a keystroke without re-reading and
 * re-parsing every record file on disk (issue #3506).
 *
 * Brain entity stores are per-record `collectionStore` dirs
 * (`data/brain/<type>/<id>/index.json`) with NO whole-store cache — every
 * `brainStorage.getAll(type)` lists the directory and `loadOne`s each record.
 * That is the right trade for the write paths, but the ⌘K palette fans out to
 * seven of those stores on EVERY keystroke, so a brain of a few thousand
 * records turns each character typed into thousands of stat+read+JSON.parse
 * calls. This module reads each store at most once and then keeps the
 * projection fresh from `brainEvents`.
 *
 * Only the fields search actually matches on (plus the ordering key) are
 * projected — the index holds no attachments, embeddings, or classification
 * payloads.
 *
 * FRESHNESS — three signal classes, all of them covered:
 *   1. `${type}:upserted` / `${type}:deleted` — the per-record events every
 *      local write path emits (create/update/updateWith/updateMany/remove, and
 *      upsertWithId in its default mode). Patched incrementally, no re-scan.
 *   2. `record:changed` — the local-only invalidation signal brainStorage emits
 *      from the write paths that are deliberately event-SILENT: peer applies
 *      (`applyRemoteRecord`, silent to prevent the #1077 cross-peer echo) and
 *      `upsertWithId({ emitEvent: false })`. Without it an inbound sync or
 *      anti-entropy reconcile would leave this cache stale indefinitely.
 *   3. Nothing else writes brain entity records — `pruneTombstones` only hard-
 *      prunes tombstones, which `getAll` strips and which therefore were never
 *      in the projection, and `backfillOriginInstanceId` runs once at boot and
 *      touches no projected field.
 */

import { getAll, brainEvents, memoryRecencyMs } from './brainStorage.js';
import { safeDate } from '../lib/fileUtils.js';

// The projected fields per searchable brain type — the exact set
// `searchBrain` matches on and renders snippets from.
const SEARCH_FIELDS = Object.freeze({
  inbox: Object.freeze(['capturedText']),
  people: Object.freeze(['name', 'context']),
  projects: Object.freeze(['name', 'notes']),
  ideas: Object.freeze(['title', 'oneLiner', 'notes']),
  admin: Object.freeze(['title', 'notes', 'nextAction']),
  memories: Object.freeze(['title', 'content', 'mood']),
  links: Object.freeze(['title', 'url', 'description']),
});

/** The brain entity types this index covers. */
export const BRAIN_SEARCH_TYPES = Object.freeze(Object.keys(SEARCH_FIELDS));

// Newest-first ordering key, for the two types whose reader sorted before
// handing records to search: inbox by capture time, memories by the
// import-aware recency clock. Types with no ranker keep the store's natural
// (id) order, exactly as their `getAll`-backed readers did.
const RANKERS = Object.freeze({
  inbox: (record) => safeDate(record?.capturedAt),
  memories: (record) => memoryRecencyMs(record),
});

/**
 * Per-type cache slot.
 *
 * `null` = NOT BUILT. A `Map` — INCLUDING an empty one — = built. The
 * distinction is load-bearing: a user with zero links must get a cache hit, not
 * a directory re-scan on every keystroke, so nothing here may branch on
 * `.size`/`.length` truthiness.
 */
const cache = {};
// Bumped by every invalidation. A rebuild that started before the bump is
// discarded rather than cached, so a sync landing mid-build can't be undone.
const generation = {};
// In-flight rebuild per type, so a burst of keystrokes shares one disk scan.
const building = {};

function resetState() {
  for (const type of BRAIN_SEARCH_TYPES) {
    cache[type] = null;
    generation[type] = 0;
    delete building[type];
  }
}
resetState();

function project(type, record) {
  const projection = { id: record.id };
  for (const field of SEARCH_FIELDS[type]) {
    projection[field] = record[field];
  }
  const ranker = RANKERS[type];
  if (ranker) projection._rank = ranker(record);
  return projection;
}

function sortProjections(type, projections) {
  // Newest-first. Only ranked types reorder; the rest keep store order.
  return RANKERS[type] ? projections.sort((a, b) => b._rank - a._rank) : projections;
}

function invalidate(type) {
  if (!(type in cache)) return;
  cache[type] = null;
  generation[type] += 1;
}

function patchUpsert(type, record) {
  if (!(type in cache) || !record?.id) return;
  const map = cache[type];
  if (!map) {
    // Not built (possibly mid-rebuild): there is nothing to patch, and the
    // in-flight scan may already have missed this write — bump the generation
    // so its result is discarded instead of cached stale.
    generation[type] += 1;
    return;
  }
  map.set(record.id, project(type, record));
}

function patchDelete(type, id) {
  if (!(type in cache) || !id) return;
  const map = cache[type];
  if (!map) {
    generation[type] += 1;
    return;
  }
  map.delete(id);
}

/**
 * Field projections for one brain type, newest-first where the type is ranked.
 *
 * Reads the store from disk at most once per invalidation; every later call is
 * served from memory. Returns a fresh array each call (callers filter/map it),
 * but the projection objects themselves are shared — treat them as read-only.
 * Ranked types carry a `_rank` ordering key alongside the projected fields.
 */
export async function getBrainProjections(type) {
  if (!(type in cache)) throw new Error(`brainSearchIndex: unknown search type "${type}"`);

  const cached = cache[type];
  if (cached) return sortProjections(type, [...cached.values()]);

  if (!building[type]) {
    const startedAt = generation[type];
    building[type] = getAll(type)
      .then((records) => {
        const map = new Map((records ?? []).map((r) => [r.id, project(type, r)]));
        // Only adopt the scan if nothing invalidated the type while it ran.
        if (generation[type] === startedAt) cache[type] = map;
        return map;
      })
      .finally(() => { delete building[type]; });
  }

  const map = await building[type];
  return sortProjections(type, [...map.values()]);
}

// Wire the freshness signals once, at module load.
for (const type of BRAIN_SEARCH_TYPES) {
  brainEvents.on(`${type}:upserted`, ({ record } = {}) => patchUpsert(type, record));
  brainEvents.on(`${type}:deleted`, ({ id } = {}) => patchDelete(type, id));
}
brainEvents.on('record:changed', ({ type } = {}) => invalidate(type));

/** Test hook — drop every projection and reset the in-flight/generation state. */
export function __resetBrainSearchIndex() {
  resetState();
}
