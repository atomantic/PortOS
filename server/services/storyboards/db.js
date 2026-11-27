/**
 * PostgreSQL leaf I/O for storyboards. The full sanitized record lives in
 * `data` JSONB; name/universe_id/updated_at are mirrored for the list sort and
 * universe filter, and the tombstone pair keeps a later federation additive.
 *
 * Storage: `db-primary` — federated as record kind `storyboard` / category `storyboards`
 * (version-gated, whole-board LWW on `updatedAt`, tombstone deletes, gallery takes on the
 * push asset manifest). db-primary because productions link boards by id. Rows hold image
 * filenames and sketch keys, never bytes; `sketch:` sidecars and in-flight runs stay local.
 */

import { randomUUID } from 'node:crypto';
import { query } from '../../lib/db.js';
import { createJsonbLeafDb } from '../../lib/jsonbLeafDb.js';
import { sanitizeStoryboard, summarizeStoryboard } from '../../lib/storyboardRecord.js';

export const { readRaw, listRaw, listIds, listLiveIds, listTombstoneIdsBefore, writeRaw, deleteRaw } = createJsonbLeafDb({
  table: 'storyboards',
  orderBy: [['updated_at', 'DESC'], ['id', 'ASC']],
  softDelete: {},
  mirrorColumns: {
    name: record => record.name,
    universe_id: record => record.universeId ?? null,
    list_summary: { jsonb: summarizeStoryboard },
    list_summary_write_id: () => randomUUID(),
  },
});

async function readLiveSummaries({ limit, offset } = {}) {
  // A SQL NULL means the record was written without a summary. A JSON null
  // means the backfill found an invalid record that the list used to omit.
  const { rows } = await query(`SELECT list_summary, CASE WHEN list_summary IS NULL THEN data END AS legacy_data
    FROM storyboards WHERE deleted = FALSE ORDER BY updated_at DESC, id ASC${limit === undefined ? '' : ' LIMIT $1 OFFSET $2'}`,
  limit === undefined ? [] : [limit, offset]);
  return rows.map(({ list_summary, legacy_data }) => {
    if (list_summary) return list_summary;
    const board = sanitizeStoryboard(legacy_data);
    return board && summarizeStoryboard(board);
  }).filter(Boolean);
}

export const listSummaries = () => readLiveSummaries();

/** One live-board page (`LIMIT`/`OFFSET` in SQL, newest first) plus the live total. */
export async function listSummaryPage(page) {
  const [items, count] = await Promise.all([
    readLiveSummaries(page),
    query('SELECT COUNT(*)::int AS total FROM storyboards WHERE deleted = FALSE'),
  ]);
  return { items, total: count.rows[0].total };
}
