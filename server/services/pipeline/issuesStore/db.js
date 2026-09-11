/**
 * Pipeline issues — PostgreSQL leaf I/O (#1015).
 *
 * One row per issue in `pipeline_issues`: the full sanitized record in `data`
 * JSONB, including the entire 8-stage `stages` map (text/visual/audio,
 * runHistory, canonExtraction, covers) and the stage `lastRunId` string
 * pointers into data/runs/<runId>/ (NOT migrating — file-backed transcripts).
 * series_id / season_id / number / status / ephemeral / updated_at / deleted /
 * deleted_at are mirrored into columns for the renumber pass (the hot
 * `idx_issues_series (series_id, number)` query), review dashboards, the
 * snapshot ephemeral-filter, and LWW staleness.
 *
 * PURE leaf I/O — the store facade owns serialization + sanitize; reads return
 * full `data` verbatim by default, or explicit lean/summary projections.
 */

import { query } from '../../../lib/db.js';
import { mirrorTimestamp } from '../../../lib/pgTimestamp.js';
import { PIPELINE_STAGE_IDS } from '../../../lib/pipelineStages.js';

// Only trusted, closed stage IDs form SQL paths. PostgreSQL removes history
// before serializing JSONB for Node; every other field remains lossless.
// A malformed stage is left for the sanitizer, never traversed as a JSON array.
const LEAN_DATA = PIPELINE_STAGE_IDS.reduce(
  (sql, stageId) => `${sql} #- CASE
    WHEN jsonb_typeof(data->'stages'->'${stageId}') = 'object'
    THEN '{stages,${stageId},runHistory}'::text[] ELSE '{}'::text[] END`, 'data',
);

/** Raw on-disk-equivalent record (the `data` JSONB), or null. No sanitize. */
export async function readRaw(id) {
  const { rows } = await query(`SELECT data FROM pipeline_issues WHERE id = $1`, [id]);
  return rows[0]?.data ?? null;
}

/**
 * Issue ids only — SELECT id, never the `data` JSONB (each issue can carry up to
 * ~12MB of stage runHistory, so an id sweep that loaded `data` would move the
 * whole table into memory just to read the ids, #2540). Default returns every
 * id (live, ephemeral, AND tombstones) — the "the service filters" contract the
 * facade relies on. `includeDeleted: false` scopes to non-tombstoned rows via
 * the mirrored `deleted` column so a live-membership sweep (tombstoneGc) skips
 * the whole-record load entirely.
 */
export async function listIds({ includeDeleted = true } = {}) {
  const { rows } = includeDeleted
    ? await query(`SELECT id FROM pipeline_issues`)
    : await query(`SELECT id FROM pipeline_issues WHERE deleted = false`);
  return rows.map((r) => r.id);
}

/** Every record's raw `data` JSONB in one query (live/ephemeral/tombstones). */
export async function listRaw({ withHistory = true } = {}) {
  const { rows } = await query(`SELECT ${withHistory ? 'data' : LEAN_DATA} AS data FROM pipeline_issues`);
  return rows.map((r) => r.data);
}

/**
 * Raw `data` JSONB for one series only — uses the `idx_issues_series
 * (series_id, number)` index instead of scanning + sanitizing the whole table.
 * Returns live/ephemeral/tombstones (the service applies the `deleted` filter),
 * matching `listRaw`'s contract but scoped.
 */
export async function listRawBySeries(seriesId, { withHistory = true } = {}) {
  const { rows } = await query(`SELECT ${withHistory ? 'data' : LEAN_DATA} AS data FROM pipeline_issues WHERE series_id = $1`, [seriesId]);
  return rows.map((r) => r.data);
}

/**
 * Raw `data` JSONB for several series in one indexed query. Callers that need
 * an uncapped cross-series scan use this instead of loading the whole table or
 * issuing one query per series.
 */
export async function listRawBySeriesIds(seriesIds, { withHistory = true } = {}) {
  if (seriesIds.length === 0) return [];
  const { rows } = await query(
    `SELECT ${withHistory ? 'data' : LEAN_DATA} AS data FROM pipeline_issues WHERE series_id = ANY($1::text[])`,
    [seriesIds],
  );
  return rows.map((r) => r.data);
}

/**
 * Limit in PostgreSQL before transferring records. Summary reads extract only
 * the recent HTTP endpoint's fields; title has no mirrored column.
 */
export async function listRecentRaw({ limit, withHistory = true, includeDeleted = false, summary = false }) {
  const projection = summary
    ? "jsonb_build_object('id', id, 'title', data->'title', 'number', number, 'seriesId', series_id, 'updatedAt', data->'updatedAt', 'createdAt', data->'createdAt')"
    : withHistory ? 'data' : LEAN_DATA;
  const { rows } = await query(
    `SELECT ${projection} AS data FROM pipeline_issues
     ${includeDeleted ? '' : 'WHERE deleted IS NOT TRUE'}
     ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => r.data);
}

/**
 * Upsert one record. `data` is written verbatim (lossless); the typed mirror
 * columns are bind-sanitized so a hand-edited/legacy record can't make the
 * write throw. `created_at` preserved on conflict.
 */
export async function writeRaw(id, record) {
  const now = new Date().toISOString();
  const createdAt = mirrorTimestamp(record?.createdAt, now);
  await query(
    `INSERT INTO pipeline_issues (id, series_id, season_id, number, status, data, ephemeral, created_at, updated_at, deleted, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)
     ON CONFLICT (id) DO UPDATE SET
       series_id = EXCLUDED.series_id,
       season_id = EXCLUDED.season_id,
       number = EXCLUDED.number,
       status = EXCLUDED.status,
       data = EXCLUDED.data,
       ephemeral = EXCLUDED.ephemeral,
       updated_at = EXCLUDED.updated_at,
       deleted = EXCLUDED.deleted,
       deleted_at = EXCLUDED.deleted_at`,
    [
      id,
      typeof record?.seriesId === 'string' ? record.seriesId : '',
      typeof record?.seasonId === 'string' && record.seasonId ? record.seasonId : null,
      Number.isFinite(record?.number) ? Math.floor(record.number) : null,
      typeof record?.status === 'string' && record.status ? record.status.slice(0, 32) : null,
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
  await query(`DELETE FROM pipeline_issues WHERE id = $1`, [id]);
}
