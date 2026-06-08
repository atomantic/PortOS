/**
 * Story Builder sessions — PostgreSQL leaf I/O (#1016).
 *
 * One row per session in `story_builder_sessions`: the full sanitized record
 * (the `steps` lock/integrity map, `syncedHashes` baseline, `currentStep`,
 * `llm` picker choice, `origin`, tombstone fields) in `data` JSONB, with
 * universe_id / series_id / sync / ephemeral / updated_at / deleted / deleted_at
 * mirrored into columns for the queries the service + federation actually run
 * (sessions-for-a-record lookups, the OPT-IN sync snapshot filter, LWW
 * staleness, tombstone GC).
 *
 * PURE leaf I/O — no in-process serialization, no sanitizing. The store facade
 * (store.js) owns the per-id write queue + the mutation epoch and applies
 * `sanitizeSession` on read, so reads here return `data` verbatim (the columns
 * are a queryable mirror, never read back).
 */

import { query } from '../../lib/db.js';
import { mirrorTimestamp } from '../../lib/pgTimestamp.js';

/** Raw on-disk-equivalent record (the `data` JSONB), or null. No sanitize. */
export async function readRaw(id) {
  const { rows } = await query(`SELECT data FROM story_builder_sessions WHERE id = $1`, [id]);
  return rows[0]?.data ?? null;
}

/** Every session id (live, ephemeral, AND tombstones) — the service filters. */
export async function listIds() {
  const { rows } = await query(`SELECT id FROM story_builder_sessions`);
  return rows.map((r) => r.id);
}

/** Every record's raw `data` JSONB in one query (live/ephemeral/tombstones). */
export async function listRaw() {
  const { rows } = await query(`SELECT data FROM story_builder_sessions`);
  return rows.map((r) => r.data);
}

/**
 * Upsert one record. `data` is written verbatim (lossless); the typed mirror
 * columns are bind-sanitized so a hand-edited/legacy/peer-sourced record with a
 * malformed timestamp or missing field can't make the write throw (which, during
 * the boot warm/import, would block the whole backend). `created_at` is
 * preserved on conflict — only the first INSERT sets it.
 */
export async function writeRaw(id, record) {
  const now = new Date().toISOString();
  const createdAt = mirrorTimestamp(record?.createdAt, now);
  await query(
    `INSERT INTO story_builder_sessions (id, universe_id, series_id, sync, data, ephemeral, created_at, updated_at, deleted, deleted_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO UPDATE SET
       universe_id = EXCLUDED.universe_id,
       series_id = EXCLUDED.series_id,
       sync = EXCLUDED.sync,
       data = EXCLUDED.data,
       ephemeral = EXCLUDED.ephemeral,
       updated_at = EXCLUDED.updated_at,
       deleted = EXCLUDED.deleted,
       deleted_at = EXCLUDED.deleted_at`,
    [
      id,
      typeof record?.universeId === 'string' && record.universeId ? record.universeId : null,
      typeof record?.seriesId === 'string' && record.seriesId ? record.seriesId : null,
      record?.sync === true,
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
  await query(`DELETE FROM story_builder_sessions WHERE id = $1`, [id]);
}
