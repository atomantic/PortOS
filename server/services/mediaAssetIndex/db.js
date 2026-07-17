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

import { readFile } from 'fs/promises';
import { join } from 'path';
import { query } from '../../lib/db.js';
import { PATHS } from '../../lib/fileUtils.js';
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
 * Count index rows. Optional `kind` filter ('image' | 'video').
 *
 * Use this over `listAssets().length` when only the tally is wanted: listAssets selects and
 * JSON-parses the full payload of every rendered image and video, which is a lot of work to
 * throw away for one number (the character skill registry reads this on every
 * `GET /api/character`).
 */
export async function countAssets({ kind } = {}) {
  const result = kind
    ? await query(`SELECT COUNT(*) AS count FROM media_assets WHERE kind = $1`, [kind])
    : await query(`SELECT COUNT(*) AS count FROM media_assets`);
  return parseInt(result.rows[0].count, 10);
}

// Strict video-history reader for reconcile. The live store's loadHistory()
// (readJSONFile w/ [] default) intentionally collapses a MISSING file AND a
// corrupt/unreadable one to [] — fine for the live store, but catastrophic for
// reconcile's prune: "corrupt history" would look like "no videos exist" and
// wipe every video row whose file is still on disk. This reader distinguishes
// the two: file absent → genuinely empty (ok); present-but-unparseable → failure
// (not ok), so the caller skips pruning videos. Returns { ok, list }.
export async function readVideoHistoryStrict(historyPath = join(PATHS.data, 'video-history.json')) {
  // Read with explicit error-code handling — NOT tryReadFile/readJSONFile, which
  // both collapse "missing" and "unreadable" to the same value. Only a genuine
  // ENOENT (file never written) counts as trusted-empty; an EACCES/EIO/transient
  // failure must be a non-ok read so the caller skips pruning videos.
  let raw;
  try {
    raw = await readFile(historyPath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, list: [] }; // never written → no videos yet
    return { ok: false, list: [] }; // unreadable → do NOT treat as empty
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, list: [] }; // corrupt → do NOT treat as empty
  }
  if (!Array.isArray(parsed)) return { ok: false, list: [] };
  return { ok: true, list: parsed };
}

// Wrap a reader so a thrown error becomes { ok:false } rather than a trusted
// empty list (the listGallery path throws on real I/O errors like EACCES/EIO).
async function readListStrict(fn) {
  const list = await fn().catch(() => null);
  if (!Array.isArray(list)) return { ok: false, list: [] };
  return { ok: true, list };
}

/**
 * Full reconcile: make the index match what's on disk RIGHT NOW.
 *
 * 1. Read every image (gallery scan) + every video (history file).
 * 2. Upsert a row for each — refreshing metadata for any that changed.
 * 3. Prune index rows whose media_key is no longer on disk — but ONLY for a
 *    kind whose disk read provably SUCCEEDED. A transient read failure (a
 *    throwing gallery scan, a corrupt video-history.json) must NOT be mistaken
 *    for "nothing on disk" and wipe live rows whose files still exist; in that
 *    case we upsert what we did read and skip pruning that kind, leaving the
 *    existing rows until a later clean reconcile. (This is the absent-vs-empty
 *    sentinel rule from CLAUDE.md — failed-read ≠ legitimately-empty.)
 *
 * Idempotent: re-running with no disk changes is a no-op upsert + empty prune.
 * Cheap enough to run unconditionally at boot.
 *
 * The disk readers are injected (defaulting to the real services) so tests can
 * drive reconcile without the media-gen stack. Both injected and default
 * readers go through the same strict failure-vs-empty wrapper, so a throwing
 * reader uniformly skips that kind's prune rather than wiping it.
 */
export async function reconcileMediaAssets(deps = {}) {
  const now = new Date().toISOString();

  const imageRead = await readListStrict(
    deps.listGallery || (await import('../imageGen/local.js')).listGallery,
  );
  // The video default path needs the file-level missing-vs-corrupt distinction
  // (loadHistory collapses both to []); an injected reader returns an array, so
  // readListStrict suffices for it.
  const videoRead = deps.loadHistory
    ? await readListStrict(deps.loadHistory)
    : await readVideoHistoryStrict();

  const imageRows = (Array.isArray(imageRead.list) ? imageRead.list : [])
    .map((it) => imageToRow(it, { now })).filter(Boolean);
  const videoRows = (Array.isArray(videoRead.list) ? videoRead.list : [])
    .map((v) => videoToRow(v, { now })).filter(Boolean);

  await upsertAssets([...imageRows, ...videoRows]);

  // Per-kind prune, gated on a successful read for that kind. Pruning one kind
  // never touches the other's rows (an image-read failure can't wipe videos).
  let pruned = 0;
  if (imageRead.ok) pruned += await pruneKind('image', imageRows.map((r) => r.mediaKey));
  if (videoRead.ok) pruned += await pruneKind('video', videoRows.map((r) => r.mediaKey));

  const skipped = [!imageRead.ok && 'images', !videoRead.ok && 'videos'].filter(Boolean);
  const skipNote = skipped.length ? ` — SKIPPED prune for ${skipped.join('+')} (disk read failed)` : '';
  console.log(`🗂️  Media asset index reconciled: ${imageRows.length} img / ${videoRows.length} vid on disk, ${pruned} stale row(s) pruned${skipNote}`);
  return { ok: true, indexed: imageRows.length + videoRows.length, pruned, skippedPrune: skipped };
}

// Delete index rows of `kind` whose media_key isn't in `liveKeys`. An empty
// liveKeys set legitimately means "this kind has no assets on disk" — safe to
// prune all of that kind — but the CALLER only reaches here when the read for
// that kind succeeded, so empty is trustworthy.
async function pruneKind(kind, liveKeys) {
  const res = liveKeys.length === 0
    ? await query(`DELETE FROM media_assets WHERE kind = $1`, [kind])
    : await query(
      `DELETE FROM media_assets WHERE kind = $1 AND media_key <> ALL($2::text[])`,
      [kind, liveKeys],
    );
  return res.rowCount || 0;
}
