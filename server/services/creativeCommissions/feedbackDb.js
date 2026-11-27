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
import { createJsonbLeafDb } from '../../lib/jsonbLeafDb.js';

export const { readRaw, listRaw, listIds, writeRaw } = createJsonbLeafDb({
  table: 'commission_feedback',
  orderBy: [['created_at', 'ASC'], ['id', 'ASC']],
  softDelete: { includeDeletedByDefault: false, fillDeletedAt: true },
  mirrorColumns: {
    commission_id: record => typeof record?.commissionId === 'string' && record.commissionId ? record.commissionId : null,
    run_id: record => typeof record?.runId === 'string' && record.runId ? record.runId : null,
  },
});

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
