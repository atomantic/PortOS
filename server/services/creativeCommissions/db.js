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

/** Raw stored record (the `data` JSONB), or null. No sanitize. */
export async function readRaw(id) {
  const { rows } = await query(`SELECT data FROM creative_commissions WHERE id = $1`, [id]);
  return rows[0]?.data ?? null;
}

/** Every commission's raw `data` JSONB, oldest first (stable create order). */
export async function listRaw() {
  const { rows } = await query(`SELECT data FROM creative_commissions ORDER BY created_at ASC, id ASC`);
  return rows.map((r) => r.data);
}

/**
 * Upsert one record. `data` is written verbatim (lossless); the typed mirror
 * columns are bind-sanitized so a hand-edited/legacy record with a malformed
 * timestamp can't make the write throw. `created_at` is preserved on conflict
 * (only the first INSERT sets it).
 */
export async function writeRaw(id, record) {
  const now = new Date().toISOString();
  const createdAt = mirrorTimestamp(record?.createdAt, now);
  await query(
    `INSERT INTO creative_commissions (id, name, enabled, data, created_at, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       enabled = EXCLUDED.enabled,
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at`,
    [
      id,
      typeof record?.name === 'string' ? record.name : '',
      record?.enabled !== false,
      JSON.stringify(record),
      createdAt,
      mirrorTimestamp(record?.updatedAt, createdAt),
    ],
  );
  return record;
}

/** Hard-delete a record. Idempotent — a missing row is a no-op. */
export async function deleteRaw(id) {
  await query(`DELETE FROM creative_commissions WHERE id = $1`, [id]);
}
