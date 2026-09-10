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

/** Every loom id (live AND tombstones) — the service filters. */
export async function listIds() {
  const { rows } = await query('SELECT id FROM fableloom_stories');
  return rows.map((row) => row.id);
}

/**
 * Live (non-deleted) loom ids only — id-only projection hitting
 * idx_fableloom_live. Backs tombstoneGc's LIVE_ID_LISTERS (the base-hash
 * orphan sweep), so a record stops protecting its base hash the moment it's
 * tombstoned without the sweep ever reading a loom's JSONB body.
 */
export async function listLiveIds() {
  const { rows } = await query('SELECT id FROM fableloom_stories WHERE deleted = FALSE');
  return rows.map((row) => row.id);
}

/**
 * Tombstoned loom ids whose deletedAt is older than `beforeMs` (epoch ms) —
 * the GC candidate scan for `pruneTombstonedLooms`. An id-only projection:
 * the sweep almost never finds a tombstone, so the common case must not pay
 * for a single loom's JSONB body, let alone every one of them.
 */
export async function listTombstoneIdsBefore(beforeMs) {
  const cutoffIso = new Date(beforeMs).toISOString();
  const { rows } = await query(
    'SELECT id FROM fableloom_stories WHERE deleted = TRUE AND deleted_at IS NOT NULL AND deleted_at < $1',
    [cutoffIso],
  );
  return rows.map((row) => row.id);
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
