/**
 * Media asset index — PostgreSQL row I/O + reconcile (#1000).
 *
 * Writes the `media_assets` table. This table is a DERIVED index over media
 * that lives on disk, so the write surface is small:
 *   - upsertAsset(row)         — index/refresh one asset (the live hook + reconcile)
 *   - removeAsset(mediaKey)    — drop one asset's row. Driven by the live delete
 *                                hooks (index.js unindexImage/unindexVideo), so a
 *                                row dies with its file rather than lingering
 *                                until the next boot (#2738).
 *   - reconcileMediaAssets()   — full sweep: upsert every on-disk asset, prune
 *                                rows whose backing file is gone. Idempotent and
 *                                cheap to re-run; called at boot. Still the
 *                                backstop for OUT-OF-BAND removals (a file
 *                                deleted off-disk never runs a delete hook).
 *   - listAssets(...)          — bounded gallery reads; legacy callers may
 *                                still request an unbounded array
 *
 * The image + video disk readers are dynamically imported inside reconcile so
 * importing this module (e.g. for upsertAsset from a generation hook) never
 * pulls in the heavy media-gen stack, and so tests can run the SQL paths
 * without it.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { query } from '../../lib/db.js';
import { dedupeByKey } from '../../lib/arrayUtils.js';
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
  // Collapse duplicate media_keys BEFORE chunking (see `dedupeByKey` for why a
  // multi-row upsert cannot carry a repeated conflict key). Untreated, one throw
  // aborted the WHOLE reconcile — a single duplicated gallery filename or
  // repeated video-history id froze the entire index and turned boot's
  // catalog-migration step red. Disk is the authority and it can honestly hand
  // us the same ref twice (a re-appended history entry, a filename two scans
  // both list); that is data to absorb, not an error to propagate.
  const deduped = dedupeByKey(rows, (row) => row.mediaKey);
  for (let i = 0; i < deduped.length; i += UPSERT_CHUNK) {
    const chunk = deduped.slice(i, i + UPSERT_CHUNK);
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
  return deduped.length;
}

/** Remove one index row by media_key. */
export async function removeAsset(mediaKey) {
  if (typeof mediaKey !== 'string' || !mediaKey) return;
  await query(`DELETE FROM media_assets WHERE media_key = $1`, [mediaKey]);
}

// Parameters stay bound, including literal substring search (percent and underscore
// in a prompt are not SQL wildcards). Count and page share exactly one predicate.
function assetFilter({ kind, q = '', hidden, filename, mediaKeys, excludeKeys, universeId, entryCategory, entryKind, cover } = {}) {
  const params = [];
  const clauses = [];
  if (kind) { params.push(kind); clauses.push(`kind = $${params.length}`); }
  if (hidden !== undefined) {
    clauses.push(hidden ? `data->>'hidden' = 'true'` : `COALESCE(data->>'hidden', 'false') <> 'true'`);
  }
  if (filename !== undefined) {
    params.push(filename);
    clauses.push(`(ref = $${params.length} OR data->>'filename' = $${params.length})`);
  }
  if (mediaKeys !== undefined) {
    params.push(mediaKeys);
    clauses.push(`media_key = ANY($${params.length}::text[])`);
  }
  if (excludeKeys !== undefined) {
    params.push(excludeKeys);
    clauses.push(`NOT (media_key = ANY($${params.length}::text[]))`);
  }
  for (const [field, value] of Object.entries({ universeId, entryCategory, entryKind })) {
    if (value !== undefined) {
      params.push(value);
      clauses.push(`data->>'${field}' = $${params.length}`);
    }
  }
  if (cover) clauses.push("(kind = 'image' OR NULLIF(data->>'thumbnail', '') IS NOT NULL)");
  for (const token of q.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    params.push(token);
    clauses.push(`strpos(lower(concat_ws(' ', data::text, kind,
      (data->>'width') || 'x' || (data->>'height'),
      CASE WHEN data->>'extractedFromVideoId' IS NOT NULL THEN 'extracted frame' END,
      CASE WHEN data->>'stitchedFrom' IS NOT NULL THEN 'stitched' END,
      CASE WHEN data->>'upscaledFrom' IS NOT NULL THEN 'upscaled 2x' END)), $${params.length}) > 0`);
  }
  return { params, where: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '' };
}

