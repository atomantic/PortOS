/**
 * Creative Ingredients Catalog — Postgres data layer.
 *
 * Backs the typed catalog of creative "ingredients" (characters, places,
 * objects, ideas, scenes, concepts). Mirrors the role memoryDB.js plays for
 * memories: thin SQL wrappers + row→object translation, no business logic.
 *
 * Tables: catalog_scraps, catalog_ingredients, catalog_ingredient_sources,
 * catalog_ingredient_refs. See server/scripts/init-db.sql for the schema.
 */

import { randomUUID } from 'crypto';
import { query, withTransaction, pgvectorToArray, arrayToPgvector } from '../lib/db.js';
import { getInstanceId } from './instances.js';

const TYPE_PREFIX = {
  character: 'chr',
  place: 'plc',
  object: 'obj',
  idea: 'idea',
  scene: 'scn',
  concept: 'cnc',
};

function newIngredientId(type) {
  const prefix = TYPE_PREFIX[type];
  if (!prefix) throw new Error(`Unknown ingredient type: ${type}`);
  return `cat-${prefix}-${randomUUID()}`;
}

function newScrapId() {
  return `cat-scrap-${randomUUID()}`;
}


function rowToScrap(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    rawText: row.raw_text,
    sourceKind: row.source_kind,
    metadata: row.metadata || {},
    embedding: row.embedding ? pgvectorToArray(row.embedding) : null,
    embeddingModel: row.embedding_model,
    originInstanceId: row.origin_instance_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    deleted: !!row.deleted,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    syncSequence: String(row.sync_sequence),
  };
}

function rowToIngredient(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    payload: row.payload || {},
    tags: row.tags || [],
    embedding: row.embedding ? pgvectorToArray(row.embedding) : null,
    embeddingModel: row.embedding_model,
    originInstanceId: row.origin_instance_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    deleted: !!row.deleted,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    syncSequence: String(row.sync_sequence),
  };
}

function rowToRef(row) {
  if (!row) return null;
  return {
    ingredientId: row.ingredient_id,
    refKind: row.ref_kind,
    refId: row.ref_id,
    role: row.role,
    createdAt: row.created_at.toISOString(),
    syncSequence: String(row.sync_sequence),
  };
}

function rowToSource(row) {
  if (!row) return null;
  return {
    ingredientId: row.ingredient_id,
    scrapId: row.scrap_id,
    span: row.span,
    extractedAt: row.extracted_at.toISOString(),
    syncSequence: String(row.sync_sequence),
  };
}


export async function createScrap({ title, rawText, sourceKind = 'paste', metadata = {}, embedding = null, embeddingModel = null } = {}) {
  if (!rawText) throw new Error('rawText is required');
  const id = newScrapId();
  const originInstanceId = await getInstanceId();
  const result = await query(
    `INSERT INTO catalog_scraps
       (id, title, raw_text, source_kind, metadata, embedding, embedding_model, origin_instance_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
     RETURNING *`,
    [
      id,
      title || null,
      rawText,
      sourceKind,
      JSON.stringify(metadata || {}),
      embedding ? arrayToPgvector(embedding) : null,
      embeddingModel,
      originInstanceId,
    ],
  );
  return rowToScrap(result.rows[0]);
}

export async function getScrap(id) {
  const result = await query(
    `SELECT * FROM catalog_scraps WHERE id = $1 AND deleted = false`,
    [id],
  );
  return rowToScrap(result.rows[0]);
}

