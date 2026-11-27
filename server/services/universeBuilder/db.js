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
 *
 * Storage: `db-primary` — `universes` federate via the `dataSync` snapshot/push model
 * (LWW on `updatedAt`, no `sync_sequence`); the store's mutation epoch feeds the dataSync
 * fingerprint because DB writes no longer touch `data/universes/`. `universe_runs` is
 * never federated. The built-in Reality universe is seeded by a migration gated on the id's
 * absence (tombstone included), not `data.reference/`, so a user delete is never undone.
 */

import { query, withTransaction } from '../../lib/db.js';
import { createJsonbLeafDb } from '../../lib/jsonbLeafDb.js';
import { LOGLINE_MAX } from '../../lib/universeBibleLimits.js';
import { mirrorTimestamp } from '../../lib/pgTimestamp.js';
import { toPgJson } from '../../lib/pgJson.js';

export const { readRaw, listRaw, listIds, listLiveIds, listTombstoneIdsBefore, writeRaw, deleteRaw } = createJsonbLeafDb({
  table: 'universes',
  softDelete: {},
  mirrorColumns: {
    name: record => typeof record?.name === 'string' ? record.name : '',
    schema_version: record => Number.isInteger(record?.schemaVersion) ? record.schemaVersion : 5,
    ephemeral: record => record?.ephemeral === true,
  },
});

// Keep the runs[] log bounded to the most-recent 200 — matches the file
// backend's cap (universeBuilder.recordRun) so behavior is identical.
const RUN_CAP = 200;

// --- Universe records ---

/**
 * Live universes projected down to `{ id, name }`, unordered — the rows behind
 * `listUniverseNames`, for pickers that need a label and nothing else.
 *
 * Same reasoning as `listStyles` below and `countUniverses` further down: both
 * columns are exact mirrors of the JSONB (every `writeRaw` binds them from the
 * same record), and `deleted = FALSE` hits the `idx_universes_live` partial
 * index. Skips the bibles, the composite sheets, the whole `universe_runs`
 * table, and the per-record sanitize that make `listUniverses()` a
 * multi-megabyte read.
 */
export async function listNames() {
  const { rows } = await query(
    `SELECT id, name, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt" FROM universes WHERE deleted = FALSE`,
  );
  return rows;
}

/**
 * Index projection. Only legacy canon layouts need the full sanitizer to fold
 * category variations into canon; ordinary records return counts, not arrays.
 */
export async function listSummaries() {
  const { rows } = await query(
    `SELECT id, name,
            data->>'logline' AS logline,
            left(btrim(data->>'starterPrompt'), $1) AS "starterPrompt",
            data->'origin' AS origin,
            (data->>'factual')::boolean AS factual,
            data->>'createdAt' AS "createdAt",
            data->>'updatedAt' AS "updatedAt",
            data->'styleImageRefs'->>-1 AS "styleImageRef",
            (CASE WHEN jsonb_typeof(data->'characters') = 'array' THEN jsonb_array_length(data->'characters') ELSE 0 END
             + CASE WHEN jsonb_typeof(data->'places') = 'array' THEN jsonb_array_length(data->'places') ELSE 0 END
             + CASE WHEN jsonb_typeof(data->'objects') = 'array' THEN jsonb_array_length(data->'objects') ELSE 0 END) AS "canonCount",
            CASE WHEN (CASE WHEN jsonb_typeof(data->'schemaVersion') = 'number'
                            THEN (data->>'schemaVersion')::numeric < 4 ELSE TRUE END)
                      OR EXISTS (
                        SELECT 1 FROM jsonb_object_keys(
                          CASE WHEN jsonb_typeof(data->'categories') = 'object' THEN data->'categories' ELSE '{}'::jsonb END
                        ) AS category(key)
                        WHERE key ~* '^[^a-z0-9]*characters?([^a-z0-9]|$)'
                      )
                 THEN jsonb_set(data, '{starterPrompt}', to_jsonb(left(btrim(COALESCE(data->>'starterPrompt', '')), $1)))
                 ELSE NULL END AS "legacyRecord"
       FROM universes WHERE deleted = FALSE`,
    [LOGLINE_MAX],
  );
  return rows;
}

/**
 * Live universes projected down to the style-bearing fields, unordered — the
 * raw input `listUniverseStyles` derives its token lists from. See that
 * function for what the projection is for and which fields feed it.
 *
 * `deleted = FALSE` on the mirror column, for the same reasons spelled out on
 * `countUniverses` below (exact mirror of the JSONB flag, and the form
 * `idx_universes_live` can serve). `name` reads the mirror column too — every
 * `writeRaw` binds it from the same `record.name` that lands in `data`.
 * Ordering is the service's job so both backends can't drift on it.
 */
export async function listStyles() {
  const { rows } = await query(
    `SELECT id, name,
            data->'influences' AS influences,
            data->'visualProfile' AS "visualProfile",
            data->>'stylePrompt' AS "stylePrompt",
            data->>'negativePrompt' AS "negativePrompt",
            data->>'createdAt' AS "createdAt"
       FROM universes
      WHERE deleted = FALSE`,
  );
  return rows;
}

/**
 * Cheap live-universe tally (#2729) — the count listUniverses().length used to
 * pay for by materializing every JSONB record AND the whole run history.
 *
 * Reads the `deleted` MIRROR COLUMN, not the JSONB flag listUniverses filters
 * on. Those cannot disagree: every write path derives both from the same
 * `record` in the same statement with the same predicate — `writeRaw` above and
 * the one-time file import (`server/scripts/migrateUniversesToDB.js`) each bind
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
 * `deleted = FALSE` (not `IS NOT TRUE`) is intentional on both counts: it is the
 * form the partial index can serve, and it matches every sibling live-set query
 * (tribe.js, catalogRefResolver.js, catalogDB/shared.js). The column is nullable
 * (`BOOLEAN DEFAULT FALSE`), so the two forms differ on a NULL — but neither
 * writer can produce one (both always bind a boolean; a column-omitting INSERT
 * takes the FALSE default), so the distinction is unreachable.
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
        toPgJson(run),
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
