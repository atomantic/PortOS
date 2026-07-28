/**
 * PostgreSQL leaf I/O for Game records. The full sanitized record is stored in
 * JSONB; app_id/name/updated_at are mirrored for the common list/filter paths.
 */

import { query } from '../../lib/db.js';
import { mirrorTimestamp } from '../../lib/pgTimestamp.js';

export async function readRaw(id) {
  const { rows } = await query('SELECT data FROM games WHERE id = $1', [id]);
  return rows[0]?.data ?? null;
}

export async function listRaw() {
  const { rows } = await query('SELECT data FROM games ORDER BY updated_at DESC, id ASC');
  return rows.map((row) => row.data);
}

export async function writeRaw(id, record) {
  const now = new Date().toISOString();
  const createdAt = mirrorTimestamp(record?.createdAt, now);
  const updatedAt = mirrorTimestamp(record?.updatedAt, createdAt);
  await query(
    `INSERT INTO games (id, app_id, name, data, created_at, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       app_id = EXCLUDED.app_id,
       name = EXCLUDED.name,
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at`,
    [id, record.appId, record.name, JSON.stringify(record), createdAt, updatedAt],
  );
  return record;
}

export async function deleteRaw(id) {
  await query('DELETE FROM games WHERE id = $1', [id]);
}
