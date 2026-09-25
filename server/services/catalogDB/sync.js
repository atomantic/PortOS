/**
 * Creative Ingredients Catalog — peer-sync change feeds & upserts.
 *
 * The `get*ChangesSince` readers page rows by their commit-ordered feed
 * position (`sync_feed`, #8315 — see server/lib/db/schema/syncFeed.js) for
 * outbound pulls; the `upsert*FromPeer` writers apply an inbound peer's rows. Mixed-
 * version federation is handled per-table: "tombstone keys absent" is treated
 * as "peer has no opinion" so a pre-tombstone peer can't revive a local delete,
 * and FK-lagged child/parent rows retry parent-less then re-link on a later page.
 */

import { query, arrayToPgvector } from '../../lib/db.js';
import {
  rowToScrap,
  rowToIngredient,
  rowToRef,
  rowToSource,
  rowToRelation,
  rowToMedia,
  rowToTag,
} from './shared.js';

// One page of a table's feed: rows whose committed feed position is past the
// peer's cursor, in position order. `syncSequence` on each item carries the
// FEED POSITION — the cursor unit peers store — not the row's write-time
// `sync_sequence`, which a late-committing transaction can land below a
// cursor a peer already advanced past. `stream` is one of the table-name
// literals the exported readers below pass, never caller input.
async function getFeedChangesSince(stream, mapRow, since, limit) {
  const result = await query(
    `SELECT t.*, f.position::text AS feed_position
     FROM sync_feed f
     JOIN ${stream} t ON t.sync_sequence = f.row_sequence
     WHERE f.stream = $1 AND f.position > $2
     ORDER BY f.position ASC
     LIMIT $3`,
    [stream, since, limit + 1],
  );
  const hasMore = result.rows.length > limit;
  const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
  return { items: rows.map((row) => ({ ...mapRow(row), syncSequence: row.feed_position })), hasMore };
}

export const getRelationChangesSince = (since = '0', limit = 100) =>
  getFeedChangesSince('catalog_ingredient_relations', rowToRelation, since, limit);

export async function upsertRelationFromPeer(rel) {
  // Mirrors upsertRefFromPeer's mixed-version handling: a peer that predates
  // the relations feature never emits these rows, so there's no v1-without-
  // tombstone shape to defend against here. But we still treat "key absent"
  // as "no opinion" symmetrically in case a forked peer omits the tombstone
  // fields — preserve local state on conflict rather than coercing to false.
  const hasTombstoneFields =
    Object.prototype.hasOwnProperty.call(rel, 'deleted') ||
    Object.prototype.hasOwnProperty.call(rel, 'deletedAt');
  if (hasTombstoneFields) {
    await query(
      `INSERT INTO catalog_ingredient_relations
         (from_id, to_id, kind, created_at, deleted, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (from_id, to_id, kind) DO UPDATE
         SET deleted = EXCLUDED.deleted,
             deleted_at = EXCLUDED.deleted_at`,
      [rel.fromId, rel.toId, rel.kind, rel.createdAt, !!rel.deleted, rel.deletedAt || null],
    );
  } else {
    await query(
      `INSERT INTO catalog_ingredient_relations (from_id, to_id, kind, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (from_id, to_id, kind) DO NOTHING`,
      [rel.fromId, rel.toId, rel.kind, rel.createdAt],
    );
  }
}

export const getMediaChangesSince = (since = '0', limit = 100) =>
  getFeedChangesSince('catalog_ingredient_media', rowToMedia, since, limit);

