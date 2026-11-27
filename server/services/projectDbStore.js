import { randomUUID } from 'crypto';
import { query, withTransaction } from '../lib/db.js';
import { ServerError } from '../lib/errorHandler.js';
import { makeSyncKind } from '../lib/projectStoreKit.js';
import {
  maybeJournalBeforeOverwrite,
  setSyncBaseHash,
  contentHashForRecord,
  flushBaseHashes,
  deleteSyncBaseHash,
  withBaseHashFlushBatch,
} from '../lib/conflictJournal.js';
import { toPgJson } from '../lib/pgJson.js';

// Every write rewrites the whole JSONB document, so a record this large makes each edit slow (#16210).
const LARGE_PROJECT_RECORD_BYTES = 5 * 1024 * 1024;
const MB = 1024 * 1024;

export function createProjectDbStore({ table, kind, idPrefix, logEmoji, logLabel, logic, pageHeaderFields = [], largeRecordBytes = LARGE_PROJECT_RECORD_BYTES }) {
  if (!/^[a-z][a-z0-9_]*$/.test(table)) throw new Error(`Invalid project table: ${table}`);
  const extraHeaderColumns = pageHeaderFields.map((field) => {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(field)) throw new Error(`Invalid project page header field: ${field}`);
    return `, data->'${field}' AS "${field}"`;
  }).join('');
  const sync = makeSyncKind(kind);
  // Highest whole MB already logged per record, so a large record logs once per MB it grows, not on every edit.
  const loggedLargeMb = new Map();

  function noteRecordSize(id, json) {
    const bytes = Buffer.byteLength(json);
    if (bytes < largeRecordBytes) {
      loggedLargeMb.delete(id);
      return;
    }
    const mb = Math.floor(bytes / MB);
    if (mb <= (loggedLargeMb.get(id) ?? -1)) return;
    loggedLargeMb.set(id, mb);
    console.log(`🐢 ${logLabel} project ${id} stored record is ${(bytes / MB).toFixed(1)} MB (over ${(largeRecordBytes / MB).toFixed(0)} MB); every write rewrites it whole`);
  }

  function rowToProject(row) {
    if (!row) return null;
    const project = row.data && !row.data.id ? { ...row.data, id: row.id } : row.data;
    return logic.afterLoad && project ? logic.afterLoad(project) : project;
  }

  async function persist(exec, project) {
    if (!project?.id) {
      throw new ServerError(`Cannot persist a ${logLabel} project without an id`, {
        status: 500,
        code: 'PROJECT_ID_MISSING',
      });
    }
    const prepared = logic.beforeSave ? logic.beforeSave(project) : project;
    // `toStored` encodes only the JSONB written (#16210); the caller gets the record `rowToProject` reads back.
    const data = toPgJson(logic.toStored ? logic.toStored(prepared) : prepared);
    noteRecordSize(prepared.id, data);
    const now = new Date().toISOString();
    const createdAt = logic.mirrorTimestamp(prepared.createdAt, now);
    await exec(
      `INSERT INTO ${table} (id, status, data, created_at, updated_at, deleted, deleted_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         data = EXCLUDED.data,
         updated_at = EXCLUDED.updated_at,
         deleted = EXCLUDED.deleted,
         deleted_at = EXCLUDED.deleted_at`,
      [
        prepared.id,
        logic.mirrorStatus(prepared.status),
        data,
        createdAt,
        logic.mirrorTimestamp(prepared.updatedAt, createdAt),
        prepared.deleted === true,
        logic.mirrorTimestamp(prepared.deletedAt, null),
      ],
    );
    return prepared;
  }

  async function listProjects({ includeDeleted = false } = {}) {
    const where = includeDeleted ? '' : ' WHERE deleted = FALSE';
    const result = await query(`SELECT id, data FROM ${table}${where} ORDER BY created_at ASC`);
    return result.rows.map(rowToProject);
  }

  async function readProjectPage({ where, limit, offset, compare, filter, filterNeedsExtraHeaders }) {
    if (!compare && !filter) {
      const { rows: [{ ids, total }] } = await query(`
        SELECT ARRAY(SELECT id FROM ${table}${where} ORDER BY created_at ASC LIMIT $1 OFFSET $2) AS ids,
               (SELECT COUNT(*)::int FROM ${table}${where}) AS total`, [limit, offset]);
      return { ids, total };
    }
    // The caller's comparator may fall back to a different timestamp than
    // the write-safe SQL columns. These mirrors retain the original values.
    const { rows } = await query(`SELECT id, page_created_at AS "createdAt", page_updated_at AS "updatedAt",
      page_status AS status, name${filter && filterNeedsExtraHeaders ? extraHeaderColumns : ''}
      FROM ${table}${where} ORDER BY created_at ASC`);
    const headers = filter ? rows.filter(filter) : rows;
    if (compare) headers.sort(compare);
    return { ids: headers.slice(offset, offset + limit).map(({ id }) => id), total: headers.length };
  }

  async function listProjectPage({ includeDeleted = false, limit = 50, offset = 0, compare, filter, filterNeedsExtraHeaders = true } = {}) {
    const where = includeDeleted ? '' : ' WHERE deleted = FALSE';
    const { ids, total } = await readProjectPage({ where, limit, offset, compare, filter, filterNeedsExtraHeaders });
    const projects = new Map((await getProjectsByIds(ids, { includeDeleted })).map(project => [project.id, project]));
    return { items: ids.map(id => projects.get(id)).filter(Boolean), total, limit, offset };
  }

  async function getProject(id, { includeDeleted = false } = {}) {
    const result = await query(`SELECT id, data FROM ${table} WHERE id = $1`, [id]);
    const project = rowToProject(result.rows[0]);
    if (!project) return null;
    return includeDeleted || !project.deleted ? project : null;
  }

  async function getProjectsByIds(ids, { includeDeleted = false } = {}) {
    const wanted = [...new Set((ids || []).filter(Boolean))];
    if (wanted.length === 0) return [];
    const live = includeDeleted ? '' : ' AND deleted = FALSE';
    const result = await query(
      `SELECT id, data FROM ${table} WHERE id = ANY($1)${live} ORDER BY created_at ASC`,
      [wanted],
    );
    return result.rows.map(rowToProject);
  }

  async function listProjectIds({ includeDeleted = false } = {}) {
    const where = includeDeleted ? '' : ' WHERE deleted = FALSE';
    const result = await query(`SELECT id FROM ${table}${where}`);
    return result.rows.map((row) => row.id);
  }

  // Live `{ id, name }` rows without loading the JSONB bodies (sidebar nav).
  async function listProjectNames() {
    const result = await query(`SELECT id, name FROM ${table} WHERE deleted = FALSE ORDER BY created_at ASC`);
    return result.rows.map(({ id, name }) => ({ id, name: name ?? null }));
  }

  async function createProject(input, buildOptions = {}) {
    const id = `${idPrefix}-${randomUUID()}`;
    const extra = typeof buildOptions === 'function'
      ? await buildOptions({ id, input })
      : buildOptions;
    const project = logic.buildProjectRecord(input, { id, now: new Date().toISOString(), ...extra });
    const persisted = await persist(query, project);
    console.log(`${logEmoji} Created ${logLabel} project: ${id} (${input.name})`);
    return persisted;
  }

  async function withLockedProject(id, mutate, { allowMissing = false } = {}) {
    return withTransaction(async (client) => {
      const selected = await client.query(`SELECT id, data FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
      const project = rowToProject(selected.rows[0]);
      if (!project || project.deleted) {
        if (allowMissing) return { __missing: true };
        throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
      }
      const { project: next, result, skipPersist } = await mutate(project, client);
      const persisted = skipPersist ? next : await persist(client.query.bind(client), next);
      return { project: persisted, result };
    });
  }

  async function updateProject(id, patch) {
    const { project } = await withLockedProject(id, (current) => ({
      project: logic.applyProjectPatch(current, patch),
    }));
    return project;
  }

  async function deleteProject(id) {
    const { result } = await withLockedProject(id, (current) => {
      const now = new Date().toISOString();
      return {
        project: { ...current, deleted: true, deletedAt: now, updatedAt: now },
        result: { ok: true },
      };
    });
    return result;
  }

  async function mergeProjectsFromSync(remoteProjects, { source = { via: 'sync', peerId: null } } = {}) {
    if (!Array.isArray(remoteProjects)) return { applied: false, count: 0 };
    let count = 0;
    for (const remote of remoteProjects) {
      const applied = await withTransaction(async (client) => {
        const selected = await client.query(`SELECT id, data FROM ${table} WHERE id = $1 FOR UPDATE`, [remote?.id]);
        const local = rowToProject(selected.rows[0]);
        const { changes } = sync.applySyncMerge({
          byId: new Map(local ? [[local.id, local]] : []),
          remoteProjects: [remote],
          source,
          mergeProjectRecord: logic.mergeProjectRecord,
        });
        const [change] = changes;
        if (!change) return false;
        if (!change.inserted) await maybeJournalBeforeOverwrite(change);
        await persist(client.query.bind(client), change.remote);
        await setSyncBaseHash(kind, change.id, contentHashForRecord(kind, change.remote));
        return true;
      });
      if (applied) count += 1;
    }
    await flushBaseHashes();
    return { applied: count > 0, count };
  }

  async function pruneTombstonedProjects(olderThanMs) {
    if (!Number.isFinite(olderThanMs)) return { pruned: 0 };
    const { rows } = await query(
      `DELETE FROM ${table}
       WHERE deleted = TRUE AND deleted_at IS NOT NULL AND deleted_at < $1
       RETURNING id`,
      [new Date(olderThanMs).toISOString()],
    );
    await withBaseHashFlushBatch(async () => {
      for (const row of rows) await deleteSyncBaseHash(kind, row.id);
    });
    return { pruned: rows.length };
  }

  return {
    rowToProject,
    persist,
    listProjects,
    listProjectPage,
    getProject,
    getProjectsByIds,
    listProjectIds,
    listProjectNames,
    createProject,
    withLockedProject,
    updateProject,
    deleteProject,
    mergeProjectsFromSync,
    pruneTombstonedProjects,
  };
}
