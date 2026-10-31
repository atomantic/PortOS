/**
 * Creative Ingredients Catalog — ingredient CRUD, revisions & search.
 *
 * catalog_ingredients + catalog_ingredient_revisions: the typed catalog rows
 * (characters/places/objects/ideas/scenes/concepts) and their per-edit history.
 * Also the FTS / vector / hybrid (RRF) search paths over the ingredient corpus.
 */

import { isDeepStrictEqual } from 'node:util';
import { query, withTransaction, arrayToPgvector } from '../../lib/db.js';
import { reciprocalRankFusion } from '../../lib/rrfRanking.js';
import {
  getActiveCatalogType,
  currentPayloadSchemaVersion,
  defaultTagsForType,
} from '../../lib/catalogTypes.js';
import { getInstanceId } from '../instanceIdentity.js';
import {
  newIngredientId,
  newRevisionId,
  sanitizeBiblePayload,
  BIBLE_SANITIZERS,
  CATALOG_REVISION_RETENTION,
  REVISION_SOURCES,
  rowToIngredient,
  rowToRevision,
  CANONICAL_REFS_CTE,
  inSet,
  HAS_LIVE_HOMING_REF,
  HAS_ANY_HOMING_REF,
  HOMING_REF_KINDS_SQL,
  liveHomingTargetSql,
  STORYBOARD_PANEL_MEMBERS_SQL,
} from './shared.js';
import { normalizeTags } from './tags.js';
import { assertCatalogIdentityWritable, getCatalogIdentityAccessForIds } from './identityAccess.js';
import { toPgJson } from '../../lib/pgJson.js';
import { ServerError } from '../../lib/errorHandler.js';

// Write ONE payload key under the row lock: a card or a side panel must never
// write a stale whole payload, sanitize legacy fields away, or spend an
// embedding call. `guard(current)` may throw to refuse by type; `null` clears
// the key. Returns null for a missing row.
export async function setIngredientPayloadKey(id, key, value, { source = 'user', guard } = {}) {
  return withTransaction(async client => {
    await assertCatalogIdentityWritable(id, { client });
    const { rows: [current] } = await client.query(`SELECT * FROM catalog_ingredients
      WHERE id = catalog_canonical_ingredient_id($1) AND deleted = false FOR UPDATE`, [id]);
    if (!current) return null;
    guard?.(current);
    if (isDeepStrictEqual(current.payload?.[key], value ?? undefined)) return rowToIngredient(current);
    const { rows: [row] } = value === null
      ? await client.query('UPDATE catalog_ingredients SET payload = payload - $2::text WHERE id = $1 RETURNING *', [current.id, key])
      : await client.query(`UPDATE catalog_ingredients
          SET payload = jsonb_set(COALESCE(payload, '{}'::jsonb), ARRAY[$2::text], $3::jsonb, true)
          WHERE id = $1 RETURNING *`, [current.id, key, toPgJson(value)]);
    const updated = rowToIngredient(row);
    await recordIngredientRevision(updated, { source, client });
    return updated;
  });
}

// Like setIngredientPayloadKey for several keys in one locked write:
// `update(lockedPayload)` returns `{ key: value }` changes (`null` removes a
// key), so a multi-key edit either lands whole or not at all. Returns
// `{ ingredient, priorUpdatedAt }`, the latter being the locked row's clock
// just before this write, or null for a missing row.
export async function updateIngredientPayloadKeys(id, update, { source = 'user', guard } = {}) {
  return withTransaction(async client => {
    await assertCatalogIdentityWritable(id, { client });
    const { rows: [current] } = await client.query(`SELECT * FROM catalog_ingredients
      WHERE id = catalog_canonical_ingredient_id($1) AND deleted = false FOR UPDATE`, [id]);
    if (!current) return null;
    guard?.(current);
    const priorUpdatedAt = rowToIngredient(current).updatedAt;
    const payload = current.payload && typeof current.payload === 'object' ? current.payload : {};
    const next = { ...payload };
    for (const [key, value] of Object.entries(update(payload) || {})) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    if (isDeepStrictEqual(next, payload)) return { ingredient: rowToIngredient(current), priorUpdatedAt };
    const { rows: [row] } = await client.query('UPDATE catalog_ingredients SET payload = $2::jsonb WHERE id = $1 RETURNING *',
      [current.id, toPgJson(next)]);
    const ingredient = rowToIngredient(row);
    await recordIngredientRevision(ingredient, { source, client });
    return { ingredient, priorUpdatedAt };
  });
}

export const setIngredientLock = (id, locked) => setIngredientPayloadKey(id, 'locked', locked, {
  guard: (current) => {
    if (!BIBLE_SANITIZERS[current.type]) throw new ServerError('This ingredient type has no canon lock', { status: 400 });
  },
});

