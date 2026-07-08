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
  applyPlan,
  applyPlanStepUpdate,
  applySceneUpdate,
  appendRun,
  applyRunUpdate,
  mergeProjectRecord,
} from './projectsLogic.js';
import {
  maybeJournalBeforeOverwrite, setSyncBaseHash, contentHashForRecord, flushBaseHashes, deleteSyncBaseHash,
  withBaseHashFlushBatch,
} from '../../lib/conflictJournal.js';

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
    `INSERT INTO creative_director_projects (id, status, data, created_at, updated_at, deleted, deleted_at)
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
  // created_at ASC preserves the file backend's append order (the UI sorts
  // client-side; recovery + tests don't depend on order, but stable beats random).
  const result = includeDeleted
    ? await query(`SELECT data FROM creative_director_projects ORDER BY created_at ASC`)
    : await query(`SELECT data FROM creative_director_projects WHERE deleted = FALSE ORDER BY created_at ASC`);
  return result.rows.map(rowToProject);
}

export async function getProject(id, { includeDeleted = false } = {}) {
  const result = await query(`SELECT data FROM creative_director_projects WHERE id = $1`, [id]);
  const project = rowToProject(result.rows[0]);
  if (!project) return null;
  return includeDeleted || !project.deleted ? project : null;
}

/** Live project ids (or all when includeDeleted) — used by tombstone GC sweeps. */
export async function listProjectIds({ includeDeleted = false } = {}) {
  const result = includeDeleted
    ? await query(`SELECT id FROM creative_director_projects`)
    : await query(`SELECT id FROM creative_director_projects WHERE deleted = FALSE`);
  return result.rows.map((r) => r.id);
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
    // A tombstoned project (#1564 soft-delete) is treated as gone for every
    // user-facing mutator — without this, a PATCH / scene / treatment update
    // after deletion would resurrect the row, bump updatedAt, and re-push a
    // modified tombstone to peers while getProject/deleteProject 404 the same id.
    // mergeProjectsFromSync (peer tombstone apply) bypasses this path via its own
    // persist, so receiving a tombstone still works.
    if (!project || project.deleted) {
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
  // Soft-delete tombstone (#1564) so the deletion federates and an out-of-date
  // peer can't resurrect the project via the LWW merge. The row stays; `deleted`
  // flips and `updatedAt`/`deletedAt` stamp now so the tombstone wins on merge.
  return withTransaction(async (client) => {
    const sel = await client.query(
      `SELECT data FROM creative_director_projects WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const current = rowToProject(sel.rows[0]);
    if (!current || current.deleted) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
    const now = new Date().toISOString();
    const next = { ...current, deleted: true, deletedAt: now, updatedAt: now };
    await persist(client.query.bind(client), next);
    return { ok: true };
  });
}

/**
 * Merge an incoming batch of project records from a peer (per-record push). Each
 * record's read-modify-write runs inside `withTransaction` + `SELECT … FOR
 * UPDATE` so a concurrent local edit can't lose to (or clobber) the merge. LWW
 * on `updatedAt` (tombstone-aware) via the shared `mergeProjectRecord` decision
 * — identical to the file backend so the two can't drift. Mirrors
 * `mergeAuthorsFromSync`: seeds/advances the conflict-journal base hash and
 * journals the about-to-be-overwritten local version when remote wins
 * (best-effort, never throws into the merge). Returns `{ applied, count }`.
 */
export async function mergeProjectsFromSync(remoteProjects, { source = { via: 'sync', peerId: null } } = {}) {
  if (!Array.isArray(remoteProjects)) return { applied: false, count: 0 };
  let changed = 0;
  for (const remote of remoteProjects) {
    const applied = await withTransaction(async (client) => {
      const sel = await client.query(`SELECT data FROM creative_director_projects WHERE id = $1 FOR UPDATE`, [remote?.id]);
      const local = rowToProject(sel.rows[0]);
      const { next, inserted, remoteWins, changed: didChange } = mergeProjectRecord(local, remote);
      if (!next) return false; // malformed remote → dropped
      if (inserted) {
        await persist(client.query.bind(client), next);
        await setSyncBaseHash('creativeDirectorProject', next.id, contentHashForRecord('creativeDirectorProject', next));
        return true;
      }
      // local wins, OR remote won but is byte-identical to local (already agree).
      if (!remoteWins || !didChange) return false;
      await maybeJournalBeforeOverwrite({ kind: 'creativeDirectorProject', id: next.id, local, remote: next, source });
      await persist(client.query.bind(client), next);
      await setSyncBaseHash('creativeDirectorProject', next.id, contentHashForRecord('creativeDirectorProject', next));
      return true;
    });
    if (applied) changed += 1;
  }
  await flushBaseHashes();
  if (changed === 0) return { applied: false, count: 0 };
  return { applied: true, count: changed };
}

/**
 * Hard-remove tombstoned projects whose deletedAt is older than the cutoff.
 * Called by tombstoneGc once every subscribed peer has acked the deletion.
 * Evicts each pruned project's conflict-journal base hash (mirrors
 * pruneTombstonedAuthors).
 */
export async function pruneTombstonedProjects(olderThanMs) {
  if (!Number.isFinite(olderThanMs)) return { pruned: 0 };
  const cutoffIso = new Date(olderThanMs).toISOString();
  const { rows } = await query(
    `DELETE FROM creative_director_projects
     WHERE deleted = TRUE AND deleted_at IS NOT NULL AND deleted_at < $1
     RETURNING id`,
    [cutoffIso],
  );
  // Coalesce the per-project base-hash evictions into ONE disk write.
  await withBaseHashFlushBatch(async () => {
    for (const r of rows) await deleteSyncBaseHash('creativeDirectorProject', r.id);
  });
  return { pruned: rows.length };
}

export async function setTreatment(id, treatmentInput) {
  const { project } = await withLockedProject(id, (p) => ({ project: applyTreatment(p, treatmentInput) }));
  return project;
}

export async function setPlan(id, planInput) {
  const { project } = await withLockedProject(id, (p) => ({ project: applyPlan(p, planInput) }));
  return project;
}

export async function updatePlanStep(id, stepId, patch) {
  const { result } = await withLockedProject(id, (p) => {
    const { project, updated } = applyPlanStepUpdate(p, stepId, patch);
    return { project, result: updated };
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
