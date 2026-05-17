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
 *   For each collection whose name matches `Universe: <X>` and whose
 *   `universeId` is null, look for exactly ONE universe whose name (after
 *   the `Universe: ` prefix is stripped) matches `<X>`. If found, stamp
 *   `universeId` onto the collection. Skip collections that match zero or
 *   multiple universes — the ambiguous case is the same risk this PR
 *   shipped to avoid.
 *
 * Idempotent: re-runs skip collections that already carry a `universeId`,
 * so this is safe to leave in place forever.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const UNIVERSE_NAME_PREFIX_RE = /^Universe:\s*(.+)$/i;

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

const universeNameFromCollectionName = (name) => {
  if (typeof name !== 'string') return null;
  const m = UNIVERSE_NAME_PREFIX_RE.exec(name.trim());
  return m ? m[1].trim() : null;
};

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

    // Build a name → [universe...] index so the ambiguous case is detectable.
    const universesByName = new Map();
    for (const u of universesDoc.universes) {
      const key = norm(u?.name);
      if (!key) continue;
      const bucket = universesByName.get(key) || [];
      bucket.push(u);
      universesByName.set(key, bucket);
    }

    let linked = 0;
    let ambiguous = 0;
    const now = new Date().toISOString();
    for (const c of collectionsDoc.collections) {
      if (c?.universeId) continue;
      const universeName = universeNameFromCollectionName(c?.name);
      if (!universeName) continue;
      const matches = universesByName.get(norm(universeName));
      if (!matches || matches.length === 0) continue;
      if (matches.length > 1) {
        ambiguous += 1;
        console.warn(`⚠️ migration 021: collection "${c.name}" matches ${matches.length} universes — skipping (ambiguous link).`);
        continue;
      }
      c.universeId = matches[0].id;
      c.updatedAt = now;
      linked += 1;
    }

    if (linked > 0) {
      await writeJson(collectionsPath, collectionsDoc);
      console.log(`🔗 migration 021: linked ${linked} legacy "Universe: <name>" collection(s) by name match.`);
    }
    if (ambiguous > 0) {
      console.log(`ℹ️ migration 021: ${ambiguous} collection(s) skipped due to multiple same-named universes.`);
    }
    return { linked, ambiguous };
  },
};
