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
 * This module is PURE leaf I/O — no sanitizing, no serialization. The store
 * facade (store.js) owns the sanitizer + merge semantics AND serializes the
 * scheduler-vs-request read-modify-write on a shared per-id write queue
 * (`createRecordWriteQueue`, identical to universeBuilder/storyBuilder), so reads
 * here return `data` verbatim (the columns are a queryable mirror, never read
 * back) and writes are plain upserts.
 *
 * Storage: `db-primary` — the brief/identity federates as `creativeCommission` so synced
 * `commissionFeedback` attaches to the same commission; schedule, runs, assignment,
 * enabled and feedback view stay machine-local so a schedule never double-runs. Raw
 * taste sources and per-run recipes never cross the wire.
 */

import { query } from '../../lib/db.js';
import { createJsonbLeafDb } from '../../lib/jsonbLeafDb.js';

const leaf = createJsonbLeafDb({
  table: 'creative_commissions',
  orderBy: [['created_at', 'ASC'], ['id', 'ASC']],
  softDelete: { includeDeletedByDefault: false, fillDeletedAt: true },
  mirrorColumns: {
    name: record => typeof record?.name === 'string' ? record.name : '',
    enabled: record => record?.enabled !== false,
  },
});

export const { readRaw, listRaw, listIds, writeRaw, deleteRaw } = leaf;

/** One live page (oldest first, `LIMIT`/`OFFSET` in SQL) plus the live total. */
export async function listRawPage({ limit, offset }) {
  const [page, count] = await Promise.all([
    query('SELECT data FROM creative_commissions WHERE deleted = FALSE ORDER BY created_at ASC, id ASC LIMIT $1 OFFSET $2', [limit, offset]),
    query('SELECT COUNT(*)::int AS total FROM creative_commissions WHERE deleted = FALSE'),
  ]);
  return { rows: page.rows.map((r) => r.data), total: count.rows[0].total };
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
  return leaf.listTombstoneIdsBefore(olderThanMs);
}

/** Whether ONE id currently satisfies the prune predicate (same column truth as listPrunable). */
export async function isPrunable(id, olderThanMs) {
  if (!Number.isFinite(olderThanMs)) return false;
  const cutoffIso = new Date(olderThanMs).toISOString();
  const { rows } = await query(
    `SELECT 1 FROM creative_commissions
     WHERE id = $1 AND deleted = TRUE AND deleted_at IS NOT NULL AND deleted_at < $2`,
    [id, cutoffIso],
  );
  return rows.length > 0;
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
