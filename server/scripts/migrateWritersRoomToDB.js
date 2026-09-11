/**
 * One-time importer: the bespoke data/writers-room file layout → PostgreSQL
 * (writers_room_folders / writers_room_works / writers_room_draft_versions /
 * writers_room_exercises), for Phase 3 Create / issue #1017.
 *
 * Writers Room metadata used to live in:
 *   folders.json                          → writers_room_folders rows
 *   exercises.json                        → writers_room_exercises rows
 *   works/<id>/manifest.json              → writers_room_works row + the
 *                                           manifest's drafts[] decomposed into
 *                                           writers_room_draft_versions rows
 *
 * UNLIKE the universe / story-builder importers, the legacy dir is NOT renamed
 * aside: the draft PROSE BODIES (works/<id>/drafts/<draftId>.md) are
 * file-primary and STAY where local.js reads them. So this importer parks aside
 * only the JSON METADATA files (folders.json → folders.imported.json,
 * exercises.json → exercises.imported.json, each manifest.json →
 * manifest.imported.json) as a recovery source, leaving the .md bodies in place.
 *
 * Idempotency / safety (mirrors migrateStoryBuilderToDB):
 *   - Marker-gated in data/writers-room.migrated.json so the walk runs once.
 *   - INSERT … ON CONFLICT (id) DO NOTHING — never clobbers an existing row.
 *   - LOSSLESS: folders/exercises copied verbatim into `data`; a work's manifest
 *     (minus drafts[]) into the work row's `data`, each draft entry verbatim
 *     into a draft-version row's `data`.
 *   - The JSON files are renamed aside only AFTER all rows land; the marker is
 *     written only after that — a crash mid-import leaves the files → next boot
 *     retries (ON CONFLICT DO NOTHING makes the retry safe).
 */

import { readdir } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import { markerExists, writeMarker } from '../lib/migrationMarker.js';
import { query } from '../lib/db.js';
import { readLegacyJSON, legacyDirectory, parkLegacyFile, incompleteImport } from './legacyImport.js';
import { mirrorTimestamp } from '../lib/pgTimestamp.js';

const ROOT_DIRNAME = 'writers-room';
const MARKER_FILENAME = 'writers-room.migrated.json';
const WORK_ID_RE = /^wr-work-[0-9a-f-]+$/i;

export async function importFolder(folder, execute = query) {
  if (!folder || typeof folder.id !== 'string' || !folder.id) return null;
  const now = new Date().toISOString();
  const createdAt = mirrorTimestamp(folder.createdAt, now);
  const result = await execute(
    `INSERT INTO writers_room_folders (id, parent_id, name, sort_order, data, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     ON CONFLICT (id) DO NOTHING`,
    [
      folder.id,
      typeof folder.parentId === 'string' && folder.parentId ? folder.parentId : null,
      String(folder.name ?? ''),
      Number.isInteger(folder.sortOrder) ? folder.sortOrder : 0,
      JSON.stringify(folder),
      createdAt,
      mirrorTimestamp(folder.updatedAt, createdAt),
    ],
  );
  return result.rowCount > 0;
}

