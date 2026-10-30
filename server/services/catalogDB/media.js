/**
 * Creative Ingredients Catalog — ingredient media attachments.
 *
 * catalog_ingredient_media: typed references (portrait/reference/audio/video/
 * document) into the install's media library. `media_key` is a key into the
 * library (data/images + the history.jsonl sidecar) — never duplicated bytes.
 * Image generation provenance lives in the bounded JSONB `metadata` projection;
 * detach is a soft-delete so peers receive the tombstone.
 */

import { query, withTransaction } from '../../lib/db.js';
import { resolveImageInputPath } from '../../lib/fileUtils.js';
import { rowToMedia } from './shared.js';
import { MAX_CAST_GUIDES, normalizeLibrary } from '../../lib/catalogMediaLibrary.js';
import { assertCatalogIdentityWritable, assertCatalogAssociationRemovable } from './identityAccess.js';
import { toPgJson } from '../../lib/pgJson.js';
import { catalogEvents } from '../catalogEvents.js';

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const hasMeaningfulMetadata = (value) => value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length > 0;

// Every local image write takes the owning ingredient's row lock, so the
// generated-image decision in attachGeneratedMedia sees each one either fully
// before or fully after it. The media table's write lock comes first: merge
// takes a SHARE ROW EXCLUSIVE table lock and then the ingredient rows, so a
// writer holding the row while waiting for the table would deadlock with it.
const IMAGE_KINDS = new Set(['portrait', 'reference']);
const lockIngredient = async (client, ingredientId) => {
  await client.query('LOCK TABLE catalog_ingredient_media IN ROW EXCLUSIVE MODE');
  await client.query('SELECT id FROM catalog_ingredients WHERE id = catalog_resolve_ingredient_id($1) FOR UPDATE', [ingredientId]);
};
const inTransaction = (options, fn) => (options.client ? fn(options.client) : withTransaction(fn));
// Image attaches file into the record's universe collections
// (catalogUniverseFiling.js), which reads after a short delay so a caller's
// enclosing transaction has committed.
const announceImage = (ingredientId) => catalogEvents.emit('assets-changed', { ingredientId });

export async function attachMedia(ingredientId, mediaKey, kind, options = {}) {
  // Every local portrait entry point shares the replacement transaction,
  // including the generic media API and file uploads.
  if (kind === 'portrait') return setPortraitMedia(ingredientId, mediaKey, options);
  ingredientId = await assertCatalogIdentityWritable(ingredientId, options);
  if (!IMAGE_KINDS.has(kind)) {
    return insertMedia(options.client ? options.client.query.bind(options.client) : query, ingredientId, mediaKey, kind, options);
  }
  const media = await inTransaction(options, async (client) => {
    await lockIngredient(client, ingredientId);
    return insertMedia(client.query.bind(client), ingredientId, mediaKey, kind, options);
  });
  announceImage(ingredientId);
  return media;
}

