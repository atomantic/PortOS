/** Builds PostgreSQL CRUD for JSONB records with typed mirror columns and optional soft deletion. */

import { z } from 'zod';
import { query } from './db.js';
import { toPgJson } from './pgJson.js';
import { mirrorTimestamp } from './pgTimestamp.js';

const IDENTIFIER = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const CORE_COLUMNS = new Set(['id', 'data', 'created_at', 'updated_at', 'deleted', 'deleted_at']);
const MIRROR_COLUMN = IDENTIFIER.refine(column => !CORE_COLUMNS.has(column), 'Reserved JSONB leaf column');
const projector = z.custom(value => typeof value === 'function', 'Expected a mirror projection');
const leafConfig = z.strictObject({
  table: IDENTIFIER,
  orderBy: z.array(z.tuple([IDENTIFIER, z.enum(['ASC', 'DESC'])])).default([]),
  softDelete: z.strictObject({
    includeDeletedByDefault: z.boolean().default(true),
    fillDeletedAt: z.boolean().default(false),
  }).optional(),
  mirrorColumns: z.record(MIRROR_COLUMN, z.union([projector, z.strictObject({ jsonb: projector })])).default({}),
});

const LIVE = 'deleted = FALSE';
const OLD_TOMBSTONE = 'deleted = TRUE AND deleted_at IS NOT NULL AND deleted_at < $1';

const execute = (client, sql, params) => client ? client.query(sql, params) : query(sql, params);

/**
 * Use code-owned identifiers and mirror projections. Ordinary projections bind
 * typed values. Use `{ jsonb: project }` for an additional JSONB column.
 * Reads return stored JSONB verbatim, and upserts keep the original created_at.
 * Soft deletion defaults to including tombstones so the store can filter them.
 * Set fillDeletedAt for stores that date missing tombstones and clear dates on live rows.
 */
export function createJsonbLeafDb(config) {
  const { table, orderBy, softDelete, mirrorColumns } = leafConfig.parse(config);
  const includeDeletedByDefault = softDelete?.includeDeletedByDefault ?? true;
  const sort = orderBy.length ? ` ORDER BY ${orderBy.map(([column, direction]) => `${column} ${direction}`).join(', ')}` : '';
  const mirrors = Object.entries(mirrorColumns).map(([column, project]) => ({
    column,
    jsonb: typeof project !== 'function',
    project: typeof project === 'function' ? project : project.jsonb,
  }));
  const columns = ['id', 'data', 'created_at', 'updated_at', ...mirrors.map(({ column }) => column)];
  const jsonbColumns = new Set(['data', ...mirrors.filter(mirror => mirror.jsonb).map(({ column }) => column)]);
  if (softDelete) columns.push('deleted', 'deleted_at');
  const placeholders = columns.map((column, index) => {
    const cast = jsonbColumns.has(column) ? '::jsonb' : '';
    return `$${index + 1}${cast}`;
  });
  const updates = columns.filter(column => column !== 'id' && column !== 'created_at')
    .map(column => `${column} = EXCLUDED.${column}`).join(', ');
  const upsert = `INSERT INTO ${table} (${columns.join(', ')})
    VALUES (${placeholders.join(', ')})
    ON CONFLICT (id) DO UPDATE SET ${updates}`;
  const liveOnly = includeDeleted => softDelete && !includeDeleted;

  async function readRaw(id, { client, includeDeleted = includeDeletedByDefault } = {}) {
    const live = liveOnly(includeDeleted) ? ` AND ${LIVE}` : '';
    const { rows } = await execute(client, `SELECT data FROM ${table} WHERE id = $1${live}`, [id]);
    return rows[0]?.data ?? null;
  }

  async function listRaw({ includeDeleted = includeDeletedByDefault } = {}) {
    const where = liveOnly(includeDeleted) ? ` WHERE ${LIVE}` : '';
    const { rows } = await query(`SELECT data FROM ${table}${where}${sort}`);
    return rows.map(row => row.data);
  }

  async function listIds({ includeDeleted = includeDeletedByDefault } = {}) {
    const where = liveOnly(includeDeleted) ? ` WHERE ${LIVE}` : '';
    const { rows } = await query(`SELECT id FROM ${table}${where}`);
    return rows.map(row => row.id);
  }

  function listLiveIds() {
    return listIds({ includeDeleted: false });
  }

  // Garbage collection projects ids only and leaves undated tombstones alone.
  async function listTombstoneIdsBefore(beforeMs) {
    const { rows } = await query(`SELECT id FROM ${table} WHERE ${OLD_TOMBSTONE}`, [new Date(beforeMs).toISOString()]);
    return rows.map(row => row.id);
  }

  async function writeRaw(id, record, { client } = {}) {
    const now = new Date().toISOString();
    const createdAt = mirrorTimestamp(record?.createdAt, now);
    const values = [id, toPgJson(record), createdAt, mirrorTimestamp(record?.updatedAt, createdAt)];
    for (const { project, jsonb } of mirrors) {
      const value = project(record);
      values.push(jsonb ? toPgJson(value) : value);
    }
    if (softDelete) {
      const deleted = record?.deleted === true;
      const deletedAt = softDelete.fillDeletedAt && !deleted
        ? null
        : mirrorTimestamp(record?.deletedAt, softDelete.fillDeletedAt ? now : null);
      values.push(deleted, deletedAt);
    }
    await execute(client, upsert, values);
    return record;
  }

  async function deleteRaw(id) {
    await query(`DELETE FROM ${table} WHERE id = $1`, [id]);
  }

  const crud = { readRaw, listRaw, listIds, writeRaw, deleteRaw };
  return softDelete ? { ...crud, listLiveIds, listTombstoneIdsBefore } : crud;
}
