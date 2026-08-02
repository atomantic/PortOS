// Search / sort ordering for the Media Collections grid (#3283).
//
// The grid is dominated by collections nothing created on purpose: every
// Creative Director project, Writers Room render batch, and universe/series
// render bucket auto-files itself as a collection, so a user with a handful of
// real collections scrolls past dozens of empty auto-generated ones to find
// them. These helpers give the page one definition of "auto-generated" and the
// display ordering that keeps real collections on top.
//
// Pure — no React, no I/O. The page and its tests share them.

import { tokenizeQuery, matchHaystack } from './mediaSearch.js';

// Shared name prefixes that auto-creators stamp onto every collection they
// make, paired with the badge label the card renders above the title instead
// of inside it — otherwise every auto-generated card shows the same clipped
// prefix and the trailing project name/date that tells them apart is what gets
// cut. This list drives PRESENTATION (the badge) plus the provenance fallback
// for records an older peer sent without a `source` stamp — the classification
// itself comes from `collection.source` now (#3311), so a new auto-creator only
// has to stamp `source: 'auto'` server-side, not extend this list (it should
// still add its prefix here if it wants the badge). Keep in sync with the
// server-side creators: `universeCollectionNameFor`
// / `seriesCollectionNameFor` in `server/services/mediaCollections.js`,
// `server/services/creativeDirector/projects{DB,File}.js`, and
// `server/services/writersRoom/local.js`.
export const AUTO_NAME_PREFIXES = [
  'Creative Director: ',
  'Writers Room: ',
  'Universe: ',
  'Series: ',
].map((prefix) => ({ prefix, badge: prefix.replace(/[:\s]+$/, '') }));

// Descriptions stamped by the auto-creators. A user can't produce these by
// accident through the UI (the create form takes a name only).
const AUTO_DESCRIPTION_PREFIXES = ['Auto-created for project ', 'Auto-generated images for '];

// Deterministic id prefixes for the universe-/series-linked render buckets the
// pipeline files into (see `mediaCollections.js` — `uc-<universeId>` /
// `sc-<seriesId>`).
const AUTO_ID_PREFIXES = ['uc-', 'sc-'];

// One collator for every name comparison — `String.localeCompare` rebuilds
// collation state on each call, and these run per comparison during a sort.
// `sensitivity: 'base'` makes it case- and accent-insensitive, so the sort key
// needs no `toLowerCase()`.
const collator = new Intl.Collator(undefined, { sensitivity: 'base' });

/**
 * Split a collection name into its auto-creator badge label and the remaining
 * title. Returns `{ badge: null, title: name }` for a user-named collection.
 * @param {string} name
 * @returns {{ badge: string|null, title: string }}
 */
export function splitCollectionName(name) {
  const str = typeof name === 'string' ? name : '';
  for (const { prefix, badge } of AUTO_NAME_PREFIXES) {
    if (str.startsWith(prefix) && str.length > prefix.length) {
      return { badge, title: str.slice(prefix.length) };
    }
  }
  return { badge: null, title: str };
}

/**
 * True when a collection was created by an automated flow rather than by the
 * user.
 *
 * The server stamps provenance at mint time (`source: 'auto' | 'user'`, #3311)
 * and migration 220 backfilled existing records, so the stamp is authoritative
 * whenever it is present — a new auto-creator no longer has to remember to
 * extend a client-side list.
 *
 * An ABSENT `source` is a third state, NOT a synonym for `'user'`: the record
 * came from a federated peer still running a PortOS that predates the field (or
 * was restored from a pre-migration backup). Those fall back to the marker
 * heuristic below, where any ONE of the four independent markers is sufficient
 * — an install can hold records from before a given marker existed, so this
 * must not require all of them to agree.
 * @param {object} collection
 * @returns {boolean}
 */