// File a generated render exactly once. The live image kinds are re-read under
// the ingredient lock, so the completion hook and the mounted client's
// optimistic attach cannot both decide before either writes and leave the same
// filename as portrait AND reference. A render already attached under any kind
// is returned untouched (`attached: false`); explicit attaches through
// attachMedia/setPortraitMedia stay free to add a second kind on purpose.
// `kind` is 'portrait', 'reference', or 'auto' (first image → portrait). With a
// job `queuedAt`, an explicit portrait yields to a different live portrait
// changed after the job was queued (filed as a reference instead), so an older
// render never replaces a newer choice from any writer.
export async function attachGeneratedMedia(ingredientId, mediaKey, { kind = 'auto', queuedAt = null, ...options } = {}) {
  ingredientId = await assertCatalogIdentityWritable(ingredientId, options);
  const result = await inTransaction(options, async (client) => {
    await lockIngredient(client, ingredientId);
    const { rows } = await client.query(
      `SELECT * FROM catalog_identity_read_media
        WHERE ingredient_id = ANY(catalog_identity_member_ids($1)) AND deleted = false
        ORDER BY (kind = 'portrait') DESC, created_at DESC`,
      [ingredientId],
    );
    // A key deliberately held as both kinds reports its portrait, so the
    // hook's newest-render guard still sees it.
    const existing = rows.find((row) => row.media_key === mediaKey);
    if (existing) return { media: rowToMedia(existing), kind: existing.kind, attached: false };
    const queuedTime = queuedAt ? Date.parse(queuedAt) : NaN;
    const newerPortrait = Number.isFinite(queuedTime) && rows.some((row) => row.kind === 'portrait'
      && row.media_key !== mediaKey && row.updated_at && new Date(row.updated_at).getTime() > queuedTime);
    const target = kind === 'auto' ? (rows.some((row) => row.kind === 'portrait') ? 'reference' : 'portrait')
      : kind === 'portrait' && newerPortrait ? 'reference' : kind;
    const media = target === 'portrait'
      ? await setPortraitMedia(ingredientId, mediaKey, { ...options, client })
      : await insertMedia(client.query.bind(client), ingredientId, mediaKey, target, options);
    return { media, kind: target, attached: true };
  });
  if (result.attached) announceImage(ingredientId);
  return result;
}

async function insertMedia(runQuery, ingredientId, mediaKey, kind, options) {
  const { role = null, caption = null } = options;
  // Metadata is additive on the wire and optional at the call boundary. When
  // absent, leave an existing prompt untouched; a legacy attach/re-attach must
  // not erase provenance just because its caller predates this field.
  const hasMetadata = hasOwn(options, 'metadata') && hasMeaningfulMetadata(options.metadata);
  const metadataColumn = hasMetadata ? ', metadata' : '';
  const metadataPlaceholder = hasMetadata ? ', $6' : '';
  const preserveOnConflict = options.preserveExistingOnConflict === true;
  const metadataUpdate = hasMetadata && !preserveOnConflict ? ', metadata = EXCLUDED.metadata' : '';
  const hasLibrary = hasOwn(options, 'library');
  const libraryColumn = hasLibrary ? ', library' : '';
  const libraryPlaceholder = hasLibrary ? `, $${hasMetadata ? 7 : 6}` : '';
  const libraryUpdate = hasLibrary && !preserveOnConflict ? ', library = EXCLUDED.library' : '';
  const fieldsUpdate = preserveOnConflict ? '' : ', role = EXCLUDED.role, caption = EXCLUDED.caption';
  const result = await runQuery(
    `INSERT INTO catalog_ingredient_media (ingredient_id, media_key, kind, role, caption${metadataColumn}${libraryColumn})
     VALUES (catalog_resolve_ingredient_id($1), $2, $3, $4, $5${metadataPlaceholder}${libraryPlaceholder})
     ON CONFLICT (ingredient_id, media_key, kind) DO UPDATE
       SET deleted = false, deleted_at = NULL${fieldsUpdate}${metadataUpdate}${libraryUpdate}
     RETURNING *`,
    [
      ingredientId, mediaKey, kind, role, caption,
      ...(hasMetadata ? [toPgJson(options.metadata || {})] : []),
      ...(hasLibrary ? [toPgJson(normalizeLibrary(options.library))] : []),
    ],
  );
  return rowToMedia(result.rows[0]);
}

export async function detachMedia(ingredientId, mediaKey, kind) {
  ingredientId = await assertCatalogIdentityWritable(ingredientId);
  await assertCatalogAssociationRemovable(ingredientId, 'media', [mediaKey, kind]);
  // Soft-delete (mirrors unlinkIngredientRelation): keep the row as a tombstone
  // so the sync_sequence bump propagates the detach to peers. `AND deleted =
  // false` keeps a re-detach from re-bumping the sequence needlessly.
  await query(
    `UPDATE catalog_ingredient_media
        SET deleted = true, deleted_at = NOW()
      WHERE ingredient_id = catalog_resolve_ingredient_id($1) AND media_key = $2 AND kind = $3
        AND deleted = false`,
    [ingredientId, mediaKey, kind],
  );
}

