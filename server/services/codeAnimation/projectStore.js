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
