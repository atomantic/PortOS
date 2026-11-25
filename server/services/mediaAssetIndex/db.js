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
 * Storage: `asset-file-db-indexed` — machine-local, never federated: each install
 * rebuilds it from its own disk, so there is no sync cursor or tombstone. Image
 * sidecars and `video-history.json` stay authoritative; rows are a derived mirror
 * keyed `image:<filename>` / `video:<jobId>`. Snapshot dumps exclude the rows, and
 * a database restore rebuilds them from local files before releasing recovery.
 *
 * The image + video disk readers are dynamically imported inside reconcile so
 * importing this module (e.g. for upsertAsset from a generation hook) never
 * pulls in the heavy media-gen stack, and so tests can run the SQL paths
 * without it.
 */

import { readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { GALLERY_IMAGE_EXTENSIONS, isSafeFilename } from '../../lib/pathSafety.js';
import { sidecarPathForImage } from '../../lib/assetHash.js';
import { query, withTransaction } from '../../lib/db.js';
import { dedupeByKey } from '../../lib/arrayUtils.js';
import { createFileWriteQueue } from '../../lib/fileWriteQueue.js';

// Queue the complete source-read → mirror-write flow, not merely SQL, so an
// old completion hook cannot overwrite a restore's newer reconstruction.
export const queueMediaIndexRefresh = createFileWriteQueue();
import {
  imageToRow, videoToRow, compactSource, compactSourceToRow, recordSearchText,
  COMPACT_SOURCE_FIELDS, COMPACT_PREVIEW_KEY, COMPACT_PROMPT_CHARS,
} from './logic.js';
import { toPgJson } from '../../lib/pgJson.js';

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
       provenance_refs = EXCLUDED.provenance_refs,
       created_at = EXCLUDED.created_at,
       indexed_at = NOW()`;

// A boot reconcile re-reads every asset and almost none changed, so leave those rows
// alone. Only the bulk sweep may skip: its prune spares every key it upserted, while
// a live single-row write must refresh indexed_at so a concurrent prune spares it.
const ROW_COLUMNS = ['kind', 'ref', 'data', 'provenance_refs', 'created_at'];
const UPSERT_CHANGED = `${UPSERT_CONFLICT}
     WHERE (${ROW_COLUMNS.map((column) => `media_assets.${column}`).join(', ')})
       IS DISTINCT FROM (${ROW_COLUMNS.map((column) => `EXCLUDED.${column}`).join(', ')})`;

/** Upsert one index row. `row` is the shape produced by logic.js. */
export async function upsertAsset(row) {
  if (!row) return;
  await query(
    `INSERT INTO media_assets (media_key, kind, ref, data, provenance_refs, created_at, indexed_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::text[], $6, NOW())
     ${UPSERT_CONFLICT}`,
    [row.mediaKey, row.kind, row.ref, toPgJson(row.data), row.provenanceRefs ?? [], row.createdAt],
  );
}

// Upsert many rows in chunked multi-row INSERTs so reconcile (which runs every
// boot over the whole gallery) is a handful of round-trips, not one-per-asset.
const UPSERT_CHUNK = 500;
async function upsertAssets(rows, runQuery = query) {
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
      const b = j * 6;
      // NOW() for indexed_at is a literal, not a param.
      values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}::jsonb, $${b + 5}::text[], $${b + 6}, NOW())`);
      params.push(row.mediaKey, row.kind, row.ref, toPgJson(row.data), row.provenanceRefs ?? [], row.createdAt);
    });
    await runQuery(
      `INSERT INTO media_assets (media_key, kind, ref, data, provenance_refs, created_at, indexed_at)
       VALUES ${values.join(', ')}
       ${UPSERT_CHANGED}`,
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

const searchTokens = q => String(q ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);

// Predicates that read the stored read columns (schema/media.js) and mean the
// same thing to every consumer of one request, so a multi-aggregate reader can
// run them once per row at the source. Tokens are literal substrings (percent
// and underscore in a prompt are not SQL wildcards) of `search_text`, which
// already holds the lower-cased record text and its derived words.
function sharedClauses({ q = '', universeId, entryCategory, entryKind } = {}, params) {
  const clauses = [];
  for (const [column, value] of [['universe_id', universeId], ['entry_category', entryCategory], ['entry_kind', entryKind]]) {
    if (value !== undefined) {
      params.push(value);
      clauses.push(`${column} = $${params.length}`);
    }
  }
  for (const token of searchTokens(q)) {
    params.push(token);
    clauses.push(`strpos(search_text, $${params.length}) > 0`);
  }
  return clauses;
}

// Parameters stay bound. Count and page share exactly one predicate. `shared:
// false` leaves out sharedClauses() for a caller that applied them at the source.
function assetFilter({ kind, hidden, filename, cleanedFrom, mediaKeys, excludeKeys, cover, ...rest } = {}, params = [], { shared = true } = {}) {
  const clauses = [];
  if (kind) { params.push(kind); clauses.push(`kind = $${params.length}`); }
  if (hidden !== undefined) clauses.push(hidden ? 'is_hidden' : 'NOT is_hidden');
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
  // `cleanedFrom` is the variant-lineage reverse lookup: given an original
  // filename it returns every cleaned/regenerated/de-watermarked copy that
  // points back at it.
  if (cleanedFrom !== undefined) {
    params.push(cleanedFrom);
    clauses.push(`data->>'cleanedFrom' = $${params.length}`);
  }
  if (cover) clauses.push("(kind = 'image' OR NULLIF(data->>'thumbnail', '') IS NOT NULL)");
  if (shared) clauses.push(...sharedClauses(rest, params));
  return clauses;
}

const whereOf = clauses => clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';

// The characters String.prototype.trim() removes, as a regex bracket body, so
// the SQL "non-blank prompt" test agrees with logic.js (an all-whitespace
// prompt falls back to metadata.prompt in both).
const JS_TRIM_CLASS = String.raw`\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff`;
const SOURCE_KEYS = COMPACT_SOURCE_FIELDS.map(field => `'${field}'`).join(', ');

/**
 * SQL twin of logic.js compactSource() for an indexed record, in one pass over
 * its keys so the stored JSONB is decoded once: present keys only (an explicit
 * JSON null survives, an absent key stays absent) plus the bounded preview
 * source — prompt, else metadata.prompt. left() counts code points, never
 * fewer than the UTF-16 units the JS preview cuts at, so the final preview is
 * identical to one cut from the full prompt. Index rows are always objects
 * (logic.js imageToRow), which jsonb_each requires.
 */
function compactSourceSql(column) {
  const preview = (key, json) => `min(left(${json} #>> '{}', ${COMPACT_PROMPT_CHARS + 1})) FILTER (WHERE field.key = '${key}'
      AND jsonb_typeof(${json}) = 'string' AND (${json} #>> '{}') ~ '[^${JS_TRIM_CLASS}]')`;
  return `(SELECT COALESCE(jsonb_object_agg(field.key, field.value) FILTER (WHERE field.key IN (${SOURCE_KEYS})), '{}'::jsonb)
      || jsonb_strip_nulls(jsonb_build_object('${COMPACT_PREVIEW_KEY}',
        COALESCE(${preview('prompt', 'field.value')}, ${preview('metadata', "(field.value -> 'prompt')")})))
    FROM jsonb_each(${column}) AS field)`;
}

// A compact reader returns card rows cut from the projected source (#9676);
// internal keys are dropped on the way out.
const rowShape = compact => compact ? compactSourceToRow : data => data;

const videoFacetSql = field => `CASE WHEN jsonb_typeof(video.data->'${field}') = 'string' THEN video.data->>'${field}' END`;

/**
 * The rows a gallery read ranges over, filtered at the source by `clauses`
 * BEFORE any projection, so a search never materializes or compacts a row it
 * is about to discard. Returns `(clauses) => ({ cte, from, data })`.
 *
 * Without `videos` that is the index itself. With them, videos come from the
 * caller's video-history snapshot rather than their index rows: prompt and
 * visibility edits and uploads do not all refresh the derived index. They are
 * joined in SQL rather than downloading either full list to the client, and
 * expose the same read columns as an image row so one predicate serves both.
 *
 * Video search runs HERE, in JS: a video's text lives in video-history, not in
 * `search_text`, so non-matching videos are dropped before binding and the
 * survivors carry the query's own tokens as their search text (every token is
 * then a substring of it, and no record body is bound to satisfy a predicate).
 * `searchTextOf(video)` supplies the lower-cased text; the default derives it
 * from the record, and the gallery passes the per-revision cache in
 * videoGen/history.js so a keystroke does not re-serialize the history.
 *
 * `compact` (#9676) projects card/filter fields of either kind, so neither the
 * bound parameter nor a materialized CTE holds full detail bodies.
 */
function assetSource(params, videos, { materialized = false, compact = false, localImages, q = '', searchTextOf } = {}) {
  const scope = [];
  if (localImages !== undefined) {
    params.push(localImages);
    scope.push("kind = 'image'", `ref = ANY($${params.length}::text[])`);
  }
  if (videos === undefined) {
    const data = compact ? `${compactSourceSql('data')} AS data` : 'data';
    return clauses => ({ cte: '', from: `media_assets${whereOf([...scope, ...clauses])}`, data });
  }
  if (!scope.length) scope.push("kind = 'image'");
  const tokens = searchTokens(q);
  const textOf = searchTextOf || (video => recordSearchText('video', video));
  const matching = tokens.length ? videos.filter((video) => {
    const text = textOf(video);
    return tokens.every(token => text.includes(token));
  }) : videos;
  params.push(toPgJson(matching.map(video => ({ data: compact ? compactSource(video) : video,
    createdAt: Number.isFinite(Date.parse(video.createdAt)) ? new Date(video.createdAt).toISOString() : new Date(0).toISOString() }))));
  const rows = params.length;
  params.push(tokens.join(' '));
  const text = params.length;
  // Videos arrive already compact; only index rows are projected in SQL.
  const data = compact ? `CASE WHEN kind = 'image' THEN ${compactSourceSql('data')} ELSE data END` : 'data';
  return clauses => ({
    data: 'data',
    from: 'gallery_assets',
    cte: `WITH gallery_assets AS ${materialized ? 'MATERIALIZED ' : ''}(
      SELECT media_key, kind, ref, ${data} AS data, created_at, is_hidden FROM (
        SELECT media_key, kind, ref, data, created_at, search_text, is_hidden, universe_id, entry_category, entry_kind
        FROM media_assets WHERE ${scope.join(' AND ')}
        UNION ALL
        SELECT 'video:' || (video.data->>'id'), 'video', video.data->>'id', video.data, video.created_at,
          $${text}::text, COALESCE(video.data->>'hidden', 'false') = 'true',
          ${videoFacetSql('universeId')}, ${videoFacetSql('entryCategory')}, ${videoFacetSql('entryKind')}
        FROM (SELECT value->'data' AS data, (value->>'createdAt')::timestamptz AS created_at
          FROM jsonb_array_elements($${rows}::jsonb)) AS video
      ) AS source${whereOf(clauses)}
    ) `,
  });
}

/** List index rows. Omitting limit retains the legacy array contract. */
export async function listAssets({ limit, offset = 0, videos, typed = false, orderedKeys, compact = false, localImages, searchTextOf, ...filters } = {}) {
  const params = [];
  const source = assetSource(params, videos, { compact, localImages, q: filters.q, searchTextOf });
  const { cte, from, data } = source(assetFilter(filters, params));
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
    `${cte}SELECT ${typed ? 'kind, ' : ''}${data} FROM ${from} ORDER BY ${order}${paging}`, params,
  );
  const shape = rowShape(compact);
  return result.rows.map(row => typed ? { kind: row.kind, data: shape(row.data) } : shape(rowToAsset(row)));
}

