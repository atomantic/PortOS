/**
 * Creative Ingredients Catalog — ingredient media attachments.
 *
 * catalog_ingredient_media: typed references (portrait/reference/audio/video/
 * document) into the install's media library. `media_key` is a key into the
 * library (data/images + the history.jsonl sidecar) — never duplicated bytes.
 * Detach is a soft-delete so peers receive the tombstone.
 */

import { query } from '../../lib/db.js';
import { resolveImageInputPath } from '../../lib/fileUtils.js';
import { rowToMedia } from './shared.js';

export async function attachMedia(ingredientId, mediaKey, kind, { role = null, caption = null } = {}) {
  const result = await query(
    `INSERT INTO catalog_ingredient_media (ingredient_id, media_key, kind, role, caption)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (ingredient_id, media_key, kind) DO UPDATE
       SET deleted = false, deleted_at = NULL,
           role = EXCLUDED.role, caption = EXCLUDED.caption
     RETURNING *`,
    [ingredientId, mediaKey, kind, role, caption],
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

// Set THE portrait for an ingredient: attach `mediaKey` as kind 'portrait' and
// demote any other live portrait. One active portrait per ingredient — the UI
// renders it as the ingredient's avatar. Serialized as two statements; the
// single-user trust model means no competing writer can interleave.
export async function setPortraitMedia(ingredientId, mediaKey, { role = null, caption = null } = {}) {
  await query(
    `UPDATE catalog_ingredient_media
        SET deleted = true, deleted_at = NOW()
      WHERE ingredient_id = $1 AND kind = 'portrait'
        AND media_key <> $2 AND deleted = false`,
    [ingredientId, mediaKey],
  );
  return attachMedia(ingredientId, mediaKey, 'portrait', { role, caption });
}

// Live (non-tombstoned) media rows for an ingredient's detail "Media" panel,
// newest first. Portrait(s) first so the avatar is easy to pluck off the head.
export async function listMediaForIngredient(ingredientId) {
  const result = await query(
    `SELECT * FROM catalog_ingredient_media
      WHERE ingredient_id = $1 AND deleted = false
      ORDER BY (kind = 'portrait') DESC, created_at DESC`,
    [ingredientId],
  );
  return result.rows.map(rowToMedia);
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
