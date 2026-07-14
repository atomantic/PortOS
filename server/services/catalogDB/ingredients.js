/**
 * Creative Ingredients Catalog — ingredient CRUD, revisions & search.
 *
 * catalog_ingredients + catalog_ingredient_revisions: the typed catalog rows
 * (characters/places/objects/ideas/scenes/concepts) and their per-edit history.
 * Also the FTS / vector / hybrid (RRF) search paths over the ingredient corpus.
 */

import { query, arrayToPgvector } from '../../lib/db.js';
import { reciprocalRankFusion } from '../../lib/rrfRanking.js';
import {
  getActiveCatalogType,
  currentPayloadSchemaVersion,
  defaultTagsForType,
} from '../../lib/catalogTypes.js';
import { getInstanceId } from '../instances.js';
import {
  newIngredientId,
  newRevisionId,
  sanitizeBiblePayload,
  BIBLE_SANITIZERS,
  CATALOG_REVISION_RETENTION,
  REVISION_SOURCES,
  rowToIngredient,
  rowToRevision,
  HAS_LIVE_HOMING_REF,
  HAS_ANY_HOMING_REF,
} from './shared.js';
import { normalizeTags } from './tags.js';

// `{ client }` is optional — when supplied, SQL runs on the caller's transaction
// client (so the write rolls back if a later step in the same `withTransaction`
// block throws). Absent, falls through to the pool-level `query` as before.
// See `POST /api/catalog/scraps/:id/commit` for the scrap-commit batch that
// needs every per-draft ingredient + source-link to commit-or-rollback together.
export async function createIngredient({ id: explicitId, type, name, payload = {}, tags = [], embedding = null, embeddingModel = null } = {}, { client, source = 'user', actor = null } = {}) {
  if (!type || !getActiveCatalogType(type)) throw new Error(`Invalid ingredient type: ${type}`);
  if (!name || !String(name).trim()) throw new Error('name is required');

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
  const exec = client ? client.query.bind(client) : query;
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
      JSON.stringify(storedPayload),
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

export async function getIngredient(id) {
  const result = await query(
    `SELECT * FROM catalog_ingredients WHERE id = $1 AND deleted = false`,
    [id],
  );
  return rowToIngredient(result.rows[0]);
}

// `{ source, actor }` drive the revision-history row written on a content
// change. `source` is one of user|extract|refine|sync (default 'user'); `actor`
// is an optional free label (agent run id, provider). Embedding-only patches
// (the backfill path) carry no name/payload/tags and so record NO revision.
export async function updateIngredient(id, patch = {}, { source = 'user', actor = null } = {}) {
  const fields = [];
  const params = [];
  let idx = 1;
  // Normalize freeform tags through the canonical table on edit too — a user
  // adding `Noir` reuses the existing `noir` row instead of accumulating a
  // casing variant. `tags: []` (intentional clear) round-trips as an empty
  // array; absent `tags` skips normalization entirely (the loop below skips it).
  let normalizedPatch = patch.tags !== undefined
    ? { ...patch, tags: await normalizeTags(patch.tags) }
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
    const current = await getIngredient(id);
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
      params.push(JSON.stringify(normalizedPatch.payload || {}));
    } else if (jsField === 'embedding') {
      fields.push(`${dbField} = $${idx++}`);
      params.push(normalizedPatch.embedding ? arrayToPgvector(normalizedPatch.embedding) : null);
    } else {
      fields.push(`${dbField} = $${idx++}`);
      params.push(normalizedPatch[jsField]);
    }
  }
  if (fields.length === 0) return getIngredient(id);
  params.push(id);
  // Mirrors updateScrap: PATCH on a soft-deleted row returns zero rows so the
  // route 404s. Revival of soft-deleted rows is intentionally separate via
  // `reviveDeletedIngredient`, so this filter doesn't conflict with that path.
  const result = await query(
    `UPDATE catalog_ingredients SET ${fields.join(', ')} WHERE id = $${idx} AND deleted = false RETURNING *`,
    params,
  );
  const updated = rowToIngredient(result.rows[0]);

  // Record a revision only when a USER-facing field (name/payload/tags) was
  // part of this patch AND the row actually exists/updated. Embedding/model-
  // only patches skip history entirely. `payload.schemaVersion` is stripped
  // from the stored revision diff-by-content check below, but we snapshot the
  // committed payload verbatim so a restore round-trips the exact stored shape.
  const touchedContent =
    patch.name !== undefined || patch.payload !== undefined || patch.tags !== undefined;
  if (updated && touchedContent) {
    await recordIngredientRevision(updated, { source, actor });
  }
  return updated;
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
      JSON.stringify(ingredient.payload || {}),
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
    `SELECT * FROM catalog_ingredient_revisions
      WHERE ingredient_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2 OFFSET $3`,
    [ingredientId, Math.min(Math.max(limit, 1), 200), Math.max(offset, 0)],
  );
  return { items: result.rows.map(rowToRevision), nextOffset: offset + result.rows.length };
}

export async function getIngredientRevision(revisionId) {
  const result = await query(
    `SELECT * FROM catalog_ingredient_revisions WHERE id = $1`,
    [revisionId],
  );
  return rowToRevision(result.rows[0]);
}