/** Image gallery identities without materializing metadata or file sizes. */
export async function listGalleryImageRefs() {
  const { rows } = await query("SELECT ref FROM media_assets WHERE kind = 'image'");
  return rows.map(row => row.ref);
}

/** Prompt-only library picker search. Exclude filed images before taking the page. */
export async function searchImagePrompts(words, limit, excludedRefs = []) {
  // PostgreSQL JSONB cannot contain a NUL, and text parameters reject it too.
  if (words.some(word => word.includes('\0'))) return [];
  const matches = words.map((_, index) => `AND strpos(lower(data->>'prompt'), $${index + 3}) > 0`).join(' ');
  const { rows } = await query(`SELECT ref, data->>'prompt' AS prompt, data->'createdAt' AS "createdAt"
    FROM media_assets WHERE kind = 'image' AND jsonb_typeof(data->'prompt') = 'string'
      AND ref <> ALL($2::text[]) ${matches}
    ORDER BY created_at DESC, ref COLLATE "C" ASC LIMIT $1`, [limit, excludedRefs, ...words]);
  return rows;
}

/** Count matching rows without materializing their JSONB payloads. */
export async function countAssets({ videos, localImages, searchTextOf, ...filters } = {}) {
  const params = [];
  // Compact: a count reads no payload, so bind the small video source.
  const source = assetSource(params, videos, { compact: true, localImages, q: filters.q, searchTextOf });
  const { cte, from } = source(assetFilter(filters, params));
  const result = await query(`${cte}SELECT COUNT(*) AS count FROM ${from}`, params);
  return parseInt(result.rows[0].count, 10);
}