export async function importExercise(exercise, execute = query) {
  if (!exercise || typeof exercise.id !== 'string' || !exercise.id) return null;
  const result = await execute(
    `INSERT INTO writers_room_exercises (id, work_id, status, data, started_at, finished_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [
      exercise.id,
      typeof exercise.workId === 'string' && exercise.workId ? exercise.workId : null,
      typeof exercise.status === 'string' ? exercise.status.slice(0, 16) : null,
      JSON.stringify(exercise),
      mirrorTimestamp(exercise.startedAt, null),
      mirrorTimestamp(exercise.finishedAt, null),
    ],
  );
  return result.rowCount > 0;
}

// A work manifest → one work row (manifest minus drafts[]) + one draft-version
// row per draft entry. All existing works import as deleted = FALSE.
export async function importWork(manifest, execute = query) {
  if (!manifest || typeof manifest.id !== 'string' || !manifest.id) return null;
  if (manifest.drafts !== undefined && (!Array.isArray(manifest.drafts) || manifest.drafts.some(draft => !draft || typeof draft.id !== 'string' || !draft.id))) return null;
  const now = new Date().toISOString();
  const createdAt = mirrorTimestamp(manifest.createdAt, now);
  const { drafts: draftList, ...workData } = manifest;
  const drafts = Array.isArray(draftList) ? draftList : [];
  const result = await execute(
    `INSERT INTO writers_room_works
       (id, folder_id, title, kind, status, active_draft_version_id,
        pipeline_series_id, pipeline_issue_id, cd_project_id, media_collection_id,
        data, created_at, updated_at, deleted, deleted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,FALSE,NULL)
     ON CONFLICT (id) DO NOTHING`,
    [
      manifest.id,
      typeof manifest.folderId === 'string' && manifest.folderId ? manifest.folderId : null,
      String(manifest.title ?? ''),
      typeof manifest.kind === 'string' ? manifest.kind.slice(0, 32) : null,
      typeof manifest.status === 'string' ? manifest.status.slice(0, 32) : null,
      typeof manifest.activeDraftVersionId === 'string' ? manifest.activeDraftVersionId : null,
      typeof manifest.pipelineSeriesId === 'string' ? manifest.pipelineSeriesId : null,
      typeof manifest.pipelineIssueId === 'string' ? manifest.pipelineIssueId : null,
      typeof manifest.cdProjectId === 'string' ? manifest.cdProjectId : null,
      typeof manifest.mediaCollectionId === 'string' ? manifest.mediaCollectionId : null,
      JSON.stringify(workData),
      createdAt,
      mirrorTimestamp(manifest.updatedAt, createdAt),
    ],
  );
  for (const draft of drafts) {
    await execute(
      `INSERT INTO writers_room_draft_versions
         (id, work_id, label, content_file, content_hash, word_count,
          segment_index, created_from_version_id, data, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10)
       ON CONFLICT (id) DO NOTHING`,
      [
        draft.id,
        manifest.id,
        typeof draft.label === 'string' ? draft.label : null,
        String(draft.contentFile ?? ''),
        typeof draft.contentHash === 'string' ? draft.contentHash : null,
        Number.isInteger(draft.wordCount) ? draft.wordCount : 0,
        JSON.stringify(Array.isArray(draft.segmentIndex) ? draft.segmentIndex : []),
        typeof draft.createdFromVersionId === 'string' ? draft.createdFromVersionId : null,
        JSON.stringify(draft),
        mirrorTimestamp(draft.createdAt, createdAt),
      ],
    );
  }
  return result.rowCount > 0;
}

export async function migrateWritersRoomToDB() {
  if (await markerExists(MARKER_FILENAME)) return { ok: true, reason: 'already-applied' };

  const root = join(PATHS.data, ROOT_DIRNAME);
  const rootStat = await legacyDirectory(root);
  if (!rootStat) return { ok: true, reason: 'fresh-install', folders: 0, works: 0, exercises: 0 };

  const counts = { folders: 0, works: 0, exercises: 0 };
  let incomplete = 0;
  for (const [name, importRow] of [['folders', importFolder], ['exercises', importExercise]]) {
    const path = join(root, `${name}.json`);
    const source = await readLegacyJSON(path);
    if (source.status === 'missing') continue;
    if (source.status !== 'valid' || !Array.isArray(source.value)) { incomplete += 1; continue; }
    let valid = true;
    for (const row of source.value) {
      const inserted = await importRow(row);
      if (inserted === null) { incomplete += 1; valid = false; }
      else if (inserted) counts[name] += 1;
    }
    if (valid && !await parkLegacyFile(path, path.replace(/\.json$/, '.imported.json'))) incomplete += 1;
  }

  const worksDir = join(root, 'works');
  const workEntries = await legacyDirectory(worksDir) ? await readdir(worksDir, { withFileTypes: true }) : [];
  for (const entry of workEntries) {
    if (!entry.isDirectory() || !WORK_ID_RE.test(entry.name)) continue;
    const path = join(worksDir, entry.name, 'manifest.json');
    const aside = path.replace(/\.json$/, '.imported.json');
    const source = await readLegacyJSON(path);
    if (source.status === 'missing') {
      // A DB-native work creates prose directories but no legacy manifest.
      const existing = await query('SELECT id FROM writers_room_works WHERE id = $1', [entry.name]);
      if (!existing.rows.length) incomplete += 1;
      continue;
    }
    if (source.status !== 'valid' || source.value?.id !== entry.name) { incomplete += 1; continue; }
    const inserted = await importWork(source.value);
    if (inserted === null) { incomplete += 1; continue; }
    if (inserted) counts.works += 1;
    if (!await parkLegacyFile(path, aside)) incomplete += 1;
  }

  if (incomplete) return incompleteImport('Writers Room', counts, incomplete);
  await writeMarker(MARKER_FILENAME, { migratedAt: new Date().toISOString(), ...counts, reason: 'imported' });
  console.log(`✍️ writers-room→DB import: ${counts.folders} folder(s), ${counts.works} work(s), ${counts.exercises} exercise(s); .md bodies left in place`);
  return { ok: true, reason: 'imported', ...counts };
}
