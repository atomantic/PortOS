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

import { readFile, rename, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { PATHS, readJSONFile, safeJSONParse } from '../lib/fileUtils.js';
import { markerExists, writeMarker } from '../lib/migrationMarker.js';
import { query } from '../lib/db.js';
import { mirrorTimestamp } from '../lib/pgTimestamp.js';

const ROOT_DIRNAME = 'writers-room';
const MARKER_FILENAME = 'writers-room.migrated.json';
const WORK_ID_RE = /^wr-work-[0-9a-f-]+$/i;

// Rename a file aside (path → path.replace('.json','.imported.json')) if it
// exists; a missing file is a no-op. Never overwrites an existing recovery copy.
async function parkFileAside(path) {
  const exists = await stat(path).catch(() => null);
  if (!exists) return;
  const aside = path.replace(/\.json$/, '.imported.json');
  const asideExists = await stat(aside).catch(() => null);
  if (asideExists) return; // recovery copy already present — don't clobber
  await rename(path, aside).catch((err) => {
    console.warn(`⚠️ writers-room→DB import: could not park ${path} aside (${err.message})`);
  });
}

async function importFolder(folder) {
  if (!folder || typeof folder.id !== 'string' || !folder.id) return false;
  const now = new Date().toISOString();
  const createdAt = mirrorTimestamp(folder.createdAt, now);
  const result = await query(
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

async function importExercise(exercise) {
  if (!exercise || typeof exercise.id !== 'string' || !exercise.id) return false;
  const result = await query(
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
async function importWork(manifest) {
  if (!manifest || typeof manifest.id !== 'string' || !manifest.id) return false;
  const now = new Date().toISOString();
  const createdAt = mirrorTimestamp(manifest.createdAt, now);
  const { drafts: draftList, ...workData } = manifest;
  const drafts = Array.isArray(draftList) ? draftList : [];
  const result = await query(
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
    if (!draft || typeof draft.id !== 'string') continue;
    await query(
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
  const rootStat = await stat(root).catch(() => null);

  // Fresh install (no legacy dir): no-op WITHOUT stamping the marker (keeps the
  // recovery escape hatch open — see migrateStoryBuilderToDB).
  if (!rootStat || !rootStat.isDirectory()) {
    return { ok: true, reason: 'fresh-install', folders: 0, works: 0, exercises: 0 };
  }

  // Folders.
  const foldersFile = join(root, 'folders.json');
  const folders = await readJSONFile(foldersFile, []);
  let folderCount = 0;
  for (const f of Array.isArray(folders) ? folders : []) {
    if (await importFolder(f)) folderCount += 1;
  }

  // Exercises.
  const exercisesFile = join(root, 'exercises.json');
  const exercises = await readJSONFile(exercisesFile, []);
  let exerciseCount = 0;
  for (const e of Array.isArray(exercises) ? exercises : []) {
    if (await importExercise(e)) exerciseCount += 1;
  }

  // Works (manifest.json per work dir; .md bodies stay in place).
  const worksDir = join(root, 'works');
  const worksStat = await stat(worksDir).catch(() => null);
  const workEntries = worksStat?.isDirectory()
    ? await readdir(worksDir, { withFileTypes: true }).catch(() => [])
    : [];
  let workCount = 0;
  const importedManifestPaths = [];
  for (const entry of workEntries) {
    if (!entry.isDirectory() || !WORK_ID_RE.test(entry.name)) continue;
    const manifestPath = join(worksDir, entry.name, 'manifest.json');
    const content = await readFile(manifestPath, 'utf-8').catch(() => null);
    if (content === null) continue;
    const manifest = safeJSONParse(content, null, { allowArray: false, logError: true, context: manifestPath });
    if (!manifest) continue; // corrupted manifest — skip, leave on disk untouched
    if (await importWork(manifest)) workCount += 1;
    importedManifestPaths.push(manifestPath);
  }

  // Park the JSON metadata files aside (the .md bodies stay put). Only after all
  // rows have landed, so a crash before this leaves a clean retry.
  await parkFileAside(foldersFile);
  await parkFileAside(exercisesFile);
  for (const p of importedManifestPaths) await parkFileAside(p);

  await writeMarker(MARKER_FILENAME, {
    migratedAt: new Date().toISOString(),
    folders: folderCount, works: workCount, exercises: exerciseCount, reason: 'imported',
  });
  console.log(`✍️ writers-room→DB import: ${folderCount} folder(s), ${workCount} work(s), ${exerciseCount} exercise(s); .md bodies left in place`);
  return { ok: true, reason: 'imported', folders: folderCount, works: workCount, exercises: exerciseCount };
}
