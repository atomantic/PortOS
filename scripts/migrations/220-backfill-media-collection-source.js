/**
 * Migration 220 — backfill `source: 'auto'` on media collections that a machine flow created before the field existed (#3311).
 *
 * Creative Director projects, Writers Room works and universe/series render buckets auto-file as media collections. The grid used to infer that on the
 * CLIENT from four markers (name prefix, an `Auto-…` description, a `uc-`/`sc-` id, a universe/series link); `server/services/mediaCollections.js` now stamps
 * `source` at mint time and this migration classifies records already on disk with the SAME markers.
 *
 * Writes `source: 'auto'` on each live record matching a non-forgeable marker with no `source` yet (a bare name prefix is NOT enough: the create route lets a user
 * pick one). `updatedAt` is deliberately NOT bumped: this is a derived classification, not a user edit, and advancing the LWW clock would make every collection
 * look freshly edited to peers and out-race real remote edits.
 *
 * Deliberately NOT written: `source: 'user'` on non-matching records (an ABSENT stamp falls back to the marker heuristic, which already classifies them; stamping would
 * freeze an answer the heuristic re-evaluates, e.g. a name-only match stays auto until renamed), and tombstones (`deleted: true`; nothing renders them).
 *
 * Cross-install: `source` is LOCAL-ONLY (`sanitizeRecordForWire` strips it), so no `schemaVersions` bump is needed; each peer runs this over ITS OWN copy and the
 * deterministic markers classify identically. The legacy monolithic `data/media-collections.json` is not read (migration 059 split it and runs first).
 *
 * Idempotent: a record that already carries a `source` is skipped.
 */

import { readdir, readFile, writeFile, rename } from 'fs/promises';
import { join } from 'path';

// Frozen snapshot of the markers as of #3311, kept INLINE (not imported from `client/src/lib/mediaCollectionList.js` / `services/mediaCollections.js`):
// a migration is a point-in-time transform and must not shift if those lists evolve.
//
// The client heuristic's FOURTH marker, the `Creative Director: ` / `Writers Room: ` / `Universe: ` / `Series: ` NAME prefix, is deliberately unused: nothing
// reserves those prefixes (a user can name a collection `Universe: Notes`), and a stamped record is never re-evaluated. Name-only matches stay on the client
// fallback, and every real auto-creator also carries a marker below.
//
// The description prefixes are weak evidence (the POST/PATCH routes accept a free description) but are the ONLY markers a legacy Creative Director / Writers Room
// bucket carries (random uuid, no owner link). `PATCH /api/media/collections/:id` accepts `source`, so a user collection described `Auto-created for project …` can be corrected.
const AUTO_DESCRIPTION_PREFIXES = ['Auto-created for project ', 'Auto-generated images for '];
const AUTO_ID_PREFIXES = ['uc-', 'sc-'];

const isNonEmptyString = (v) => typeof v === 'string' && v !== '';

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
  // Owner link must be a non-empty STRING, matching `sanitizeCollection` — this
  // reads raw disk, where the client only ever sees sanitized records. A
  // hand-edited/corrupt `universeId: true` is dropped to null on the next read,
  // so treating it as a machine-owned marker would stamp a record that has none.
  return isNonEmptyString(record.universeId) || isNonEmptyString(record.seriesId);
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