export async function upsertMediaFromPeer(media) {
  // Mirrors upsertRefFromPeer's mixed-version handling: a peer that predates
  // the media feature never emits these rows, so there's no pre-tombstone
  // shape to defend against. We still treat "tombstone keys absent" as "peer
  // has no opinion" so a forked peer that omits them preserves local state on
  // conflict. On INSERT a tombstone-less row defaults to deleted=false, which
  // is correct (brand-new locally, peer believes it active). role/caption and
  // metadata are adopted when the peer includes them (LWW is implicit — last
  // writer's envelope wins for these tuple-unique rows, same as refs); an older
  // peer's absent metadata is no opinion.
  const hasTombstoneFields =
    Object.prototype.hasOwnProperty.call(media, 'deleted') ||
    Object.prototype.hasOwnProperty.call(media, 'deletedAt');
  // A peer that predates media provenance has no `metadata` key. Treat that as
  // no opinion on conflict, just like the tombstone-less compatibility path,
  // so an older peer cannot erase a prompt already stored locally.
  const hasMetadata = Object.prototype.hasOwnProperty.call(media, 'metadata')
    && media.metadata && typeof media.metadata === 'object'
    && !Array.isArray(media.metadata) && Object.keys(media.metadata).length > 0;
  const metadataColumn = hasMetadata ? ', metadata' : '';
  const metadataPlaceholder = hasMetadata ? `, $${hasTombstoneFields ? 9 : 7}` : '';
  const metadataUpdate = hasMetadata ? ', metadata = EXCLUDED.metadata' : '';
  const metadataParam = hasMetadata ? [JSON.stringify(media.metadata || {})] : [];
  if (hasTombstoneFields) {
    await query(
      `INSERT INTO catalog_ingredient_media
         (ingredient_id, media_key, kind, role, caption, created_at, deleted, deleted_at${metadataColumn})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8${metadataPlaceholder})
       ON CONFLICT (ingredient_id, media_key, kind) DO UPDATE
         SET role = EXCLUDED.role,
             caption = EXCLUDED.caption,
             deleted = EXCLUDED.deleted,
             deleted_at = EXCLUDED.deleted_at${metadataUpdate}`,
      [
        media.ingredientId, media.mediaKey, media.kind,
        media.role ?? null, media.caption ?? null, media.createdAt,
        !!media.deleted, media.deletedAt || null,
        ...metadataParam,
      ],
    );
  } else {
    await query(
      `INSERT INTO catalog_ingredient_media
         (ingredient_id, media_key, kind, role, caption, created_at${metadataColumn})
       VALUES ($1, $2, $3, $4, $5, $6${metadataPlaceholder})
       ON CONFLICT (ingredient_id, media_key, kind) DO UPDATE
         SET role = EXCLUDED.role, caption = EXCLUDED.caption${metadataUpdate}`,
      [media.ingredientId, media.mediaKey, media.kind, media.role ?? null, media.caption ?? null, media.createdAt, ...metadataParam],
    );
  }
}

export const getTagChangesSince = (since = '0', limit = 100) =>
  getFeedChangesSince('catalog_tags', rowToTag, since, limit);

export async function upsertTagFromPeer(tag) {
  // LWW on updated_at for the mutable fields (description/color/parent_id) +
  // label. `parent_id` may FK to a tag that hasn't arrived yet in this envelope
  // — the receiver orders tags before ingredients, but a parent can still lag a
  // child across pages. We retry parent-less first: NULL the parent on FK
  // violation so the child row still lands, and a later page carrying the
  // parent re-runs this upsert (LWW) to restore the link.
  const apply = async (parentId) => query(
    `INSERT INTO catalog_tags
       (id, label, description, color, parent_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       label = EXCLUDED.label,
       description = EXCLUDED.description,
       color = EXCLUDED.color,
       parent_id = EXCLUDED.parent_id,
       updated_at = EXCLUDED.updated_at
     WHERE EXCLUDED.updated_at > catalog_tags.updated_at
     RETURNING (xmax = 0) AS is_insert`,
    [
      tag.id,
      tag.label,
      tag.description ?? null,
      tag.color ?? null,
      parentId ?? null,
      tag.createdAt,
      tag.updatedAt || tag.createdAt,
    ],
  );
  let result;
  try {
    result = await apply(tag.parentId ?? null);
  } catch (err) {
    // 23503 = foreign_key_violation (parent not present yet). Retry parent-less.
    if (err?.code === '23503' && (tag.parentId ?? null) !== null) {
      result = await apply(null);
    } else {
      throw err;
    }
  }
  return { applied: result.rows.length > 0, isInsert: result.rows[0]?.is_insert ?? false };
}

