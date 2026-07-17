/**
 * Creative Commission feedback — PostgreSQL leaf I/O (#2686, split-record
 * federation).
 *
 * One row per reaction in `commission_feedback`: the full sanitized record
 * (commissionId / runId / rating / note / tags / at) in `data` JSONB, with
 * commission_id / run_id / created_at / updated_at / deleted / deleted_at
 * mirrored into columns for the per-commission hydration query and the
 * federation sweep. This is the DEFAULT backend for real installs; the file
 * backend (collectionStore) is a dev/test escape hatch only (see feedbackStore.js).
 *
 * FEDERATED (unlike the parent commission, which stays machine-local): the
 * `deleted`/`deleted_at` tombstone columns carry a soft-delete so a removal
 * propagates without an out-of-date peer resurrecting it (the LWW merge never
 * propagates a hard delete). `data` mirrors the soft-delete pair so a tombstone
 * round-trips through the sanitizer.
 *
 * PURE leaf I/O — no sanitizing, no serialization, no LWW policy. The store
 * facade (feedbackStore.js) owns the sanitizer + merge decision (via the pure
 * feedbackLogic.js) and serializes writes on a per-id queue, so reads here return
 * `data` verbatim (the columns are a queryable mirror, never read back) and
 * writes are plain upserts.
 */

import { query } from '../../lib/db.js';
import { mirrorTimestamp } from '../../lib/pgTimestamp.js';

/** Raw stored record (the `data` JSONB), or null. Live only unless includeDeleted. */
export async function readRaw(id, { includeDeleted = false } = {}) {
  const { rows } = await query(
    includeDeleted
      ? `SELECT data FROM commission_feedback WHERE id = $1`
      : `SELECT data FROM commission_feedback WHERE id = $1 AND deleted = FALSE`,
    [id],
  );
  return rows[0]?.data ?? null;
}

/** Every LIVE feedback record's raw `data` JSONB, oldest reaction first. */
export async function listRaw() {
  const { rows } = await query(
    `SELECT data FROM commission_feedback WHERE deleted = FALSE ORDER BY created_at ASC, id ASC`,
  );
  return rows.map((r) => r.data);
}

/** Every LIVE feedback record for one commission, oldest reaction first. */
export async function listRawByCommission(commissionId) {
  const { rows } = await query(
    `SELECT data FROM commission_feedback
     WHERE commission_id = $1 AND deleted = FALSE
     ORDER BY created_at ASC, id ASC`,
    [commissionId],
  );
  return rows.map((r) => r.data);
}

/** Every feedback id — live only by default, or all (incl. tombstones) when asked. */
export async function listIds({ includeDeleted = false } = {}) {
  const { rows } = await query(
    includeDeleted
      ? `SELECT id FROM commission_feedback`
      : `SELECT id FROM commission_feedback WHERE deleted = FALSE`,
  );
  return rows.map((r) => r.id);
}

/**
 * Upsert one feedback record. `data` is written verbatim (lossless); the typed
 * mirror columns are bind-sanitized. `created_at` is preserved on conflict (only
 * the first INSERT sets it), so a re-rating (deterministic id) keeps the original
 * creation moment while `updated_at`/`data` reflect the new reaction.
 */
export async function writeRaw(id, record) {
  const now = new Date().toISOString();
  const createdAt = mirrorTimestamp(record?.createdAt, now);
  const deleted = record?.deleted === true;
  const deletedAt = deleted ? mirrorTimestamp(record?.deletedAt, now) : null;
  await query(
    `INSERT INTO commission_feedback (id, commission_id, run_id, data, created_at, updated_at, deleted, deleted_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET
       commission_id = EXCLUDED.commission_id,
       run_id = EXCLUDED.run_id,
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at,
       deleted = EXCLUDED.deleted,
       deleted_at = EXCLUDED.deleted_at`,
    [
      id,
      typeof record?.commissionId === 'string' && record.commissionId ? record.commissionId : null,
      typeof record?.runId === 'string' && record.runId ? record.runId : null,
      JSON.stringify(record),
      createdAt,
      mirrorTimestamp(record?.updatedAt, createdAt),
      deleted,
      deletedAt,
    ],
  );
  return record;
}

/** Hard-remove tombstoned rows whose `deleted_at` is older than the cutoff; returns their ids. */
export async function pruneTombstoned(olderThanMs) {
  if (!Number.isFinite(olderThanMs)) return { pruned: 0, ids: [] };
  const cutoffIso = new Date(olderThanMs).toISOString();
  const { rows } = await query(
    `DELETE FROM commission_feedback
     WHERE deleted = TRUE AND deleted_at IS NOT NULL AND deleted_at < $1
     RETURNING id`,
    [cutoffIso],
  );
  const ids = rows.map((r) => r.id);
  return { pruned: ids.length, ids };
}