// `{ client }` is optional — when supplied, SQL runs on the caller's transaction
// client (so the write rolls back if a later step in the same `withTransaction`
// block throws). Standalone creates own a transaction including tags and history.
// See `POST /api/catalog/scraps/:id/commit` for the scrap-commit batch that
// needs every per-draft ingredient + source-link to commit-or-rollback together.
export async function createIngredient({ id: explicitId, type, name, payload = {}, tags = [], embedding = null, embeddingModel = null } = {}, { client, source = 'user', actor = null } = {}) {
  if (!type || !getActiveCatalogType(type)) throw new Error(`Invalid ingredient type: ${type}`);
  if (!name || !String(name).trim()) throw new Error('name is required');

  if (!client) {
    return withTransaction((tx) => createIngredient(
      { id: explicitId, type, name, payload, tags, embedding, embeddingModel },
      { client: tx, source, actor },
    ));
  }

  // `explicitId` is used by the backfill when a universe arrives from a peer
  // already carrying an ingredientId — preserves cross-peer identity so the
  // same logical character has the same catalog id on every install. New
  // user-initiated creates omit it and we mint a fresh prefix:uuid.
  const id = explicitId || newIngredientId(type);
  // Bible-type hardening: run character/place/object payloads through their
  // storyBible sanitizer before persist so the structured array editors (color
  // palette / stats / aliases) can't land malformed rows and the catalog↔canon
  // projection stays shape-stable. Non-bible / user types pass through.
  const sanitizedPayload = sanitizeBiblePayload(type, name, payload);
  // Stamp the per-record payload-shape version from the registry so a later
  // `migrateCatalogPayload` run knows which shape this row was written in.
  // An incoming payload may already carry `schemaVersion` (peer backfill) — we
  // overwrite with the LOCAL registry-current value so the stored marker
  // reflects the shape this install's code actually wrote, not a stale sender
  // claim. (The wire `PORTOS_SCHEMA_VERSIONS.catalog` gate covers cross-install
  // skew; this is the per-record payload-shape marker, distinct from that.)
  const storedPayload = { ...sanitizedPayload, schemaVersion: currentPayloadSchemaVersion(type) };
  const originInstanceId = await getInstanceId();
  const exec = client.query.bind(client);
  // Route freeform tags through the canonical catalog_tags table (creating
  // rows on first use) and seed the type's registry default tags. The freeform
  // TEXT[] column stores the canonical labels so existing tag-search/GIN paths
  // keep working unchanged.
  const normalizedTags = await normalizeTags([...defaultTagsForType(type), ...(tags || [])], { client });
  const result = await exec(
    `INSERT INTO catalog_ingredients
       (id, type, name, payload, tags, embedding, embedding_model, origin_instance_id)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
     RETURNING *`,
    [
      id,
      type,
      String(name).trim(),
      toPgJson(storedPayload),
      normalizedTags,
      embedding ? arrayToPgvector(embedding) : null,
      embeddingModel,
      originInstanceId,
    ],
  );
  const created = rowToIngredient(result.rows[0]);
  // Seed an initial revision so the history list shows the original state and a
  // restore can always return to "as created". Runs on the same transaction
  // client when one was supplied (scrap-commit batch) so a mid-batch rollback
  // drops the seed revision alongside its ingredient.
  await recordIngredientRevision(created, { source, actor, client });
  return created;
}

export async function getIngredient(id, { client } = {}) {
  const exec = client ? client.query.bind(client) : query;
  const result = await exec(
    `SELECT * FROM catalog_ingredients WHERE id = catalog_canonical_ingredient_id($1) AND deleted = false`,
    [id],
  );
  return rowToIngredient(result.rows[0]);
}

// All stable IDs belonging to a local consolidated identity. The source row
// stays live for peers; callers can match embedded IDs without rewriting canon.
export async function getIngredientIdentityIds(id) {
  const { rows } = await query('SELECT unnest(catalog_identity_member_ids($1)) AS id', [id]);
  return rows.map(row => row.id);
}

/**
 * Batched freshness lookup for LWW comparisons (#3941) — ONE query for N ids
 * instead of N `getIngredient` round-trips. Returns
 * `Map<id, updatedAt ISO string>` holding an entry ONLY for live (non-deleted)
 * rows, so a MISSING key means "no such row" — distinct from a row that exists
 * and happens to be stale. Selects two columns, not `*`: the canon→catalog
 * projection needs existence + freshness, never the jsonb payload.
 */
