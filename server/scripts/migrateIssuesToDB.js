/**
 * One-time importer: data/pipeline-issues/{id}/index.json (collectionStore) →
 * PostgreSQL (`pipeline_issues`), for Phase 3 Create / issue #1015.
 *
 * Issues used to live one-record-per-dir. As of #1015 they live one-row-per-
 * issue in Postgres. On the first PG-backed access (from
 * services/pipeline/issuesStore/store.js, BEFORE the boot warm reads any issue),
 * this importer copies each legacy record into `pipeline_issues`. Issue dirs
 * hold ONLY index.json (no file-primary siblings), so — like the universe
 * importer — the whole legacy dir is renamed aside after all rows land.
 *
 * Idempotency / safety (mirrors migrateUniversesToDB):
 *   - Marker-gated in data/pipeline-issues.migrated.json so the walk runs once.
 *   - INSERT … ON CONFLICT (id) DO NOTHING — never clobbers an existing row.
 *   - LOSSLESS: each record copied verbatim into `data`.
 *   - The legacy dir is RENAMED to data/pipeline-issues.imported (not deleted)
 *     so it remains a recovery source for ≥1 release. Renamed ONLY after all
 *     rows land AND only then is the marker written — a crash mid-import leaves
 *     the dir → next boot retries (ON CONFLICT DO NOTHING makes the retry safe).
 */

import { rename, readdir } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import { markerExists, writeMarker } from '../lib/migrationMarker.js';
import { query } from '../lib/db.js';
import { readLegacyJSON, legacyDirectory, incompleteImport } from './legacyImport.js';
import { mirrorTimestamp } from '../lib/pgTimestamp.js';

const LEGACY_DIRNAME = 'pipeline-issues';
const IMPORTED_DIRNAME = 'pipeline-issues.imported';
const MARKER_FILENAME = 'pipeline-issues.migrated.json';
const RECORD_RE = /^iss-[A-Za-z0-9-]+$/;

export async function importRecord(record, execute = query) {
  if (!record || typeof record !== 'object' || typeof record.id !== 'string' || !record.id) return null;
  if (typeof record.seriesId !== 'string' || !record.seriesId) return null;
  const now = new Date().toISOString();
  const createdAt = mirrorTimestamp(record.createdAt, now);
  const result = await execute(
    `INSERT INTO pipeline_issues (id, series_id, season_id, number, status, data, ephemeral, created_at, updated_at, deleted, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)
     ON CONFLICT (id) DO NOTHING`,
    [
      record.id,
      record.seriesId,
      typeof record.seasonId === 'string' && record.seasonId ? record.seasonId : null,
      Number.isFinite(record.number) ? Math.floor(record.number) : null,
      typeof record.status === 'string' && record.status ? record.status.slice(0, 32) : null,
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

export async function migrateIssuesToDB() {
  if (await markerExists(MARKER_FILENAME)) return { ok: true, reason: 'already-applied', imported: 0 };

  const legacyDir = join(PATHS.data, LEGACY_DIRNAME);
  const dirStat = await legacyDirectory(legacyDir);

  if (!dirStat) {
    return { ok: true, reason: 'fresh-install', imported: 0 };
  }

  const entries = await readdir(legacyDir);
  let imported = 0;
  let skipped = 0;
  const incomplete = [];
  for (const name of entries) {
    if (!RECORD_RE.test(name)) continue;
    const recordPath = join(legacyDir, name, 'index.json');
    const source = await readLegacyJSON(recordPath);
    if (source.status === 'missing') {
      // Current DB-backed records may own file-primary siblings without legacy
      // metadata. Confirm the row instead of treating those directories as loss.
      const existing = await query('SELECT id FROM pipeline_issues WHERE id = $1', [name]);
      if (!existing.rows.length) incomplete.push(recordPath);
      skipped += 1;
      continue;
    }
    if (source.status !== 'valid' || source.value?.id !== name) { incomplete.push(recordPath); continue; }
    const inserted = await importRecord(source.value);
    if (inserted === null) { incomplete.push(recordPath); continue; }
    if (inserted) imported += 1;
    else skipped += 1;
  }

  if (incomplete.length) return incompleteImport('Issues', { imported, skipped }, incomplete);

  try {
    await rename(legacyDir, join(PATHS.data, IMPORTED_DIRNAME));
  } catch (err) {
    console.warn(`⚠️ pipeline-issues→DB import: imported ${imported} issue(s) but renaming ${LEGACY_DIRNAME} aside failed (${err.message}) — leaving dir, will retry marker next boot`);
    return { ok: true, reason: 'imported-rename-failed', imported, skipped };
  }
  await writeMarker(MARKER_FILENAME, { migratedAt: new Date().toISOString(), imported, skipped, reason: 'imported' });
  console.log(`📚 pipeline-issues→DB import: imported ${imported} issue(s) (${skipped} skipped); data/${LEGACY_DIRNAME} renamed to ${IMPORTED_DIRNAME}`);
  return { ok: true, reason: 'imported', imported, skipped };
}