// Lock the owning row even when there is no media yet. Both demotion and
// attachment commit together, so overlapping HTTP/generation writes serialize
// and a failed replacement leaves the previous portrait intact.
export async function setPortraitMedia(ingredientId, mediaKey, options = {}) {
  ingredientId = await assertCatalogIdentityWritable(ingredientId, options);
  const media = await inTransaction(options, async (client) => {
    await lockIngredient(client, ingredientId);
    await client.query(
      `UPDATE catalog_ingredient_media
          SET deleted = true, deleted_at = NOW()
        WHERE ingredient_id = catalog_resolve_ingredient_id($1) AND kind = 'portrait'
          AND media_key <> $2 AND deleted = false`,
      [ingredientId, mediaKey],
    );
    return insertMedia(client.query.bind(client), ingredientId, mediaKey, 'portrait', options);
  });
  announceImage(ingredientId);
  return media;
}

// Live (non-tombstoned) media rows for an ingredient's detail "Media" panel,
// newest first. Portrait(s) first so the avatar is easy to pluck off the head.
export async function listMediaForIngredient(ingredientId) {
  const byIngredient = await listMediaForIngredients([ingredientId]);
  return byIngredient.get(ingredientId);
}

// Preserve the detail page's portrait/reference precedence without fetching
// image metadata or checking every library file before the profile can render.
export async function getIngredientMediaCover(ingredientId) {
  const { rows } = await query(`SELECT DISTINCT ON (kind) kind, media_key
    FROM catalog_identity_read_media
    WHERE ingredient_id = ANY(catalog_identity_member_ids($1)) AND deleted = false
      AND (kind = 'portrait' OR (kind = 'reference' AND (role IS NULL OR NOT (role LIKE 'archive:%'
        OR (role LIKE 'design:%' AND COALESCE(library->>'guide', '') <> 'true')))))
    ORDER BY kind, ingredient_id, created_at DESC`, [ingredientId]);
  return { portraitKey: rows.find((row) => row.kind === 'portrait')?.media_key || null,
    referenceKey: rows.find((row) => row.kind === 'reference')?.media_key || null };
}

// Batched `listMediaForIngredient` for bulk hydration paths (#3940) — ONE query
// for N ingredients instead of N. Same live filter and same per-ingredient
// ordering (portraits first, then newest-first); the outer `ingredient_id` sort
// key only groups the rows, it doesn't reorder within a group. Returns
// `Map<ingredientId, media[]>` with an entry (possibly `[]`) for every id.
export async function listMediaForIngredients(ingredientIds, { preserveIdentity = false, includeRetained = false } = {}) {
  const ids = [...new Set(ingredientIds)];
  if (ids.length === 0) return new Map();
  const result = await query(
    preserveIdentity ? `SELECT * FROM ${includeRetained ? `(SELECT * FROM catalog_identity_read_media UNION ALL
      SELECT m.*, false AS identity_retained FROM catalog_ingredient_media m
       WHERE m.ingredient_id <> catalog_resolve_ingredient_id(m.ingredient_id)) exported_media` : 'catalog_ingredient_media'}
      WHERE ingredient_id = ANY($1) AND deleted = false
      ORDER BY ingredient_id, (kind = 'portrait') DESC, created_at DESC` : `SELECT m.*, requested.id AS requested_id FROM unnest($1::text[]) requested(id)
      JOIN catalog_identity_read_media m ON m.ingredient_id = ANY(catalog_identity_member_ids(requested.id))
      WHERE m.deleted = false
      ORDER BY ingredient_id, (kind = 'portrait') DESC, created_at DESC`,
    [ids],
  );
  const grouped = new Map(ids.map(id => [id, []]));
  for (const row of result.rows) grouped.get(row.requested_id ?? row.ingredient_id)?.push(rowToMedia(row));
  return grouped;
}

