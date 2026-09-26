/**
 * Creative Ingredients Catalog — peer-sync change feeds & upserts.
 *
 * The `get*ChangesSince` readers page rows by their commit-ordered feed
 * position (`sync_feed`, #8315 — see server/lib/db/schema/syncFeed.js) for
 * outbound pulls; the `upsert*FromPeer` writers apply an inbound peer's rows. Mixed-
 * version federation is handled per-table: "tombstone keys absent" is treated
 * as "peer has no opinion" so a pre-tombstone peer can't revive a local delete,
 * and FK-lagged children are durably deferred until their parents arrive.
 *
 * The three tuple-unique kinds (refs, relations, media) additionally gate
 * their tombstone/revival apply on an `updated_at` change-clock (#8347): a
 * peer's `deleted`/`deleted_at` only lands when its `updated_at` is strictly
 * newer than the local row's, so a stale re-send of a still-live row (a
 * reset rewind, a role/data resend, or the #8315 upgrade replay that resends
 * every catalog row once) can't revive a tombstone that happened after the
 * peer's own clock. See `upsertRefFromPeer` for the full rationale.
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
    // #8347 revival guard: `updated_at` is the tombstone/revival change-clock
    // (bumped by the trg_catalog_relation_sync_seq trigger on every
    // deleted/deleted_at flip — see catalog.js). Gate the apply on it being
    // strictly newer than the local row's, the same LWW shape as
    // upsertTagFromPeer, so a stale re-send of a still-live edge (a reset
    // rewind, a role/data resend, or the #8315 upgrade replay) can't revive a
    // local unlink that already happened. A peer that predates this field
    // (`rel.updatedAt` absent) falls back to its `deletedAt`/`createdAt`,
    // which is always older than a genuine later local tombstone.
    const updatedAtClock = rel.updatedAt || rel.deletedAt || rel.createdAt;
    await query(
      `INSERT INTO catalog_ingredient_relations
         (from_id, to_id, kind, created_at, deleted, deleted_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (from_id, to_id, kind) DO UPDATE
         SET deleted = EXCLUDED.deleted,
             deleted_at = EXCLUDED.deleted_at,
             updated_at = EXCLUDED.updated_at
       WHERE EXCLUDED.updated_at > catalog_ingredient_relations.updated_at`,
      [rel.fromId, rel.toId, rel.kind, rel.createdAt, !!rel.deleted, rel.deletedAt || null, updatedAtClock],
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
  const metadataPlaceholder = hasMetadata ? `, $${hasTombstoneFields ? 10 : 7}` : '';
  const metadataUpdate = hasMetadata ? ', metadata = EXCLUDED.metadata' : '';
  const metadataParam = hasMetadata ? [JSON.stringify(media.metadata || {})] : [];
  if (hasTombstoneFields) {
    // #8347 revival guard — see upsertRelationFromPeer for the rationale.
    // `updated_at` also moves on a role/caption/metadata-only edit (the
    // media trigger watches those too), so the same guard additionally
    // protects a live edit from a stale peer resend, not just a tombstone.
    const updatedAtClock = media.updatedAt || media.deletedAt || media.createdAt;
    await query(
      `INSERT INTO catalog_ingredient_media
         (ingredient_id, media_key, kind, role, caption, created_at, deleted, deleted_at, updated_at${metadataColumn})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9${metadataPlaceholder})
       ON CONFLICT (ingredient_id, media_key, kind) DO UPDATE
         SET role = EXCLUDED.role,
             caption = EXCLUDED.caption,
             deleted = EXCLUDED.deleted,
             deleted_at = EXCLUDED.deleted_at,
             updated_at = EXCLUDED.updated_at${metadataUpdate}
       WHERE EXCLUDED.updated_at > catalog_ingredient_media.updated_at`,
      [
        media.ingredientId, media.mediaKey, media.kind,
        media.role ?? null, media.caption ?? null, media.createdAt,
        !!media.deleted, media.deletedAt || null, updatedAtClock,
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
  // Never materialize a child with a different parent: an equal-clock replay
  // cannot repair that under LWW. Persist the complete row on missing-parent FK.
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
    // A durable inbox write must succeed before this row is cursor-safe.
    if (err?.code === '23503' && err.constraint === 'catalog_tags_parent_id_fkey' && (tag.parentId ?? null) !== null) {
      await deferParentApply('tags', tag, tag.parentId, tag.updatedAt || tag.createdAt);
      return { applied: false, isInsert: false, deferred: true };
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
  // Cross-page children remain in the durable inbox, not the top-level list.
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
    // A durable inbox write must succeed before this row is cursor-safe.
    if (err?.code === '23503' && err.constraint === 'catalog_scraps_parent_scrap_id_fkey' && parentId !== null) {
      await deferParentApply('scraps', scrap, parentId, scrap.updatedAt);
      return { applied: false, isInsert: false, deferred: true };
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
  // is mirrored locally. Refs are tuple-unique (no editable content fields),
  // so `updated_at` exists ONLY as a tombstone/revival change-clock (#8347),
  // bumped by trg_catalog_ref_sync_seq whenever deleted/deleted_at flips —
  // never by a content edit, since there is no other mutable field. The
  // WHERE guard below rejects a stale apply whose clock isn't strictly newer
  // than the local row's, so a stale re-send of a still-live ref (a reset
  // rewind or the #8315 upgrade replay resending every row once) can't
  // silently revive a tombstone that happened after the peer's clock. A
  // no-op replay (peer already matches local) still bumps nothing new, so
  // it stays silent on the next outbound pull.
  //
  // Mixed-version federation: a v1 peer (pre-tombstone) emits ref rows with
  // NO `deleted`/`deletedAt` keys. Treat "key absent" as "peer has no opinion"
  // and preserve the local state on conflict — otherwise the v1 payload would
  // coerce missing-to-false and ON CONFLICT DO UPDATE would silently revive
  // a locally tombstoned ref. The `hasTombstoneFields` flag distinguishes this
  // from an explicit v2 revival (`deleted: false` present). On INSERT a v1
  // peer's row defaults to `deleted=false`, which is correct — the row is
  // brand-new locally and the peer believes it's active. A peer that carries
  // tombstone fields but predates the `updatedAt` wire field (a v2-but-not-v3
  // sender, which cannot occur once every peer ships this fix) falls back to
  // its `deletedAt`/`createdAt`, which is always older than a genuine later
  // local tombstone.
  const hasTombstoneFields =
    Object.prototype.hasOwnProperty.call(ref, 'deleted') ||
    Object.prototype.hasOwnProperty.call(ref, 'deletedAt');
  if (hasTombstoneFields) {
    const updatedAtClock = ref.updatedAt || ref.deletedAt || ref.createdAt;
    await query(
      `INSERT INTO catalog_ingredient_refs
         (ingredient_id, ref_kind, ref_id, role, created_at, deleted, deleted_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (ingredient_id, ref_kind, ref_id, role) DO UPDATE
         SET deleted = EXCLUDED.deleted,
             deleted_at = EXCLUDED.deleted_at,
             updated_at = EXCLUDED.updated_at
       WHERE EXCLUDED.updated_at > catalog_ingredient_refs.updated_at`,
      [
        ref.ingredientId,
        ref.refKind,
        ref.refId,
        ref.role,
        ref.createdAt,
        !!ref.deleted,
        ref.deletedAt || null,
        updatedAtClock,
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

// The inbox is db-primary, receiver-local, and covered by the normal DB backup.
// Its key coalesces duplicate delivery; source clocks prevent an older replay
// from replacing a newer deferred edit. No success is returned before commit.
async function deferParentApply(kind, row, parentId, updatedAt) {
  await query(
    `INSERT INTO catalog_pending_applies (kind, id, parent_id, source_updated_at, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (kind, id) DO UPDATE SET
       parent_id = EXCLUDED.parent_id,
       source_updated_at = EXCLUDED.source_updated_at,
       payload = EXCLUDED.payload
     WHERE EXCLUDED.source_updated_at > catalog_pending_applies.source_updated_at`,
    [kind, row.id, parentId, updatedAt, JSON.stringify(row)],
  );
}

export async function drainPendingCatalogApplies() {
  // No in-memory ownership: every apply (even an empty page after restart)
  // recovers ready rows. Iterate so a multi-level hierarchy drains completely.
  for (const [kind, table, upsert] of [
    ['tags', 'catalog_tags', upsertTagFromPeer],
    ['scraps', 'catalog_scraps', upsertScrapFromPeer],
  ]) {
    let progressed;
    do {
      progressed = false;
      const { rows } = await query(
        `SELECT p.id, p.payload FROM catalog_pending_applies p
         WHERE p.kind = $1 AND (
           EXISTS (SELECT 1 FROM ${table} parent WHERE parent.id = p.parent_id)
           OR EXISTS (SELECT 1 FROM ${table} current
                      WHERE current.id = p.id AND current.updated_at >= p.source_updated_at))
         ORDER BY p.id LIMIT 100`,
        [kind],
      );
      for (const pending of rows) {
        const result = await upsert(pending.payload);
        if (result.deferred) continue; // parent deleted since the readiness query
        // Crash after apply is safe (LWW replay); compare payload so concurrent
        // delivery of a newer deferred edit cannot be deleted by this drain.
        const removed = await query(
          `DELETE FROM catalog_pending_applies
           WHERE kind = $1 AND id = $2 AND payload = $3::jsonb`,
          [kind, pending.id, JSON.stringify(pending.payload)],
        );
        progressed ||= removed.rowCount > 0;
      }
    } while (progressed);
  }
}
