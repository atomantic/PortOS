/**
 * Creative Director — PostgreSQL-backed project store (default backend, #997).
 *
 * One row per project in `creative_director_projects`: id / status / created_at
 * / updated_at as columns, the full record in `data` JSONB. This replaces the
 * monolithic data/creative-director-projects.json (per-project rows remove the
 * whole-file reserialize the orchestrator triggered ≈10× per scene render).
 *
 * Concurrency: the orchestrator has two writers that can touch the SAME project
 * concurrently (sceneRunner's render-progress writes + completionHook's run
 * updates). A read-modify-write spanning two pool round-trips would lose
 * updates, so every mutator runs inside withTransaction + `SELECT … FOR UPDATE`
 * — the row lock serializes concurrent writes to one project without blocking
 * writes to other projects (the per-file queue the JSON backend never had).
 *
 * All mutation semantics live in projectsLogic.js (shared with projectsFile.js)
 * so the two backends can't drift; this module only does row I/O + locking.
 */

import { randomUUID } from 'crypto';
import { query, withTransaction } from '../../lib/db.js';
import { ServerError } from '../../lib/errorHandler.js';
import { createCollection } from '../mediaCollections.js';
import {
  trimRuns,
  mirrorStatus,
  mirrorTimestamp,
  buildProjectRecord,
  applyProjectPatch,
  applyTreatment,
  applySceneUpdate,
  appendRun,
  applyRunUpdate,
} from './projectsLogic.js';

// The `data` JSONB is the whole record. status/created_at/updated_at are
// mirrored into columns (kept in lockstep with the JSONB on every write) for
// future queries, but reads always return `data` verbatim so callers see the
// exact record shape the file backend gave — the columns are never read back.
function rowToProject(row) {
  if (!row) return null;
  // `data` already holds id/status/createdAt/updatedAt; the columns are a
  // queryable mirror. Return the JSONB verbatim so consumers (and the route
  // slim projection) see an identical shape to the file backend.
  return row.data;
}

async function persist(exec, project) {
  // Cap runs[] at the single write chokepoint (mirrors the file backend's
  // saveAll) so legacy over-cap rows shrink on first write.
  if (Array.isArray(project.runs)) project.runs = trimRuns(project.runs);
  // `data` is written verbatim (lossless); the typed mirror columns are
  // sanitized so a malformed status/timestamp on a legacy record can't make
  // the INSERT throw (which, during boot init, would block the whole backend).
  const now = new Date().toISOString();
  const createdAt = mirrorTimestamp(project.createdAt, now);
  await exec(
    `INSERT INTO creative_director_projects (id, status, data, created_at, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT (id) DO UPDATE SET
       status = EXCLUDED.status,
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at`,
    [
      project.id,
      mirrorStatus(project.status),
      JSON.stringify(project),
      createdAt,
      mirrorTimestamp(project.updatedAt, createdAt),
    ],
  );
  return project;
}

export async function listProjects() {
  // created_at ASC preserves the file backend's append order (the UI sorts
  // client-side; recovery + tests don't depend on order, but stable beats random).
  const result = await query(
    `SELECT data FROM creative_director_projects ORDER BY created_at ASC`,
  );
  return result.rows.map(rowToProject);
}

export async function getProject(id) {
  const result = await query(`SELECT data FROM creative_director_projects WHERE id = $1`, [id]);
  return rowToProject(result.rows[0]);
}

export async function createProject(input) {
  const id = `cd-${randomUUID()}`;
  const now = new Date().toISOString();
  const collection = await createCollection({ name: `Creative Director: ${input.name}`, description: `Auto-created for project ${id}` });
  const project = buildProjectRecord(input, { id, now, collectionId: collection.id });
  await persist(query, project);
  console.log(`🎬 Created Creative Director project: ${id} (${input.name})`);
  return project;
}

// Lock the row, apply `mutate(project)`, persist, and return whatever the
// mutator's continuation produces. `mutate` returns `{ project, result, skipPersist? }`.
// `skipPersist` lets a no-op mutation (unknown runId) avoid a wasted row rewrite,
// matching the file backend's "return null without writing". Throws NOT_FOUND
// when the row is absent unless `allowMissing` is set (updateRun's path).
async function withLockedProject(id, mutate, { allowMissing = false } = {}) {
  return withTransaction(async (client) => {
    const sel = await client.query(
      `SELECT data FROM creative_director_projects WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const project = rowToProject(sel.rows[0]);
    if (!project) {
      if (allowMissing) return { __missing: true };
      throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
    }
    const { project: next, result, skipPersist } = mutate(project);
    if (!skipPersist) await persist(client.query.bind(client), next);
    return { project: next, result };
  });
}

export async function updateProject(id, patch) {
  const { project } = await withLockedProject(id, (p) => ({ project: applyProjectPatch(p, patch) }));
  return project;
}

export async function deleteProject(id) {
  const result = await query(`DELETE FROM creative_director_projects WHERE id = $1`, [id]);
  if (result.rowCount === 0) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  return { ok: true };
}

export async function setTreatment(id, treatmentInput) {
  const { project } = await withLockedProject(id, (p) => ({ project: applyTreatment(p, treatmentInput) }));
  return project;
}

export async function updateScene(id, sceneId, patch) {
  const { result } = await withLockedProject(id, (p) => {
    const { project, updated } = applySceneUpdate(p, sceneId, patch);
    return { project, result: updated };
  });
  return result;
}

export async function recordRun(id, runEntry) {
  const { result } = await withLockedProject(id, (p) => {
    const { project, run } = appendRun(p, runEntry);
    return { project, result: run };
  });
  return result;
}

export async function updateRun(id, runId, patch) {
  const outcome = await withLockedProject(id, (p) => {
    const { project, updated } = applyRunUpdate(p, runId, patch);
    // Unknown runId: skip the write entirely so we don't bump updated_at or
    // rewrite the row for a no-op (mirrors the file backend's return null).
    return { project, result: updated, skipPersist: updated === null };
  }, { allowMissing: true });
  // Project row absent → mirror the file backend's "return null" (updateRun is
  // best-effort; callers .catch or null-guard it).
  if (outcome.__missing) return null;
  return outcome.result;
}
