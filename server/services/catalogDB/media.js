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
import { rowToMedia, groupRowsByIngredient } from './shared.js';

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const hasMeaningfulMetadata = (value) => value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length > 0;

export async function attachMedia(ingredientId, mediaKey, kind, options = {}) {
  // Every local portrait entry point shares the replacement transaction,
  // including the generic media API and file uploads.
  if (kind === 'portrait') return setPortraitMedia(ingredientId, mediaKey, options);
  return insertMedia(query, ingredientId, mediaKey, kind, options);
}

async function insertMedia(runQuery, ingredientId, mediaKey, kind, options) {
  const { role = null, caption = null } = options;
  // Metadata is additive on the wire and optional at the call boundary. When
  // absent, leave an existing prompt untouched; a legacy attach/re-attach must
  // not erase provenance just because its caller predates this field.
  const hasMetadata = hasOwn(options, 'metadata') && hasMeaningfulMetadata(options.metadata);
  const metadataColumn = hasMetadata ? ', metadata' : '';
  const metadataPlaceholder = hasMetadata ? ', $6' : '';
  const metadataUpdate = hasMetadata ? ', metadata = EXCLUDED.metadata' : '';
  const result = await runQuery(
    `INSERT INTO catalog_ingredient_media (ingredient_id, media_key, kind, role, caption${metadataColumn})
     VALUES ($1, $2, $3, $4, $5${metadataPlaceholder})
     ON CONFLICT (ingredient_id, media_key, kind) DO UPDATE
       SET deleted = false, deleted_at = NULL,
           role = EXCLUDED.role, caption = EXCLUDED.caption${metadataUpdate}
     RETURNING *`,
    [
      ingredientId, mediaKey, kind, role, caption,
      ...(hasMetadata ? [JSON.stringify(options.metadata || {})] : []),
    ],
  );
  return rowToMedia(result.rows[0]);
}

export async function detachMedia(ingredientId, mediaKey, kind) {
  // Soft-delete (mirrors unlinkIngredientRelation): keep the row as a tombstone
  // so the sync_sequence bump propagates the detach to peers. `AND deleted =
  // false` keeps a re-detach from re-bumping the sequence needlessly.
  await query(
    `UPDATE catalog_ingredient_media
        SET deleted = true, deleted_at = NOW()
      WHERE ingredient_id = $1 AND media_key = $2 AND kind = $3
        AND deleted = false`,
    [ingredientId, mediaKey, kind],
  );
}

// Lock the owning row even when there is no media yet. Both demotion and
// attachment commit together, so overlapping HTTP/generation writes serialize
// and a failed replacement leaves the previous portrait intact.
export async function setPortraitMedia(ingredientId, mediaKey, options = {}) {
  return withTransaction(async (client) => {
    await client.query('SELECT id FROM catalog_ingredients WHERE id = $1 FOR UPDATE', [ingredientId]);
    await client.query(
      `UPDATE catalog_ingredient_media
          SET deleted = true, deleted_at = NOW()
        WHERE ingredient_id = $1 AND kind = 'portrait'
          AND media_key <> $2 AND deleted = false`,
      [ingredientId, mediaKey],
    );
    return insertMedia(client.query.bind(client), ingredientId, mediaKey, 'portrait', options);
  });
}

// Live (non-tombstoned) media rows for an ingredient's detail "Media" panel,
// newest first. Portrait(s) first so the avatar is easy to pluck off the head.
export async function listMediaForIngredient(ingredientId) {
  const byIngredient = await listMediaForIngredients([ingredientId]);
  return byIngredient.get(ingredientId);
}

// Batched `listMediaForIngredient` for bulk hydration paths (#3940) — ONE query
// for N ingredients instead of N. Same live filter and same per-ingredient
// ordering (portraits first, then newest-first); the outer `ingredient_id` sort
// key only groups the rows, it doesn't reorder within a group. Returns
// `Map<ingredientId, media[]>` with an entry (possibly `[]`) for every id.
export async function listMediaForIngredients(ingredientIds) {
  const ids = [...new Set(ingredientIds)];
  if (ids.length === 0) return new Map();
  const result = await query(
    `SELECT * FROM catalog_ingredient_media
      WHERE ingredient_id = ANY($1) AND deleted = false
      ORDER BY ingredient_id, (kind = 'portrait') DESC, created_at DESC`,
    [ids],
  );
  return groupRowsByIngredient(ids, result.rows, rowToMedia);
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
export async function getMissingMediaForIngredient(ingredientId) {
  const rows = await listMediaForIngredient(ingredientId);
  return rows
    .filter((m) => RESOLVABLE_MEDIA_KINDS.has(m.kind) && !resolveImageInputPath(m.mediaKey))
    .map((m) => ({ mediaKey: m.mediaKey, kind: m.kind }));
}
