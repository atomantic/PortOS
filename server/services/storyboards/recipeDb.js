/**
 * PostgreSQL leaf I/O for saved storyboard recipes (the Make tab's library).
 * The sanitized record lives in `data` JSONB; name/updated_at are mirrored for
 * the list sort, and the tombstone pair keeps a later federation additive.
 */

import { query } from '../../lib/db.js';
import { mirrorTimestamp } from '../../lib/pgTimestamp.js';
import { toPgJson } from '../../lib/pgJson.js';

export async function readRaw(id) {
  const { rows } = await query('SELECT data FROM storyboard_recipes WHERE id = $1', [id]);
  return rows[0]?.data ?? null;
}

export async function listRaw() {
  const { rows } = await query('SELECT data FROM storyboard_recipes ORDER BY updated_at DESC, id ASC');
  return rows.map((row) => row.data);
}

export async function writeRaw(id, record) {
  const now = new Date().toISOString();
  const createdAt = mirrorTimestamp(record?.createdAt, now);
  await query(
    `INSERT INTO storyboard_recipes (id, name, data, created_at, updated_at, deleted, deleted_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at,
       deleted = EXCLUDED.deleted,
       deleted_at = EXCLUDED.deleted_at`,
    [
      id,
      record.name,
      toPgJson(record),
      createdAt,
      mirrorTimestamp(record?.updatedAt, createdAt),
      record.deleted === true,
      mirrorTimestamp(record.deletedAt, null),
    ],
  );
  return record;
}