/** One snapshot expansion serves the mixed page and every summary count. */
export async function listMixedGalleryPage({
  videos = [], limit = 60, offset = 0, orderedKeys, cover, countMediaKeys, compact = false, localImages, searchTextOf, ...filters
} = {}) {
  const params = [];
  const source = assetSource(params, videos, { materialized: true, compact, localImages, q: filters.q, searchTextOf });
  // The page and all four aggregates share the search and facet predicates, so
  // they run once per row at the source; the rest differ per consumer.
  const { cte, from } = source(sharedClauses(filters, params));
  const predicate = options => assetFilter(options, params, { shared: false }).join(' AND ') || 'TRUE';
  const totalFilter = predicate(filters);
  const hiddenFilter = predicate({ ...filters, hidden: true });
  // Chips follow search/collection/visibility, before kind and favorites.
  const facetFilter = predicate({ ...filters, kind: undefined, mediaKeys: countMediaKeys });
  const pageFilter = predicate({ ...filters, cover });
  let order = 'created_at DESC, media_key ASC';
  if (orderedKeys) {
    params.push(orderedKeys);
    order = `array_position($${params.length}::text[], media_key), media_key ASC`;
  }
  params.push(limit, offset);
  const result = await query(`${cte}, gallery_page AS (
      SELECT * FROM ${from} WHERE ${pageFilter}
      ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}
    )
    SELECT
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', kind, 'data', data)
        ORDER BY ${order}), '[]'::jsonb) FROM gallery_page) AS items,
      COUNT(*) FILTER (WHERE ${totalFilter}) AS total,
      COUNT(*) FILTER (WHERE ${hiddenFilter}) AS "hiddenTotal",
      COUNT(*) FILTER (WHERE (${facetFilter}) AND kind = 'image') AS image,
      COUNT(*) FILTER (WHERE (${facetFilter}) AND kind = 'video') AS video
    FROM ${from}`, params);
  const row = result.rows[0];
  const image = Number(row.image);
  const video = Number(row.video);
  const shape = rowShape(compact);
  return { items: row.items.map(item => ({ kind: item.kind, data: shape(item.data) })), total: Number(row.total), hiddenTotal: Number(row.hiddenTotal),
    counts: { image, video, all: image + video } };
}

