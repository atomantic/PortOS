/**
 * Migration 220 — backfill `source: 'auto'` on media collections that a machine
 * flow created before the field existed (#3311).
 *
 * Background:
 *   Every Creative Director project, Writers Room work, and universe/series
 *   render bucket auto-files itself as a media collection. Until #3311 nothing
 *   recorded that fact, so the grid reverse-engineered it on the CLIENT from
 *   four independent markers — a name prefix, an `Auto-…` description, a
 *   `uc-`/`sc-` id, or a universe/series link. Every new auto-creator silently
 *   regressed the ordering until someone remembered to extend that list.
 *
 *   `server/services/mediaCollections.js` now stamps `source` at mint time.
 *   This migration performs the one-time classification of records already on
 *   disk, using the SAME four markers, so the client heuristic stops being
 *   load-bearing for anything this install already had.
 *
 * What it writes:
 *   `source: 'auto'` on each live record matching a non-forgeable marker and
 *   carrying no `source` yet (see the marker note below — a bare name prefix is
 *   deliberately NOT enough, since the create route lets a user pick one).
 *   Nothing else — in particular `updatedAt` is deliberately NOT
 *   bumped: this is a derived classification, not a user edit, and advancing
 *   the LWW clock would make every collection look freshly edited to peers and
 *   out-race real remote edits. `source` is not part of the conflict journal's
 *   scalar projection either, so no base hashes churn.
 *
 * Deliberately NOT written:
 *   - `source: 'user'` on non-matching records. The client treats an ABSENT
 *     stamp as "fall back to the marker heuristic", which returns false for
 *     exactly these records — identical behavior with no extra writes, and no
 *     risk of freezing a misclassification.
 *   - Tombstones (`deleted: true`). `deleteCollection` clears the owner links
 *     and items; nothing renders a tombstone, and rewriting one only adds sync
 *     noise.
 *
 * Cross-install: `source` is LOCAL-ONLY — `sanitizeRecordForWire` strips it, so
 * no `schemaVersions` bump is needed and no peer's checksum moves. Each peer
 * upgrades and runs this independently over ITS OWN copy of the shared
 * collections; because the markers are deterministic, they classify the same
 * record identically.
 *
 * The legacy monolithic `data/media-collections.json` is not read — migration
 * 059 split it into `data/media-collections/<id>/index.json` and runs first.
 *
 * Idempotent: a record that already carries a `source` is skipped, so a second
 * pass writes nothing.
 */

import { readdir, readFile, writeFile, rename } from 'fs/promises';
import { join } from 'path';

// Frozen snapshot of the markers as of #3311. Kept INLINE rather than imported
// from `client/src/lib/mediaCollectionList.js` / `services/mediaCollections.js`
// on purpose: a migration is a point-in-time transform and must not shift if
// those lists later evolve.
//
// The client heuristic has a FOURTH marker this migration deliberately does not
// use: the `Creative Director: ` / `Writers Room: ` / `Universe: ` / `Series: `
// NAME prefix. Nothing reserves those prefixes — the create route takes a free
// name — so a user-made collection called `Universe: Notes` matches it, and a
// stamped record is skipped on every later pass rather than re-evaluated.
// Leaving name-only matches unstamped keeps them on the client fallback, which
// classifies them exactly as it does today and still re-evaluates if the user
// renames them. Nothing is lost: every real auto-creator also carries one of
// the markers below — Creative Director and Writers Room stamp an `Auto-…`
// description, and universe/series buckets carry the deterministic id and/or
// the owner link.
//
// The description prefixes are far weaker evidence than the id/link markers
// (the POST/PATCH routes do accept a free description), but they are the ONLY
// markers a legacy Creative Director / Writers Room bucket carries — those get
// a random uuid and no owner link. `PATCH /api/media/collections/:id` accepts
// `source`, so the rare user collection described as `Auto-created for project
// …` can be corrected rather than being stuck.
const AUTO_DESCRIPTION_PREFIXES = ['Auto-created for project ', 'Auto-generated images for '];
const AUTO_ID_PREFIXES = ['uc-', 'sc-'];

/**
 * True when a record carries a marker of machine creation that a user could not
 * have produced through the create form. A subset of `isAutoCollection` in
 * `client/src/lib/mediaCollectionList.js` — see the note above on why the name
 * prefix is excluded. ANY one marker suffices, because an install can hold
 * records from before a given marker existed.
 * @param {object} record
 * @returns {boolean}
 */
export function isAutoCreated(record) {
  if (!record || typeof record !== 'object') return false;
  if (typeof record.description === 'string' && AUTO_DESCRIPTION_PREFIXES.some((p) => record.description.startsWith(p))) return true;
  if (typeof record.id === 'string' && AUTO_ID_PREFIXES.some((p) => record.id.startsWith(p))) return true;
  return Boolean(record.universeId || record.seriesId);
}

/**
 * Decide the new record for one on-disk collection. Returns `null` when the
 * record should be left exactly as it is (already stamped, tombstoned, or no
 * marker matched).
 * @param {object} record
 * @returns {object|null}
 */
export function stampAutoSource(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.source === 'auto' || record.source === 'user') return null;
  if (record.deleted === true) return null;
  if (!isAutoCreated(record)) return null;
  return { ...record, source: 'auto' };
}

const readJson = async (abs) => {
  const raw = await readFile(abs, 'utf-8').catch((err) => { if (err.code === 'ENOENT') return null; throw err; });
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
};

const writeJsonAtomic = async (abs, value) => {
  const tmp = `${abs}.tmp-220`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
  await rename(tmp, abs);
};

export default {
  async up({ rootDir }) {
    const typeDir = join(rootDir, 'data', 'media-collections');
    const entries = await readdir(typeDir, { withFileTypes: true })
      .catch((err) => { if (err.code === 'ENOENT') return null; throw err; });
    if (entries === null) {
      console.log('📦 migration 220: no data/media-collections dir — fresh install, no-op');
      return { ok: true, reason: 'no-collections' };
    }

    let stamped = 0;
    let scanned = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue; // skips the type-level index.json
      const recordPath = join(typeDir, entry.name, 'index.json');
      const record = await readJson(recordPath);
      if (!record) continue; // missing or unparseable — leave it for the store to drop
      scanned += 1;
      const next = stampAutoSource(record);
      if (!next) continue;
      await writeJsonAtomic(recordPath, next);
      stamped += 1;
    }

    console.log(`📦 migration 220: stamped source:auto on ${stamped} of ${scanned} media collection(s)`);
    return { ok: true, reason: stamped ? 'migrated' : 'nothing-to-stamp', stamped, scanned };
  },
};
