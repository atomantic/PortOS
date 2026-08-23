/**
 * Upgrade data/video-projects.json to the v2 layered timeline shape.
 *
 * v1 projects persisted a single ordered `clips` array of
 * `{ clipId, inSec, outSec }`. v2 replaces that with three lanes — `segments`
 * (the ordered video lane, which now also holds stills), `overlays`, and
 * `audio` — plus a per-project `schemaVersion`.
 *
 * The service normalizes on every read too, so this migration is not strictly
 * required for correctness. It exists so the on-disk file matches what the app
 * writes: without it, a project the user never re-saves keeps its v1 shape
 * forever, and a backup/restore carries the old layout around indefinitely.
 * That is also why the upgrade itself is `normalizeProject` from the service
 * rather than a copy — a second implementation would drift, and the read-time
 * normalizer would silently paper over the difference.
 *
 * `clips` is deliberately RETAINED as a derived mirror of the clip segments —
 * an install rolled back to a v1 build still renders its video lane instead of
 * opening an empty project. Idempotent: a project already at schemaVersion 2
 * with a lane array is left untouched.
 */

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { writeJsonAtomic } from './_lib.js';
import { normalizeProject, TIMELINE_SCHEMA_VERSION } from '../../server/services/videoTimeline/segments.js';

export default {
  async up({ rootDir }) {
    const path = join(rootDir, 'data', 'video-projects.json');
    if (!existsSync(path)) return { ok: true, reason: 'no-projects-file', updated: 0 };

    const raw = await readFile(path, 'utf8').catch(() => null);
    if (raw == null) return { ok: false, reason: 'unreadable', updated: 0 };

    let projects;
    try {
      projects = JSON.parse(raw);
    } catch (err) {
      // A corrupt state file must not crash the migration runner — that would
      // turn a cosmetic upgrade into a boot blocker.
      console.warn(`⚠️ migration 295: ${path} is not valid JSON (${err.message}); skipping`);
      return { ok: false, reason: 'invalid-json', updated: 0 };
    }
    if (!Array.isArray(projects)) return { ok: false, reason: 'not-an-array', updated: 0 };

    let updated = 0;
    const next = projects.map((project) => {
      if (!project || typeof project !== 'object') return project;
      if (project.schemaVersion === TIMELINE_SCHEMA_VERSION && Array.isArray(project.segments)) return project;
      updated += 1;
      return normalizeProject(project);
    });

    if (!updated) return { ok: true, reason: 'already-current', updated: 0 };
    await writeJsonAtomic(path, next);
    console.log(`📝 ${path}: upgraded ${updated} timeline project${updated === 1 ? '' : 's'} to the layered segment model`);
    return { ok: true, reason: 'updated', updated };
  },
};