// The media kinds whose `media_key` resolves against the image library today.
// Non-image kinds (audio/video/document) have no library resolver yet, so the
// integrity check skips them rather than reporting a false "missing" — when an
// audio/video library lands, add its resolver and widen this set.
const RESOLVABLE_MEDIA_KINDS = new Set(['portrait', 'reference']);

// Integrity surface: which of an ingredient's live IMAGE media_keys DON'T
// resolve against this install's media library. Federation ships keys, not
// bytes, so a received attachment whose asset never arrived (or was pruned)
// shows up here — the detail page surfaces it as `metadata-missing` rather than
// rendering a broken <img>. `resolveImageInputPath` returns null when the key
// isn't under any approved image root. Non-image kinds are excluded (no
// resolver yet). Returns the list of missing `{ mediaKey, kind }`.
export async function getMissingMediaForIngredient(ingredientId, { media } = {}) {
  const rows = media ?? await listMediaForIngredient(ingredientId);
  return rows
    .filter((m) => RESOLVABLE_MEDIA_KINDS.has(m.kind) && !resolveImageInputPath(m.mediaKey))
    .map((m) => ({ mediaKey: m.mediaKey, kind: m.kind }));
}

// Casting reference library: merge a variant/tags/guide patch into one live
// media row. Turning a guide ON is serialized on the owning ingredient row and
// refused (409) past MAX_CAST_GUIDES so the render picker's cap holds.
export async function updateMediaLibrary(ingredientId, mediaKey, kind, patch = {}, { preserveExisting = false } = {}) {
  ingredientId = await assertCatalogIdentityWritable(ingredientId);
  return withTransaction(async (client) => {
    await lockIngredient(client, ingredientId);
    const cur = await client.query(
      `SELECT *, (updated_at IS DISTINCT FROM created_at OR updated_at IS NULL OR created_at IS NULL) AS changed_since_creation
         FROM catalog_ingredient_media
        WHERE ingredient_id = catalog_resolve_ingredient_id($1) AND media_key = $2 AND kind = $3 AND deleted = false`,
      [ingredientId, mediaKey, kind],
    );
    const row = cur.rows[0];
    if (!row) {
      const err = new Error('Media not attached to this ingredient');
      err.status = 404;
      throw err;
    }
    const prev = normalizeLibrary(row.library);
    // A completion hook may race a user's edits after an optimistic attach.
    // Edited rows keep their whole library, including fields cleared to an
    // absent key by normalization; only the missing lineage can be filled.
    // Compare timestamps in Postgres, which keeps their sub-millisecond
    // precision. The media update trigger advances this clock monotonically.
    const generated = preserveExisting && row.changed_since_creation !== false
      ? (hasOwn(patch, 'derivedFrom') ? { derivedFrom: patch.derivedFrom } : {}) : patch;
    const effective = preserveExisting ? { ...generated, ...prev } : generated;
    const next = normalizeLibrary({
      ...prev,
      ...(hasOwn(effective, 'variant') ? { variant: effective.variant } : {}),
      ...(hasOwn(effective, 'tags') ? { tags: effective.tags } : {}),
      ...(hasOwn(effective, 'guide') ? { guide: effective.guide } : {}),
      ...(hasOwn(effective, 'likeness') ? { likeness: effective.likeness } : {}),
      ...(hasOwn(effective, 'review') ? { review: { ...prev.review, ...effective.review } } : {}),
      ...(hasOwn(effective, 'derivedFrom') ? { derivedFrom: effective.derivedFrom } : {}),
    });
    if (['bad', 'rejected'].includes(next.review?.status)) {
      await client.query(`UPDATE catalog_ingredient_media SET library = jsonb_set(COALESCE(library, '{}'::jsonb), '{guide}', 'false'::jsonb, true)
        WHERE ingredient_id = catalog_resolve_ingredient_id($1) AND media_key = $2 AND kind <> $3 AND deleted = false
          AND library->>'guide' = 'true'`, [ingredientId, mediaKey, kind]);
    }
    // Likeness is per image, not per attachment: the portrait and reference
    // rows of one file always agree, like a bad rating.
    if (hasOwn(effective, 'likeness')) {
      await client.query(`UPDATE catalog_ingredient_media SET library = CASE WHEN $4::boolean
          THEN COALESCE(library, '{}'::jsonb) - 'likeness'
          ELSE COALESCE(library, '{}'::jsonb) || '{"likeness": false, "guide": false}'::jsonb END
        WHERE ingredient_id = catalog_resolve_ingredient_id($1) AND media_key = $2 AND kind <> $3 AND deleted = false`,
      [ingredientId, mediaKey, kind, next.likeness !== false]);
    }
    if (next.guide === true) {
      const rejected = await client.query(`SELECT EXISTS (SELECT 1 FROM catalog_ingredient_media
        WHERE ingredient_id = catalog_resolve_ingredient_id($1) AND media_key = $2 AND kind <> $3 AND deleted = false
          AND (library->'review'->>'status' IN ('bad', 'rejected') OR library->>'likeness' = 'false')) AS blocked`, [ingredientId, mediaKey, kind]);
      if (rejected.rows[0].blocked) next.guide = false;
    }
    if (next.guide === true && prev.guide !== true) {
      const count = await client.query(
        `SELECT COUNT(*)::int AS n FROM catalog_ingredient_media
          WHERE ingredient_id = catalog_resolve_ingredient_id($1) AND deleted = false AND library->>'guide' = 'true'`,
        [ingredientId],
      );
      if (count.rows[0].n >= MAX_CAST_GUIDES) {
        const err = new Error(`At most ${MAX_CAST_GUIDES} references can be render guides`);
        err.status = 409;
        throw err;
      }
    }
    const result = await client.query(
      `UPDATE catalog_ingredient_media SET library = $4::jsonb
        WHERE ingredient_id = catalog_resolve_ingredient_id($1) AND media_key = $2 AND kind = $3 AND deleted = false
        RETURNING *`,
      [ingredientId, mediaKey, kind, toPgJson(next)],
    );
    return rowToMedia(result.rows[0]);
  });
}

