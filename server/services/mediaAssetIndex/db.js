/**
 * Media asset index — PostgreSQL row I/O + reconcile (#1000).
 *
 * Writes the `media_assets` table. This table is a DERIVED index over media
 * that lives on disk, so the write surface is small:
 *   - upsertAsset(row)         — index/refresh one asset (the live hook + reconcile)
 *   - removeAsset(mediaKey)    — drop one asset's row (delete hook, future slice)
 *   - reconcileMediaAssets()   — full sweep: upsert every on-disk asset, prune
 *                                rows whose backing file is gone. Idempotent and
 *                                cheap to re-run; called at boot.
 *   - listAssets(...)          — query helper (no consumer reads it for
 *                                correctness yet; here for the follow-up slices
 *                                that make collections/catalog resolve through it)
 *
 * The image + video disk readers are dynamically imported inside reconcile so
 * importing this module (e.g. for upsertAsset from a generation hook) never
 * pulls in the heavy media-gen stack, and so tests can run the SQL paths
 * without it.
 */

import { query } from '../../lib/db.js';
import { imageToRow, videoToRow } from './logic.js';

function rowToAsset(row) {
  if (!row) return null;
  // `data` already carries the full metadata record; return it verbatim so
  // consumers see the same shape the gallery/history gave.
  return row.data;
}

const UPSERT_CONFLICT = `ON CONFLICT (media_key) DO UPDATE SET
       kind = EXCLUDED.kind,
       ref = EXCLUDED.ref,
       data = EXCLUDED.data,
       created_at = EXCLUDED.created_at,
       indexed_at = NOW()`;

/** Upsert one index row. `row` is the shape produced by logic.js. */
export async function upsertAsset(row) {
  if (!row) return;
  await query(
    `INSERT INTO media_assets (media_key, kind, ref, data, created_at, indexed_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, NOW())
     ${UPSERT_CONFLICT}`,
    [row.mediaKey, row.kind, row.ref, JSON.stringify(row.data), row.createdAt],
  );
}

// Upsert many rows in chunked multi-row INSERTs so reconcile (which runs every
// boot over the whole gallery) is a handful of round-trips, not one-per-asset.
const UPSERT_CHUNK = 500;
async function upsertAssets(rows) {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    const values = [];
    const params = [];
    chunk.forEach((row, j) => {
      const b = j * 5;
      // NOW() for indexed_at is a literal, not a param.
      values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}::jsonb, $${b + 5}, NOW())`);
      params.push(row.mediaKey, row.kind, row.ref, JSON.stringify(row.data), row.createdAt);
    });
    await query(
      `INSERT INTO media_assets (media_key, kind, ref, data, created_at, indexed_at)
       VALUES ${values.join(', ')}
       ${UPSERT_CONFLICT}`,
      params,
    );
  }
}

/** Remove one index row by media_key. */
export async function removeAsset(mediaKey) {
  if (typeof mediaKey !== 'string' || !mediaKey) return;
  await query(`DELETE FROM media_assets WHERE media_key = $1`, [mediaKey]);
}

/** List index rows, newest first. Optional `kind` filter ('image' | 'video'). */
export async function listAssets({ kind } = {}) {
  const result = kind
    ? await query(`SELECT data FROM media_assets WHERE kind = $1 ORDER BY created_at DESC`, [kind])
    : await query(`SELECT data FROM media_assets ORDER BY created_at DESC`);
  return result.rows.map(rowToAsset);
}

/**
 * Full reconcile: make the index match what's on disk RIGHT NOW.
 *
 * 1. Read every image (gallery scan) + every video (history file).
 * 2. Upsert a row for each — refreshing metadata for any that changed.
 * 3. Prune index rows whose media_key is no longer on disk (deleted out-of-band,
 *    e.g. a file removed while the server was down, or by a path this slice
 *    doesn't hook yet). This is what keeps the derived index honest without a
 *    delete hook on every removal path.
 *
 * Idempotent: re-running with no disk changes is a no-op upsert per row + an
 * empty prune. Cheap enough to run unconditionally at boot.
 *
 * The disk readers are injected (defaulting to the real services) so tests can
 * drive reconcile without the media-gen stack.
 */
export async function reconcileMediaAssets(deps = {}) {
  const now = new Date().toISOString();
  const listGallery = deps.listGallery
    || (await import('../imageGen/local.js')).listGallery;
  const loadHistory = deps.loadHistory
    || (await import('../videoGen/local.js')).loadHistory;

  const [images, videos] = await Promise.all([
    listGallery().catch(() => []),
    loadHistory().catch(() => []),
  ]);

  const rows = [
    ...(Array.isArray(images) ? images : []).map((it) => imageToRow(it, { now })),
    ...(Array.isArray(videos) ? videos : []).map((v) => videoToRow(v, { now })),
  ].filter(Boolean);

  await upsertAssets(rows);

  // Prune: any row whose media_key isn't in the current on-disk set is stale.
  const liveKeys = rows.map((r) => r.mediaKey);
  let pruned = 0;
  if (liveKeys.length === 0) {
    // Nothing on disk → the whole index is stale.
    const res = await query(`DELETE FROM media_assets`);
    pruned = res.rowCount || 0;
  } else {
    const res = await query(
      `DELETE FROM media_assets WHERE media_key <> ALL($1::text[])`,
      [liveKeys],
    );
    pruned = res.rowCount || 0;
  }

  console.log(`🗂️  Media asset index reconciled: ${rows.length} on disk (${images.length || 0} img / ${videos.length || 0} vid), ${pruned} stale row(s) pruned`);
  return { ok: true, indexed: rows.length, pruned };
}
