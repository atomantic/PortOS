/** PostgreSQL owns projects, source revision lineage and import-run records. */
import { query, withTransaction } from '../../lib/db.js';
import { ServerError } from '../../lib/errorHandler.js';

const columns = `id, title, data, accepted_revision_id AS "acceptedRevisionId",
  candidate_revision_id AS "candidateRevisionId", created_at AS "createdAt", updated_at AS "updatedAt"`;
const present = row => {
  if (!row) return null;
  const { data, ...metadata } = row;
  return { ...data, ...metadata };
};
const missing = () => new ServerError('Production project not found', { status: 404, code: 'NOT_FOUND' });

export async function createProjectRecord(id, settings) {
  const { rows } = await query(`INSERT INTO code_animation_projects (id, title, data)
    VALUES ($1, $2, $3) RETURNING ${columns}`, [id, settings.manifest.title, settings]);
  return present(rows[0]);
}

export async function getProjectRecord(id) {
  const { rows } = await query(`SELECT ${columns} FROM code_animation_projects WHERE id = $1`, [id]);
  return present(rows[0]) || null;
}

export async function pageProjectRecords({ limit, offset }) {
  const [page, count] = await Promise.all([
    query(`SELECT id, title, accepted_revision_id AS "acceptedRevisionId",
      candidate_revision_id AS "candidateRevisionId", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM code_animation_projects ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2`, [limit + 1, offset]),
    query('SELECT COUNT(*)::integer AS total FROM code_animation_projects'),
  ]);
  return { items: page.rows.slice(0, limit), total: count.rows[0].total,
    nextCursor: page.rows.length > limit ? String(offset + limit) : null };
}

export async function patchProjectRecord(id, patch) {
  return withTransaction(async client => {
    const { rows } = await client.query(`SELECT ${columns} FROM code_animation_projects WHERE id = $1 FOR UPDATE`, [id]);
    if (!rows[0]) throw missing();
    const settings = { ...rows[0].data, ...patch };
    if (patch.budgets) {
      const used = await client.query("SELECT COALESCE(SUM((data->>'reservedBytes')::bigint), 0) AS bytes FROM code_animation_project_runs WHERE project_id = $1", [id]);
      if (Number(used.rows[0].bytes) > settings.budgets.diskBytes) {
        throw new ServerError('Disk budget cannot be smaller than retained source reservations', { status: 409, code: 'CODE_ANIMATION_DISK_BUDGET' });
      }
    }
    const result = await client.query(`UPDATE code_animation_projects SET title = $2, data = $3, updated_at = NOW()
      WHERE id = $1 RETURNING ${columns}`, [id, settings.manifest.title, settings]);
    return present(result.rows[0]);
  });
}

export async function startImportRecord(id, projectId, data) {
  return withTransaction(async client => {
    const project = await client.query('SELECT data FROM code_animation_projects WHERE id = $1 FOR UPDATE', [projectId]);
    if (!project.rows[0]) throw missing();
    const settings = project.rows[0].data;
    const used = await client.query("SELECT COALESCE(SUM((data->>'reservedBytes')::bigint), 0) AS bytes FROM code_animation_project_runs WHERE project_id = $1", [projectId]);
    const allowed = Number(used.rows[0].bytes) + data.totalBytes <= settings.budgets.diskBytes;
    await client.query(`INSERT INTO code_animation_project_runs (id, project_id, status, data, completed_at)
      VALUES ($1, $2, $3, $4, $5)`, [id, projectId, allowed ? 'staging' : 'failed',
      { ...data, requested: settings.localSettings, budgets: settings.budgets, reservedBytes: allowed ? data.totalBytes : 0 },
      allowed ? null : new Date().toISOString()]);
    return allowed;
  });
}

export async function failImportRecord(id, error, releaseReservation = false) {
  await query(`UPDATE code_animation_project_runs SET status = 'failed',
    data = data || jsonb_build_object('error', $2::text) ||
      CASE WHEN $3 THEN '{"reservedBytes":0}'::jsonb ELSE '{}'::jsonb END,
    completed_at = NOW() WHERE id = $1`, [id, error, releaseReservation]);
}

export async function commitImportRecord(projectId, revision, runId) {
  return withTransaction(async client => {
    const { rows } = await client.query(`SELECT ${columns} FROM code_animation_projects WHERE id = $1 FOR UPDATE`, [projectId]);
    if (!rows[0]) throw missing();
    await client.query(`INSERT INTO code_animation_project_revisions
      (id, project_id, package_hash, source_hash, total_bytes, data)
      VALUES ($1, $2, $3, $4, $5, $6)`,
    [revision.id, projectId, revision.packageHash, revision.sourceHash, revision.totalBytes, revision]);
    await client.query(`UPDATE code_animation_project_runs SET status = 'completed', revision_id = $2, completed_at = NOW() WHERE id = $1`, [runId, revision.id]);
    const saved = await client.query(`UPDATE code_animation_projects SET candidate_revision_id = $2, updated_at = NOW()
      WHERE id = $1 RETURNING ${columns}`, [projectId, revision.id]);
    return present(saved.rows[0]);
  });
}

export async function acceptProjectRevision(projectId, revisionId) {
  const { rows } = await query(`UPDATE code_animation_projects SET accepted_revision_id = $2,
    candidate_revision_id = NULL, updated_at = NOW() WHERE id = $1 AND candidate_revision_id = $2 RETURNING ${columns}`, [projectId, revisionId]);
  if (!rows[0]) throw new ServerError('Candidate changed; reload before accepting source', { status: 409, code: 'CODE_ANIMATION_CANDIDATE_CHANGED' });
  return present(rows[0]);
}

