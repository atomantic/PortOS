/** PostgreSQL owns projects, source revision lineage and import-run records. */
import { randomUUID } from 'crypto';
import { query, withTransaction } from '../../lib/db.js';
import { ServerError } from '../../lib/errorHandler.js';
import { toPgJson } from '../../lib/pgJson.js';

const columns = `id, title, data, accepted_revision_id AS "acceptedRevisionId",
  candidate_revision_id AS "candidateRevisionId", created_at AS "createdAt", updated_at AS "updatedAt"`;
const present = row => {
  if (!row) return null;
  const { data, ...metadata } = row;
  return { kind: 'package', ...data, ...metadata };
};
const missing = () => new ServerError('Production project not found', { status: 404, code: 'NOT_FOUND' });

// Keep PostgreSQL's full timestamp precision in the token. node-postgres turns
// timestamptz values into millisecond Date objects, which is not a safe keyset
// boundary when two rows were inserted within the same millisecond.
const encodePageCursor = ({ createdAt, id }) => Buffer.from(JSON.stringify({ createdAt, id })).toString('base64url');
function validCursorTimestamp(timestamp) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(timestamp);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year === 0 || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]
    || hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== 'Z') {
    const offset = /[+-](\d{2})(?::?(\d{2}))?$/.exec(zone);
    if (!offset || Number(offset[1]) > 15 || Number(offset[2] || 0) > 59) return false;
  }
  return Number.isFinite(Date.parse(timestamp));
}
function decodePageCursor(cursor) {
  if (!cursor) return null;
  // Older clients sent a numeric offset. Resolve it once to a tuple, then
  // return a keyset cursor so subsequent requests use stable boundaries.
  if (/^(0|[1-9][0-9]{0,8})$/.test(cursor)) return { legacyOffset: Number(cursor) };
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const timestamp = value.createdAt;
    if (typeof timestamp !== 'string' || !validCursorTimestamp(timestamp)
      || typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 255) throw new Error('invalid cursor');
    return { createdAt: timestamp, id: value.id };
  } catch {
    throw new ServerError('Invalid page cursor', { status: 400, code: 'INVALID_CURSOR' });
  }
}

export async function createProjectRecord(id, settings) {
  const { rows } = await query(`INSERT INTO code_animation_projects (id, title, data)
    VALUES ($1, $2, $3) RETURNING ${columns}`, [id, settings.manifest?.title ?? settings.title, settings]);
  return present(rows[0]);
}

export async function getProjectRecord(id) {
  const { rows } = await query(`SELECT ${columns} FROM code_animation_projects WHERE id = $1`, [id]);
  return present(rows[0]) || null;
}

export async function pageProjectRecords({ limit, cursor }) {
  let after = decodePageCursor(cursor);
  if (after?.legacyOffset) {
    const { rows } = await query(`SELECT created_at::text AS "createdAt", id FROM code_animation_projects
      ORDER BY created_at DESC, id DESC LIMIT 1 OFFSET $1`, [after.legacyOffset - 1]);
    if (!rows[0]) return { items: [], total: (await query('SELECT COUNT(*)::integer AS total FROM code_animation_projects')).rows[0].total, nextCursor: null };
    after = rows[0];
  }
  const [page, count] = await Promise.all([
    query(`SELECT id, title, COALESCE(data->>'kind', 'package') AS kind, accepted_revision_id AS "acceptedRevisionId",
      candidate_revision_id AS "candidateRevisionId", created_at AS "createdAt", created_at::text AS "cursorCreatedAt",
      updated_at AS "updatedAt" FROM code_animation_projects
      WHERE ($1::timestamptz IS NULL OR (created_at, id) < ($1::timestamptz, $2::text))
      ORDER BY created_at DESC, id DESC LIMIT $3`, [after?.createdAt || null, after?.id || null, limit + 1]),
    query('SELECT COUNT(*)::integer AS total FROM code_animation_projects'),
  ]);
  const rows = page.rows.slice(0, limit);
  const last = rows.at(-1);
  const items = rows.map(({ cursorCreatedAt: _cursorCreatedAt, ...item }) => item);
  return { items, total: count.rows[0].total,
    nextCursor: page.rows.length > limit ? encodePageCursor({ createdAt: last.cursorCreatedAt, id: last.id }) : null };
}

