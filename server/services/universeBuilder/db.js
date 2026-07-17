/**
 * Universe Builder — PostgreSQL leaf I/O (#1014).
 *
 * One row per universe in `universes`: the full sanitized record (canon bibles,
 * categories, compositeSheets, locks, influences) in `data` JSONB, with
 * name / schema_version / ephemeral / updated_at / deleted / deleted_at mirrored
 * into columns for the queries the service + federation actually run (rename
 * cascade, delete-guard, list sort, snapshot ephemeral-filter, LWW staleness).
 * Render-history runs live one-row-per-run in `universe_runs` (local-only,
 * capped at 200, never federated). Non-federation is a deliberate decision, not
 * an oversight: runs are a regenerable render cache under a 200-row GLOBAL cap
 * (trimmed in `appendRun`) that two peers would mutually evict, and the durable
 * universe record already federates. See ADR
 * docs/decisions/2026-06-26-tribe-and-universe-runs-local.md (#1724).
 *
 * This module is PURE leaf I/O — no in-process serialization, no sanitizing.
 * The store facade (store.js) owns the per-id write queue + the mutation epoch
 * and applies `sanitizeTemplate` on read, so reads here return `data` verbatim
 * (the columns are a queryable mirror, never read back). The facade serializes
 * the run RMWs, so the run ops here are single atomic statements/transactions.
 */

import { query, withTransaction } from '../../lib/db.js';
import { mirrorTimestamp } from '../../lib/pgTimestamp.js';

// Keep the runs[] log bounded to the most-recent 200 — matches the file
// backend's cap (universeBuilder.recordRun) so behavior is identical.
const RUN_CAP = 200;

// --- Universe records ---

/** Raw on-disk-equivalent record (the `data` JSONB), or null. No sanitize. */
export async function readRaw(id) {
  const { rows } = await query(`SELECT data FROM universes WHERE id = $1`, [id]);
  return rows[0]?.data ?? null;
}

/** Every universe id (live, ephemeral, AND tombstones) — the service filters. */
export async function listIds() {
  const { rows } = await query(`SELECT id FROM universes`);
  return rows.map((r) => r.id);
}

/**
 * Every record's raw `data` JSONB in one query (live/ephemeral/tombstones).
 * The bulk read behind listUniverses — one SELECT instead of N per-id reads.
 */
export async function listRaw() {
  const { rows } = await query(`SELECT data FROM universes`);
  return rows.map((r) => r.data);
}

/**
 * Cheap live-universe tally (#2729) — the count listUniverses().length used to
 * pay for by materializing every JSONB record AND the whole run history.
 *
 * Reads the `deleted` MIRROR COLUMN, not the JSONB flag listUniverses filters
 * on. Those cannot disagree: every write path derives both from the same
 * `record` in the same statement with the same predicate — `writeRaw` above and
 * the one-time file import (`scripts/migrateUniversesToDB.js`) each bind
 * `record.deleted === true` into the column, and the sanitizer the service
 * filters on (`sanitizeSoftDeleteFields`, lib/syncWire.js) computes
 * `raw?.deleted === true` off the same field. There is no third writer, and no
 * UPDATE that touches `deleted` without rewriting `data`. So the column is an
 * exact mirror, and `WHERE deleted = FALSE` also hits the `idx_universes_live`
 * partial index that exists for precisely this "live set" scan.
 *
 * Deliberately does NOT filter `ephemeral` — listUniverses() counts ephemeral
 * universes too (it filters ONLY on `deleted`), so filtering here would
 * undercount.
 *
 * Known boundary: a row whose `data` can't survive `sanitizeTemplate` (blank
 * `name`, non-string `id`) is dropped by listUniverses's `.filter(Boolean)` but
 * still counted here. Unreachable through the service — create/update/sync all
 * sanitize before writing — and only a corrupt legacy record imported verbatim
 * could hit it. Replicating the sanitizer's drop rules in SQL would couple this
 * count to sanitizeTemplate's internals and silently drift when they change;
 * a ±1 on an already-corrupt record is not worth that. The file backend's
 * counterpart (store.js) has the same semantics, so the two agree.
 */
export async function countUniverses({ includeDeleted = false } = {}) {
  const { rows } = includeDeleted
    ? await query(`SELECT COUNT(*) AS count FROM universes`)
    : await query(`SELECT COUNT(*) AS count FROM universes WHERE deleted = FALSE`);
  return parseInt(rows[0].count, 10);
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
  const schemaVersion = Number.isInteger(record?.schemaVersion) ? record.schemaVersion : 4;
  await query(
    `INSERT INTO universes (id, name, data, schema_version, ephemeral, created_at, updated_at, deleted, deleted_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       data = EXCLUDED.data,
       schema_version = EXCLUDED.schema_version,
       ephemeral = EXCLUDED.ephemeral,
       updated_at = EXCLUDED.updated_at,
       deleted = EXCLUDED.deleted,
       deleted_at = EXCLUDED.deleted_at`,
    [
      id,
      typeof record?.name === 'string' ? record.name : '',
      JSON.stringify(record),
      schemaVersion,
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
  await query(`DELETE FROM universes WHERE id = $1`, [id]);
}

// --- Render-history runs (local-only) ---

/** Runs (newest first), optionally scoped to one universe. Returns `data` verbatim. */
export async function loadRuns(universeId = null) {
  const { rows } = universeId
    ? await query(
        `SELECT data FROM universe_runs WHERE universe_id = $1 ORDER BY created_at DESC, id DESC`,
        [universeId],
      )
    : await query(`SELECT data FROM universe_runs ORDER BY created_at DESC, id DESC`);
  return rows.map((r) => r.data);
}

/**
 * Append one run + trim the global log back to the most-recent RUN_CAP. Runs
 * in a transaction so a concurrent read never sees the over-cap intermediate.
 */
export async function appendRun(run) {
  await withTransaction(async (client) => {
    const exec = client.query.bind(client);
    await exec(
      `INSERT INTO universe_runs (id, universe_id, collection_id, data, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (id) DO NOTHING`,
      [
        run.id,
        run.universeId,
        typeof run.collectionId === 'string' ? run.collectionId : null,
        JSON.stringify(run),
        mirrorTimestamp(run.createdAt, new Date().toISOString()),
      ],
    );
    // Trim to the newest RUN_CAP across ALL universes (matches the file
    // backend's whole-array cap, not a per-universe cap).
    await exec(
      `DELETE FROM universe_runs WHERE id IN (
         SELECT id FROM universe_runs ORDER BY created_at DESC, id DESC OFFSET $1
       )`,
      [RUN_CAP],
    );
  });
}

/** Drop every run referencing any of `universeIds` (cascade on universe delete). */
export async function removeRunsForUniverses(universeIds) {
  const ids = Array.isArray(universeIds) ? universeIds.filter((x) => typeof x === 'string' && x) : [];
  if (ids.length === 0) return;
  await query(`DELETE FROM universe_runs WHERE universe_id = ANY($1::text[])`, [ids]);
}
