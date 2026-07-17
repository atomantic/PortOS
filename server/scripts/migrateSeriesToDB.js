/**
 * One-time importer: data/pipeline-series/{id}/index.json (collectionStore) →
 * PostgreSQL (`pipeline_series`), for Phase 3 Create / issue #1015.
 *
 * Series used to live one-record-per-dir. As of #1015 the series RECORD lives
 * one-row-per-series in Postgres. On the first PG-backed access (from
 * services/pipeline/seriesStore/store.js, BEFORE the boot warm reads any
 * series), this importer copies each legacy `index.json` into `pipeline_series`.
 *
 * The series dir ALSO holds a `manuscript-review.json` sibling doc that is
 * `file-primary` (manuscriptReview.js reads/writes it at
 * data/pipeline-series/{id}/manuscript-review.json). So — UNLIKE the universe
 * importer, which renames the whole legacy dir aside — this importer must NOT
 * move the dirs: it would orphan the review siblings the live code still reads
 * from that path. Instead it renames each migrated record's `index.json` to
 * `index.json.imported` IN PLACE, leaving the dir + its review sibling intact,
 * and stamps a type-level marker.
 *
 * Idempotency / safety (mirrors migrateUniversesToDB):
 *   - Marker-gated in data/pipeline-series.migrated.json so the walk runs once.
 *   - INSERT … ON CONFLICT (id) DO NOTHING — a row already in the table is never
 *     clobbered. The DB row is authoritative once it exists.
 *   - LOSSLESS: each record copied verbatim into `data` (the live store's
 *     sanitizer runs on read).
 *   - Each `index.json` is RENAMED to `index.json.imported` (not deleted) so it
 *     remains a recovery source for ≥1 release and a re-run can't re-import
 *     stale rows over fresher DB state. Renamed ONLY after the row lands.
 *   - Marker stamped only after the full walk; a crash mid-import leaves some
 *     index.json in place → next boot retries (ON CONFLICT DO NOTHING makes the
 *     retry safe; an already-renamed record is simply skipped on re-read).
 */

import { rename, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { PATHS, readJSONFile } from '../lib/fileUtils.js';
import { markerExists, writeMarker } from '../lib/migrationMarker.js';
import { query } from '../lib/db.js';
import { mirrorTimestamp } from '../lib/pgTimestamp.js';

const LEGACY_DIRNAME = 'pipeline-series';
const MARKER_FILENAME = 'pipeline-series.migrated.json';
const RECORD_RE = /^ser-[A-Za-z0-9-]+$/;

// One legacy series record → `pipeline_series` row. Verbatim into `data`; the
// typed mirror columns are bind-sanitized so a hand-edited/legacy value can't
// make the INSERT throw and abort the whole import.
async function importRecord(record) {
  if (!record || typeof record !== 'object' || typeof record.id !== 'string' || !record.id) return false;
  const now = new Date().toISOString();
  const createdAt = mirrorTimestamp(record.createdAt, now);
  const result = await query(
    `INSERT INTO pipeline_series (id, name, universe_id, writers_room_work_id, data, ephemeral, created_at, updated_at, deleted, deleted_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO NOTHING`,
    [
      record.id,
      typeof record.name === 'string' ? record.name : '',
      typeof record.universeId === 'string' && record.universeId ? record.universeId : null,
      typeof record.writersRoomWorkId === 'string' && record.writersRoomWorkId ? record.writersRoomWorkId : null,
      JSON.stringify(record),
      record.ephemeral === true,
      createdAt,
      mirrorTimestamp(record.updatedAt, createdAt),
      record.deleted === true,
      mirrorTimestamp(record.deletedAt, null),
    ],
  );
  return result.rowCount > 0;
}

export async function migrateSeriesToDB() {
  if (await markerExists(MARKER_FILENAME)) return { ok: true, reason: 'already-applied', imported: 0 };

  const legacyDir = join(PATHS.data, LEGACY_DIRNAME);
  const dirStat = await stat(legacyDir).catch(() => null);

  // Fresh install (no legacy dir): no-op WITHOUT stamping the marker (keeps the
  // recovery escape hatch open — see migrateUniversesToDB).
  if (!dirStat || !dirStat.isDirectory()) {
    return { ok: true, reason: 'fresh-install', imported: 0 };
  }

  const entries = await readdir(legacyDir).catch(() => []);
  let imported = 0;
  let skipped = 0;
  for (const name of entries) {
    if (!RECORD_RE.test(name)) continue; // skip index.json, hidden, non-record dirs
    const recordPath = join(legacyDir, name, 'index.json');
    const record = await readJSONFile(recordPath, null, { allowArray: false, logError: false });
    // Already-renamed (index.json absent) on a retried run, or unreadable.
    if (!record) { skipped += 1; continue; }
    if (await importRecord(record)) imported += 1;
    else skipped += 1;
    // Rename the record's index.json aside IN PLACE — leaves the dir + its
    // manuscript-review.json sibling untouched, so the file-primary review doc
    // stays readable at its canonical path. Best-effort: a rename failure leaves
    // the index.json (next boot retries; ON CONFLICT DO NOTHING is safe).
    await rename(recordPath, `${recordPath}.imported`).catch(() => {});
  }

  await writeMarker(MARKER_FILENAME, { migratedAt: new Date().toISOString(), imported, skipped, reason: 'imported' });
  console.log(`🎬 pipeline-series→DB import: imported ${imported} series (${skipped} skipped); index.json renamed aside in place (review siblings kept)`);
  return { ok: true, reason: 'imported', imported, skipped };
}
