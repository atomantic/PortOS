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
import {
  getCatalogType,
  ingredientIdPrefix,
  currentPayloadSchemaVersion,
  canonicalTagKey,
  tagIdForKey,
  defaultTagsForType,
} from '../lib/catalogTypes.js';
import { resolveImageInputPath } from '../lib/fileUtils.js';
import { getInstanceId } from './instances.js';

function newIngredientId(type) {
  return `cat-${ingredientIdPrefix(type)}-${randomUUID()}`;
}

function newScrapId() {
  return `cat-scrap-${randomUUID()}`;
}

function newRevisionId() {
  return `cat-rev-${randomUUID()}`;
}

// Cap on how many revision rows we keep per ingredient. Configurable via
// CATALOG_REVISION_RETENTION (env) so an install that wants a deeper audit
// trail can raise it; default 50 bounds unbounded growth from AI refine loops
// or rapid manual edits. A non-positive / non-numeric value falls back to 50.
export const CATALOG_REVISION_RETENTION = (() => {
  const raw = parseInt(process.env.CATALOG_REVISION_RETENTION, 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 50;
})();

// The four revision sources, mirrored from the DB CHECK constraint. 'user' is
// the default (manual detail-page edit); 'extract' for ingest commits, 'refine'
// for AI refinement passes, 'sync' for peer-apply changes.
const REVISION_SOURCES = new Set(['user', 'extract', 'refine', 'sync']);


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
    deleted: !!row.deleted,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    syncSequence: String(row.sync_sequence),
  };
}

function rowToRelation(row) {
  if (!row) return null;
  return {
    fromId: row.from_id,
    toId: row.to_id,
    kind: row.kind,
    createdAt: row.created_at.toISOString(),
    deleted: !!row.deleted,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    syncSequence: String(row.sync_sequence),
  };
}