export async function patchProjectRecord(id, patch) {
  return withTransaction(async client => {
    const { rows } = await client.query(`SELECT ${columns} FROM code_animation_projects WHERE id = $1 FOR UPDATE`, [id]);
    if (!rows[0]) throw missing();
    const stored = rows[0].data;
    if (stored.kind === 'film') throw new ServerError('Use the Film project routes to change this project', { status: 409, code: 'FILM_PROJECT' });
    // Nested objects merge field by field: a partial PATCH names only the fields it changes.
    const settings = {
      ...stored, ...patch,
      budgets: { ...stored.budgets, ...patch.budgets },
      localSettings: { ...stored.localSettings, ...patch.localSettings },
      referenceIntent: { ...stored.referenceIntent, ...patch.referenceIntent },
    };
    if (patch.budgets) {
      const used = await client.query("SELECT COALESCE(SUM((data->>'reservedBytes')::bigint), 0) AS bytes FROM code_animation_project_runs WHERE project_id = $1", [id]);
      if (Number(used.rows[0].bytes) > settings.budgets.diskBytes) {
        throw new ServerError('Disk budget cannot be smaller than retained source reservations', { status: 409, code: 'CODE_ANIMATION_DISK_BUDGET' });
      }
    }
    const result = await client.query(`UPDATE code_animation_projects SET title = $2, data = $3, updated_at = NOW()
      WHERE id = $1 RETURNING ${columns}`, [id, settings.manifest?.title ?? settings.title, settings]);
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

export async function pageProjectHistory(projectId, { limit, cursor }) {
  let after = decodePageCursor(cursor);
  if (after?.legacyOffset) {
    const { rows } = await query(`SELECT created_at::text AS "createdAt", id FROM code_animation_project_runs
      WHERE project_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1 OFFSET $2`, [projectId, after.legacyOffset - 1]);
    if (!rows[0]) return { items: [], nextCursor: null };
    after = rows[0];
  }
  const { rows } = await query(`SELECT id, status, revision_id AS "revisionId", data,
    created_at AS "createdAt", created_at::text AS "cursorCreatedAt", completed_at AS "completedAt" FROM code_animation_project_runs
    WHERE project_id = $1 AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::text))
    ORDER BY created_at DESC, id DESC LIMIT $4`, [projectId, after?.createdAt || null, after?.id || null, limit + 1]);
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items: items.map(({ cursorCreatedAt: _cursorCreatedAt, ...item }) => item),
    nextCursor: rows.length > limit ? encodePageCursor({ createdAt: last.cursorCreatedAt, id: last.id }) : null };
}

export async function interruptImports(projectId, activeIds) {
  await query(`UPDATE code_animation_project_runs SET status = 'interrupted', completed_at = NOW()
    WHERE project_id = $1 AND status = 'staging' AND NOT (id = ANY($2::text[]))`, [projectId, activeIds]);
}

// ---- Stage runs (#9389): one active run per project, durable status ----

const RUN_ACTIVE = 'running';

/**
 * Insert a running stage run. Rows left `running` by a previous process (not in
 * `getActiveIds()`) are marked interrupted first, so a restart never blocks the
 * project and never silently resumes. Another live run is a conflict. Resolve
 * live IDs under the project lock; a queued snapshot can omit a newer run.
 */
export async function startStageRun(id, projectId, data, getActiveIds) {
  return withTransaction(async client => {
    const project = await client.query('SELECT data FROM code_animation_projects WHERE id = $1 FOR UPDATE', [projectId]);
    if (!project.rows[0]) throw missing();
    await client.query(`UPDATE code_animation_project_runs SET status = 'interrupted',
      data = data || '{"resumable":true}'::jsonb, completed_at = NOW()
      WHERE project_id = $1 AND status = $2 AND data->>'kind' = 'production-stages' AND NOT (id = ANY($3::text[]))`,
    [projectId, RUN_ACTIVE, getActiveIds()]);
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

export async function interruptStageRuns(projectId, getActiveIds) {
  await withTransaction(async client => {
    await client.query('SELECT id FROM code_animation_projects WHERE id = $1 FOR UPDATE', [projectId]);
    await client.query(`UPDATE code_animation_project_runs SET status = 'interrupted',
      data = data || '{"resumable":true}'::jsonb, completed_at = NOW()
      WHERE project_id = $1 AND status = 'running' AND data->>'kind' = 'production-stages' AND NOT (id = ANY($2::text[]))`, [projectId, getActiveIds()]);
  });
}

// ---- Accepted output (#9392): a frozen record beside, never inside, the run history ----

/**
 * Store the accepted output on the project. A later failed or stale run never
 * touches it. When the output's revision is the current candidate, accepting
 * the output also accepts that source in the same transaction.
 */
export async function setAcceptedOutput(projectId, accepted) {
  return withTransaction(async client => {
    const { rows } = await client.query(`SELECT ${columns} FROM code_animation_projects WHERE id = $1 FOR UPDATE`, [projectId]);
    if (!rows[0]) throw missing();
    const promoteSource = rows[0].candidateRevisionId === accepted.revisionId;
    const result = await client.query(`UPDATE code_animation_projects SET data = data || jsonb_build_object('acceptedOutput', $2::jsonb, 'acceptanceProjection', $5::jsonb),
      accepted_revision_id = CASE WHEN $4 THEN $3 ELSE accepted_revision_id END,
      candidate_revision_id = CASE WHEN $4 THEN NULL ELSE candidate_revision_id END, updated_at = NOW()
      WHERE id = $1 RETURNING ${columns}`, [projectId, toPgJson(accepted), accepted.revisionId, promoteSource,
      toPgJson({ decisionId: randomUUID(), status: 'pending' })]);
    return present(result.rows[0]);
  });
}

/** A history write only acknowledges the exact decision it projected. */
export async function acknowledgeAcceptanceProjection(projectId, decisionId) {
  const { rows } = await query(`UPDATE code_animation_projects
    SET data = jsonb_set(data, '{acceptanceProjection,status}', '"synced"'::jsonb)
    WHERE id = $1 AND data->'acceptanceProjection'->>'decisionId' = $2
    RETURNING ${columns}`, [projectId, decisionId]);
  return present(rows[0]) || getProjectRecord(projectId);
}

function decodeAcceptedCursor(cursor) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string'
      || typeof value[1] !== 'string' || !value[1]) throw new Error('invalid cursor');
    return value;
  } catch {
    throw new ServerError('Invalid page cursor', { status: 400, code: 'INVALID_CURSOR' });
  }
}

export async function pageAcceptedOutputs({ limit, cursor }) {
  const after = decodeAcceptedCursor(cursor);
  // The normal writer always stores an ISO timestamp. Treat a missing one as
  // oldest so a legacy record can still be reached and used as a boundary.
  const { rows } = await query(`SELECT id, title, data->'acceptedOutput' AS accepted,
    COALESCE(data->'acceptedOutput'->>'acceptedAt', '') AS "cursorAcceptedAt" FROM code_animation_projects
    WHERE data ? 'acceptedOutput' AND ($1::text IS NULL OR (COALESCE(data->'acceptedOutput'->>'acceptedAt', ''), id) < ($1::text, $2::text))
    ORDER BY COALESCE(data->'acceptedOutput'->>'acceptedAt', '') DESC, id DESC LIMIT $3`, [after?.[0] ?? null, after?.[1] ?? null, limit + 1]);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(({ cursorAcceptedAt: _cursorAcceptedAt, ...item }) => item),
    nextCursor: rows.length > limit ? Buffer.from(JSON.stringify([last.cursorAcceptedAt, last.id])).toString('base64url') : null,
  };
}

/** Film settings/notes and acceptance share one row lock so overlapping saves merge. */
export async function mutateFilmProject(id, change) {
  return withTransaction(async client => {
    const { rows } = await client.query(`SELECT ${columns} FROM code_animation_projects WHERE id = $1 FOR UPDATE`, [id]);
    const project = present(rows[0]);
    if (!project || project.kind !== 'film') throw missing();
    const data = { ...rows[0].data, ...await change(project) };
    const saved = await client.query(`UPDATE code_animation_projects SET title = $2, data = $3, updated_at = NOW()
      WHERE id = $1 RETURNING ${columns}`, [id, data.title, data]);
    return present(saved.rows[0]);
  });
}