export function isAutoCollection(collection) {
  if (!collection || collection.synthetic) return false;
  if (collection.source === 'auto') return true;
  if (collection.source === 'user') return false;
  if (splitCollectionName(collection.name).badge) return true;
  const description = typeof collection.description === 'string' ? collection.description : '';
  if (AUTO_DESCRIPTION_PREFIXES.some((p) => description.startsWith(p))) return true;
  const id = typeof collection.id === 'string' ? collection.id : '';
  if (AUTO_ID_PREFIXES.some((p) => id.startsWith(p))) return true;
  return Boolean(collection.universeId || collection.seriesId);
}

/** Item count for a collection (0 for a malformed/absent items array). */
export function collectionItemCount(collection) {
  return Array.isArray(collection?.items) ? collection.items.length : 0;
}

// The sort control's options, in menu order. First entry is the default.
export const COLLECTION_SORTS = [
  { id: 'updated', label: 'Recently updated' },
  { id: 'name', label: 'Name' },
  { id: 'count', label: 'Item count' },
];

export const DEFAULT_COLLECTION_SORT = COLLECTION_SORTS[0].id;

/** Coerce a stored/URL sort id to a known one (unknown → the default). */
export function normalizeCollectionSort(raw) {
  return COLLECTION_SORTS.some((s) => s.id === raw) ? raw : DEFAULT_COLLECTION_SORT;
}

// Sort timestamp. `null`/absent means "never stamped" — distinct from a real
// epoch-0 date — and sorts last rather than pretending to be the oldest record.
const updatedTime = (collection) => {
  const raw = collection?.updatedAt || collection?.createdAt;
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

// Derive every sort/search key ONCE per record. Recomputing them inside the
// comparator would re-run the prefix split, the auto-collection markers, and
// Date.parse on both operands of every one of the O(n log n) comparisons.
//
// The name key is the PREFIX-STRIPPED title, so the auto-generated entries
// interleave by their real project names instead of all clumping under "C"/"U"
// — the same reason the prefix moves to a badge in the card.
const decorate = (record) => {
  const count = collectionItemCount(record);
  return {
    record,
    // Ordering bucket: synthetic ("Unsorted") is pinned first, then anything
    // with items or a user-chosen name, then the auto-generated empties that
    // motivated this. Within a bucket the caller's sort applies.
    bucket: record?.synthetic ? 0 : ((count === 0 && isAutoCollection(record)) ? 2 : 1),
    nameKey: splitCollectionName(record?.name).title,
    time: updatedTime(record),
    count,
    // Same AND-token semantics as the media search, over name + description.
    haystack: `${record?.name || ''} ${record?.description || ''}`.toLowerCase(),
  };
};

const compareBy = (sort) => (a, b) => {
  if (sort === 'name') return collator.compare(a.nameKey, b.nameKey);
  if (sort === 'count') return (b.count - a.count) || collator.compare(a.nameKey, b.nameKey);
  if (a.time === b.time) return collator.compare(a.nameKey, b.nameKey);
  if (a.time === null) return 1;
  if (b.time === null) return -1;
  return b.time - a.time;
};

/**
 * Filter + order the collection grid. "Hide empty" is deliberately NOT applied
 * here: the page needs both the full match set and the non-empty slice to say
 * how many rows the toggle removed, so it owns that one predicate
 * (`collectionItemCount(c) > 0`) rather than having two definitions of empty.
 * @param {object[]} collections - Enriched collections (synthetic entry included)
 * @param {object} view
 * @param {string} [view.query] - Free-text name/description search
 * @param {string} [view.sort] - One of COLLECTION_SORTS ids
 * @returns {object[]} A new array of the input records; the input is not mutated
 */
export function applyCollectionView(collections, { query = '', sort = DEFAULT_COLLECTION_SORT } = {}) {
  const tokens = tokenizeQuery(query);
  const comparator = compareBy(normalizeCollectionSort(sort));
  return (collections || [])
    .map(decorate)
    .filter((d) => matchHaystack(d.haystack, tokens))
    .sort((a, b) => (a.bucket - b.bucket) || comparator(a, b))
    .map((d) => d.record);
}