/** Batch cover selection: membership ordinals retain stable added-at ordering.
 * Only addressing fields cross the video-history boundary; prompts never enter SQL.
 * Hidden assets remain eligible here, just as on the collection grid.
 */
export async function collectionCovers(collections, videos) {
  const videoRows = videos.map(({ id, filename, createdAt, hidden, thumbnail }) => ({
    id, filename, hidden, thumbnail,
    createdAt: Number.isFinite(Date.parse(createdAt)) ? new Date(createdAt).toISOString() : new Date(0).toISOString(),
  }));
  const result = await query(`WITH collections AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS c(id text, "coverKey" text, keys jsonb)
    ), memberships AS MATERIALIZED (
      SELECT c.id, c."coverKey", k.key, k.ordinal
      FROM collections c CROSS JOIN LATERAL jsonb_array_elements_text(c.keys) WITH ORDINALITY AS k(key, ordinal)
    ), assets AS MATERIALIZED (
      SELECT media_key, kind, ref, data->>'filename' AS filename, created_at,
        COALESCE(NULLIF(data->>'path', ''), '/data/images/' || (data->>'filename')) AS cover
      FROM media_assets WHERE kind = 'image'
      UNION ALL
      SELECT 'video:' || v.id, 'video', v.id, v.filename, v."createdAt"::timestamptz,
        '/data/video-thumbnails/' || NULLIF(v.thumbnail, '')
      FROM jsonb_to_recordset($2::jsonb) AS v(id text, filename text, "createdAt" text, thumbnail text)
    ), covers AS (
      SELECT DISTINCT ON (m.id) m.id, a.cover
      FROM memberships m JOIN assets a ON a.media_key = m.key
      WHERE a.kind = 'image' OR a.cover IS NOT NULL
      ORDER BY m.id,
        (CASE WHEN a.kind = CASE WHEN m."coverKey" LIKE 'image:%' THEN 'image' ELSE 'video' END
          AND (a.ref = substring(m."coverKey" FROM length(a.kind) + 2)
            OR a.filename = substring(m."coverKey" FROM length(a.kind) + 2)) THEN 0 ELSE 1 END),
        m.ordinal, a.media_key
    ), unsorted AS MATERIALIZED (
      SELECT a.* FROM assets a WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.key = a.media_key)
    )
    SELECT c.id, covers.cover, NULL::bigint AS image, NULL::bigint AS video
    FROM collections c LEFT JOIN covers ON covers.id = c.id
    UNION ALL
    SELECT 'unsorted',
      (SELECT cover FROM unsorted WHERE kind = 'image' OR cover IS NOT NULL ORDER BY created_at DESC, media_key ASC LIMIT 1),
      COUNT(*) FILTER (WHERE kind = 'image'), COUNT(*) FILTER (WHERE kind = 'video')
    FROM unsorted`, [toPgJson(collections), toPgJson(videoRows)]);
  return result.rows;
}

