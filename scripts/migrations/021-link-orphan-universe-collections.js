/**
 * Link pre-existing "Universe: <name>" media collections to their universes
 * by name match.
 *
 * Background:
 *   The cover-auto-file feature (PR #273) routes universe-owned collection
 *   provisioning through `findOrCreateUniverseCollection`, which resolves
 *   by `universeId` and DOES NOT adopt a same-name unlinked collection at
 *   runtime — that path can't tell a true pre-link legacy bucket apart
 *   from a post-`deleteUniverse` orphan, so adopting either would risk
 *   silently mixing renders across universes.
 *
 *   Upgraded installs that have an existing unlinked `Universe: <name>`
 *   bucket (filed manually before universeId stamping existed) would
 *   otherwise get a duplicate bucket on the next render, with new covers
 *   landing in the fresh bucket and the legacy renders stranded.
 *
 * What this does:
 *   1. Forward-link: index universes by the *canonical collection name*
 *      they'd produce (`"Universe: " + name`, truncated to 80 chars — the
 *      same transform the runtime helper uses). For each unlinked
 *      collection whose name matches exactly one universe's canonical name
 *      (case-insensitive), stamp the `universeId` AND canonicalize the
 *      visible name to the freshly-computed canonical form. Skip zero or
 *      multi matches — the ambiguous case is the same risk this PR
 *      shipped to avoid.
 *   2. Stale-link cleanup: clear `universeId` on any collection whose
 *      stamp doesn't correspond to a current universe. The old
 *      `deleteUniverse` didn't unlink linked collections, so upgraded
 *      installs can have stamped buckets whose universes are long gone —
 *      with this PR's new rename-lock, those would be permanently stuck
 *      under their old name. Unlinking releases the lock so the user can
 *      rename or delete the orphan via normal flows.
 *
 *   Indexing by canonical (truncated) name closes two upgrade-path gaps:
 *     1. Long universe names: the runtime truncates the collection name to
 *        80 chars, so an install with a 100-char universe name has a
 *        collection holding only the truncated suffix. Comparing against
 *        the raw universe name would miss it.
 *     2. Casing/whitespace drift: a legacy bucket named `universe: bar`
 *        (lowercase) gets relinked AND its display name is canonicalized
 *        to `Universe: bar` in the same write — without canonicalization
 *        the rename-lock kicks in immediately and the user is stuck with
 *        the bad-casing name forever.
 *
 * Idempotent: re-runs skip collections that already carry a `universeId`,
 * so this is safe to leave in place forever.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const COLLECTION_NAME_MAX = 80;

const readJson = async (path, fallback) => {
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return fallback;
  return JSON.parse(raw);
};

const writeJson = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + '\n');

// Mirrors `universeCollectionNameFor` in server/services/mediaCollections.js
// — duplicated inline so this one-shot migration's contract is frozen
// against future runtime changes to the naming convention.
const canonicalCollectionName = (universeName) =>
  `Universe: ${typeof universeName === 'string' ? universeName : ''}`.slice(0, COLLECTION_NAME_MAX);

const norm = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');

export default {
  async up({ rootDir }) {
    const collectionsPath = join(rootDir, 'data', 'media-collections.json');
    const universesPath = join(rootDir, 'data', 'universe-builder.json');

    const collectionsDoc = await readJson(collectionsPath, null);
    const universesDoc = await readJson(universesPath, null);
    if (!collectionsDoc || !Array.isArray(collectionsDoc.collections)) {
      return { linked: 0, reason: 'no-collections' };
    }
    if (!universesDoc || !Array.isArray(universesDoc.universes)) {
      return { linked: 0, reason: 'no-universes' };
    }

    // Index universes by the canonical collection-name they'd produce, so
    // long names (truncated) and short names match through the same path.
    // Value is a list — multi-match means ambiguous, skip.
    const universesByCanonicalName = new Map();
    for (const u of universesDoc.universes) {
      const canonical = canonicalCollectionName(u?.name);
      const key = norm(canonical);
      if (!key || key === norm('Universe: ')) continue; // skip universes with empty/whitespace names
      const bucket = universesByCanonicalName.get(key) || [];
      bucket.push(u);
      universesByCanonicalName.set(key, bucket);
    }

    // Set of all current universe ids so we can detect stale stamps
    // (collection.universeId pointing at a universe that no longer exists).
    const currentUniverseIds = new Set(
      universesDoc.universes
        .map((u) => (typeof u?.id === 'string' ? u.id : null))
        .filter(Boolean),
    );

    let linked = 0;
    let unlinkedStale = 0;
    let ambiguous = 0;
    const now = new Date().toISOString();
    for (const c of collectionsDoc.collections) {
      if (c?.universeId) {
        // Stale-link cleanup: pre-PR `deleteUniverse` didn't unlink, and
        // the new rename-lock now strands those orphans permanently. Clear
        // the stamp so the user can rename or delete them via normal flows.
        if (!currentUniverseIds.has(c.universeId)) {
          c.universeId = null;
          c.updatedAt = now;
          unlinkedStale += 1;
        }
        continue;
      }
      if (typeof c?.name !== 'string') continue;
      const key = norm(c.name);
      const matches = universesByCanonicalName.get(key);
      if (!matches || matches.length === 0) continue;
      if (matches.length > 1) {
        ambiguous += 1;
        console.warn(`⚠️ migration 021: collection "${c.name}" matches ${matches.length} universes — skipping (ambiguous link).`);
        continue;
      }
      const universe = matches[0];
      c.universeId = universe.id;
      // Canonicalize the visible name in the same write. After link the
      // rename-lock takes effect, so this is the user's last chance to
      // get the correct casing/whitespace without hand-editing JSON.
      c.name = canonicalCollectionName(universe.name);
      c.updatedAt = now;
      linked += 1;
    }

    if (linked > 0 || unlinkedStale > 0) {
      await writeJson(collectionsPath, collectionsDoc);
    }
    if (linked > 0) {
      console.log(`🔗 migration 021: linked ${linked} legacy "Universe: <name>" collection(s) by canonical-name match.`);
    }
    if (unlinkedStale > 0) {
      console.log(`🔓 migration 021: unlinked ${unlinkedStale} collection(s) whose universe no longer exists (releases rename-lock).`);
    }
    if (ambiguous > 0) {
      console.log(`ℹ️ migration 021: ${ambiguous} collection(s) skipped due to multiple same-named universes.`);
    }
    return { linked, unlinkedStale, ambiguous };
  },
};
