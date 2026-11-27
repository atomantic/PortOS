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
import { mirrorTimestamp } from '../../lib/pgTimestamp.js';
import { toPgJson } from '../../lib/pgJson.js';
import { sanitizeStoryboard, summarizeStoryboard } from '../../lib/storyboardRecord.js';

export async function readRaw(id) {
  const { rows } = await query('SELECT data FROM storyboards WHERE id = $1', [id]);
  return rows[0]?.data ?? null;
}

export async function listRaw() {
  const { rows } = await query('SELECT data FROM storyboards ORDER BY updated_at DESC, id ASC');
  return rows.map((row) => row.data);
}

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

export async function writeRaw(id, record) {
  const now = new Date().toISOString();
  const createdAt = mirrorTimestamp(record?.createdAt, now);
  await query(
    `INSERT INTO storyboards (id, name, universe_id, data, created_at, updated_at, deleted, deleted_at, list_summary, list_summary_write_id)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9::jsonb, $10)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       universe_id = EXCLUDED.universe_id,
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at,
       deleted = EXCLUDED.deleted,
       deleted_at = EXCLUDED.deleted_at,
       list_summary = EXCLUDED.list_summary,
       list_summary_write_id = EXCLUDED.list_summary_write_id`,
    [
      id,
      record.name,
      record.universeId ?? null,
      toPgJson(record),
      createdAt,
      mirrorTimestamp(record?.updatedAt, createdAt),
      record.deleted === true,
      mirrorTimestamp(record.deletedAt, null),
      toPgJson(summarizeStoryboard(record)),
      randomUUID(),
    ],
  );
  return record;
}

export async function deleteRaw(id) {
  await query('DELETE FROM storyboards WHERE id = $1', [id]);
}

/** Every board id (live AND tombstones). */
export async function listIds() {
  const { rows } = await query('SELECT id FROM storyboards');
  return rows.map((row) => row.id);
}

/** Live board ids only — id-only projection. */
export async function listLiveIds() {
  const { rows } = await query('SELECT id FROM storyboards WHERE deleted = FALSE');
  return rows.map((row) => row.id);
}

/** Tombstoned board ids deleted before `beforeMs` — the GC candidate scan. */
export async function listTombstoneIdsBefore(beforeMs) {
  const { rows } = await query(
    'SELECT id FROM storyboards WHERE deleted = TRUE AND deleted_at IS NOT NULL AND deleted_at < $1',
    [new Date(beforeMs).toISOString()],
  );
  return rows.map((row) => row.id);
}
