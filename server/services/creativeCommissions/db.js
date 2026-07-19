/**
 * Creative Commission — PostgreSQL leaf I/O (#2657, Autonomous Creation Engine).
 *
 * One row per commission in `creative_commissions`: the full sanitized record
 * (brief / schedule / generation / feedback / runs[]) in `data` JSONB, with
 * id / name / enabled / created_at / updated_at mirrored into columns for the
 * scheduler's "arm every enabled commission" query. This is the DEFAULT backend
 * for real installs; the file backend (collectionStore) is a dev/test escape
 * hatch only (see store.js).
 *
 * INTENTIONALLY MACHINE-LOCAL — never federated (a synced schedule would
 * double-run on every peer). So there is NO sync_sequence and NO
 * deleted/deleted_at tombstone: `deleteRaw` is a hard delete, mirroring
 * tribe_people (ADR docs/decisions/2026-06-26-tribe-and-universe-runs-local.md).
 *
 * This module is PURE leaf I/O — no sanitizing, no serialization. The store
 * facade (store.js) owns the sanitizer + merge semantics AND serializes the
 * scheduler-vs-request read-modify-write on a shared per-id write queue
 * (`createRecordWriteQueue`, identical to universeBuilder/storyBuilder), so reads
 * here return `data` verbatim (the columns are a queryable mirror, never read
 * back) and writes are plain upserts.
 */

import { query } from '../../lib/db.js';
import { mirrorTimestamp } from '../../lib/pgTimestamp.js';

/** Raw stored record (the `data` JSONB), or null. Live only unless includeDeleted (#2686). */
export async function readRaw(id, { includeDeleted = false } = {}) {
  const { rows } = await query(
    includeDeleted
      ? `SELECT data FROM creative_commissions WHERE id = $1`
      : `SELECT data FROM creative_commissions WHERE id = $1 AND deleted = FALSE`,
    [id],
  );
  return rows[0]?.data ?? null;
}

/** Every commission's raw `data` JSONB, oldest first. Live only unless includeDeleted. */
export async function listRaw({ includeDeleted = false } = {}) {
  const { rows } = await query(
    includeDeleted
      ? `SELECT data FROM creative_commissions ORDER BY created_at ASC, id ASC`
      : `SELECT data FROM creative_commissions WHERE deleted = FALSE ORDER BY created_at ASC, id ASC`,
  );
  return rows.map((r) => r.data);
}

/** Every commission id — live only by default, or all (incl. tombstones) for the sweep. */
export async function listIds({ includeDeleted = false } = {}) {
  const { rows } = await query(
    includeDeleted
      ? `SELECT id FROM creative_commissions`
      : `SELECT id FROM creative_commissions WHERE deleted = FALSE`,
  );
  return rows.map((r) => r.id);
}

/**
 * Upsert one record. `data` is written verbatim (lossless); the typed mirror
 * columns are bind-sanitized so a hand-edited/legacy record with a malformed
 * timestamp can't make the write throw. `created_at` is preserved on conflict
 * (only the first INSERT sets it). The soft-delete pair (#2686) is mirrored into
 * columns for the sweep AND stays in `data` (the sanitizer round-trips it).
 */
export async function writeRaw(id, record) {
  const now = new Date().toISOString();
  const createdAt = mirrorTimestamp(record?.createdAt, now);
  const deleted = record?.deleted === true;
  const deletedAt = deleted ? mirrorTimestamp(record?.deletedAt, now) : null;
  await query(
    `INSERT INTO creative_commissions (id, name, enabled, data, created_at, updated_at, deleted, deleted_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       enabled = EXCLUDED.enabled,
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at,
       deleted = EXCLUDED.deleted,
       deleted_at = EXCLUDED.deleted_at`,
    [
      id,
      typeof record?.name === 'string' ? record.name : '',
      record?.enabled !== false,
      JSON.stringify(record),
      createdAt,
      mirrorTimestamp(record?.updatedAt, createdAt),
      deleted,
      deletedAt,
    ],
  );
  return record;
}

/** Hard-delete a record (used by the tombstone sweep). Idempotent — a missing row is a no-op. */
export async function deleteRaw(id) {
  await query(`DELETE FROM creative_commissions WHERE id = $1`, [id]);
}

/**
 * Ids eligible for pruneTombstoned, by the SAME `deleted_at` column predicate
 * the DELETE uses. The column is the backend's truth — writeRaw normalizes
 * malformed/out-of-range timestamps into it while preserving the JSON verbatim,
 * so an eligibility check against the raw JSON `deletedAt` can diverge from
 * what the DELETE would actually remove.
 */
export async function listPrunable(olderThanMs) {
  if (!Number.isFinite(olderThanMs)) return [];
  const cutoffIso = new Date(olderThanMs).toISOString();
  const { rows } = await query(
    `SELECT id FROM creative_commissions
     WHERE deleted = TRUE AND deleted_at IS NOT NULL AND deleted_at < $1`,
    [cutoffIso],
  );
  return rows.map((r) => r.id);
}

/** Hard-remove tombstoned commissions whose `deleted_at` is older than the cutoff; returns their ids. */
export async function pruneTombstoned(olderThanMs) {
  if (!Number.isFinite(olderThanMs)) return { pruned: 0, ids: [] };
  const cutoffIso = new Date(olderThanMs).toISOString();
  const { rows } = await query(
    `DELETE FROM creative_commissions
     WHERE deleted = TRUE AND deleted_at IS NOT NULL AND deleted_at < $1
     RETURNING id`,
    [cutoffIso],
  );
  const ids = rows.map((r) => r.id);
  return { pruned: ids.length, ids };
}
