/**
 * Backfill universe + entity metadata onto pre-existing image sidecars.
 *
 * Background:
 *   The Universe Builder render path now writes universe/entity context
 *   (universeId, universeName, entryName, entryKind, entryCategory) into
 *   each image's `data/images/<jobId>.metadata.json` sidecar so the media
 *   history search can find renders by character name, place name, etc.
 *   (See `server/services/universeBuilderCollectionHook.js`.)
 *
 *   Images rendered before that change have no such tag — `MediaHistory`
 *   can't find them by entity name. This migration walks every universe's
 *   canon entries, category variations, and composite sheets, reading the
 *   `imageRefs[]` that already link entities → filenames, and stamps the
 *   universe context onto each sidecar.
 *
 * Algorithm:
 *   1. Read `data/universe-builder.json`. For each universe:
 *      a. canon characters[], places[], objects[]  → entryKind: 'canon'
 *      b. categories[*].variations[*]              → entryKind: 'variation'
 *      c. compositeSheets[*]                       → entryKind: 'sheet'
 *   2. For each entry, walk its `imageRefs[]` (basenames in `data/images/`).
 *   3. Read the sidecar (either naming convention), merge in universe context
 *      *only when the keys are absent*, write back. Never clobber an existing
 *      tag — a filename could have been moved between universes by hand-edit.
 *
 * Idempotent: re-runs skip sidecars where all target keys are already set.
 * Best-effort: missing sidecars (orphaned imageRefs from earlier deletions)
 * are silently skipped, not treated as errors.
 */

import { readFile, writeFile, stat } from 'fs/promises';
import { join } from 'path';

const readJson = async (path) => {
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return null;
  return JSON.parse(raw);
};

// Mirrors the two sidecar naming conventions handled by
// `server/services/imageGen/local.js#readImageSidecar`. Either filename<->sidecar
// shape is valid on disk depending on which generator wrote the image.
async function findSidecar(imagesDir, filename) {
  const candidates = [
    join(imagesDir, filename.replace(/\.png$/i, '.metadata.json')),
    join(imagesDir, `${filename}.metadata.json`),
  ];
  for (const path of candidates) {
    const exists = await stat(path).then(() => true).catch(() => false);
    if (exists) return path;
  }
  return null;
}

// Build the patch to merge into the sidecar — mirrors `buildSidecarPatch`
// in `server/services/universeBuilderCollectionHook.js`. Inlined here so this
// one-shot migration's contract is frozen against future runtime changes.
function buildPatch({ universe, entry, entryKind, entryCategory, entryLabel }) {
  const patch = {
    universeId: universe.id,
    ...(typeof universe.name === 'string' ? { universeName: universe.name } : {}),
    entryKind,
    entryId: entry.id,
    ...(entryCategory ? { entryCategory } : {}),
  };
  // Canon → use the entity's canonical name; variation/sheet → fall back to
  // the entry's label (the closest analogue to "what the user called it").
  const name = (entryKind === 'canon' && typeof entry.name === 'string' && entry.name)
    || (typeof entry.label === 'string' && entry.label)
    || null;
  if (name) patch.entryName = name;
  if (entryLabel) patch.entryLabel = entryLabel;
  return patch;
}

// Returns true when at least one absent key got filled in.
function applyPatch(metadata, patch) {
  let changed = false;
  for (const [k, v] of Object.entries(patch)) {
    if (v == null) continue;
    if (metadata[k] === undefined || metadata[k] === null) {
      metadata[k] = v;
      changed = true;
    }
  }
  return changed;
}

async function backfillEntry({ imagesDir, universe, entry, entryKind, entryCategory, stats }) {
  if (!entry || typeof entry !== 'object' || !entry.id) return;
  const refs = Array.isArray(entry.imageRefs) ? entry.imageRefs : [];
  if (refs.length === 0) return;
  const patch = buildPatch({
    universe, entry, entryKind, entryCategory,
    entryLabel: typeof entry.label === 'string' ? entry.label : null,
  });
  for (const ref of refs) {
    if (typeof ref !== 'string' || !ref) continue;
    const sidecarPath = await findSidecar(imagesDir, ref);
    if (!sidecarPath) {
      stats.missingSidecar += 1;
      continue;
    }
    const raw = await readFile(sidecarPath, 'utf-8').catch(() => null);
    if (raw == null) {
      stats.missingSidecar += 1;
      continue;
    }
    let metadata;
    try { metadata = JSON.parse(raw); } catch { stats.invalidSidecar += 1; continue; }
    if (!metadata || typeof metadata !== 'object') { stats.invalidSidecar += 1; continue; }
    const changed = applyPatch(metadata, patch);
    if (!changed) {
      stats.alreadyTagged += 1;
      continue;
    }
    await writeFile(sidecarPath, JSON.stringify(metadata, null, 2));
    stats.updated += 1;
  }
}

const CANON_KINDS = ['characters', 'places', 'objects'];

export default {
  async up({ rootDir }) {
    const universesPath = join(rootDir, 'data', 'universe-builder.json');
    const imagesDir = join(rootDir, 'data', 'images');
    const doc = await readJson(universesPath);
    if (!doc || !Array.isArray(doc.universes) || doc.universes.length === 0) {
      return { updated: 0, reason: 'no-universes' };
    }

    const stats = { updated: 0, alreadyTagged: 0, missingSidecar: 0, invalidSidecar: 0 };
    let universesTouched = 0;

    for (const universe of doc.universes) {
      if (!universe || typeof universe !== 'object' || !universe.id) continue;
      const before = stats.updated;

      // 1. Canon entries — kindKey carries through as the entryCategory so
      //    search hits like "characters" / "places" / "objects" work too.
      for (const kindKey of CANON_KINDS) {
        const list = Array.isArray(universe[kindKey]) ? universe[kindKey] : [];
        for (const entry of list) {
          await backfillEntry({
            imagesDir, universe, entry,
            entryKind: 'canon', entryCategory: kindKey,
            stats,
          });
        }
      }

      // 2. Category variations.
      const categories = universe.categories && typeof universe.categories === 'object'
        ? universe.categories : {};
      for (const [categoryKey, cat] of Object.entries(categories)) {
        const variations = Array.isArray(cat?.variations) ? cat.variations : [];
        for (const variation of variations) {
          await backfillEntry({
            imagesDir, universe, entry: variation,
            entryKind: 'variation', entryCategory: categoryKey,
            stats,
          });
        }
      }

      // 3. Composite sheets — no category, but the sheet's label carries the
      //    user-visible name.
      const sheets = Array.isArray(universe.compositeSheets) ? universe.compositeSheets : [];
      for (const sheet of sheets) {
        await backfillEntry({
          imagesDir, universe, entry: sheet,
          entryKind: 'sheet', entryCategory: null,
          stats,
        });
      }

      if (stats.updated > before) universesTouched += 1;
    }

    if (stats.updated > 0) {
      console.log(`📦 migration 028: tagged ${stats.updated} image sidecar(s) across ${universesTouched} universe(s).`);
    } else {
      console.log(`📦 migration 028: nothing to backfill (${stats.alreadyTagged} already tagged, ${stats.missingSidecar} orphaned refs, ${stats.invalidSidecar} invalid).`);
    }

    return stats;
  },
};