export async function listScraps({ limit = 50, offset = 0 } = {}) {
  const result = await query(
    `SELECT * FROM catalog_scraps
     WHERE deleted = false
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return { items: result.rows.map(rowToScrap), nextOffset: offset + result.rows.length };
}

export async function updateScrap(id, patch = {}) {
  const fields = [];
  const params = [];
  let idx = 1;
  const fieldMap = {
    title: 'title',
    rawText: 'raw_text',
    sourceKind: 'source_kind',
    metadata: 'metadata',
    embedding: 'embedding',
    embeddingModel: 'embedding_model',
  };
  for (const [jsField, dbField] of Object.entries(fieldMap)) {
    if (patch[jsField] === undefined) continue;
    if (jsField === 'metadata') {
      fields.push(`${dbField} = $${idx++}::jsonb`);
      params.push(JSON.stringify(patch.metadata || {}));
    } else if (jsField === 'embedding') {
      fields.push(`${dbField} = $${idx++}`);
      params.push(patch.embedding ? arrayToPgvector(patch.embedding) : null);
    } else {
      fields.push(`${dbField} = $${idx++}`);
      params.push(patch[jsField]);
    }
  }
  if (fields.length === 0) return getScrap(id);
  params.push(id);
  // `AND deleted = false` keeps PATCH consistent with GET — a PATCH on a
  // soft-deleted row returns zero rows so the route 404s, instead of silently
  // mutating a row the next GET would refuse to return.
  const result = await query(
    `UPDATE catalog_scraps SET ${fields.join(', ')} WHERE id = $${idx} AND deleted = false RETURNING *`,
    params,
  );
  return rowToScrap(result.rows[0]);
}

export async function deleteScrap(id, { hard = false } = {}) {
  if (hard) {
    await query(`DELETE FROM catalog_scraps WHERE id = $1`, [id]);
  } else {
    await query(
      `UPDATE catalog_scraps SET deleted = true, deleted_at = NOW() WHERE id = $1`,
      [id],
    );
  }
  return { success: true, id };
}


export async function createIngredient({ id: explicitId, type, name, payload = {}, tags = [], embedding = null, embeddingModel = null } = {}) {
  if (!type || !TYPE_PREFIX[type]) throw new Error(`Invalid ingredient type: ${type}`);
  if (!name || !String(name).trim()) throw new Error('name is required');

  // `explicitId` is used by the backfill when a universe arrives from a peer
  // already carrying an ingredientId — preserves cross-peer identity so the
  // same logical character has the same catalog id on every install. New
  // user-initiated creates omit it and we mint a fresh prefix:uuid.
  const id = explicitId || newIngredientId(type);
  const originInstanceId = await getInstanceId();
  const result = await query(
    `INSERT INTO catalog_ingredients
       (id, type, name, payload, tags, embedding, embedding_model, origin_instance_id)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
     RETURNING *`,
    [
      id,
      type,
      String(name).trim(),
      JSON.stringify(payload || {}),
      tags || [],
      embedding ? arrayToPgvector(embedding) : null,
      embeddingModel,
      originInstanceId,
    ],
  );
  return rowToIngredient(result.rows[0]);
}

export async function getIngredient(id) {
  const result = await query(
    `SELECT * FROM catalog_ingredients WHERE id = $1 AND deleted = false`,
    [id],
  );
  return rowToIngredient(result.rows[0]);
}

export async function updateIngredient(id, patch = {}) {
  const fields = [];
  const params = [];
  let idx = 1;
  const fieldMap = {
    name: 'name',
    payload: 'payload',
    tags: 'tags',
    embedding: 'embedding',
    embeddingModel: 'embedding_model',
  };
  for (const [jsField, dbField] of Object.entries(fieldMap)) {
    if (patch[jsField] === undefined) continue;
    if (jsField === 'payload') {
      fields.push(`${dbField} = $${idx++}::jsonb`);
      params.push(JSON.stringify(patch.payload || {}));
    } else if (jsField === 'embedding') {
      fields.push(`${dbField} = $${idx++}`);
      params.push(patch.embedding ? arrayToPgvector(patch.embedding) : null);
    } else {
      fields.push(`${dbField} = $${idx++}`);
      params.push(patch[jsField]);
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
  return rowToIngredient(result.rows[0]);
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
  if (!type || !TYPE_PREFIX[type]) throw new Error(`reviveDeletedIngredient: invalid type ${type}`);
  if (!name || !String(name).trim()) throw new Error('reviveDeletedIngredient: name required');
  const result = await query(
    `UPDATE catalog_ingredients
        SET deleted = false, deleted_at = NULL,
            type = $2, name = $3, payload = $4::jsonb, tags = $5,
            updated_at = NOW()
      WHERE id = $1 AND deleted = true
      RETURNING *`,
    [id, type, String(name).trim(), JSON.stringify(payload || {}), tags || []],
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

export async function listIngredients({ type, tag, query: q, limit = 50, offset = 0, includeEmbedding = false, embeddingMissing = false, staleEmbeddingModel = null } = {}) {
  const conditions = ['deleted = false'];
  const params = [];
  let idx = 1;
  if (type) {
    conditions.push(`type = $${idx++}`);
    params.push(type);
  }
  if (tag) {
    conditions.push(`$${idx++} = ANY(tags)`);
    params.push(tag);
  }
  let qIdx = null;
  if (q) {
    qIdx = idx++;
    conditions.push(`search_tsv @@ websearch_to_tsquery('english', $${qIdx})`);
    params.push(q);
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
  const cols = includeEmbedding ? '*' : INGREDIENT_LIGHT_COLS;
  const result = await query(
    `SELECT ${cols} FROM catalog_ingredients ${where} ${orderBy} LIMIT $${idx++} OFFSET $${idx}`,
    params,
  );
  return { items: result.rows.map(rowToIngredient), nextOffset: offset + result.rows.length };
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


export async function linkIngredientToSource(ingredientId, scrapId, span = null) {
  await query(
    `INSERT INTO catalog_ingredient_sources (ingredient_id, scrap_id, span)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (ingredient_id, scrap_id) DO UPDATE SET span = EXCLUDED.span`,
    [ingredientId, scrapId, span ? JSON.stringify(span) : null],
  );
}

export async function listSourcesForIngredient(ingredientId) {
  const result = await query(
    `SELECT * FROM catalog_ingredient_sources WHERE ingredient_id = $1`,
    [ingredientId],
  );
  return result.rows.map(rowToSource);
}

export async function listSourcesForScrap(scrapId) {
  const result = await query(
    `SELECT * FROM catalog_ingredient_sources WHERE scrap_id = $1`,
    [scrapId],
  );
  return result.rows.map(rowToSource);
}

export async function linkIngredientToRef(ingredientId, refKind, refId, role) {
  await query(
    `INSERT INTO catalog_ingredient_refs (ingredient_id, ref_kind, ref_id, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (ingredient_id, ref_kind, ref_id, role) DO NOTHING`,
    [ingredientId, refKind, refId, role],
  );
}

export async function unlinkIngredientFromRef(ingredientId, refKind, refId, role) {
  await query(
    `DELETE FROM catalog_ingredient_refs
     WHERE ingredient_id = $1 AND ref_kind = $2 AND ref_id = $3 AND role = $4`,
    [ingredientId, refKind, refId, role],
  );
}

export async function listRefsForIngredient(ingredientId) {
  const result = await query(
    `SELECT * FROM catalog_ingredient_refs WHERE ingredient_id = $1`,
    [ingredientId],
  );
  return result.rows.map(rowToRef);
}

export async function listIngredientsForRef(refKind, refId) {
  const result = await query(
    `SELECT i.*, r.role, r.created_at AS ref_created_at
       FROM catalog_ingredients i
       JOIN catalog_ingredient_refs r ON r.ingredient_id = i.id
       WHERE r.ref_kind = $1 AND r.ref_id = $2 AND i.deleted = false`,
    [refKind, refId],
  );
  return result.rows.map((row) => ({ ingredient: rowToIngredient(row), role: row.role }));
}


export async function getMaxSequences() {
  const result = await query(`
    SELECT
      COALESCE((SELECT MAX(sync_sequence) FROM catalog_ingredients), 0)::text AS ingredients,
      COALESCE((SELECT MAX(sync_sequence) FROM catalog_scraps), 0)::text AS scraps,
      COALESCE((SELECT MAX(sync_sequence) FROM catalog_ingredient_sources), 0)::text AS sources,
      COALESCE((SELECT MAX(sync_sequence) FROM catalog_ingredient_refs), 0)::text AS refs
  `);
  return result.rows[0];
}

export async function getScrapChangesSince(since = '0', limit = 100) {
  const result = await query(
    `SELECT * FROM catalog_scraps WHERE sync_sequence > $1 ORDER BY sync_sequence ASC LIMIT $2`,
    [since, limit + 1],
  );
  const hasMore = result.rows.length > limit;
  const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
  return { items: rows.map(rowToScrap), hasMore };
}

export async function getIngredientChangesSince(since = '0', limit = 100) {
  const result = await query(
    `SELECT * FROM catalog_ingredients WHERE sync_sequence > $1 ORDER BY sync_sequence ASC LIMIT $2`,
    [since, limit + 1],
  );
  const hasMore = result.rows.length > limit;
  const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
  return { items: rows.map(rowToIngredient), hasMore };
}

export async function getSourceChangesSince(since = '0', limit = 100) {
  const result = await query(
    `SELECT * FROM catalog_ingredient_sources WHERE sync_sequence > $1 ORDER BY sync_sequence ASC LIMIT $2`,
    [since, limit + 1],
  );
  const hasMore = result.rows.length > limit;
  const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
  return { items: rows.map(rowToSource), hasMore };
}

export async function getRefChangesSince(since = '0', limit = 100) {
  const result = await query(
    `SELECT * FROM catalog_ingredient_refs WHERE sync_sequence > $1 ORDER BY sync_sequence ASC LIMIT $2`,
    [since, limit + 1],
  );
  const hasMore = result.rows.length > limit;
  const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
  return { items: rows.map(rowToRef), hasMore };
}


export async function upsertScrapFromPeer(scrap) {
  const result = await query(
    `INSERT INTO catalog_scraps
       (id, title, raw_text, source_kind, metadata, embedding, embedding_model,
        origin_instance_id, created_at, updated_at, deleted, deleted_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title,
       raw_text = EXCLUDED.raw_text,
       source_kind = EXCLUDED.source_kind,
       metadata = EXCLUDED.metadata,
       embedding = EXCLUDED.embedding,
       embedding_model = EXCLUDED.embedding_model,
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
      scrap.createdAt,
      scrap.updatedAt,
      !!scrap.deleted,
      scrap.deletedAt || null,
    ],
  );
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
  await query(
    `INSERT INTO catalog_ingredient_refs (ingredient_id, ref_kind, ref_id, role, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (ingredient_id, ref_kind, ref_id, role) DO NOTHING`,
    [ref.ingredientId, ref.refKind, ref.refId, ref.role, ref.createdAt],
  );
}


export async function getCatalogStats() {
  const [byTypeResult, scrapResult, withEmb] = await Promise.all([
    query(`SELECT type, COUNT(*) AS count FROM catalog_ingredients WHERE deleted = false GROUP BY type`),
    query(`SELECT COUNT(*) AS count FROM catalog_scraps WHERE deleted = false`),
    query(`SELECT COUNT(*) AS count FROM catalog_ingredients WHERE deleted = false AND embedding IS NOT NULL`),
  ]);
  const byType = {};
  let total = 0;
  for (const r of byTypeResult.rows) {
    byType[r.type] = parseInt(r.count, 10);
    total += parseInt(r.count, 10);
  }
  return {
    total,
    byType,
    scraps: parseInt(scrapResult.rows[0].count, 10),
    withEmbeddings: parseInt(withEmb.rows[0].count, 10),
  };
}
