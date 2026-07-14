/**
 * One-time importer: data/creative-director-projects.json → PostgreSQL
 * (creative_director_projects), for Phase 3 / issue #997.
 *
 * Creative Director projects used to live in a single JSON array. As of #997
 * they live one-row-per-project in Postgres. On the first PG-backed init (from
 * services/creativeDirector/local.js, BEFORE the boot recovery scan reads any
 * project), this importer copies each legacy project into the table.
 *
 * Idempotency / safety:
 *   - Marker-gated in data/creative-director-projects.migrated.json (mirrors
 *     the migrateBibleToCatalog marker convention) so the walk runs once.
 *   - INSERT … ON CONFLICT (id) DO NOTHING — a project already in the table
 *     (e.g. a partial prior run, or a row created after the JSON was written)
 *     is never clobbered. The DB row is authoritative once it exists.
 *   - The legacy JSON is RENAMED to .imported (not deleted) so it remains a
 *     recovery source for at least one release (per the plan's Phase 5 note),
 *     and so a re-run can't re-import stale rows over fresher DB state.
 *   - The import is LOSSLESS: each project is copied verbatim, runs[] included.
 *     Trimming the runs[] cap is the LIVE store's job (projectsDB.persist /
 *     projectsFile.saveAll both call trimRuns on the next write) — doing it here
 *     would silently drop run history the file still holds. A legacy over-cap
 *     array shrinks on the project's first post-import write instead.
 *
 * NOT marker-gated via data/migrations.applied.json: that list is driven by the
 * prompt-replace runner under scripts/migrations/ and runs at a different boot
 * phase (before the DB gate). This import must run only when Postgres is the
 * confirmed-healthy backend, so it's gated on its own marker and invoked from
 * the backend selector instead.
 */

import { readFile, rename } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import { markerExists, writeMarker } from '../lib/migrationMarker.js';
import { query } from '../lib/db.js';
import { mirrorStatus, mirrorTimestamp } from '../services/creativeDirector/projectsLogic.js';

const LEGACY_FILENAME = 'creative-director-projects.json';
const IMPORTED_SUFFIX = '.imported';
const MARKER_FILENAME = 'creative-director-projects.migrated.json';

export async function migrateCreativeDirectorToDB() {
  // Already imported on a prior boot → no-op.
  if (await markerExists(MARKER_FILENAME)) return { ok: true, reason: 'already-applied' };

  const legacyPath = join(PATHS.data, LEGACY_FILENAME);
  const raw = await readFile(legacyPath, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });

  // Fresh install (no legacy file): stamp the marker so we don't re-probe every
  // boot, and return.
  if (raw == null) {
    await writeMarker(MARKER_FILENAME, { migratedAt: new Date().toISOString(), imported: 0, reason: 'fresh-install' });
    return { ok: true, reason: 'fresh-install', imported: 0 };
  }

  let projects;
  try {
    projects = JSON.parse(raw);
  } catch (err) {
    // A corrupt legacy file shouldn't block boot — leave it in place (un-renamed,
    // no marker) so the user can repair it and the next boot retries.
    console.warn(`⚠️ CD→DB import: ${LEGACY_FILENAME} is invalid JSON (${err.message}) — leaving it for manual repair, will retry next boot`);
    return { ok: false, reason: 'unreadable' };
  }
  if (!Array.isArray(projects)) {
    console.warn(`⚠️ CD→DB import: ${LEGACY_FILENAME} is not an array — skipping, will retry next boot`);
    return { ok: false, reason: 'not-an-array' };
  }

  let imported = 0;
  let skipped = 0;
  for (const project of projects) {
    if (!project || typeof project !== 'object' || typeof project.id !== 'string') {
      skipped += 1;
      continue;
    }
    // Import verbatim — the full record (runs[] included) goes into `data`. The
    // typed mirror columns are sanitized via the shared helpers so a legacy
    // record with a malformed timestamp or over-long status can't make the
    // INSERT throw and abort the whole import (which runs during backend init).
    const now = new Date().toISOString();
    const createdAt = mirrorTimestamp(project.createdAt, now);
    const result = await query(
      `INSERT INTO creative_director_projects (id, status, data, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [
        project.id,
        mirrorStatus(project.status),
        JSON.stringify(project),
        createdAt,
        mirrorTimestamp(project.updatedAt, createdAt),
      ],
    );
    if (result.rowCount > 0) imported += 1;
    else skipped += 1;
  }

  // Rename the legacy file aside AFTER all rows land, so a crash mid-import
  // leaves the marker unwritten and the file in place → next boot retries
  // (ON CONFLICT DO NOTHING makes the retry safe for already-imported rows).
  //
  // The marker is written ONLY if the rename succeeds. If the rename fails, the
  // live file is still in place — stamping the marker would leave Postgres
  // authoritative while data/creative-director-projects.json lingers, so a
  // rollback or MEMORY_BACKEND=file boot would silently read stale pre-migration
  // state, and the marker would block any retry. Leaving the marker unwritten
  // makes the next boot retry the (idempotent) import + rename instead.
  let renamed = true;
  await rename(legacyPath, legacyPath + IMPORTED_SUFFIX).catch((err) => {
    renamed = false;
    console.warn(`⚠️ CD→DB import: imported ${imported} row(s) but could not rename ${LEGACY_FILENAME} aside (${err.message}) — NOT stamping marker; will retry the rename next boot`);
  });
  if (!renamed) return { ok: false, reason: 'rename-failed', imported, skipped };

  await writeMarker(MARKER_FILENAME, { migratedAt: new Date().toISOString(), imported, skipped });
  console.log(`🎬 CD→DB import: imported ${imported} project(s) into creative_director_projects (${skipped} skipped); legacy file renamed to ${LEGACY_FILENAME}${IMPORTED_SUFFIX}`);
  return { ok: true, reason: 'imported', imported, skipped };
}
