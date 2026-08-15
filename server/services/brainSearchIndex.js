/**
 * Brain Search Index
 *
 * In-memory field projections of the brain entity stores, so unified search
 * (`server/services/search.js`) can answer a keystroke without re-reading and
 * re-parsing every record file on disk (issue #3506), and so the brain graph's
 * search index (`brainGraph.getBrainGraphSearchIndex`) can answer the graph
 * search box without a full-body disk walk (issue #3507).
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
 * Only the fields a consumer actually reads (plus the ordering key) are
 * projected — the index holds no attachments, embeddings, or classification
 * payloads. A consumer that needs a *predicate* over a large body (the Daily
 * Log's `content`/`segments`) gets a derived boolean instead, so the body never
 * enters the cache.
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

/**
 * The projected fields per indexed brain type — the union of what every
 * consumer reads:
 *   - `searchBrain` (server/services/search.js) matches on and renders snippets
 *     from `capturedText` / `name` / `context` / `title` / `oneLiner` / `notes`
 *     / `nextAction` / `content` / `mood` / `url` / `description`.
 *   - `getBrainGraphSearchIndex` (server/services/brainGraph.js) derives each
 *     node's label from `name || title` and drops archived records, while the
 *     edge-bearing graph views also need tags, status, and summary fields.
 * `journals` is graph-only (the Daily Log is not a unified-search source), and
 * projects no body — see `journalHasBody` below. `songs` (SongBook) is
 * graph-only too, and its sheet body lives in `content.text` (up to 200k
 * chars of tab/ChordPro per song). The graph projection keeps only a string
 * `content` value, so the SongBook object never reaches the cache.
 */
const GRAPH_PROJECTION_FIELDS = Object.freeze([
  'name', 'title', 'archived', 'tags', 'status',
  'description', 'context', 'oneLiner', 'artist', 'notes'
]);

const PROJECTED_FIELDS = Object.freeze({
  inbox: Object.freeze(['capturedText']),
  people: GRAPH_PROJECTION_FIELDS,
  projects: GRAPH_PROJECTION_FIELDS,
  ideas: GRAPH_PROJECTION_FIELDS,
  admin: Object.freeze([...GRAPH_PROJECTION_FIELDS, 'nextAction']),
  memories: Object.freeze([...GRAPH_PROJECTION_FIELDS, 'mood']),
  links: Object.freeze(['title', 'url', 'description']),
  journals: Object.freeze(['date']),
  songs: GRAPH_PROJECTION_FIELDS,
});

/**
 * Is this Daily Log entry non-empty? The graph only asks the question — it
 * never renders the answer's source — and a journal body is the largest record
 * in the brain, so the predicate is projected and `content`/`segments` are not.
 * Exported so `brainGraph`'s journal path applies the identical rule.
 */
export const journalHasBody = (record) => !!(record?.content || record?.segments?.length);

const stringContent = (record) => typeof record?.content === 'string' ? record.content : undefined;
const GRAPH_DERIVED_FIELDS = Object.freeze({ content: stringContent });

// Fields computed from the record rather than copied off it, per type.
const DERIVED_FIELDS = Object.freeze({
  people: GRAPH_DERIVED_FIELDS,
  projects: GRAPH_DERIVED_FIELDS,
  ideas: GRAPH_DERIVED_FIELDS,
  admin: GRAPH_DERIVED_FIELDS,
  memories: GRAPH_DERIVED_FIELDS,
  songs: GRAPH_DERIVED_FIELDS,
  journals: Object.freeze({ hasBody: journalHasBody }),
});

/**
 * The brain entity types unified search reads. A strict subset of
 * `BRAIN_PROJECTION_TYPES` — every source `search.js` fans out to must be
 * indexed here or its `getBrainProjections` call throws.
 */
export const BRAIN_SEARCH_TYPES = Object.freeze([
  'inbox', 'people', 'projects', 'ideas', 'admin', 'memories', 'links',
]);

/** Every brain entity type this index projects (search sources + graph-only). */
export const BRAIN_PROJECTION_TYPES = Object.freeze(Object.keys(PROJECTED_FIELDS));

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
  for (const type of BRAIN_PROJECTION_TYPES) {
    cache[type] = null;
    generation[type] = 0;
    delete building[type];
  }
}
resetState();

function project(type, record) {
  const projection = { id: record.id };
  for (const field of PROJECTED_FIELDS[type]) {
    projection[field] = record[field];
  }
  for (const [field, derive] of Object.entries(DERIVED_FIELDS[type] ?? {})) {
    projection[field] = derive(record);
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
 *
 * `ranked: false` keeps store order for a type that HAS a ranker. The brain
 * graph's node list is built from `brainStorage.getAll()` order, so the graph
 * search index opts out rather than silently reordering its `memories` nodes.
 */
export async function getBrainProjections(type, { ranked = true } = {}) {
  if (!(type in cache)) throw new Error(`brainSearchIndex: unknown projection type "${type}"`);
  const order = (projections) => (ranked ? sortProjections(type, projections) : projections);

  const cached = cache[type];
  if (cached) return order([...cached.values()]);

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
  return order([...map.values()]);
}

// Wire the freshness signals once, at module load.
for (const type of BRAIN_PROJECTION_TYPES) {
  brainEvents.on(`${type}:upserted`, ({ record } = {}) => patchUpsert(type, record));
  brainEvents.on(`${type}:deleted`, ({ id } = {}) => patchDelete(type, id));
}
brainEvents.on('record:changed', ({ type } = {}) => invalidate(type));

/** Test hook — drop every projection and reset the in-flight/generation state. */
export function __resetBrainSearchIndex() {
  resetState();
}