// Per-stream maximum feed position. Each subquery is a backward scan of the
// (stream, position) index.
export async function getMaxSequences() {
  const maxOf = (stream) =>
    `COALESCE((SELECT MAX(position) FROM sync_feed WHERE stream = '${stream}'), 0)::text`;
  const result = await query(`
    SELECT
      ${maxOf('catalog_ingredients')} AS ingredients,
      ${maxOf('catalog_scraps')} AS scraps,
      ${maxOf('catalog_ingredient_sources')} AS sources,
      ${maxOf('catalog_ingredient_refs')} AS refs,
      ${maxOf('catalog_ingredient_relations')} AS relations,
      ${maxOf('catalog_tags')} AS tags,
      ${maxOf('catalog_ingredient_media')} AS media
  `);
  return result.rows[0];
}

export const getScrapChangesSince = (since = '0', limit = 100) =>
  getFeedChangesSince('catalog_scraps', rowToScrap, since, limit);

export const getIngredientChangesSince = (since = '0', limit = 100) =>
  getFeedChangesSince('catalog_ingredients', rowToIngredient, since, limit);

export const getSourceChangesSince = (since = '0', limit = 100) =>
  getFeedChangesSince('catalog_ingredient_sources', rowToSource, since, limit);

export const getRefChangesSince = (since = '0', limit = 100) =>
  getFeedChangesSince('catalog_ingredient_refs', rowToRef, since, limit);

export async function upsertScrapFromPeer(scrap) {
  // A child scrap (parent_scrap_id set) may arrive in the envelope BEFORE its
  // parent row — the sync apply path sorts parents first within one envelope,
  // but a parent can still lag a child across pagination pages. Mirror the
  // catalog_tags parent-less retry: on FK violation, NULL the parent so the
  // child still lands, and a later page carrying the parent re-runs this upsert
  // (LWW) to restore the link. chunk_index has no FK, so it always rides.
  const apply = async (parentScrapId) => query(
    `INSERT INTO catalog_scraps
       (id, title, raw_text, source_kind, metadata, embedding, embedding_model,
        origin_instance_id, chunk_index, parent_scrap_id,
        created_at, updated_at, deleted, deleted_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title,
       raw_text = EXCLUDED.raw_text,
       source_kind = EXCLUDED.source_kind,
       metadata = EXCLUDED.metadata,
       embedding = EXCLUDED.embedding,
       embedding_model = EXCLUDED.embedding_model,
       chunk_index = EXCLUDED.chunk_index,
       parent_scrap_id = EXCLUDED.parent_scrap_id,
       updated_at = EXCLUDED.updated_at,
       deleted = EXCLUDED.deleted,
       deleted_at = EXCLUDED.deleted_at
     WHERE EXCLUDED.updated_at > catalog_scraps.updated_at
     RETURNING (xmax = 0) AS is_insert`,
    [
      scrap.id,
      scrap.title || null,
      scrap.rawText,
      scrap.sourceKind || 'paste',
      JSON.stringify(scrap.metadata || {}),
      scrap.embedding ? arrayToPgvector(scrap.embedding) : null,
      scrap.embeddingModel || null,
      scrap.originInstanceId || null,
      Number.isInteger(scrap.chunkIndex) ? scrap.chunkIndex : 0,
      parentScrapId,
      scrap.createdAt,
      scrap.updatedAt,
      !!scrap.deleted,
      scrap.deletedAt || null,
    ],
  );
  const parentId = scrap.parentScrapId ?? null;
  let result;
  try {
    result = await apply(parentId);
  } catch (err) {
    // 23503 = foreign_key_violation (parent not present yet). Retry parent-less.
    if (err?.code === '23503' && parentId !== null) {
      result = await apply(null);
    } else {
      throw err;
    }
  }
  return { applied: result.rows.length > 0, isInsert: result.rows[0]?.is_insert ?? false };
}