export async function getIngredientTimestamps(ingredientIds, { excludeAliases = false } = {}) {
  const ids = [...new Set((ingredientIds || []).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const result = await query(
    `SELECT requested.id, i.updated_at FROM unnest($1::text[]) AS requested(id)
     JOIN catalog_ingredients i ON i.id = catalog_canonical_ingredient_id(requested.id) AND i.deleted = false${excludeAliases ? ` AND requested.id = i.id AND NOT EXISTS (SELECT 1 FROM catalog_identity_operations o
       WHERE (o.source_id = i.id OR o.survivor_id = i.id) AND
       (o.state IN ('prepared', 'recovery_prepared') OR (o.state = 'committed' AND o.local_owner <> o.survivor_owner)))` : ''}`,
    [ids],
  );
  return new Map(result.rows.map((row) => [row.id, row.updated_at.toISOString()]));
}

// `{ source, actor }` drive the revision-history row written on a content
// change. `source` is one of user|extract|refine|sync (default 'user'); `actor`
// is an optional free label (agent run id, provider). Embedding-only patches
// (the backfill path) carry no name/payload/tags and so record NO revision.
export async function updateIngredient(id, patch = {}, { client, source = 'user', actor = null } = {}) {
  const touchedContent =
    patch.name !== undefined || patch.payload !== undefined || patch.tags !== undefined;
  // Share one commit boundary for tags, content, snapshot and retention. A
  // caller-owned transaction must never nest or escape through the pool.
  if (touchedContent && !client) {
    return withTransaction((tx) => updateIngredient(id, patch, { client: tx, source, actor }));
  }
  id = await assertCatalogIdentityWritable(id, { client });
  const exec = client ? client.query.bind(client) : query;
  const fields = [];
  const params = [];
  let idx = 1;
  // Normalize freeform tags through the canonical table on edit too — a user
  // adding `Noir` reuses the existing `noir` row instead of accumulating a
  // casing variant. `tags: []` (intentional clear) round-trips as an empty
  // array; absent `tags` skips normalization entirely (the loop below skips it).
  let normalizedPatch = patch.tags !== undefined
    ? { ...patch, tags: await normalizeTags(patch.tags, { client }) }
    : patch;
  // Bible-type hardening: when a character/place/object payload is being
  // written, run it through the storyBible sanitizer (the same one the canon
  // surface uses) so the array editors can't land malformed rows and the
  // catalog↔canon projection round-trip stays shape-stable. Look up the current
  // row for its `type` (and `name`, when the patch doesn't carry one). Scoped
  // to `extractionShape: 'bible'` types via BIBLE_SANITIZERS — idea/scene/
  // concept and user-defined types skip this entirely. Embedding-only patches
  // (no payload) never trigger the lookup.
  if (normalizedPatch.payload !== undefined) {
    const current = await getIngredient(id, { client });
    if (current && BIBLE_SANITIZERS[current.type]) {
      const name = normalizedPatch.name !== undefined ? normalizedPatch.name : current.name;
      normalizedPatch = {
        ...normalizedPatch,
        payload: sanitizeBiblePayload(current.type, name, normalizedPatch.payload),
      };
    }
  }
  const fieldMap = {
    name: 'name',
    payload: 'payload',
    tags: 'tags',
    embedding: 'embedding',
    embeddingModel: 'embedding_model',
  };
  for (const [jsField, dbField] of Object.entries(fieldMap)) {
    if (normalizedPatch[jsField] === undefined) continue;
    if (jsField === 'payload') {
      fields.push(`${dbField} = $${idx++}::jsonb`);
      params.push(toPgJson(normalizedPatch.payload || {}));
    } else if (jsField === 'embedding') {
      fields.push(`${dbField} = $${idx++}`);
      params.push(normalizedPatch.embedding ? arrayToPgvector(normalizedPatch.embedding) : null);
    } else {
      fields.push(`${dbField} = $${idx++}`);
      params.push(normalizedPatch[jsField]);
    }
  }
  if (fields.length === 0) return getIngredient(id, { client });
  params.push(id);
  // Mirrors updateScrap: PATCH on a soft-deleted row returns zero rows so the
  // route 404s. Revival of soft-deleted rows is intentionally separate via
  // `reviveDeletedIngredient`, so this filter doesn't conflict with that path.
  const result = await exec(
    `UPDATE catalog_ingredients SET ${fields.join(', ')} WHERE id = catalog_resolve_ingredient_id($${idx}) AND deleted = false RETURNING *`,
    params,
  );
  const updated = rowToIngredient(result.rows[0]);

  // Record a revision only when a USER-facing field (name/payload/tags) was
  // part of this patch AND the row actually exists/updated. Embedding/model-
  // only patches skip history entirely. Snapshot the stored payload verbatim
  // so a restore round-trips the exact shape, including its schemaVersion.
  if (updated && touchedContent) {
    await recordIngredientRevision(updated, { source, actor, client });
  }
  return updated;
}

/**
 * Conditional content write for a source that carries its own clock (the
 * canon→catalog projection and the boot reconciler, #12503). A batched
 * freshness snapshot read earlier is only an optimization: this re-reads the
 * target row's clock under `FOR UPDATE` inside the write transaction, so the
 * sanitize read, the UPDATE and the revision all see the locked row and a
 * catalog edit committed after the snapshot can no longer be overwritten.
 *
 * Writes only when `sourceUpdatedAt` is at least as fresh as the live row
 * (millisecond precision, matching the ISO clocks callers compare). `priorWrite`
 * — `{ syncSequence, sourceUpdatedAt }` from this caller's own earlier result —
 * lets a multi-step pass supersede the row it wrote itself: the trigger stamps
 * NOW() on that write, so the live clock alone would reject a newer sibling.
 * The trigger also bumps `sync_sequence` on every content change, so a match
 * proves nobody else wrote since.
 *
 * Returns `{ status: 'written' | 'stale' | 'missing', ingredient }`.
 */
export async function updateIngredientIfFresh(id, patch, { sourceUpdatedAt, priorWrite = null, source = 'user', actor = null } = {}) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT updated_at, sync_sequence FROM catalog_ingredients
        WHERE id = catalog_resolve_ingredient_id($1) AND deleted = false FOR UPDATE`,
      [id],
    );
    if (rows.length === 0) return { status: 'missing', ingredient: null };
    const ownRow = priorWrite?.syncSequence != null && String(rows[0].sync_sequence) === String(priorWrite.syncSequence);
    const rowAt = ownRow ? Date.parse(priorWrite.sourceUpdatedAt || '') || 0 : Date.parse(rows[0].updated_at.toISOString());
    if ((Date.parse(sourceUpdatedAt || '') || 0) < rowAt) return { status: 'stale', ingredient: null };
    const ingredient = await updateIngredient(id, patch, { client, source, actor });
    return ingredient ? { status: 'written', ingredient } : { status: 'missing', ingredient: null };
  });
}

/**
 * Insert one revision row capturing the committed state of an ingredient, then
 * prune the ingredient's history to the most-recent CATALOG_REVISION_RETENTION
 * rows. Called from updateIngredient (content changes) and createIngredient's
 * seed path. `{ client }` runs the insert on a caller transaction when present.
 */
export async function recordIngredientRevision(ingredient, { source = 'user', actor = null, client } = {}) {
  if (!ingredient?.id) return null;
  const src = REVISION_SOURCES.has(source) ? source : 'user';
  const exec = client ? client.query.bind(client) : query;
  const result = await exec(
    `INSERT INTO catalog_ingredient_revisions
       (id, ingredient_id, name, payload, tags, source, actor)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
     RETURNING *`,
    [
      newRevisionId(),
      ingredient.id,
      ingredient.name,
      toPgJson(ingredient.payload || {}),
      ingredient.tags || [],
      src,
      actor ? String(actor).slice(0, 120) : null,
    ],
  );
  // Prune to the retention cap. Keep the newest N by created_at (tie-break on
  // id so a same-millisecond burst prunes deterministically). DELETE the rest.
  await exec(
    `DELETE FROM catalog_ingredient_revisions
      WHERE ingredient_id = $1
        AND id NOT IN (
          SELECT id FROM catalog_ingredient_revisions
           WHERE ingredient_id = $1
           ORDER BY created_at DESC, id DESC
           LIMIT $2
        )`,
    [ingredient.id, CATALOG_REVISION_RETENTION],
  );
  return rowToRevision(result.rows[0]);
}

export async function listIngredientRevisions(ingredientId, { limit = 50, offset = 0 } = {}) {
  const result = await query(
    `SELECT * FROM catalog_identity_read_revisions
      WHERE ingredient_id = ANY(catalog_identity_member_ids($1))
      ORDER BY created_at DESC, id DESC
      LIMIT $2 OFFSET $3`,
    [ingredientId, Math.min(Math.max(limit, 1), 200), Math.max(offset, 0)],
  );
  return { items: result.rows.map(rowToRevision), nextOffset: offset + result.rows.length };
}

export async function getIngredientRevision(revisionId) {
  const result = await query(
    `SELECT * FROM catalog_identity_read_revisions WHERE id = $1`,
    [revisionId],
  );
  return rowToRevision(result.rows[0]);
}

export async function deleteIngredient(id, { hard = false } = {}) {
  id = await assertCatalogIdentityWritable(id);
  if (hard) {
    await query(`DELETE FROM catalog_ingredients WHERE id = $1`, [id]);
  } else {
    await query(
      `UPDATE catalog_ingredients SET deleted = true, deleted_at = NOW() WHERE id = $1`,
      [id],
    );
  }
  return { success: true, id };
}

/**
 * Un-delete a soft-deleted ingredient row at a deterministic id and replace
 * its `name`/`payload`/`tags`/`type` with the current values. Used only by
 * the bible→catalog backfill — `getIngredient(id)` filters `deleted = false`,
 * so without this an INSERT at the deterministic id collides on the PK and
 * the migration silently re-fails on every boot. Returns the revived row, or
 * `null` if no row exists at that id (caller falls through to plain INSERT).
 */
export async function reviveDeletedIngredient(id, { type, name, payload = {}, tags = [] } = {}) {
  if (!type || !getActiveCatalogType(type)) throw new Error(`reviveDeletedIngredient: invalid type ${type}`);
  if (!name || !String(name).trim()) throw new Error('reviveDeletedIngredient: name required');
  id = await assertCatalogIdentityWritable(id);
  // Re-stamp the payload schemaVersion on revive — the revived row is being
  // rewritten with a fresh payload, so it gets this install's current marker
  // (mirrors createIngredient).
  const storedPayload = { ...(payload && typeof payload === 'object' ? payload : {}), schemaVersion: currentPayloadSchemaVersion(type) };
  const result = await query(
    `UPDATE catalog_ingredients
        SET deleted = false, deleted_at = NULL,
            type = $2, name = $3, payload = $4::jsonb, tags = $5
      WHERE id = $1 AND deleted = true
      RETURNING *`,
    [id, type, String(name).trim(), toPgJson(storedPayload), tags || []],
  );
  return result.rows.length > 0 ? rowToIngredient(result.rows[0]) : null;
}

// `includeEmbedding: false` (the default for list paths) strips the 768-float
// vector column from the SELECT — each row's embedding is ~6KB stringified, so
// a 200-row page would otherwise ship >1MB the UI never displays. The detail
// endpoint sets includeEmbedding: true.
// `embeddingMissing: true` is for the backfill admin path so SQL filters
// directly instead of fetching-then-JS-filtering.
const INGREDIENT_LIGHT_COLS = 'id, type, name, payload, tags, embedding_model, origin_instance_id, created_at, updated_at, deleted, deleted_at, sync_sequence';

// Card decorations for one already-limited page, in one grouped pass over each
// identity read view (#12989 — a per-row correlated subquery re-evaluated the
// whole view for every row). Light list path only (see listIngredients).
//  - thumbnail_key: the live portrait when set, otherwise the most recent live
//    reference image. Mirrors listMediaForIngredient's `(kind='portrait') DESC,
//    created_at DESC` ordering so the card shows the detail page's avatar.
//    Non-image kinds are excluded so a card never points an <img> at an
//    unrenderable key, looks, archives and plates are excluded. Reference sheets are a fallback
//    when no portrait or ordinary reference exists.
//  - ref_usage: per-kind count of the distinct records the row is linked to
//    ({ universe: 1, series: 2 }) for the "used in" line; a homing kind counts
//    only live targets.
async function decorateIngredientPage(ids) {
  if (ids.length === 0) return new Map();
  const result = await query(
    `WITH page AS (SELECT DISTINCT unnest($1::text[]) AS id),
     usage AS (
       SELECT cid, jsonb_object_agg(ref_kind, n) AS ref_usage FROM (
         SELECT r.cid, r.ref_kind, COUNT(DISTINCT r.ref_id) AS n
           FROM (SELECT catalog_canonical_ingredient_id(ingredient_id) AS cid, ref_kind, ref_id
                   FROM catalog_identity_read_refs WHERE deleted = false AND NOT (ref_kind = 'universe' AND role = 'owner')) r
          WHERE ${inSet('r.cid', 'SELECT id FROM page')}
            AND (r.ref_kind NOT IN (${HOMING_REF_KINDS_SQL}) OR ${liveHomingTargetSql('r')})
          GROUP BY r.cid, r.ref_kind
       ) u GROUP BY cid
     ),
     owners AS (
       SELECT ingredient_id AS id, COUNT(DISTINCT ref_id) AS n, MIN(ref_id) AS universe_id
         FROM catalog_identity_read_refs
        WHERE ref_kind = 'universe' AND role = 'owner' AND deleted = false
          AND ingredient_id = catalog_canonical_ingredient_id(ingredient_id)
          AND ingredient_id = ANY($1)
        GROUP BY ingredient_id
     ),
     thumbs AS (
       SELECT DISTINCT ON (m.cid) m.cid, m.media_key
         FROM (SELECT catalog_canonical_ingredient_id(ingredient_id) AS cid, media_key, kind, role, created_at
                 FROM catalog_identity_read_media
                WHERE deleted = false AND kind IN ('portrait', 'reference')
                  AND (role IS NULL OR NOT (role LIKE 'look:%' OR role LIKE 'archive:%' OR role = 'plate'
                    OR (role LIKE 'design:%' AND COALESCE(library->>'guide', '') <> 'true')))) m
        WHERE ${inSet('m.cid', 'SELECT id FROM page')}
        ORDER BY m.cid, (m.kind = 'portrait') DESC, COALESCE(m.role LIKE 'sheet:%', false), m.created_at DESC
     )
     SELECT page.id, thumbs.media_key AS thumbnail_key, usage.ref_usage,
       CASE WHEN owners.n = 1 AND u.id IS NOT NULL THEN jsonb_build_object('id', u.id, 'name', u.name) ELSE NULL END AS owning_universe,
       CASE WHEN owners.n > 1 THEN 'conflict' WHEN owners.n = 1 AND u.id IS NOT NULL THEN 'owned' ELSE 'needs-review' END AS ownership_status
       FROM page LEFT JOIN thumbs ON thumbs.cid = page.id LEFT JOIN usage ON usage.cid = page.id
       LEFT JOIN owners ON owners.id = page.id LEFT JOIN universes u ON u.id = owners.universe_id AND u.deleted = false`,
    [ids],
  );
  return new Map(result.rows.map((row) => [row.id, row]));
}

export async function listIngredients({ ids, type, tag, query: q, refKind = null, refId = null, unlinked = false, orphaned = false, scrapId = null, limit = 50, offset = 0, includeEmbedding = false, embeddingMissing = false, staleEmbeddingModel = null } = {}) {
  const conditions = ['deleted = false', 'id = catalog_canonical_ingredient_id(id)'];
  const params = [];
  let idx = 1;
  // Batch-fetch by id (Story Builder catalog→series linking, #1761). When
  // present, `ids` takes precedence over type/tag/q — they're skipped so the
  // caller gets exactly the requested (still non-deleted) rows.
  const byIds = Array.isArray(ids) && ids.length > 0;
  let qIdx = null;
  // Set by any filter that reads canonical_refs (CANONICAL_REFS_CTE).
  let needsRefs = false;
  if (byIds) {
    conditions.push(`id IN (SELECT catalog_canonical_ingredient_id(requested) FROM unnest($${idx++}::text[]) requested)`);
    params.push(ids);
  } else {
    if (type) {
      conditions.push(`type = $${idx++}`);
      params.push(type);
    }
    if (tag) {
      conditions.push(`$${idx++} = ANY(tags)`);
      params.push(tag);
    }
    if (q) {
      qIdx = idx++;
      conditions.push(`search_tsv @@ websearch_to_tsquery('english', $${qIdx})`);
      params.push(q);
    }
    // Album/facet filters (#1762). A set-membership test (not a JOIN) so a row
    // linked under multiple roles isn't duplicated — no DISTINCT needed — over
    // the statement-level canonical_refs CTE, so the read view is evaluated once
    // per statement, not once per row (#12989). Composes with type/tag/q above.
    // `unlinked` and `orphaned` are mutually exclusive views of the un-homed
    // set; the route schema rejects combining them with ref.
    if (refKind === 'universe' && refId) {
      // A universe album/filter is the universe's WHOLE membership: ingredients
      // linked directly to the universe OR to any live series under it (decision
      // #1 — the series dropdown narrows *within* the universe, so a series-only
      // ingredient must still land in its parent universe). $refId is referenced
      // twice via one placeholder.
      const refIdx = idx++;
      needsRefs = true;
      conditions.push(inSet('id', `SELECT r.cid FROM canonical_refs r
        WHERE (r.ref_kind = 'universe' AND r.ref_id = $${refIdx})
            OR (r.ref_kind = 'series' AND r.ref_id IN (
                  SELECT id FROM pipeline_series WHERE universe_id = $${refIdx} AND deleted = false))`));
      params.push(refId);
    } else if (refKind === 'storyboard' && refId) {
      // A storyboard story is its `storyboard` refs plus the records its panels use.
      const refIdx = idx++;
      needsRefs = true;
      conditions.push(inSet('id', `SELECT r.cid FROM canonical_refs r WHERE r.ref_kind = 'storyboard' AND r.ref_id = $${refIdx}
        UNION SELECT pm.cid FROM (${STORYBOARD_PANEL_MEMBERS_SQL}) pm WHERE pm.board_id = $${refIdx}`));
      params.push(refId);
    } else if (refKind && refId) {
      needsRefs = true;
      conditions.push(inSet('id', `SELECT r.cid FROM canonical_refs r WHERE r.ref_kind = $${idx++} AND r.ref_id = $${idx++}`));
      params.push(refKind, refId);
    } else if (unlinked) {
      // "Unsorted / Raw": no universe/series ref at all.
      needsRefs = true;
      conditions.push(`NOT (${HAS_ANY_HOMING_REF})`);
    } else if (orphaned) {
      // "Orphaned": has a universe/series ref, but none resolve to a live target.
      needsRefs = true;
      conditions.push(HAS_ANY_HOMING_REF);
      conditions.push(`NOT (${HAS_LIVE_HOMING_REF})`);
    }
  }
  // Source-scrap filter (#7617): "everything extracted from this piece" — a
  // provenance dimension independent of the ids/type/tag/q/ref branches above,
  // so it composes with any of them (unlike unlinked/orphaned/refKind, which
  // are mutually exclusive album views enforced at the schema level).
  // One hashed pass over the sources read view (#12989).
  if (scrapId) {
    conditions.push(inSet('id', `SELECT catalog_canonical_ingredient_id(cis.ingredient_id)
      FROM catalog_identity_read_sources cis WHERE cis.scrap_id = $${idx++}`));
    params.push(scrapId);
  }
  if (embeddingMissing) {
    conditions.push('embedding IS NULL');
  }
  // Re-embed admin path: catch rows that have an embedding but were created
  // under a different provider/model. Without this, a settings change leaves
  // every prior row in the wrong vector space, silently degrading search.
  if (staleEmbeddingModel) {
    conditions.push(`(embedding IS NULL OR embedding_model IS DISTINCT FROM $${idx++})`);
    params.push(staleEmbeddingModel);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  // ORDER BY must reference q's actual param index — when type/tag is also
  // present, q is not $1 and a hardcoded $1 would rank against the type literal.
  const orderBy = qIdx
    ? `ORDER BY ts_rank_cd(search_tsv, websearch_to_tsquery('english', $${qIdx})) DESC, created_at DESC`
    : `ORDER BY created_at DESC`;
  params.push(limit, offset);
  // Card decorations (thumbnailKey, usage) are computed for the returned page
  // only, and only on the light-column path — the includeEmbedding admin paths
  // (re-embed/backfill) don't render cards. They ride ALONGSIDE
  // rowToIngredient's shape, so the sync/revision payloads that share
  // rowToIngredient stay untouched.
  const cols = includeEmbedding ? '*' : INGREDIENT_LIGHT_COLS;
  const withClause = needsRefs ? `WITH ${CANONICAL_REFS_CTE} ` : '';
  const result = await query(
    `${withClause}SELECT ${cols} FROM catalog_ingredients ${where} ${orderBy} LIMIT $${idx++} OFFSET $${idx}`,
    params,
  );
  const decorations = includeEmbedding ? new Map() : await decorateIngredientPage(result.rows.map((row) => row.id));
  const access = includeEmbedding ? new Map() : await getCatalogIdentityAccessForIds(result.rows.map(row => row.id));
  return {
    items: result.rows.map((row) => {
      const decoration = decorations.get(row.id);
      return { ...rowToIngredient(row), thumbnailKey: decoration?.thumbnail_key ?? null, usage: decoration?.ref_usage ?? {},
        owningUniverse: decoration?.owning_universe ?? null, ownershipStatus: decoration?.ownership_status ?? 'needs-review',
        sharedIdentity: access.get(row.id) || null };
    }),
    nextOffset: offset + result.rows.length,
  };
}

// Preserve requested IDs (including retained originals) while hydrating an
// entire visible card collection in bounded queries, without media/history.
export async function getIngredientCards(ids) {
  if (!ids.length) return [];
  const columns = INGREDIENT_LIGHT_COLS.split(', ').map(column => column === 'payload'
    ? `jsonb_strip_nulls(jsonb_build_object('role', left(i.payload->>'role', 300), 'physicalDescription', left(i.payload->>'physicalDescription', 1000),
        'description', left(i.payload->>'description', 1000), 'locked', i.payload->'locked', 'primaryImageRef', i.payload->'primaryImageRef',
        'imageRefs', jsonb_build_array(i.payload->'imageRefs'->0))) AS payload` : `i.${column}`).join(', ');
  const { rows } = await query(`SELECT requested.id AS requested_key, ${columns}
    FROM unnest($1::text[]) WITH ORDINALITY requested(id, position)
    JOIN catalog_ingredients i ON i.id = catalog_canonical_ingredient_id(requested.id) AND i.deleted = false
    ORDER BY requested.position`, [ids]);
  const decorations = await decorateIngredientPage([...new Set(rows.map(row => row.id))]);
  const access = await getCatalogIdentityAccessForIds(ids);
  return rows.map(row => {
    const decoration = decorations.get(row.id);
    return { ...rowToIngredient(row), id: row.requested_key, canonicalId: row.id,
      thumbnailKey: decoration?.thumbnail_key ?? null, usage: decoration?.ref_usage ?? {},
      owningUniverse: decoration?.owning_universe ?? null, ownershipStatus: decoration?.ownership_status ?? 'needs-review',
      sharedIdentity: access.get(row.requested_key) || null };
  });
}

/**
 * Cosine-similarity search over the ingredient embedding column.
 * `threshold` is a similarity floor (1 - cosine_distance), default 0.5.
 */
export async function searchIngredientsByEmbedding(vector, { type, limit = 20, threshold = 0.5 } = {}) {
  if (!vector) return [];
  const conditions = ['deleted = false', 'id = catalog_canonical_ingredient_id(id)', 'embedding IS NOT NULL'];
  const params = [arrayToPgvector(vector), threshold, limit];
  let idx = 4;
  if (type) {
    conditions.push(`type = $${idx++}`);
    params.push(type);
  }
  const result = await query(
    `SELECT *, 1 - (embedding <=> $1) AS score
       FROM catalog_ingredients
       WHERE ${conditions.join(' AND ')}
         AND 1 - (embedding <=> $1) >= $2
       ORDER BY embedding <=> $1
       LIMIT $3`,
    params,
  );
  return result.rows.map((row) => ({ ingredient: rowToIngredient(row), score: parseFloat(row.score) }));
}

/**
 * Live records of `type` whose name or one of whose aliases equals one of
 * `names` (trimmed, case-insensitive), oldest first. Used to link to an
 * existing record instead of creating a same-named duplicate. With
 * `firstWord`, the name's or alias's first word is compared instead, so
 * "Ada" finds "Ada Example".
 */
export async function findIngredientsByName(type, names, { firstWord = false } = {}) {
  const keys = [...new Set((names || []).map((n) => String(n || '').trim().toLowerCase()).filter(Boolean))];
  if (!type || !keys.length) return [];
  const key = (column) => (firstWord ? `split_part(lower(btrim(${column})), ' ', 1)` : `lower(btrim(${column}))`);
  const result = await query(
    `SELECT * FROM catalog_ingredients
       WHERE deleted = false AND id = catalog_canonical_ingredient_id(id) AND type = $1
         AND (${key('name')} = ANY($2)
           OR (jsonb_typeof(payload->'aliases') = 'array'
             AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(payload->'aliases') a WHERE ${key('a')} = ANY($2))))
       ORDER BY created_at, id`,
    [type, keys],
  );
  return result.rows.map(rowToIngredient);
}

export async function searchIngredientsByText(q, { type, limit = 20 } = {}) {
  if (!q) return [];
  const conditions = ['deleted = false', 'id = catalog_canonical_ingredient_id(id)', `search_tsv @@ websearch_to_tsquery('english', $1)`];
  const params = [q, limit];
  let idx = 3;
  if (type) {
    conditions.push(`type = $${idx++}`);
    params.push(type);
  }
  const result = await query(
    `SELECT *, ts_rank_cd(search_tsv, websearch_to_tsquery('english', $1)) AS rank
       FROM catalog_ingredients
       WHERE ${conditions.join(' AND ')}
       ORDER BY rank DESC
       LIMIT $2`,
    params,
  );
  return result.rows.map((row) => ({ ingredient: rowToIngredient(row), rank: parseFloat(row.rank) }));
}

// Hybrid search: Reciprocal Rank Fusion over FTS (`search_tsv`) + vector
// (`embedding`) results, mirroring memoryDB.hybridSearchMemories so the catalog
// shares the SAME scoring model when it feeds Ask retrieval. Returns
// `[{ ingredient, rrfScore, ftsRank, vectorRank, searchMethod }]` sorted by
// rrfScore. Either signal can be absent (no query text, or no embeddings
// backfilled yet) — the present one still ranks.
export async function hybridSearchIngredients(queryText, queryEmbedding, options = {}) {
  const { type, limit = 20, minRelevance = 0.5, ftsWeight = 0.4, vectorWeight = 0.6 } = options;
  const RRF_K = 60;
  const fetchLimit = limit * 2;

  let ftsRows = [];
  if (queryText) {
    const conds = ['deleted = false', 'id = catalog_canonical_ingredient_id(id)', `search_tsv @@ websearch_to_tsquery('english', $1)`];
    const params = [queryText, fetchLimit];
    let idx = 3;
    if (type) { conds.push(`type = $${idx++}`); params.push(type); }
    const r = await query(
      `SELECT *, ts_rank_cd(search_tsv, websearch_to_tsquery('english', $1)) AS rank
         FROM catalog_ingredients WHERE ${conds.join(' AND ')}
         ORDER BY rank DESC LIMIT $2`,
      params,
    );
    ftsRows = r.rows;
  }

  let vecRows = [];
  if (queryEmbedding) {
    const conds = ['deleted = false', 'id = catalog_canonical_ingredient_id(id)', 'embedding IS NOT NULL', '1 - (embedding <=> $1) >= $2'];
    const params = [arrayToPgvector(queryEmbedding), minRelevance * 0.5, fetchLimit];
    let idx = 4;
    if (type) { conds.push(`type = $${idx++}`); params.push(type); }
    const r = await query(
      `SELECT *, 1 - (embedding <=> $1) AS similarity
         FROM catalog_ingredients WHERE ${conds.join(' AND ')}
         ORDER BY embedding <=> $1 LIMIT $3`,
      params,
    );
    vecRows = r.rows;
  }

  const rrf = reciprocalRankFusion(ftsRows, vecRows, { k: RRF_K, ftsWeight, vectorWeight });

  return Array.from(rrf.values())
    .map((d) => ({
      ingredient: rowToIngredient(d.row),
      rrfScore: d.rrfScore,
      ftsRank: d.ftsRank,
      vectorRank: d.vectorRank,
      searchMethod: d.ftsRank && d.vectorRank ? 'hybrid' : d.ftsRank ? 'fts' : 'vector',
    }))
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, limit);
}

// Resolve a list of ingredient ids to live ingredient records in a single batch
// query (listIngredients already excludes soft-deleted rows), de-duped and
// re-ordered to the caller's pick order so a composed seed/cast reads in the
// order the user selected. Missing/deleted ids are simply absent and skipped.
// Shared by every remix target (#1761 Story Builder seed, #1808 Creative
// Director cast) so the resolve logic lives in one place next to the data layer.
export async function resolveIngredientsByIds(ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : [])
    .filter((id) => typeof id === 'string' && id.trim())
    .map((id) => id.trim()))];
  if (list.length === 0) return [];
  const { rows } = await query(`SELECT i.*, requested.ordinality FROM unnest($1::text[]) WITH ORDINALITY requested(id, ordinality)
    JOIN catalog_ingredients i ON i.id = catalog_canonical_ingredient_id(requested.id) AND i.deleted = false
    ORDER BY requested.ordinality`, [list]);
  return [...new Map(rows.map(row => [row.id, rowToIngredient(row)])).values()];
}