function rowToMedia(row) {
  if (!row) return null;
  return {
    ingredientId: row.ingredient_id,
    mediaKey: row.media_key,
    kind: row.kind,
    role: row.role ?? null,
    caption: row.caption ?? null,
    createdAt: row.created_at.toISOString(),
    deleted: !!row.deleted,
    deletedAt: row.deleted_at?.toISOString() ?? null,
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

function rowToTag(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    description: row.description ?? null,
    color: row.color ?? null,
    parentId: row.parent_id ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    syncSequence: String(row.sync_sequence),
  };
}

function rowToRevision(row) {
  if (!row) return null;
  return {
    id: row.id,
    ingredientId: row.ingredient_id,
    name: row.name,
    payload: row.payload || {},
    tags: row.tags || [],
    source: row.source,
    actor: row.actor ?? null,
    createdAt: row.created_at.toISOString(),
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


// `{ client }` is optional — when supplied, SQL runs on the caller's transaction
// client (so the write rolls back if a later step in the same `withTransaction`
// block throws). Absent, falls through to the pool-level `query` as before.
// See `POST /api/catalog/scraps/:id/commit` for the scrap-commit batch that
// needs every per-draft ingredient + source-link to commit-or-rollback together.
export async function createIngredient({ id: explicitId, type, name, payload = {}, tags = [], embedding = null, embeddingModel = null } = {}, { client, source = 'user', actor = null } = {}) {
  if (!type || !getCatalogType(type)) throw new Error(`Invalid ingredient type: ${type}`);
  if (!name || !String(name).trim()) throw new Error('name is required');

  // `explicitId` is used by the backfill when a universe arrives from a peer
  // already carrying an ingredientId — preserves cross-peer identity so the
  // same logical character has the same catalog id on every install. New
  // user-initiated creates omit it and we mint a fresh prefix:uuid.
  const id = explicitId || newIngredientId(type);
  // Stamp the per-record payload-shape version from the registry so a later
  // `migrateCatalogPayload` run knows which shape this row was written in.
  // An incoming payload may already carry `schemaVersion` (peer backfill) — we
  // overwrite with the LOCAL registry-current value so the stored marker
  // reflects the shape this install's code actually wrote, not a stale sender
  // claim. (The wire `PORTOS_SCHEMA_VERSIONS.catalog` gate covers cross-install
  // skew; this is the per-record payload-shape marker, distinct from that.)
  const storedPayload = { ...(payload && typeof payload === 'object' ? payload : {}), schemaVersion: currentPayloadSchemaVersion(type) };
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
  const normalizedPatch = patch.tags !== undefined
    ? { ...patch, tags: await normalizeTags(patch.tags) }
    : patch;
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
  if (!type || !getCatalogType(type)) throw new Error(`reviveDeletedIngredient: invalid type ${type}`);
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


// `{ client }` is optional — see the createIngredient comment above. Passing
// the same client used to insert the ingredient row keeps the source-link row
// in the same transaction so a mid-batch failure rolls back both halves.
export async function linkIngredientToSource(ingredientId, scrapId, span = null, { client } = {}) {
  const exec = client ? client.query.bind(client) : query;
  await exec(
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
  // ON CONFLICT DO UPDATE revives a soft-deleted row instead of leaving it
  // tombstoned. The trigger only bumps sync_sequence when `deleted` or
  // `deleted_at` actually change, so a link-on-active-row stays a no-op for
  // peers (no spurious sync event).
  await query(
    `INSERT INTO catalog_ingredient_refs (ingredient_id, ref_kind, ref_id, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (ingredient_id, ref_kind, ref_id, role) DO UPDATE
       SET deleted = false, deleted_at = NULL`,
    [ingredientId, refKind, refId, role],
  );
}

export async function unlinkIngredientFromRef(ingredientId, refKind, refId, role) {
  // Soft-delete via UPDATE so the row stays around as a tombstone and the
  // trg_catalog_ref_sync_seq trigger bumps sync_sequence — peers pick the
  // unlink up on their next pull. The `AND deleted = false` filter keeps
  // re-unlinks from re-bumping sync_sequence unnecessarily.
  await query(
    `UPDATE catalog_ingredient_refs
        SET deleted = true, deleted_at = NOW()
      WHERE ingredient_id = $1 AND ref_kind = $2 AND ref_id = $3 AND role = $4
        AND deleted = false`,
    [ingredientId, refKind, refId, role],
  );
}

export async function listRefsForIngredient(ingredientId) {
  // Filter `deleted = false` so the "Appears in" panel doesn't surface
  // tombstoned unlinks. Tombstones are read-only state for sync purposes;
  // user-facing list paths only show live links.
  const result = await query(
    `SELECT * FROM catalog_ingredient_refs WHERE ingredient_id = $1 AND deleted = false`,
    [ingredientId],
  );
  return result.rows.map(rowToRef);
}

export async function listIngredientsForRef(refKind, refId) {
  const result = await query(
    `SELECT i.*, r.role, r.created_at AS ref_created_at
       FROM catalog_ingredients i
       JOIN catalog_ingredient_refs r ON r.ingredient_id = i.id
       WHERE r.ref_kind = $1 AND r.ref_id = $2
         AND r.deleted = false AND i.deleted = false`,
    [refKind, refId],
  );
  return result.rows.map((row) => ({ ingredient: rowToIngredient(row), role: row.role }));
}


// --- Ingredient↔ingredient relations -----------------------------------
// Directed edges (from_id → to_id, kind). Soft-deleted on unlink so peers
// receive the tombstone. ON CONFLICT DO UPDATE revives a soft-deleted edge
// (the trg_catalog_relation_sync_seq trigger bumps sync_sequence only when
// deleted/deleted_at actually change, so a link-on-active-row stays a no-op).

export async function linkIngredientRelation(fromId, toId, kind) {
  if (fromId === toId) throw new Error('cannot relate an ingredient to itself');
  await query(
    `INSERT INTO catalog_ingredient_relations (from_id, to_id, kind)
     VALUES ($1, $2, $3)
     ON CONFLICT (from_id, to_id, kind) DO UPDATE
       SET deleted = false, deleted_at = NULL`,
    [fromId, toId, kind],
  );
}

export async function unlinkIngredientRelation(fromId, toId, kind) {
  // Soft-delete (mirrors unlinkIngredientFromRef): keep the row as a tombstone
  // so the sync_sequence bump propagates the unlink to peers. `AND deleted =
  // false` keeps a re-unlink from re-bumping the sequence needlessly.
  await query(
    `UPDATE catalog_ingredient_relations
        SET deleted = true, deleted_at = NOW()
      WHERE from_id = $1 AND to_id = $2 AND kind = $3
        AND deleted = false`,
    [fromId, toId, kind],
  );
}

// Both directions for one ingredient's detail "Relations" panel. Outbound
// (from_id = id) and inbound (to_id = id) are returned separately so the UI
// can render each with the correct directional label. Joins the OTHER end's
// ingredient name/type so the chip reads without a second fetch. Live edges
// only (deleted = false on both the edge and the joined ingredient).
export async function listRelationsForIngredient(id) {
  const [outbound, inbound] = await Promise.all([
    query(
      `SELECT r.from_id, r.to_id, r.kind, r.created_at,
              i.name AS other_name, i.type AS other_type
         FROM catalog_ingredient_relations r
         JOIN catalog_ingredients i ON i.id = r.to_id
        WHERE r.from_id = $1 AND r.deleted = false AND i.deleted = false
        ORDER BY r.created_at ASC`,
      [id],
    ),
    query(
      `SELECT r.from_id, r.to_id, r.kind, r.created_at,
              i.name AS other_name, i.type AS other_type
         FROM catalog_ingredient_relations r
         JOIN catalog_ingredients i ON i.id = r.from_id
        WHERE r.to_id = $1 AND r.deleted = false AND i.deleted = false
        ORDER BY r.created_at ASC`,
      [id],
    ),
  ]);
  const mapRow = (row, otherId) => ({
    fromId: row.from_id,
    toId: row.to_id,
    kind: row.kind,
    createdAt: row.created_at.toISOString(),
    other: { id: otherId, name: row.other_name, type: row.other_type },
  });
  return {
    outbound: outbound.rows.map((row) => mapRow(row, row.to_id)),
    inbound: inbound.rows.map((row) => mapRow(row, row.from_id)),
  };
}

export async function getRelationChangesSince(since = '0', limit = 100) {
  const result = await query(
    `SELECT * FROM catalog_ingredient_relations WHERE sync_sequence > $1 ORDER BY sync_sequence ASC LIMIT $2`,
    [since, limit + 1],
  );
  const hasMore = result.rows.length > limit;
  const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
  return { items: rows.map(rowToRelation), hasMore };
}

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


// --- Ingredient media attachments ----------------------------------------
// Typed references (portrait/reference/audio/video/document) into the install's
// media library. `media_key` is a key into the library (data/images + the
// history.jsonl sidecar) — never duplicated bytes. Soft-deleted on detach so
// peers receive the tombstone; ON CONFLICT DO UPDATE revives a detached row and
// updates its role/caption (the trg_catalog_media_sync_seq trigger only bumps
// sync_sequence when one of those actually changes, so a no-op replay stays
// silent).

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

export async function getMediaChangesSince(since = '0', limit = 100) {
  const result = await query(
    `SELECT * FROM catalog_ingredient_media WHERE sync_sequence > $1 ORDER BY sync_sequence ASC LIMIT $2`,
    [since, limit + 1],
  );
  const hasMore = result.rows.length > limit;
  const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
  return { items: rows.map(rowToMedia), hasMore };
}

export async function upsertMediaFromPeer(media) {
  // Mirrors upsertRefFromPeer's mixed-version handling: a peer that predates
  // the media feature never emits these rows, so there's no pre-tombstone
  // shape to defend against. We still treat "tombstone keys absent" as "peer
  // has no opinion" so a forked peer that omits them preserves local state on
  // conflict. On INSERT a tombstone-less row defaults to deleted=false, which
  // is correct (brand-new locally, peer believes it active). role/caption are
  // always adopted from the peer (LWW is implicit — last writer's envelope wins
  // for these tuple-unique rows, same as refs).
  const hasTombstoneFields =
    Object.prototype.hasOwnProperty.call(media, 'deleted') ||
    Object.prototype.hasOwnProperty.call(media, 'deletedAt');
  if (hasTombstoneFields) {
    await query(
      `INSERT INTO catalog_ingredient_media
         (ingredient_id, media_key, kind, role, caption, created_at, deleted, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (ingredient_id, media_key, kind) DO UPDATE
         SET role = EXCLUDED.role,
             caption = EXCLUDED.caption,
             deleted = EXCLUDED.deleted,
             deleted_at = EXCLUDED.deleted_at`,
      [
        media.ingredientId, media.mediaKey, media.kind,
        media.role ?? null, media.caption ?? null, media.createdAt,
        !!media.deleted, media.deletedAt || null,
      ],
    );
  } else {
    await query(
      `INSERT INTO catalog_ingredient_media
         (ingredient_id, media_key, kind, role, caption, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (ingredient_id, media_key, kind) DO UPDATE
         SET role = EXCLUDED.role, caption = EXCLUDED.caption`,
      [media.ingredientId, media.mediaKey, media.kind, media.role ?? null, media.caption ?? null, media.createdAt],
    );
  }
}


// --- Tag taxonomy --------------------------------------------------------
// `catalog_tags` is the canonical index over the freeform
// `catalog_ingredients.tags TEXT[]` column. `normalizeTags` maps user input
// through it (creating rows on first use, deterministic `cat-tag-<key>` ids)
// and returns the de-duplicated canonical label list to store in the array
// column. The freeform column keeps working unchanged for GIN tag-search.

/**
 * Map a list of freeform tag labels to canonical labels, creating a
 * `catalog_tags` row per unique canonical key on first use. Returns the
 * de-duplicated, order-preserving list of canonical labels (first-seen casing
 * wins, both within this call and against any pre-existing row). Empty / blank
 * tags are dropped. `{ client }` runs the upserts on the caller's transaction.
 */
export async function normalizeTags(labels = [], { client } = {}) {
  if (!Array.isArray(labels) || labels.length === 0) return [];
  const exec = client ? client.query.bind(client) : query;
  const out = [];
  const seen = new Set();
  for (const raw of labels) {
    const key = canonicalTagKey(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const id = tagIdForKey(key);
    const label = String(raw).trim().replace(/\s+/g, ' ');
    // First write wins on the canonical label — ON CONFLICT DO NOTHING keeps
    // the original casing rather than letting a later `NOIR` overwrite `Noir`.
    // RETURNING after a no-op conflict is empty, so re-select to read the
    // stored canonical label for the array column.
    const ins = await exec(
      `INSERT INTO catalog_tags (id, label)
       VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING
       RETURNING label`,
      [id, label],
    );
    if (ins.rows[0]?.label) {
      out.push(ins.rows[0].label);
    } else {
      const existing = await exec(`SELECT label FROM catalog_tags WHERE id = $1`, [id]);
      out.push(existing.rows[0]?.label ?? label);
    }
  }
  return out;
}

export async function getTag(id) {
  const result = await query(`SELECT * FROM catalog_tags WHERE id = $1`, [id]);
  return rowToTag(result.rows[0]);
}

/**
 * Autocomplete / list canonical tags. `q` does a case-insensitive prefix-then-
 * substring match on label (prefix matches rank first); absent `q` returns the
 * most-recently-created tags. Drives the tag-picker autocomplete.
 */
export async function listTags({ q, limit = 20 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  if (q && String(q).trim()) {
    const term = String(q).trim();
    const result = await query(
      `SELECT * FROM catalog_tags
        WHERE label ILIKE $1
        ORDER BY
          CASE WHEN label ILIKE $2 THEN 0 ELSE 1 END,
          label ASC
        LIMIT $3`,
      [`%${term}%`, `${term}%`, lim],
    );
    return { items: result.rows.map(rowToTag) };
  }
  const result = await query(
    `SELECT * FROM catalog_tags ORDER BY created_at DESC LIMIT $1`,
    [lim],
  );
  return { items: result.rows.map(rowToTag) };
}

/**
 * Patch a tag's mutable fields (description / color / parent_id). `label` is
 * intentionally NOT patchable here — relabeling would orphan the freeform
 * array values that reference the old casing. Self-parent is rejected.
 */
export async function updateTag(id, patch = {}) {
  const fields = [];
  const params = [];
  let idx = 1;
  const fieldMap = { description: 'description', color: 'color', parentId: 'parent_id' };
  for (const [jsField, dbField] of Object.entries(fieldMap)) {
    if (patch[jsField] === undefined) continue;
    if (jsField === 'parentId' && patch.parentId === id) {
      throw new Error('a tag cannot be its own parent');
    }
    fields.push(`${dbField} = $${idx++}`);
    params.push(patch[jsField] === '' ? null : patch[jsField]);
  }
  if (fields.length === 0) return getTag(id);
  params.push(id);
  const result = await query(
    `UPDATE catalog_tags SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    params,
  );
  return rowToTag(result.rows[0]);
}

export async function getTagChangesSince(since = '0', limit = 100) {
  const result = await query(
    `SELECT * FROM catalog_tags WHERE sync_sequence > $1 ORDER BY sync_sequence ASC LIMIT $2`,
    [since, limit + 1],
  );
  const hasMore = result.rows.length > limit;
  const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
  return { items: rows.map(rowToTag), hasMore };
}

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

export async function getMaxSequences() {
  const result = await query(`
    SELECT
      COALESCE((SELECT MAX(sync_sequence) FROM catalog_ingredients), 0)::text AS ingredients,
      COALESCE((SELECT MAX(sync_sequence) FROM catalog_scraps), 0)::text AS scraps,
      COALESCE((SELECT MAX(sync_sequence) FROM catalog_ingredient_sources), 0)::text AS sources,
      COALESCE((SELECT MAX(sync_sequence) FROM catalog_ingredient_refs), 0)::text AS refs,
      COALESCE((SELECT MAX(sync_sequence) FROM catalog_ingredient_relations), 0)::text AS relations,
      COALESCE((SELECT MAX(sync_sequence) FROM catalog_tags), 0)::text AS tags,
      COALESCE((SELECT MAX(sync_sequence) FROM catalog_ingredient_media), 0)::text AS media
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


/**
 * Hydrate one ingredient with its scraps for the export bundle. Issues two
 * queries: the sources join to look up the scrap ids, then a single batch
 * lookup of those scraps. Returns `[]` when an ingredient has no sources.
 */
export async function listScrapsForIngredient(ingredientId) {
  const result = await query(
    `SELECT s.id, s.title, s.raw_text, s.source_kind, s.metadata,
            s.created_at, s.updated_at
       FROM catalog_scraps s
       JOIN catalog_ingredient_sources src ON src.scrap_id = s.id
      WHERE src.ingredient_id = $1
        AND s.deleted = false
      ORDER BY s.created_at ASC`,
    [ingredientId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    rawText: row.raw_text,
    sourceKind: row.source_kind,
    metadata: row.metadata || {},
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));
}

/**
 * Build an export bundle for one ref (universe/series/issue/work).
 * Hydrates each ingredient + its scraps + ref links + media attachments. The
 * media bundle carries `media_key` REFERENCES (not bytes) — a receiving peer
 * matches each key against its own library and surfaces unresolved ones via
 * the metadata-missing integrity surface. Relations are still omitted here
 * (see `[catalog-ingredient-relations]`); when they land, extend this helper.
 */
export async function exportSliceForRef(refKind, refId) {
  const rows = await listIngredientsForRef(refKind, refId);
  // Hydrate scraps + refs + media in parallel per ingredient. Small N (one
  // slice is typically <100 ingredients); a per-row round-trip is fine.
  const ingredients = await Promise.all(rows.map(async ({ ingredient, role }) => {
    const [scraps, refs, media] = await Promise.all([
      listScrapsForIngredient(ingredient.id),
      listRefsForIngredient(ingredient.id),
      listMediaForIngredient(ingredient.id),
    ]);
    const { embedding: _embedding, ...rest } = ingredient;
    return {
      ...rest,
      // The role this ingredient plays for the queried ref — handy for
      // round-trip re-imports that want to preserve roleness without
      // re-deriving it from the full refs list.
      roleForExportedRef: role,
      refs,
      scraps,
      media,
    };
  }));
  return {
    version: 1,
    ref: { kind: refKind, id: refId },
    exportedAt: new Date().toISOString(),
    ingredients,
  };
}

/**
 * Wire-shaped catalog bundle for one external ref (universe/series/issue/work),
 * for piggy-backing on a peer RECORD push (e.g. a universe push carries the
 * catalog rows referenced by its embedded canon). Unlike `exportSliceForRef`
 * (a user-facing export that strips embeddings + tombstones) this is a SYNC
 * payload:
 *
 *   - `ingredients` carry their `embedding` + tombstone fields, so the
 *     receiver gets the full enriched row (tags, embedding, payload.summary)
 *     rather than re-deriving a strictly-lossy view from the embedded canon.
 *   - `refs` include TOMBSTONED rows (deleted = true) so an unlink propagates
 *     with the push — the "Appears in" panel converges across peers.
 *
 * Shapes match `catalogSyncIngredientSchema` / `catalogSyncRefSchema`, so the
 * receiver applies them straight through `catalogSync.applyRemoteChanges`.
 */
export async function getCatalogBundleForRef(refKind, refId) {
  // Every ref row for this target — live AND tombstoned (no `deleted = false`
  // filter, unlike listRefsForIngredient) so unlinks ride the bundle.
  const refResult = await query(
    `SELECT * FROM catalog_ingredient_refs WHERE ref_kind = $1 AND ref_id = $2`,
    [refKind, refId],
  );
  const refs = refResult.rows.map(rowToRef);

  // Hydrate each referenced ingredient WITH embedding + tombstone state. A
  // tombstoned ref still names a (possibly live) ingredient — include it so
  // the receiver has the enriched row even if its own ref is being removed.
  const ingredientIds = [...new Set(refs.map((r) => r.ingredientId))];
  let ingredients = [];
  if (ingredientIds.length > 0) {
    const ingResult = await query(
      `SELECT * FROM catalog_ingredients WHERE id = ANY($1)`,
      [ingredientIds],
    );
    ingredients = ingResult.rows.map(rowToIngredient);
  }
  return { ingredients, refs };
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