/** Picker membership only needs existence, never covers, counts or video history. */
export async function visibleImageCollections(collections) {
  const memberships = collections.flatMap(collection => (collection.items || [])
    .filter(item => item.kind === 'image').map(item => ({ id: collection.id, key: `image:${item.ref}` })));
  const result = await query(`SELECT DISTINCT m.id
    FROM jsonb_to_recordset($1::jsonb) AS m(id text, key text)
    JOIN media_assets a ON a.media_key = m.key
    WHERE a.kind = 'image' AND NOT a.is_hidden`, [toPgJson(memberships)]);
  const populated = new Set(result.rows.map(row => row.id));
  return collections.filter(collection => populated.has(collection.id)).map(({ id, name }) => ({ id, name }));
}

/** Compact global picker options, independent of the loaded page/search. */
export async function galleryFacets() {
  const result = await query(`SELECT DISTINCT universe_id AS "universeId", universe_name AS "universeName",
      entry_category AS "entryCategory", entry_kind AS "entryKind"
    FROM media_assets WHERE kind = 'image' AND NOT is_hidden`);
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

// Restore must distinguish an absent gallery/sidecar from an unreadable or
// corrupt one. The interactive gallery intentionally tolerates both, which
// is inappropriate when replacing every restored cache row.
async function readGalleryForRestore() {
  const { PATHS } = await import('../../lib/fileUtils.js');
  let files;
  try { files = await readdir(PATHS.images); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const images = [];
  for (const filename of files.filter(name => isSafeFilename(name, GALLERY_IMAGE_EXTENSIONS))) {
    const info = await stat(join(PATHS.images, filename));
    if (!info.isFile()) throw new Error('Media gallery contains a non-file image');
    let metadata = {};
    for (const sidecar of [sidecarPathForImage(filename), join(PATHS.images, `${filename}.metadata.json`)]) {
      let raw;
      try { raw = await readFile(sidecar, 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      metadata = JSON.parse(raw);
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new Error('Media gallery sidecar must contain an object');
      }
      break;
    }
    images.push({ filename, path: `/data/images/${filename}`, createdAt: info.birthtime.toISOString(), ...metadata });
  }
  return images;
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
 * Runs every boot, but after `listen()` (reconcileMediaAssetIndexAtBoot): on a
 * large library the full read + upsert takes seconds (#16556).
 *
 * The disk readers are injected (defaulting to the real services) so tests can
 * drive reconcile without the media-gen stack. Both injected and default
 * readers go through the same strict failure-vs-empty wrapper, so a throwing
 * reader uniformly skips that kind's prune rather than wiping it.
 */
export function reconcileMediaAssets(deps = {}) {
  return queueMediaIndexRefresh(() => reconcileNow(deps));
}

async function reconcileNow(deps) {
  const now = new Date().toISOString();
  // Rows indexed after this instant (a generation/upload/peer sync landing
  // mid-reconcile) are absent from the disk snapshot but must not be pruned.
  const startedAt = now;

  const imageRead = await readListStrict(
    deps.listGallery || (deps.rebuild || deps.requireComplete
      ? readGalleryForRestore : (await import('../imageGen/local.js')).listGallery),
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

  // Restore cannot retain old or partially reconstructed cache rows. Read both
  // authorities first, then replace the mirror atomically; a failed read is
  // never a trusted empty gallery. This also removes future-dated legacy rows
  // that the ordinary concurrent-generation prune deliberately preserves.
  if ((deps.rebuild || deps.requireComplete) && (!imageRead.ok || !videoRead.ok)) {
    throw new Error('Media index rebuild could not read authoritative files');
  }
  if (deps.rebuild) {
    return withTransaction(async (client) => {
      const removed = await client.query('DELETE FROM media_assets');
      const indexed = await upsertAssets([...imageRows, ...videoRows], client.query.bind(client));
      return { ok: true, indexed, pruned: removed.rowCount || 0, skippedPrune: [] };
    });
  }

  // Rows RECONCILED, which is below the rows read when disk repeated a ref.
  const indexed = await upsertAssets([...imageRows, ...videoRows]);

  // Per-kind prune, gated on a successful read for that kind. Pruning one kind
  // never touches the other's rows (an image-read failure can't wipe videos).
  let pruned = 0;
  if (imageRead.ok) pruned += await pruneKind('image', imageRows.map((r) => r.mediaKey), startedAt);
  if (videoRead.ok) pruned += await pruneKind('video', videoRows.map((r) => r.mediaKey), startedAt);

  const skipped = [!imageRead.ok && 'images', !videoRead.ok && 'videos'].filter(Boolean);
  const skipNote = skipped.length ? ` — SKIPPED prune for ${skipped.join('+')} (disk read failed)` : '';
  console.log(`🗂️  Media asset index reconciled: ${imageRows.length} img / ${videoRows.length} vid on disk, ${pruned} stale row(s) pruned${skipNote}`);
  return { ok: true, indexed, pruned, skippedPrune: skipped };
}

// Delete index rows of `kind` whose media_key isn't in `liveKeys`. An empty
// liveKeys set legitimately means "this kind has no assets on disk" — safe to
// prune all of that kind — but the CALLER only reaches here when the read for
// that kind succeeded, so empty is trustworthy.
async function pruneKind(kind, liveKeys, startedAt) {
  const res = liveKeys.length === 0
    ? await query(
      `DELETE FROM media_assets WHERE kind = $1 AND indexed_at < $2::timestamptz`,
      [kind, startedAt],
    )
    : await query(
      `DELETE FROM media_assets WHERE kind = $1 AND indexed_at < $2::timestamptz AND media_key <> ALL($3::text[])`,
      [kind, startedAt, liveKeys],
    );
  return res.rowCount || 0;
}