export async function getRevisionRecord(projectId, revisionId) {
  const { rows } = await query('SELECT data FROM code_animation_project_revisions WHERE project_id = $1 AND id = $2', [projectId, revisionId]);
  return rows[0]?.data || null;
}

export async function pageProjectHistory(projectId, { limit, offset }) {
  const { rows } = await query(`SELECT id, status, revision_id AS "revisionId", data,
    created_at AS "createdAt", completed_at AS "completedAt" FROM code_animation_project_runs
    WHERE project_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`, [projectId, limit + 1, offset]);
  return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? String(offset + limit) : null };
}

export async function interruptImports(projectId, activeIds) {
  await query(`UPDATE code_animation_project_runs SET status = 'interrupted', completed_at = NOW()
    WHERE project_id = $1 AND status = 'staging' AND NOT (id = ANY($2::text[]))`, [projectId, activeIds]);
}

// ---- Stage runs (#9389): one active run per project, durable status ----

const RUN_ACTIVE = 'running';

/**
 * Insert a running stage run. Rows left `running` by a previous process (not in
 * `activeIds`) are marked interrupted first, so a restart never blocks the
 * project and never silently resumes. Another live run is a conflict.
 */
export async function startStageRun(id, projectId, data, activeIds) {
  return withTransaction(async client => {
    const project = await client.query('SELECT data FROM code_animation_projects WHERE id = $1 FOR UPDATE', [projectId]);
    if (!project.rows[0]) throw missing();
    await client.query(`UPDATE code_animation_project_runs SET status = 'interrupted',
      data = data || '{"resumable":true}'::jsonb, completed_at = NOW()
      WHERE project_id = $1 AND status = $2 AND data->>'kind' = 'production-stages' AND NOT (id = ANY($3::text[]))`,
    [projectId, RUN_ACTIVE, activeIds]);
    const live = await client.query(`SELECT id FROM code_animation_project_runs
      WHERE project_id = $1 AND status = $2 AND data->>'kind' = 'production-stages' LIMIT 1`, [projectId, RUN_ACTIVE]);
    if (live.rows[0]) {
      throw new ServerError('A production run is already active for this project', { status: 409, code: 'CODE_ANIMATION_RUN_ACTIVE' });
    }
    await client.query(`INSERT INTO code_animation_project_runs (id, project_id, revision_id, status, data)
      VALUES ($1, $2, $3, $4, $5)`, [id, projectId, data.sourceRevisionId, RUN_ACTIVE, data]);
  });
}

export async function saveStageRun(id, status, data, { revisionId = null, completed = false } = {}) {
  await query(`UPDATE code_animation_project_runs SET status = $2, data = $3,
    revision_id = COALESCE($4, revision_id), completed_at = CASE WHEN $5 THEN NOW() ELSE completed_at END WHERE id = $1`,
  [id, status, data, revisionId, completed]);
}

export async function getRunRecord(projectId, runId) {
  const { rows } = await query(`SELECT id, status, revision_id AS "revisionId", data, created_at AS "createdAt",
    completed_at AS "completedAt" FROM code_animation_project_runs WHERE project_id = $1 AND id = $2`, [projectId, runId]);
  return rows[0] || null;
}

/** Add `bytes` to a run's disk reservation unless it would exceed the project budget. */
export async function reserveRunBytes(runId, projectId, bytes) {
  return withTransaction(async client => {
    const project = await client.query('SELECT data FROM code_animation_projects WHERE id = $1 FOR UPDATE', [projectId]);
    if (!project.rows[0]) throw missing();
    const used = await client.query("SELECT COALESCE(SUM((data->>'reservedBytes')::bigint), 0) AS bytes FROM code_animation_project_runs WHERE project_id = $1", [projectId]);
    if (Number(used.rows[0].bytes) + bytes > project.rows[0].data.budgets.diskBytes) return false;
    await client.query(`UPDATE code_animation_project_runs SET data = jsonb_set(data, '{reservedBytes}',
      to_jsonb(COALESCE((data->>'reservedBytes')::bigint, 0) + $2::bigint)) WHERE id = $1`, [runId, bytes]);
    return true;
  });
}

/** A repaired source is a new immutable candidate revision; the accepted one is untouched. */
export async function commitRepairRevision(projectId, revision) {
  return withTransaction(async client => {
    const { rows } = await client.query(`SELECT ${columns} FROM code_animation_projects WHERE id = $1 FOR UPDATE`, [projectId]);
    if (!rows[0]) throw missing();
    await client.query(`INSERT INTO code_animation_project_revisions
      (id, project_id, package_hash, source_hash, total_bytes, data) VALUES ($1, $2, $3, $4, $5, $6)`,
    [revision.id, projectId, revision.packageHash, revision.sourceHash, revision.totalBytes, revision]);
    const saved = await client.query(`UPDATE code_animation_projects SET candidate_revision_id = $2, updated_at = NOW()
      WHERE id = $1 RETURNING ${columns}`, [projectId, revision.id]);
    return present(saved.rows[0]);
  });
}

export async function interruptStageRuns(projectId, activeIds) {
  await query(`UPDATE code_animation_project_runs SET status = 'interrupted',
    data = data || '{"resumable":true}'::jsonb, completed_at = NOW()
    WHERE project_id = $1 AND status = 'running' AND data->>'kind' = 'production-stages' AND NOT (id = ANY($2::text[]))`, [projectId, activeIds]);
}
