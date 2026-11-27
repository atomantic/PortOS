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
import { createJsonbLeafDb } from '../../../lib/jsonbLeafDb.js';
import { PIPELINE_STAGE_IDS } from '../../../lib/pipelineStages.js';

const leaf = createJsonbLeafDb({
  table: 'pipeline_issues',
  softDelete: {},
  mirrorColumns: {
    series_id: record => typeof record?.seriesId === 'string' ? record.seriesId : '',
    season_id: record => typeof record?.seasonId === 'string' && record.seasonId ? record.seasonId : null,
    number: record => Number.isFinite(record?.number) ? Math.floor(record.number) : null,
    status: record => typeof record?.status === 'string' && record.status ? record.status.slice(0, 32) : null,
    ephemeral: record => record?.ephemeral === true,
  },
});

export const { readRaw, listIds, listTombstoneIdsBefore, writeRaw, deleteRaw } = leaf;

// Only trusted, closed stage IDs form SQL paths. PostgreSQL removes history
// before serializing JSONB for Node; every other field remains lossless.
// A malformed stage is left for the sanitizer, never traversed as a JSON array.
const LEAN_DATA = PIPELINE_STAGE_IDS.reduce(
  (sql, stageId) => `${sql} #- CASE
    WHEN jsonb_typeof(data->'stages'->'${stageId}') = 'object'
    THEN '{stages,${stageId},runHistory}'::text[] ELSE '{}'::text[] END`, 'data',
);

/** Global id conflict check for imports. A missing row has no deletion status. */
export async function getDeletionStatus(id) {
  const { rows } = await query('SELECT deleted FROM pipeline_issues WHERE id = $1', [id]);
  return rows[0]?.deleted ?? null;
}

// Include tombstones: a winning remote revision may resurrect one in another series.
export async function listSeriesIdsForIssues(ids) {
  const { rows } = await query('SELECT DISTINCT series_id FROM pipeline_issues WHERE id = ANY($1::text[])', [ids]);
  return rows.map((row) => row.series_id);
}

export async function listLiveIssueSeriesIds() {
  const { rows } = await query('SELECT DISTINCT series_id FROM pipeline_issues WHERE deleted = FALSE');
  return rows.map((r) => r.series_id);
}

const OLD_TOMBSTONE = 'deleted = TRUE AND deleted_at IS NOT NULL AND deleted_at < $1';

// Check the mirrored columns again in the delete itself so resurrection or a
// newer tombstone between the candidate scan and the queued prune wins.
export async function deleteTombstonesBefore(ids, beforeMs) {
  const { rows } = await query(
    `DELETE FROM pipeline_issues WHERE ${OLD_TOMBSTONE} AND id = ANY($2::text[]) RETURNING id`,
    [new Date(beforeMs), ids],
  );
  return rows.map((r) => r.id);
}

/** Every record's raw `data` JSONB in one query (live/ephemeral/tombstones). */
export async function listRaw({ withHistory = true } = {}) {
  if (withHistory) return leaf.listRaw();
  const { rows } = await query(`SELECT ${LEAN_DATA} AS data FROM pipeline_issues`);
  return rows.map((r) => r.data);
}

/**
 * Raw `data` JSONB for one series only — can use the unfiltered
 * `idx_issues_series_all (series_id, number)` index.
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
