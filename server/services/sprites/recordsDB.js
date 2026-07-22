/**
 * Sprites — PostgreSQL-backed record store (default backend).
 *
 * One row per sprite record in `sprite_records`: id / kind / status /
 * created_at / updated_at mirrored as columns, the full record in `data`
 * JSONB. Mutators run inside withTransaction + `SELECT … FOR UPDATE` so two
 * write paths against the same record serialize instead of losing an update.
 * Mutation semantics live in recordsLogic.js (shared with recordsFile.js) so
 * the two backends can't drift. Mirrors musicVideo/projectsDB.js — minus
 * federation (sprite records are machine-local in phase 1; the tombstone trio
 * is present so peer-sync later is additive).
 */

import { query, withTransaction } from '../../lib/db.js';
import { ServerError } from '../../lib/errorHandler.js';
import {
  buildSpriteRecord,
  applySpriteRecordPatch,
  mergeImportedRecord,
  mirrorTimestamp,
} from './recordsLogic.js';

function rowToRecord(row) {
  return row ? row.data : null;
}

async function persist(exec, record) {
  const now = new Date().toISOString();
  const createdAt = mirrorTimestamp(record.createdAt, now);
  await exec(
    `INSERT INTO sprite_records (id, kind, status, data, created_at, updated_at, deleted, deleted_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET
       kind = EXCLUDED.kind,
       status = EXCLUDED.status,
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at,
       deleted = EXCLUDED.deleted,
       deleted_at = EXCLUDED.deleted_at`,
    [
      record.id,
      record.kind,
      record.status,
      JSON.stringify(record),
      createdAt,
      mirrorTimestamp(record.updatedAt, createdAt),
      record.deleted === true,
      mirrorTimestamp(record.deletedAt, null),
    ],
  );
  return record;
}

export async function listRecords({ includeDeleted = false } = {}) {
  const result = includeDeleted
    ? await query(`SELECT data FROM sprite_records ORDER BY created_at ASC`)
    : await query(`SELECT data FROM sprite_records WHERE deleted = FALSE ORDER BY created_at ASC`);
  return result.rows.map(rowToRecord);
}

export async function getRecord(id, { includeDeleted = false } = {}) {
  const result = await query(`SELECT data FROM sprite_records WHERE id = $1`, [id]);
  const record = rowToRecord(result.rows[0]);
  if (!record) return null;
  return includeDeleted || !record.deleted ? record : null;
}

export async function createRecord(input, id) {
  return withTransaction(async (client) => {
    const sel = await client.query(`SELECT data FROM sprite_records WHERE id = $1 FOR UPDATE`, [id]);
    const existing = rowToRecord(sel.rows[0]);
    if (existing && !existing.deleted) {
      throw new ServerError(`Sprite record already exists: ${id}`, { status: 409, code: 'ALREADY_EXISTS' });
    }
    const now = new Date().toISOString();
    const record = buildSpriteRecord(input, { id, now });
    await persist(client.query.bind(client), record);
    console.log(`🎞️ Created sprite record: ${id} (${record.kind})`);
    return record;
  });
}

export async function updateRecord(id, patch) {
  return withTransaction(async (client) => {
    const sel = await client.query(`SELECT data FROM sprite_records WHERE id = $1 FOR UPDATE`, [id]);
    const record = rowToRecord(sel.rows[0]);
    if (!record || record.deleted) throw new ServerError('Sprite record not found', { status: 404, code: 'NOT_FOUND' });
    const next = applySpriteRecordPatch(record, patch);
    await persist(client.query.bind(client), next);
    return next;
  });
}

export async function deleteRecord(id) {
  return withTransaction(async (client) => {
    const sel = await client.query(`SELECT data FROM sprite_records WHERE id = $1 FOR UPDATE`, [id]);
    const record = rowToRecord(sel.rows[0]);
    if (!record || record.deleted) throw new ServerError('Sprite record not found', { status: 404, code: 'NOT_FOUND' });
    const now = new Date().toISOString();
    await persist(client.query.bind(client), { ...record, deleted: true, deletedAt: now, updatedAt: now });
    return { ok: true };
  });
}

/** Importer upsert — create or refresh a record from a source-tree import. */
export async function upsertImportedRecord(id, input) {
  return withTransaction(async (client) => {
    const sel = await client.query(`SELECT data FROM sprite_records WHERE id = $1 FOR UPDATE`, [id]);
    const existing = rowToRecord(sel.rows[0]);
    const now = new Date().toISOString();
    const imported = buildSpriteRecord(input, { id, now });
    const next = mergeImportedRecord(existing, imported, now);
    await persist(client.query.bind(client), next);
    return next;
  });
}