export async function upsertIngredientFromPeer(ing) {
  const result = await query(
    `INSERT INTO catalog_ingredients
       (id, type, name, payload, tags, embedding, embedding_model,
        origin_instance_id, created_at, updated_at, deleted, deleted_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (id) DO UPDATE SET
       type = EXCLUDED.type,
       name = EXCLUDED.name,
       payload = EXCLUDED.payload,
       tags = EXCLUDED.tags,
       embedding = EXCLUDED.embedding,
       embedding_model = EXCLUDED.embedding_model,
       updated_at = EXCLUDED.updated_at,
       deleted = EXCLUDED.deleted,
       deleted_at = EXCLUDED.deleted_at
     WHERE EXCLUDED.updated_at > catalog_ingredients.updated_at
     RETURNING (xmax = 0) AS is_insert`,
    [
      ing.id,
      ing.type,
      ing.name,
      JSON.stringify(ing.payload || {}),
      ing.tags || [],
      ing.embedding ? arrayToPgvector(ing.embedding) : null,
      ing.embeddingModel || null,
      ing.originInstanceId || null,
      ing.createdAt,
      ing.updatedAt,
      !!ing.deleted,
      ing.deletedAt || null,
    ],
  );
  return { applied: result.rows.length > 0, isInsert: result.rows[0]?.is_insert ?? false };
}

export async function upsertSourceFromPeer(src) {
  await query(
    `INSERT INTO catalog_ingredient_sources (ingredient_id, scrap_id, span, extracted_at)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (ingredient_id, scrap_id) DO UPDATE SET span = EXCLUDED.span`,
    [src.ingredientId, src.scrapId, src.span ? JSON.stringify(src.span) : null, src.extractedAt],
  );
}

export async function upsertRefFromPeer(ref) {
  // ON CONFLICT DO UPDATE so a peer's soft-delete (or revival) of a ref row
  // is mirrored locally. Refs don't carry an `updated_at` column — they're
  // tuple-unique — so a strict LWW window doesn't apply; the receiver simply
  // adopts the peer's `deleted` / `deleted_at` state. The trigger only bumps
  // sync_sequence when those columns change, so a no-op replay (peer already
  // matches local) stays silent on the next outbound pull.
  //
  // Mixed-version federation: a v1 peer (pre-tombstone) emits ref rows with
  // NO `deleted`/`deletedAt` keys. Treat "key absent" as "peer has no opinion"
  // and preserve the local state on conflict — otherwise the v1 payload would
  // coerce missing-to-false and ON CONFLICT DO UPDATE would silently revive
  // a locally tombstoned ref. The `hasTombstoneFields` flag distinguishes this
  // from an explicit v2 revival (`deleted: false` present). On INSERT a v1
  // peer's row defaults to `deleted=false`, which is correct — the row is
  // brand-new locally and the peer believes it's active.
  const hasTombstoneFields =
    Object.prototype.hasOwnProperty.call(ref, 'deleted') ||
    Object.prototype.hasOwnProperty.call(ref, 'deletedAt');
  if (hasTombstoneFields) {
    await query(
      `INSERT INTO catalog_ingredient_refs
         (ingredient_id, ref_kind, ref_id, role, created_at, deleted, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (ingredient_id, ref_kind, ref_id, role) DO UPDATE
         SET deleted = EXCLUDED.deleted,
             deleted_at = EXCLUDED.deleted_at`,
      [
        ref.ingredientId,
        ref.refKind,
        ref.refId,
        ref.role,
        ref.createdAt,
        !!ref.deleted,
        ref.deletedAt || null,
      ],
    );
  } else {
    // v1-shape payload: insert when missing, leave local tombstone state alone
    // on conflict. Matches the original v1 `ON CONFLICT DO NOTHING` semantics.
    await query(
      `INSERT INTO catalog_ingredient_refs
         (ingredient_id, ref_kind, ref_id, role, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (ingredient_id, ref_kind, ref_id, role) DO NOTHING`,
      [ref.ingredientId, ref.refKind, ref.refId, ref.role, ref.createdAt],
    );
  }
}