// Which catalog record owns each image, for naming a reference picked from the
// gallery. One live row per key: a record in `preferIds` (the caller's linked
// cast) wins, then a portrait, then the newest attach. Merged records answer
// with their canonical record; `preferredId` is the `preferIds` entry it matched.
export async function findMediaOwnersByKeys(mediaKeys, { preferIds = [] } = {}) {
  const keys = [...new Set((mediaKeys || []).filter((key) => typeof key === 'string' && key))];
  if (!keys.length) return new Map();
  const { rows } = await query(
    `SELECT DISTINCT ON (m.media_key) m.media_key, i.id, i.name, i.type, preferred.id AS preferred_id
       FROM catalog_ingredient_media m
       JOIN catalog_ingredients i ON i.id = catalog_canonical_ingredient_id(m.ingredient_id) AND i.deleted = false
       LEFT JOIN LATERAL (SELECT p AS id FROM unnest($2::text[]) p
         WHERE catalog_canonical_ingredient_id(p) = i.id LIMIT 1) preferred ON true
      WHERE m.media_key = ANY($1) AND m.deleted = false
      ORDER BY m.media_key, (preferred.id IS NOT NULL) DESC, (m.kind = 'portrait') DESC, m.created_at DESC`,
    [keys, [...new Set(preferIds.filter((id) => typeof id === 'string' && id))]],
  );
  return new Map(rows.map((row) => [row.media_key, { ingredientId: row.id, name: row.name, type: row.type, preferredId: row.preferred_id ?? null }]));
}
