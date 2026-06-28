/**
 * Music Video — PostgreSQL-backed project store (default backend, #1760).
 *
 * One row per project in `music_video_projects`: id / status / created_at /
 * updated_at mirrored as columns, the full record in `data` JSONB. Mirrors the
 * Creative Director store (#997): every mutator runs inside withTransaction +
 * `SELECT … FOR UPDATE` so a blur-save and an explicit action against the same
 * project serialize instead of losing an update. Mutation semantics live in
 * projectsLogic.js (shared with projectsFile.js) so the two can't drift.
 */

import { randomUUID } from 'crypto';
import { query, withTransaction } from '../../lib/db.js';
import { ServerError } from '../../lib/errorHandler.js';
import {
  mirrorStatus,
  mirrorTimestamp,
  buildProjectRecord,
  applyProjectPatch,
  setAudioAnalysis,
  addScene,
  applySceneUpdate,
  removeScene,
  reorderScenes,
} from './projectsLogic.js';

// `data` JSONB is the whole record; status/created_at/updated_at are a queryable
// mirror kept in lockstep but never read back — reads return `data` verbatim so
// callers see the exact shape the file backend gives.
function rowToProject(row) {
  return row ? row.data : null;
}

async function persist(exec, project) {
  const now = new Date().toISOString();
  const createdAt = mirrorTimestamp(project.createdAt, now);
  await exec(
    `INSERT INTO music_video_projects (id, status, data, created_at, updated_at, deleted, deleted_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       status = EXCLUDED.status,
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at,
       deleted = EXCLUDED.deleted,
       deleted_at = EXCLUDED.deleted_at`,
    [
      project.id,
      mirrorStatus(project.status),
      JSON.stringify(project),
      createdAt,
      mirrorTimestamp(project.updatedAt, createdAt),
      project.deleted === true,
      mirrorTimestamp(project.deletedAt, null),
    ],
  );
  return project;
}

export async function listProjects({ includeDeleted = false } = {}) {
  const result = includeDeleted
    ? await query(`SELECT data FROM music_video_projects ORDER BY created_at ASC`)
    : await query(`SELECT data FROM music_video_projects WHERE deleted = FALSE ORDER BY created_at ASC`);
  return result.rows.map(rowToProject);
}

export async function getProject(id, { includeDeleted = false } = {}) {
  const result = await query(`SELECT data FROM music_video_projects WHERE id = $1`, [id]);
  const project = rowToProject(result.rows[0]);
  if (!project) return null;
  return includeDeleted || !project.deleted ? project : null;
}

export async function createProject(input) {
  const id = `mv-${randomUUID()}`;
  const now = new Date().toISOString();
  const project = buildProjectRecord(input, { id, now });
  await persist(query, project);
  console.log(`🎞️ Created Music Video project: ${id} (${input.name})`);
  return project;
}

// Lock the row, apply `mutate(project)`, persist, return the mutator's result.
// Throws NOT_FOUND when the row is absent or tombstoned (a post-delete write
// must not resurrect the row).
async function withLockedProject(id, mutate) {
  return withTransaction(async (client) => {
    const sel = await client.query(`SELECT data FROM music_video_projects WHERE id = $1 FOR UPDATE`, [id]);
    const project = rowToProject(sel.rows[0]);
    if (!project || project.deleted) {
      throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
    }
    const { project: next, result } = mutate(project);
    await persist(client.query.bind(client), next);
    return { project: next, result };
  });
}

export async function updateProject(id, patch) {
  const { project } = await withLockedProject(id, (p) => ({ project: applyProjectPatch(p, patch) }));
  return project;
}

export async function deleteProject(id) {
  return withTransaction(async (client) => {
    const sel = await client.query(`SELECT data FROM music_video_projects WHERE id = $1 FOR UPDATE`, [id]);
    const current = rowToProject(sel.rows[0]);
    if (!current || current.deleted) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
    const now = new Date().toISOString();
    const next = { ...current, deleted: true, deletedAt: now, updatedAt: now };
    await persist(client.query.bind(client), next);
    return { ok: true };
  });
}

export async function setProjectAnalysis(id, analysis) {
  const { project } = await withLockedProject(id, (p) => ({ project: setAudioAnalysis(p, analysis) }));
  return project;
}

export async function addProjectScene(id, sceneInput) {
  const { result } = await withLockedProject(id, (p) => {
    const { project, scene } = addScene(p, sceneInput);
    return { project, result: scene };
  });
  return result;
}

export async function updateScene(id, sceneId, patch) {
  const { result } = await withLockedProject(id, (p) => {
    const { project, updated } = applySceneUpdate(p, sceneId, patch);
    return { project, result: updated };
  });
  return result;
}

export async function deleteScene(id, sceneId) {
  const { project } = await withLockedProject(id, (p) => ({ project: removeScene(p, sceneId) }));
  return project;
}

export async function reorderProjectScenes(id, orderedIds) {
  const { project } = await withLockedProject(id, (p) => ({ project: reorderScenes(p, orderedIds) }));
  return project;
}