// Videos stay authoritative in video-history: prompt/visibility edits and uploads
// do not all refresh the derived index. Mixed pages join that snapshot in SQL,
// rather than using stale video rows or downloading either full list to the client.
function assetSource(params, videos) {
  if (videos === undefined) return { cte: '', table: 'media_assets' };
  params.push(JSON.stringify(videos.map(data => ({ data, createdAt: Number.isFinite(Date.parse(data.createdAt)) ? new Date(data.createdAt).toISOString() : new Date(0).toISOString() }))));
  return {
    cte: `WITH gallery_assets AS (
      SELECT media_key, kind, ref, data, created_at FROM media_assets WHERE kind = 'image'
      UNION ALL
      SELECT 'video:' || (value->'data'->>'id'), 'video', value->'data'->>'id', value->'data',
        (value->>'createdAt')::timestamptz
      FROM jsonb_array_elements($${params.length}::jsonb)
    ) `,
    table: 'gallery_assets',
  };
}

/** List index rows. Omitting limit retains the legacy array contract. */
export async function listAssets({ limit, offset = 0, videos, typed = false, orderedKeys, ...filters } = {}) {
  const { params, where } = assetFilter(filters);
  const { cte, table } = assetSource(params, videos);
  let order = 'created_at DESC, media_key ASC';
  if (orderedKeys) {
    params.push(orderedKeys);
    order = `array_position($${params.length}::text[], media_key), media_key ASC`;
  }
  let paging = '';
  if (limit !== undefined) {
    params.push(limit, offset);
    paging = ` LIMIT $${params.length - 1} OFFSET $${params.length}`;
  }
  const result = await query(
    `${cte}SELECT ${typed ? 'kind, ' : ''}data FROM ${table}${where} ORDER BY ${order}${paging}`, params,
  );
  return result.rows.map(row => typed ? { kind: row.kind, data: row.data } : rowToAsset(row));
}

/** Count matching rows without materializing their JSONB payloads. */
export async function countAssets({ videos, ...filters } = {}) {
  const { params, where } = assetFilter(filters);
  const { cte, table } = assetSource(params, videos);
  const result = await query(`${cte}SELECT COUNT(*) AS count FROM ${table}${where}`, params);
  return parseInt(result.rows[0].count, 10);
}

/** Compact global picker options, independent of the loaded page/search. */
export async function galleryFacets() {
  const fields = ['universeId', 'universeName', 'entryCategory', 'entryKind'];
  const result = await query(`SELECT DISTINCT ${fields.map(field =>
    `CASE WHEN jsonb_typeof(data->'${field}') = 'string' THEN data->>'${field}' END AS "${field}"`).join(', ')}
    FROM media_assets WHERE kind = 'image' AND COALESCE(data->>'hidden', 'false') <> 'true'`);
  return result.rows;
}

// Strict video-history reader for reconcile. The live store's loadHistory()
// (readJSONFile w/ [] default) intentionally collapses a MISSING file AND a
// corrupt/unreadable one to [] — fine for the live store, but catastrophic for
// reconcile's prune: "corrupt history" would look like "no videos exist" and
// wipe every video row whose file is still on disk. This reader distinguishes
// the two: file absent → genuinely empty (ok); present-but-unparseable → failure
// (not ok), so the caller skips pruning videos. Returns { ok, list }.
export async function readVideoHistoryStrict(historyPath) {
  // Only reconcile needs filesystem paths; indexed list reads do not. Keep the
  // facade specifier so existing test path overrides still intercept it.
  historyPath ??= join((await import('../../lib/fileUtils.js')).PATHS.data, 'video-history.json');
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
 *    sentinel rule from AGENTS.md — failed-read ≠ legitimately-empty.)
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

  // Rows WRITTEN, which is below the rows read when disk repeated a ref.
  const indexed = await upsertAssets([...imageRows, ...videoRows]);

  // Per-kind prune, gated on a successful read for that kind. Pruning one kind
  // never touches the other's rows (an image-read failure can't wipe videos).
  let pruned = 0;
  if (imageRead.ok) pruned += await pruneKind('image', imageRows.map((r) => r.mediaKey));
  if (videoRead.ok) pruned += await pruneKind('video', videoRows.map((r) => r.mediaKey));

  const skipped = [!imageRead.ok && 'images', !videoRead.ok && 'videos'].filter(Boolean);
  const skipNote = skipped.length ? ` — SKIPPED prune for ${skipped.join('+')} (disk read failed)` : '';
  console.log(`🗂️  Media asset index reconciled: ${imageRows.length} img / ${videoRows.length} vid on disk, ${pruned} stale row(s) pruned${skipNote}`);
  return { ok: true, indexed, pruned, skippedPrune: skipped };
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
