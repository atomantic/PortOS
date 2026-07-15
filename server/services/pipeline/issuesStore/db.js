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
 * `data` verbatim (the columns are a queryable mirror, never read back).
 */

import { query } from '../../../lib/db.js';
import { mirrorTimestamp } from '../../../lib/pgTimestamp.js';

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
export async function listRaw() {
  const { rows } = await query(`SELECT data FROM pipeline_issues`);
  return rows.map((r) => r.data);
}

/**
 * Raw `data` JSONB for one series only — uses the `idx_issues_series
 * (series_id, number)` index instead of scanning + sanitizing the whole table.
 * Returns live/ephemeral/tombstones (the service applies the `deleted` filter),
 * matching `listRaw`'s contract but scoped.
 */
export async function listRawBySeries(seriesId) {
  const { rows } = await query(`SELECT data FROM pipeline_issues WHERE series_id = $1`, [seriesId]);
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
