/**
 * PostgreSQL leaf I/O for FableLoom records. The full sanitized record lives
 * in JSONB; name/universe_id/series_id/updated_at are mirrored for the common
 * list/filter paths; delete markers are mirrored for federated tombstone GC.
 */

import { query } from '../../lib/db.js';
import { mirrorTimestamp } from '../../lib/pgTimestamp.js';

export async function readRaw(id) {
  const { rows } = await query('SELECT data FROM fableloom_stories WHERE id = $1', [id]);
  return rows[0]?.data ?? null;
}

export async function listRaw() {
  const { rows } = await query('SELECT data FROM fableloom_stories ORDER BY updated_at DESC, id ASC');
  return rows.map((row) => row.data);
}

export async function writeRaw(id, record) {
  const now = new Date().toISOString();
  const createdAt = mirrorTimestamp(record?.createdAt, now);
  const updatedAt = mirrorTimestamp(record?.updatedAt, createdAt);
  await query(
    `INSERT INTO fableloom_stories (id, name, universe_id, series_id, data, created_at, updated_at, deleted, deleted_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       universe_id = EXCLUDED.universe_id,
       series_id = EXCLUDED.series_id,
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at,
       deleted = EXCLUDED.deleted,
       deleted_at = EXCLUDED.deleted_at`,
    [
      id,
      record.name,
      record.universeId ?? null,
      record.seriesId ?? null,
      JSON.stringify(record),
      createdAt,
      updatedAt,
      record.deleted === true,
      mirrorTimestamp(record.deletedAt, null),
    ],
  );
  return record;
}

export async function deleteRaw(id) {
  await query('DELETE FROM fableloom_stories WHERE id = $1', [id]);
}
