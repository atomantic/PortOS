/**
 * Duplicate detection for Universes and Series.
 *
 * Universes use random UUIDs and Series use `ser-<uuid>` — neither id is
 * derived from the name and there is NO name-uniqueness constraint. So two
 * installs that independently create "Clandestiny" produce two different ids
 * that ID-keyed peer sync treats as separate records, leaving same-named
 * duplicates on the merged machine. (Media collections sidestep this with the
 * deterministic `uc-`/`sc-` id scheme — see migration 038 — so they are not
 * scanned here.)
 *
 * Detection is ON-DEMAND (computed when the user opens the Sharing → Duplicates
 * tab) rather than flagged on sync ingest: a read-time grouping needs no
 * persisted flags and no per-60s-snapshot write storm, and it always reflects
 * whatever just synced.
 *
 * Series are grouped WITHIN a universe — two same-name series in different
 * universes are NOT duplicates (mirrors importer.findSeriesByName(name,
 * universeId) scoping). Orphan series (no universeId) surface in a separate
 * marked bucket and are never offered for cross-universe merge.
 */

import { normalizeBibleName as normName } from '../lib/storyBible.js';
import { listUniverses } from './universeBuilder.js';
import { listSeries } from './pipeline/series.js';
import { listCollections } from './mediaCollections.js';

const isNonEmptyArray = (a) => Array.isArray(a) && a.length > 0;

// Per-universe canon/category counts, used by the UI to suggest a survivor
// (e.g. "merge into the one with the most canon") without a second round-trip.
const universeCounts = (u) => ({
  characters: Array.isArray(u.characters) ? u.characters.length : 0,
  places: Array.isArray(u.places) ? u.places.length : 0,
  objects: Array.isArray(u.objects) ? u.objects.length : 0,
  categories: u.categories && typeof u.categories === 'object' ? Object.keys(u.categories).length : 0,
  compositeSheets: Array.isArray(u.compositeSheets) ? u.compositeSheets.length : 0,
  embrace: isNonEmptyArray(u.influences?.embrace) ? u.influences.embrace.length : 0,
  avoid: isNonEmptyArray(u.influences?.avoid) ? u.influences.avoid.length : 0,
});

// Group an array by a key function, returning only groups with >= 2 members.
const groupDuplicates = (items, keyFn) => {
  const byKey = new Map();
  for (const it of items) {
    const key = keyFn(it);
    if (!key) continue;
    const arr = byKey.get(key);
    if (arr) arr.push(it);
    else byKey.set(key, [it]);
  }
  return [...byKey.entries()].filter(([, arr]) => arr.length >= 2);
};

/**
 * Find sets of non-deleted, non-ephemeral universes that share a normalized
 * name. Returns `[{ normalizedName, records: [...] }]`.
 */
export async function findDuplicateUniverseGroups() {
  const [universes, seriesAll, collections] = await Promise.all([
    listUniverses(),
    listSeries(),
    listCollections(),
  ]);
  const live = universes.filter((u) => !u.deleted && u.ephemeral !== true);

  // Pre-index linked-series count + collection item count per universe so the
  // scan stays single-pass (no per-universe re-list).
  const seriesByUniverse = new Map();
  for (const s of seriesAll) {
    if (!s.universeId) continue;
    seriesByUniverse.set(s.universeId, (seriesByUniverse.get(s.universeId) || 0) + 1);
  }
  const collectionItemsByUniverse = new Map();
  for (const c of collections) {
    if (c.deleted || !c.universeId) continue;
    collectionItemsByUniverse.set(
      c.universeId,
      (collectionItemsByUniverse.get(c.universeId) || 0) + (c.items || []).length,
    );
  }

  const groups = groupDuplicates(live, (u) => normName(u.name));
  return groups.map(([normalizedName, records]) => ({
    normalizedName,
    records: records
      .map((u) => ({
        id: u.id,
        name: u.name,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
        counts: universeCounts(u),
        linkedSeriesCount: seriesByUniverse.get(u.id) || 0,
        linkedCollectionItemCount: collectionItemsByUniverse.get(u.id) || 0,
      }))
      // Stable display order: newest first (most likely the survivor).
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')),
  }));
}

/**
 * Find sets of non-deleted, non-ephemeral series that share a normalized name
 * WITHIN the same universe. Orphan series (no universeId) are returned in a
 * separate `orphans` array (grouped among themselves) and flagged — they should
 * not exist post-migration-039 and must never be merged across the null
 * boundary.
 */
export async function findDuplicateSeriesGroups() {
  const [seriesAll, universes] = await Promise.all([listSeries(), listUniverses()]);
  const live = seriesAll.filter((s) => !s.deleted && s.ephemeral !== true);
  const universeNameById = new Map(universes.map((u) => [u.id, u.name]));

  const linked = live.filter((s) => s.universeId);
  const orphanRecords = live.filter((s) => !s.universeId);

  const toRecord = (s) => ({
    id: s.id,
    name: s.name,
    universeId: s.universeId || null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    issueCountTarget: s.issueCountTarget || 0,
    hasArc: !!s.arc,
    seasonCount: Array.isArray(s.seasons) ? s.seasons.length : 0,
  });

  // Scope the grouping key by universe — a NUL separator can't appear in a name
  // or id, so "<universeId>\0<name>" can't collide across universes.
  const groups = groupDuplicates(linked, (s) => `${s.universeId}\0${normName(s.name)}`);
  const series = groups.map(([, records]) => ({
    universeId: records[0].universeId,
    universeName: universeNameById.get(records[0].universeId) || null,
    normalizedName: normName(records[0].name),
    records: records.map(toRecord).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')),
  }));

  // Orphans: group same-name orphans together so the UI can show "these N
  // orphan series share a name" — but they're a distinct, un-mergeable bucket.
  const orphanGroups = groupDuplicates(orphanRecords, (s) => normName(s.name))
    .map(([normalizedName, records]) => ({
      normalizedName,
      records: records.map(toRecord).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')),
    }));

  return { series, orphans: orphanGroups, orphanCount: orphanRecords.length };
}

/**
 * Non-blocking create/rename warning: same-name live universes (excluding the
 * record being created/updated). The route layer attaches the result as
 * `_warnings.duplicateName`; the UI decides whether to proceed.
 */
export async function findSameNameUniverses(name, { excludeId = null } = {}) {
  const target = normName(name);
  if (!target) return [];
  const universes = await listUniverses();
  return universes
    .filter((u) => !u.deleted && u.ephemeral !== true && u.id !== excludeId && normName(u.name) === target)
    .map((u) => ({ id: u.id, name: u.name }));
}

/**
 * Same-name live series within a given universe (excluding the record being
 * created/updated). Orphan/no-universe creates pass `universeId = null` and get
 * an empty result — orphans aren't duplicate-warned (they shouldn't exist).
 */
export async function findSameNameSeries(name, universeId, { excludeId = null } = {}) {
  const target = normName(name);
  if (!target || !universeId) return [];
  const series = await listSeries();
  return series
    .filter((s) => !s.deleted && s.ephemeral !== true && s.id !== excludeId
      && s.universeId === universeId && normName(s.name) === target)
    .map((s) => ({ id: s.id, name: s.name }));
}
