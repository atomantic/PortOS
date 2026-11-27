/**
 * Pipeline series — PostgreSQL leaf I/O (#1015).
 *
 * One row per series in `pipeline_series`: the full sanitized record
 * (arc, seasons[], locks, covers, style notes) in `data` JSONB, with
 * name / universe_id / writers_room_work_id / ephemeral / updated_at /
 * deleted / deleted_at mirrored into columns for the queries the service +
 * federation actually run (rename cascade, universe delete-guard, "series in
 * this universe" lists, snapshot ephemeral-filter, LWW staleness, the
 * writers-room promote back-link).
 *
 * PURE leaf I/O — no in-process serialization, no sanitizing. The store facade
 * (store.js) owns the per-id write queue + the mutation epoch and applies
 * `sanitizeSeries` on read, so reads here return `data` verbatim (the columns
 * are a queryable mirror, never read back).
 *
 * The series' `manuscript-review.json` sibling doc is `file-primary` and does
 * NOT live here — it stays on disk under data/pipeline-series/{id}/ (see
 * manuscriptReview.js); only the series record itself moved to PG.
 */

import { query } from '../../../lib/db.js';
import { createJsonbLeafDb } from '../../../lib/jsonbLeafDb.js';

export const { readRaw, listRaw, listIds, listLiveIds, listTombstoneIdsBefore, writeRaw, deleteRaw } = createJsonbLeafDb({
  table: 'pipeline_series',
  softDelete: {},
  mirrorColumns: {
    name: record => typeof record?.name === 'string' ? record.name : '',
    universe_id: record => typeof record?.universeId === 'string' && record.universeId ? record.universeId : null,
    writers_room_work_id: record => typeof record?.writersRoomWorkId === 'string' && record.writersRoomWorkId ? record.writersRoomWorkId : null,
    ephemeral: record => record?.ephemeral === true,
  },
});

/** Names and ordering only: no JSONB body is read for sidebar navigation. */
export async function listNames() {
  const { rows } = await query(
    `SELECT id, name, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"
       FROM pipeline_series WHERE deleted = FALSE`,
  );
  return rows;
}

/** Fields used by index rows and universe-scoped pickers, without arc/seasons. */
export async function listSummaries() {
  const { rows } = await query(
    `SELECT id, name, universe_id AS "universeId",
            data->>'logline' AS logline, data->>'coverImage' AS "coverImage",
            data->'origin' AS origin, data->'issueCountTarget' AS "issueCountTarget",
            jsonb_build_object('shape', data->'arc'->'shape') AS arc,
            data->>'createdAt' AS "createdAt", data->>'updatedAt' AS "updatedAt"
       FROM pipeline_series WHERE deleted = FALSE`,
  );
  return rows;
}
