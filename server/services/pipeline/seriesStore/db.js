/**
 * Pipeline series — PostgreSQL leaf I/O (#1015).
 *
 * One row per series in `pipeline_series`: the full sanitized record
 * (arc, seasons[], locks, covers, style notes) in `data` JSONB, with
 * name / universe_id / writers_room_work_id / ephemeral / updated_at /
 * deleted / deleted_at mirrored into columns for the queries the service +
 * federation actually run (rename cascade, universe delete-guard, "series in
 * this universe" lists, snapshot ephemeral-filter, LWW staleness, the
 * writers-room promote back-link).
 *
 * PURE leaf I/O — no in-process serialization, no sanitizing. The store facade
 * (store.js) owns the per-id write queue + the mutation epoch and applies
 * `sanitizeSeries` on read, so reads here return `data` verbatim (the columns
 * are a queryable mirror, never read back).
 *
 * The series' `manuscript-review.json` sibling doc is `file-primary` and does
 * NOT live here — it stays on disk under data/pipeline-series/{id}/ (see
 * manuscriptReview.js); only the series record itself moved to PG.
 */

import { query } from '../../../lib/db.js';
import { mirrorTimestamp } from '../../../lib/pgTimestamp.js';

/** Raw on-disk-equivalent record (the `data` JSONB), or null. No sanitize. */
export async function readRaw(id) {
  const { rows } = await query(`SELECT data FROM pipeline_series WHERE id = $1`, [id]);
  return rows[0]?.data ?? null;
}

/** Every series id (live, ephemeral, AND tombstones) — the service filters. */
export async function listIds() {
  const { rows } = await query(`SELECT id FROM pipeline_series`);
  return rows.map((r) => r.id);
}

/** Every record's raw `data` JSONB in one query (live/ephemeral/tombstones). */
export async function listRaw() {
  const { rows } = await query(`SELECT data FROM pipeline_series`);
  return rows.map((r) => r.data);
}

/**
 * Upsert one record. `data` is written verbatim (lossless); the typed mirror
 * columns are bind-sanitized so a hand-edited/legacy record with a malformed
 * timestamp or missing field can't make the write throw (which, during the boot
 * warm/import, would block the whole backend). `created_at` is preserved on
 * conflict — only the first INSERT sets it.
 */
export async function writeRaw(id, record) {
  const now = new Date().toISOString();
  const createdAt = mirrorTimestamp(record?.createdAt, now);
  await query(
    `INSERT INTO pipeline_series (id, name, universe_id, writers_room_work_id, data, ephemeral, created_at, updated_at, deleted, deleted_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       universe_id = EXCLUDED.universe_id,
       writers_room_work_id = EXCLUDED.writers_room_work_id,
       data = EXCLUDED.data,
       ephemeral = EXCLUDED.ephemeral,
       updated_at = EXCLUDED.updated_at,
       deleted = EXCLUDED.deleted,
       deleted_at = EXCLUDED.deleted_at`,
    [
      id,
      typeof record?.name === 'string' ? record.name : '',
      typeof record?.universeId === 'string' && record.universeId ? record.universeId : null,
      typeof record?.writersRoomWorkId === 'string' && record.writersRoomWorkId ? record.writersRoomWorkId : null,
      JSON.stringify(record),
      record?.ephemeral === true,
      createdAt,
      mirrorTimestamp(record?.updatedAt, createdAt),
      record?.deleted === true,
      mirrorTimestamp(record?.deletedAt, null),
    ],
  );
  return record;
}

/** Hard-delete a record (tombstone GC). Idempotent — missing row is a no-op. */
export async function deleteRaw(id) {
  await query(`DELETE FROM pipeline_series WHERE id = $1`, [id]);
}
