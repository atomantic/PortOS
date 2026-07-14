/**
 * One-time importer: data/story-builder/{id}/index.json (collectionStore) →
 * PostgreSQL (`story_builder_sessions`), for Phase 3 Create / issue #1016.
 *
 * Sessions used to live one-record-per-dir. As of #1016 they live one-row-per-
 * session in Postgres. On the first PG-backed access (from
 * services/storyBuilderStore/store.js, BEFORE the boot warm reads any session),
 * this importer copies each legacy record into `story_builder_sessions`. Session
 * dirs hold ONLY index.json (no file-primary siblings), so — like the universe
 * and pipeline-issues importers — the whole legacy dir is renamed aside after
 * all rows land.
 *
 * Idempotency / safety (mirrors migrateIssuesToDB):
 *   - Marker-gated in data/story-builder.migrated.json so the walk runs once.
 *   - INSERT … ON CONFLICT (id) DO NOTHING — never clobbers an existing row.
 *   - LOSSLESS: each record copied verbatim into `data`.
 *   - The legacy dir is RENAMED to data/story-builder.imported (not deleted)
 *     so it remains a recovery source for ≥1 release. Renamed ONLY after all
 *     rows land AND only then is the marker written — a crash mid-import leaves
 *     the dir → next boot retries (ON CONFLICT DO NOTHING makes the retry safe).
 */

import { rename, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { PATHS, readJSONFile } from '../lib/fileUtils.js';
import { markerExists, writeMarker } from '../lib/migrationMarker.js';
import { query } from '../lib/db.js';
import { mirrorTimestamp } from '../lib/pgTimestamp.js';

const LEGACY_DIRNAME = 'story-builder';
const IMPORTED_DIRNAME = 'story-builder.imported';
const MARKER_FILENAME = 'story-builder.migrated.json';
const RECORD_RE = /^stb-[A-Za-z0-9-]+$/;

// One legacy session record → `story_builder_sessions` row. Verbatim into
// `data`; the typed mirror columns are bind-sanitized so a hand-edited/legacy
// value can't make the INSERT throw and abort the whole import.
async function importRecord(record) {
  if (!record || typeof record !== 'object' || typeof record.id !== 'string' || !record.id) return false;
  const now = new Date().toISOString();
  const createdAt = mirrorTimestamp(record.createdAt, now);
  const result = await query(
    `INSERT INTO story_builder_sessions (id, universe_id, series_id, sync, data, ephemeral, created_at, updated_at, deleted, deleted_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO NOTHING`,
    [
      record.id,
      typeof record.universeId === 'string' && record.universeId ? record.universeId : null,
      typeof record.seriesId === 'string' && record.seriesId ? record.seriesId : null,
      record.sync === true,
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

export async function migrateStoryBuilderToDB() {
  if (await markerExists(MARKER_FILENAME)) return { ok: true, reason: 'already-applied', imported: 0 };

  const legacyDir = join(PATHS.data, LEGACY_DIRNAME);
  const dirStat = await stat(legacyDir).catch(() => null);

  // Fresh install (no legacy dir): no-op WITHOUT stamping the marker (keeps the
  // recovery escape hatch open — see migrateIssuesToDB).
  if (!dirStat || !dirStat.isDirectory()) {
    return { ok: true, reason: 'fresh-install', imported: 0 };
  }

  const entries = await readdir(legacyDir).catch(() => []);
  let imported = 0;
  let skipped = 0;
  for (const name of entries) {
    if (!RECORD_RE.test(name)) continue; // skip index.json, hidden, non-record dirs
    const record = await readJSONFile(join(legacyDir, name, 'index.json'), null, { allowArray: false, logError: false });
    if (!record) { skipped += 1; continue; }
    if (await importRecord(record)) imported += 1;
    else skipped += 1;
  }

  try {
    await rename(legacyDir, join(PATHS.data, IMPORTED_DIRNAME));
  } catch (err) {
    console.warn(`⚠️ story-builder→DB import: imported ${imported} session(s) but renaming ${LEGACY_DIRNAME} aside failed (${err.message}) — leaving dir, will retry marker next boot`);
    return { ok: true, reason: 'imported-rename-failed', imported, skipped };
  }
  await writeMarker(MARKER_FILENAME, { migratedAt: new Date().toISOString(), imported, skipped, reason: 'imported' });
  console.log(`📖 story-builder→DB import: imported ${imported} session(s) (${skipped} skipped); data/${LEGACY_DIRNAME} renamed to ${IMPORTED_DIRNAME}`);
  return { ok: true, reason: 'imported', imported, skipped };
}
