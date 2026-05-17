/**
 * Universe Builder — assign `kind` to category buckets + retire default
 * `characters` category (schema v3 → v4).
 *
 * Why:
 *   The Universe Builder redesign tags every category bucket with a `kind`
 *   (`characters` | `settings` | `objects` | `other`) so the Phase C UI can
 *   render it under the right canon trunk. The default `characters` category
 *   was retired because canon owns characters now — leaving the bucket in
 *   place creates two homes for the same data.
 *
 * What this does to each universe in data/universe-builder.json:
 *   - If schemaVersion >= 4, skip (already migrated).
 *   - Fold any `categories.characters.variations[]` into `universe.characters[]`
 *     (canon), dedupe by name (case-insensitive). Drop the `characters` bucket.
 *   - Assign `kind` to every remaining category: built-ins use
 *     WORLD_CATEGORY_DEFAULT_KINDS (landscapes/environments/structures →
 *     settings, vehicles → objects); custom buckets default to `'other'`
 *     (Phase C surfaces an Auto-sort action to LLM-classify them).
 *   - Stamp `schemaVersion: 4`.
 *
 * Idempotent: schemaVersion gate makes a re-run a no-op. The on-read
 * sanitizer in universeBuilder.js#sanitizeTemplate applies the same
 * transformations so installs that skip this script still converge — this
 * script just makes the transition observable + atomic.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const TARGET_SCHEMA_VERSION = 4;

// Kept inline so this one-shot migration's contract is frozen against
// future runtime renames or kind-set changes.
const DEFAULT_KINDS = {
  landscapes: 'settings',
  environments: 'settings',
  structures: 'settings',
  vehicles: 'objects',
};
const VALID_KINDS = new Set(['characters', 'settings', 'objects', 'other']);
const FALLBACK_KIND = 'other';

const resolveKind = (key, rawKind) => {
  if (VALID_KINDS.has(rawKind)) return rawKind;
  return DEFAULT_KINDS[key] || FALLBACK_KIND;
};

// Lowercase-trim — same shape as normalizeBibleName for cross-process dedupe.
const nameKey = (name) => (typeof name === 'string' ? name.trim().toLowerCase() : '');

const readJson = async (path) => {
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return null;
  return JSON.parse(raw);
};

const writeJson = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + '\n');

export default {
  async up({ rootDir }) {
    const filePath = join(rootDir, 'data', 'universe-builder.json');
    const doc = await readJson(filePath);
    if (!doc || !Array.isArray(doc.universes)) {
      console.log('🌐 migration 018: no universe-builder.json found, skipping');
      return;
    }

    let touched = 0;
    let charactersFolded = 0;
    let kindsAssigned = 0;
    let bucketsDropped = 0;

    for (const universe of doc.universes) {
      if (!universe || typeof universe !== 'object') continue;
      if ((universe.schemaVersion || 0) >= TARGET_SCHEMA_VERSION) continue;

      try {
        const categories = universe.categories && typeof universe.categories === 'object'
          ? universe.categories
          : {};

        // Fold legacy `characters` bucket into canon characters[] (dedupe by
        // name). The on-read backfill already does this for v1/v2 universes;
        // we re-run here to cover v3 universes that still carry the bucket.
        const charactersBucket = categories.characters;
        if (charactersBucket && Array.isArray(charactersBucket.variations)) {
          if (!Array.isArray(universe.characters)) universe.characters = [];
          const seen = new Set(universe.characters.map((e) => nameKey(e?.name)));
          for (const variation of charactersBucket.variations) {
            const name = (variation?.label || '').trim();
            if (!name) continue;
            const key = nameKey(name);
            if (seen.has(key)) continue;
            seen.add(key);
            const entry = {
              name,
              prompt: (variation?.prompt || '').trim(),
              tags: [],
              source: 'universe-expand',
            };
            if (variation?.locked === true) entry.locked = true;
            universe.characters.push(entry);
            charactersFolded += 1;
          }
          delete categories.characters;
          bucketsDropped += 1;
        }

        // Assign kind to remaining buckets.
        for (const [key, bucket] of Object.entries(categories)) {
          if (!bucket || typeof bucket !== 'object') continue;
          const kind = resolveKind(key, bucket.kind);
          if (bucket.kind !== kind) {
            bucket.kind = kind;
            kindsAssigned += 1;
          }
        }

        universe.categories = categories;
        universe.schemaVersion = TARGET_SCHEMA_VERSION;
        touched += 1;
      } catch (err) {
        // Re-throw with the offending universe id so a partial-batch failure
        // is debuggable. Without this, the bare stack points at the field
        // access but doesn't say which universe.
        throw new Error(`migration 018 failed on universe id=${universe.id || '<unknown>'}: ${err.message}`);
      }
    }

    if (touched === 0) {
      console.log('🌐 migration 018: all universes already at schema v4, skipping write');
      return;
    }

    await writeJson(filePath, doc);
    console.log(`🌐 migration 018: updated ${touched} universe(s) — folded ${charactersFolded} character variation(s) into canon, dropped ${bucketsDropped} 'characters' bucket(s), assigned kind to ${kindsAssigned} bucket(s)`);
  },
};
