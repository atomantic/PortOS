/**
 * Backfill durable ids on `stages.storyboards.scenes[]` for FILE-BACKED
 * pipeline issues (#3413).
 *
 * Storyboard scenes were addressed purely by array index end to end, so a
 * reorder or delete landing between a render's read and its write retargeted
 * the job id onto a different scene. `sanitizeVisualStage` now stamps a
 * durable `id` on every scene (and shot); this migration stamps the records
 * already on disk so id resolution is live immediately.
 *
 * Two stores, two migrations — this is the FILE half:
 *   - `data/pipeline-issues/{id}/index.json` — the pre-#1015 file store, still
 *     the live store under `MEMORY_BACKEND=file` / `NODE_ENV=test`, and still
 *     the source the one-time `migrateIssuesToDB` import reads on installs that
 *     have not yet moved to Postgres. Stamping here first means the import
 *     carries the ids across.
 *   - `pipeline_issues` rows in Postgres — handled by the boot-time DB
 *     migration `server/scripts/db-migrations/007-storyboard-scene-durable-ids.js`
 *     (this file runner executes BEFORE the DB pool exists, so a row transform
 *     cannot live here).
 *
 * Ids are deterministic (`scene-01`, `shot-02`, collision-escaped with `-2`)
 * and produced by the SAME `ensureStoryboardIds` the sanitizer uses, so every
 * federated peer stamps a shared issue identically instead of churning
 * conflicts. `updatedAt` is deliberately NOT bumped — a derived normalization
 * must not advance the LWW clock and out-race real remote edits.
 *
 * Idempotent: a scene that already carries an `id` is untouched, so a re-run
 * writes nothing.
 */

import { readFile, writeFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { ensureStoryboardIds } from '../../server/lib/storyboardScenes.js';

const readJsonOrNull = async (path) => {
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

// Stamp one issue record in place. Returns true when the record changed.
const stampIssue = (issue) => {
  const scenes = issue?.stages?.storyboards?.scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) return false;
  const stamped = ensureStoryboardIds(scenes);
  if (stamped === scenes) return false;
  issue.stages.storyboards.scenes = stamped;
  return true;
};

const listIssueDirs = async (typeDir) => {
  const entries = await readdir(typeDir).catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (entries == null) return [];
  const dirs = [];
  for (const name of entries) {
    if (name === 'index.json') continue;
    const full = join(typeDir, name);
    const st = await stat(full).catch(() => null);
    if (st?.isDirectory()) dirs.push(full);
  }
  return dirs;
};

export default {
  async up({ rootDir }) {
    const typeDir = join(rootDir, 'data', 'pipeline-issues');
    const dirs = await listIssueDirs(typeDir);
    if (dirs.length === 0) {
      console.log('🎬 storyboard scene ids: no file-backed pipeline issues — nothing to do (Postgres rows are handled by db-migration 007)');
      return;
    }

    let touched = 0;
    for (const dir of dirs) {
      const recordPath = join(dir, 'index.json');
      const issue = await readJsonOrNull(recordPath);
      if (!issue) continue;
      if (stampIssue(issue)) {
        await writeFile(recordPath, `${JSON.stringify(issue, null, 2)}\n`);
        touched += 1;
      }
    }

    if (touched > 0) {
      console.log(`🎬 storyboard scene ids: stamped scene/shot ids on ${touched} issue${touched === 1 ? '' : 's'}`);
    } else {
      console.log('✅ storyboard scene ids: every file-backed issue already carries scene ids — nothing to do');
    }
  },
};
