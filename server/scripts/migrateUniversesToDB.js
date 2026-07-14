/**
 * One-time importer: data/universes/{id}/index.json (collectionStore) →
 * PostgreSQL (`universes` + `universe_runs`), for Phase 3 Create / issue #1014.
 *
 * Universes used to live one-record-per-dir with a type-level index.json holding
 * the cross-record `config.runs[]` log. As of #1014 they live one-row-per-
 * universe in Postgres. On the first PG-backed access (from
 * services/universeBuilder/store.js, BEFORE the boot warm reads any universe),
 * this importer copies each legacy record into `universes` and each run into
 * `universe_runs`.
 *
 * Idempotency / safety (mirrors migrateCreativeDirectorToDB):
 *   - Marker-gated in data/universes.migrated.json so the walk runs once.
 *   - INSERT … ON CONFLICT (id) DO NOTHING — a row already in the table (a
 *     partial prior run, or a record created after the import began) is never
 *     clobbered. The DB row is authoritative once it exists.
 *   - LOSSLESS: each record is copied verbatim into `data` (the live store's
 *     sanitizer runs on read; trimming the runs cap is the live store's job).
 *   - The legacy directory is RENAMED to data/universes.imported (not deleted)
 *     so it remains a recovery source for at least one release, and a re-run
 *     can't re-import stale rows over fresher DB state. Renamed ONLY after all
 *     rows land AND the marker is written — a crash mid-import leaves the dir in
 *     place → next boot retries (ON CONFLICT DO NOTHING makes the retry safe).
 *
 * NOT marker-gated via data/migrations.applied.json: that list is the
 * prompt-replace runner under scripts/migrations/ and runs before the DB gate.
 * This import must run only when Postgres is the confirmed-healthy backend, so
 * it's gated on its own marker and invoked from the backend selector.
 */

import { rename, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { PATHS, readJSONFile } from '../lib/fileUtils.js';
import { markerExists, writeMarker } from '../lib/migrationMarker.js';
import { query } from '../lib/db.js';
import { mirrorTimestamp } from '../lib/pgTimestamp.js';

const LEGACY_DIRNAME = 'universes';
const IMPORTED_DIRNAME = 'universes.imported';
const MARKER_FILENAME = 'universes.migrated.json';

// One legacy universe record → `universes` row. Verbatim into `data`; the typed
// mirror columns are bind-sanitized so a hand-edited/legacy timestamp or missing
// field can't make the INSERT throw and abort the whole import.
async function importRecord(record) {
  if (!record || typeof record !== 'object' || typeof record.id !== 'string' || !record.id) return false;
  const now = new Date().toISOString();
  const createdAt = mirrorTimestamp(record.createdAt, now);
  const schemaVersion = Number.isInteger(record.schemaVersion) ? record.schemaVersion : 4;
  const result = await query(
    `INSERT INTO universes (id, name, data, schema_version, ephemeral, created_at, updated_at, deleted, deleted_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO NOTHING`,
    [
      record.id,
      typeof record.name === 'string' ? record.name : '',
      JSON.stringify(record),
      schemaVersion,
      record.ephemeral === true,
      createdAt,
      mirrorTimestamp(record.updatedAt, createdAt),
      record.deleted === true,
      mirrorTimestamp(record.deletedAt, null),
    ],
  );
  return result.rowCount > 0;
}

async function importRun(run) {
  if (!run || typeof run !== 'object' || typeof run.id !== 'string' || typeof run.universeId !== 'string') return false;
  const result = await query(
    `INSERT INTO universe_runs (id, universe_id, collection_id, data, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (id) DO NOTHING`,
    [
      run.id,
      run.universeId,
      typeof run.collectionId === 'string' ? run.collectionId : null,
      JSON.stringify(run),
      mirrorTimestamp(run.createdAt, new Date().toISOString()),
    ],
  );
  return result.rowCount > 0;
}

export async function migrateUniversesToDB() {
  if (await markerExists(MARKER_FILENAME)) return { ok: true, reason: 'already-applied', imported: 0 };

  const legacyDir = join(PATHS.data, LEGACY_DIRNAME);
  const dirStat = await stat(legacyDir).catch(() => null);

  // Fresh install (no legacy dir): no-op WITHOUT stamping the marker. The probe
  // is a single stat per boot — cheap — and NOT stamping keeps the recovery
  // escape hatch open: a user who later restores data/universes.imported back to
  // data/universes (to re-import after a rollback) gets a real import on the next
  // boot. Stamping here would silently suppress that forever.
  if (!dirStat || !dirStat.isDirectory()) {
    return { ok: true, reason: 'fresh-install', imported: 0, runs: 0 };
  }

  const entries = await readdir(legacyDir).catch(() => []);
  let imported = 0;
  let skipped = 0;
  for (const name of entries) {
    if (name === 'index.json' || name.startsWith('.')) continue;
    const record = await readJSONFile(join(legacyDir, name, 'index.json'), null, { allowArray: false, logError: false });
    if (!record) { skipped += 1; continue; }
    if (await importRecord(record)) imported += 1;
    else skipped += 1;
  }

  // Runs from the type-level index.json `config.runs[]`.
  let runs = 0;
  const typeIndex = await readJSONFile(join(legacyDir, 'index.json'), null, { allowArray: false, logError: false });
  const legacyRuns = Array.isArray(typeIndex?.config?.runs) ? typeIndex.config.runs : [];
  for (const run of legacyRuns) {
    if (await importRun(run)) runs += 1;
  }

  // Rename the legacy dir aside AFTER all rows land, then stamp the marker only
  // if the rename succeeded (so a rollback / MEMORY_BACKEND=file boot can't read
  // a stale dir while the marker claims migration is done). If the rename fails,
  // leave the dir + no marker → next boot retries the idempotent import.
  try {
    await rename(legacyDir, join(PATHS.data, IMPORTED_DIRNAME));
  } catch (err) {
    console.warn(`⚠️ universes→DB import: imported ${imported} record(s)/${runs} run(s) but renaming ${LEGACY_DIRNAME} aside failed (${err.message}) — leaving dir, will retry marker next boot`);
    return { ok: true, reason: 'imported-rename-failed', imported, runs };
  }
  await writeMarker(MARKER_FILENAME, { migratedAt: new Date().toISOString(), imported, runs, skipped, reason: 'imported' });
  console.log(`🌍 universes→DB import: imported ${imported} universe(s) + ${runs} run(s) (${skipped} skipped); data/${LEGACY_DIRNAME} renamed to ${IMPORTED_DIRNAME}`);
  return { ok: true, reason: 'imported', imported, runs, skipped };
}