export async function deleteIngredient(id, { hard = false } = {}) {
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
  // Re-stamp the payload schemaVersion on revive — the revived row is being
  // rewritten with a fresh payload, so it gets this install's current marker
  // (mirrors createIngredient).
  const storedPayload = { ...(payload && typeof payload === 'object' ? payload : {}), schemaVersion: currentPayloadSchemaVersion(type) };
  const result = await query(
    `UPDATE catalog_ingredients
        SET deleted = false, deleted_at = NULL,
            type = $2, name = $3, payload = $4::jsonb, tags = $5,
            updated_at = NOW()
      WHERE id = $1 AND deleted = true
      RETURNING *`,
    [id, type, String(name).trim(), JSON.stringify(storedPayload), tags || []],
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

// Correlated subquery that yields the card-thumbnail media key for each row:
// the live portrait when set, otherwise the most recent live reference image.
// Non-image media kinds (audio/video/document) are excluded so a card never
// points an <img> at an unrenderable key. Used only by listIngredients' light
// path (see the note there).
const THUMBNAIL_KEY_SUBQUERY = `(
    SELECT m.media_key FROM catalog_ingredient_media m
     WHERE m.ingredient_id = catalog_ingredients.id
       AND m.deleted = false
       AND m.kind IN ('portrait', 'reference')
     ORDER BY (m.kind = 'portrait') DESC, m.created_at DESC
     LIMIT 1
  ) AS thumbnail_key`;

export async function listIngredients({ ids, type, tag, query: q, refKind = null, refId = null, unlinked = false, orphaned = false, limit = 50, offset = 0, includeEmbedding = false, embeddingMissing = false, staleEmbeddingModel = null } = {}) {
  const conditions = ['deleted = false'];
  const params = [];
  let idx = 1;
  // Batch-fetch by id (Story Builder catalog→series linking, #1761). When
  // present, `ids` takes precedence over type/tag/q — they're skipped so the
  // caller gets exactly the requested (still non-deleted) rows.
  const byIds = Array.isArray(ids) && ids.length > 0;
  let qIdx = null;
  if (byIds) {
    conditions.push(`id = ANY($${idx++})`);
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
    // Album/facet filters (#1762). EXISTS subquery (not a JOIN) so a row linked
    // under multiple roles isn't duplicated — no DISTINCT needed. Composes with
    // type/tag/q above. `unlinked` and `orphaned` are mutually exclusive views
    // of the un-homed set; the route schema rejects combining them with ref.
    if (refKind === 'universe' && refId) {
      // A universe album/filter is the universe's WHOLE membership: ingredients
      // linked directly to the universe OR to any live series under it (decision
      // #1 — the series dropdown narrows *within* the universe, so a series-only
      // ingredient must still land in its parent universe). $refId is referenced
      // twice via one placeholder.
      const refIdx = idx++;
      conditions.push(`EXISTS (SELECT 1 FROM catalog_ingredient_refs r
        WHERE r.ingredient_id = catalog_ingredients.id AND r.deleted = false
          AND ((r.ref_kind = 'universe' AND r.ref_id = $${refIdx})
            OR (r.ref_kind = 'series' AND r.ref_id IN (
                  SELECT id FROM pipeline_series WHERE universe_id = $${refIdx} AND deleted = false))))`);
      params.push(refId);
    } else if (refKind && refId) {
      conditions.push(`EXISTS (SELECT 1 FROM catalog_ingredient_refs r
        WHERE r.ingredient_id = catalog_ingredients.id AND r.deleted = false
          AND r.ref_kind = $${idx++} AND r.ref_id = $${idx++})`);
      params.push(refKind, refId);
    } else if (unlinked) {
      // "Unsorted / Raw": no universe/series ref at all.
      conditions.push(`NOT ${HAS_ANY_HOMING_REF}`);
    } else if (orphaned) {
      // "Orphaned": has a universe/series ref, but none resolve to a live target.
      conditions.push(HAS_ANY_HOMING_REF);
      conditions.push(`NOT ${HAS_LIVE_HOMING_REF}`);
    }
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
  // Card-thumbnail key: the live portrait if one exists, else the most recent
  // reference image. Mirrors listMediaForIngredient's `(kind='portrait') DESC,
  // created_at DESC` ordering so the card shows the same image the detail page
  // treats as the avatar. Scoped to the light-column list path only — the
  // includeEmbedding admin paths (re-embed/backfill) don't render cards and
  // don't pay for the correlated subquery. The field rides ALONGSIDE
  // rowToIngredient's shape (attached below), so the sync/revision payloads
  // that share rowToIngredient stay untouched.
  const cols = includeEmbedding ? '*' : `${INGREDIENT_LIGHT_COLS}, ${THUMBNAIL_KEY_SUBQUERY}`;
  const result = await query(
    `SELECT ${cols} FROM catalog_ingredients ${where} ${orderBy} LIMIT $${idx++} OFFSET $${idx}`,
    params,
  );
  return {
    items: result.rows.map((row) => ({ ...rowToIngredient(row), thumbnailKey: row.thumbnail_key ?? null })),
    nextOffset: offset + result.rows.length,
  };
}

/**
 * Cosine-similarity search over the ingredient embedding column.
 * `threshold` is a similarity floor (1 - cosine_distance), default 0.5.
 */
export async function searchIngredientsByEmbedding(vector, { type, limit = 20, threshold = 0.5 } = {}) {
  if (!vector) return [];
  const conditions = ['deleted = false', 'embedding IS NOT NULL'];
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

export async function searchIngredientsByText(q, { type, limit = 20 } = {}) {
  if (!q) return [];
  const conditions = ['deleted = false', `search_tsv @@ websearch_to_tsquery('english', $1)`];
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
    const conds = ['deleted = false', `search_tsv @@ websearch_to_tsquery('english', $1)`];
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
    const conds = ['deleted = false', 'embedding IS NOT NULL', '1 - (embedding <=> $1) >= $2'];
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
  const { items } = await listIngredients({ ids: list, limit: list.length });
  const byId = new Map(items.map((ing) => [ing.id, ing]));
  return list.map((id) => byId.get(id)).filter(Boolean);
}
