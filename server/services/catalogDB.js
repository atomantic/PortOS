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
import { reciprocalRankFusion } from '../lib/rrfRanking.js';
import {
  getActiveCatalogType,
  ingredientIdPrefix,
  currentPayloadSchemaVersion,
  canonicalTagKey,
  tagIdForKey,
  defaultTagsForType,
} from '../lib/catalogTypes.js';
import { resolveImageInputPath } from '../lib/fileUtils.js';
import { chunkRawText } from '../lib/catalogChunking.js';
import { sanitizeCharacter, sanitizePlace, sanitizeObject } from '../lib/storyBible.js';
import { getInstanceId } from './instances.js';
import { resolveRefs } from './catalogRefResolver.js';

// Story-bible sanitizers keyed by catalog type, for the registry
// `extractionShape: 'bible'` types ONLY (character/place/object). The catalog
// payload is the bible-entry shape MINUS the columns the row owns (id / name /
// timestamps) — so we sanitize a synthetic entry `{ name, ...payload }`,
// preserve timestamps, and strip the control fields back out before persist.
// Scoped strictly to bible types: idea/scene/concept AND user-defined types
// pass through untouched (running a user type's payload through a storyBible
// sanitizer would silently drop every field it doesn't recognize).
const BIBLE_SANITIZERS = Object.freeze({
  character: sanitizeCharacter,
  place: sanitizePlace,
  object: sanitizeObject,
});

// Control fields the sanitizer stamps onto an entry that are NOT part of the
// catalog `payload` (the row owns id/name/timestamps as columns). Stripped from
// the sanitized entry so the stored payload stays shape-stable across the
// catalog↔canon projection round-trip.
const SANITIZED_NON_PAYLOAD_KEYS = ['id', 'name', 'createdAt', 'updatedAt'];

/**
 * Run a bible-type ingredient payload through its storyBible sanitizer so the
 * structured array editors (color palette / stats / aliases) can't land
 * malformed rows and the projection round-trip is shape-stable. Returns the
 * sanitized payload (control fields stripped). Non-bible types (idea/scene/
 * concept, user-defined) return their payload UNCHANGED. `preserveTimestamps`
 * keeps the sanitizer from minting fresh ids/timestamps on an existing row.
 */
function sanitizeBiblePayload(type, name, payload) {
  const sanitizer = BIBLE_SANITIZERS[type];
  if (!sanitizer) return payload && typeof payload === 'object' ? payload : {};
  const entry = { ...(payload && typeof payload === 'object' ? payload : {}), name: String(name || '').trim() };
  const sane = sanitizer(entry, { preserveTimestamps: true });
  if (!sane) return payload && typeof payload === 'object' ? payload : {};
  const out = { ...sane };
  for (const k of SANITIZED_NON_PAYLOAD_KEYS) delete out[k];
  // The storyBible sanitizer only emits known bible fields, so it drops
  // `schemaVersion`. Preserve the incoming marker (createIngredient re-stamps
  // it anyway; updateIngredient writes payload verbatim, and the restore route
  // relies on the marker round-tripping) so a bible payload keeps its shape
  // version through the sanitize pass.
  if (payload && typeof payload === 'object' && payload.schemaVersion !== undefined) {
    out.schemaVersion = payload.schemaVersion;
  }
  return out;
}

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
    chunkIndex: row.chunk_index ?? 0,
    parentScrapId: row.parent_scrap_id ?? null,
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


// `{ client }` is optional — when supplied, the INSERT runs on the caller's
// transaction client so a bulk-import batch can commit-or-rollback its scraps
// alongside the ingredients + source links (see POST /api/catalog/bulk-import).
// Absent, falls through to the pool-level `query` as before. Mirrors the same
// option on `createIngredient` / `linkIngredientToSource`.
export async function createScrap({ title, rawText, sourceKind = 'paste', metadata = {}, embedding = null, embeddingModel = null, chunkIndex = 0, parentScrapId = null } = {}, { client } = {}) {
  if (!rawText) throw new Error('rawText is required');
  const id = newScrapId();
  const originInstanceId = await getInstanceId();
  const exec = client ? client.query.bind(client) : query;
  const result = await exec(
    `INSERT INTO catalog_scraps
       (id, title, raw_text, source_kind, metadata, embedding, embedding_model, origin_instance_id, chunk_index, parent_scrap_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
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
      chunkIndex,
      parentScrapId,
    ],
  );
  return rowToScrap(result.rows[0]);
}

/**
 * Create a scrap, chunking a long `rawText` into a parent row + N child rows.
 *
 * The parent (chunk_index 0, parent_scrap_id NULL) stores the FULL original
 * text so the existing scrap FTS index + "view source" UI keep working. When
 * `chunkRawText` returns more than one chunk, each chunk slice is written as a
 * child row (parent_scrap_id = parent.id, chunk_index 1..N, raw_text = the
 * slice). The catalog extractor then runs per-child and unions the drafts.
 *
 * Short inputs (≤ one chunk) insert a single parent row identical to the
 * pre-chunking behavior — no children. Returns the PARENT scrap.
 *
 * Wrapped in `withTransaction` so the parent + every child commit-or-rollback
 * together — a half-written chunk set would leave the extractor unioning a
 * partial corpus.
 */
export async function createChunkedScrap({ title, rawText, sourceKind = 'paste', metadata = {} } = {}) {
  if (!rawText) throw new Error('rawText is required');
  const chunks = chunkRawText(rawText);
  if (chunks.length <= 1) {
    return createScrap({ title, rawText, sourceKind, metadata });
  }
  return withTransaction(async (client) => {
    // Parent carries the FULL text (chunk_index 0, no parent).
    const parent = await createScrap(
      { title, rawText, sourceKind, metadata, chunkIndex: 0, parentScrapId: null },
      { client },
    );
    for (let i = 0; i < chunks.length; i++) {
      await createScrap(
        {
          title,
          rawText: chunks[i],
          sourceKind,
          metadata,
          chunkIndex: i + 1,
          parentScrapId: parent.id,
        },
        { client },
      );
    }
    return parent;
  });
}

/**
 * Live child scraps for a chunked parent, ordered by chunk_index so the
 * extractor processes the corpus in document order. Returns [] for a
 * non-chunked scrap (no children).
 */
export async function listChildScraps(parentId) {
  const result = await query(
    `SELECT * FROM catalog_scraps
      WHERE parent_scrap_id = $1 AND deleted = false
      ORDER BY chunk_index ASC`,
    [parentId],
  );
  return result.rows.map(rowToScrap);
}

export async function getScrap(id) {
  const result = await query(
    `SELECT * FROM catalog_scraps WHERE id = $1 AND deleted = false`,
    [id],
  );
  return rowToScrap(result.rows[0]);
}

// `parent_scrap_id IS NULL` hides child chunk rows from the user-facing list —
// a long paste that chunked into a parent + N children should surface as ONE
// scrap (the parent carries the full text), not N+1 entries. Children are an
// internal extraction detail reached only via listChildScraps.
export async function listScraps({ limit = 50, offset = 0 } = {}) {
  const result = await query(
    `SELECT * FROM catalog_scraps
     WHERE deleted = false AND parent_scrap_id IS NULL
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

  // Editing a chunked parent's rawText makes its stored child chunks stale —
  // and extractIngredientsForScrap prefers existing children over the parent
  // text, so a re-extract would silently union the OLD corpus. When rawText is
  // patched on a parent/standalone scrap, rebuild the children from the new
  // text in the SAME transaction as the parent update so the two never diverge.
  const rechunk = patch.rawText !== undefined;

  return withTransaction(async (client) => {
    const exec = client.query.bind(client);
    params.push(id);
    // `AND deleted = false` keeps PATCH consistent with GET — a PATCH on a
    // soft-deleted row returns zero rows so the route 404s, instead of silently
    // mutating a row the next GET would refuse to return.
    const result = await exec(
      `UPDATE catalog_scraps SET ${fields.join(', ')} WHERE id = $${idx} AND deleted = false RETURNING *`,
      params,
    );
    const updated = rowToScrap(result.rows[0]);
    if (!updated) return null;

    // Only a parent/standalone scrap rechunks — patching a child (which the UI
    // never exposes) must not spawn grandchildren.
    if (rechunk && updated.parentScrapId === null) {
      // Tombstone the old children (deleted=true so the removal propagates to
      // peers; a plain DELETE would leave them as live orphans on a synced peer)
      // then re-derive fresh chunks from the new full text. listChildScraps
      // filters deleted=false, so only the fresh children are ever read.
      await exec(
        `UPDATE catalog_scraps SET deleted = true, deleted_at = NOW()
          WHERE parent_scrap_id = $1 AND deleted = false`,
        [id],
      );
      const chunks = chunkRawText(updated.rawText);
      if (chunks.length > 1) {
        for (let i = 0; i < chunks.length; i++) {
          await createScrap(
            {
              title: updated.title,
              rawText: chunks[i],
              sourceKind: updated.sourceKind,
              metadata: updated.metadata,
              chunkIndex: i + 1,
              parentScrapId: id,
            },
            { client },
          );
        }
      }
    }
    return updated;
  });
}

export async function deleteScrap(id, { hard = false } = {}) {
  if (hard) {
    // ON DELETE CASCADE (parent_scrap_id FK) removes the child chunk rows.
    await query(`DELETE FROM catalog_scraps WHERE id = $1`, [id]);
  } else {
    // Soft-delete the parent AND its child chunks together. Children are hidden
    // from the list but still sync as live scraps, so leaving them deleted=false
    // would leak orphaned chunk rows to peers (the FK CASCADE only fires on a
    // hard delete). `parent_scrap_id = id` matches the children, `id = $1` the
    // parent; `deleted = false` avoids re-stamping deleted_at on already-gone rows.
    await query(
      `UPDATE catalog_scraps SET deleted = true, deleted_at = NOW()
        WHERE (id = $1 OR parent_scrap_id = $1) AND deleted = false`,
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

// Ref kinds that "home" an ingredient — i.e. drive the linked / unlinked (Raw) /
// orphaned bucket classification + the Orphaned album. universe/series define
// album membership; creative-director joined this set in #1812 so a CD project's
// soft-delete surfaces its ex-cast as orphaned (recoverable) rather than leaving
// dangling chips. issue/work refs CONSUME ingredients but don't home them, so
// they stay out. Each kind soft-deletes its target (`deleted = FALSE` =
// live in REF_TARGET_TABLES, catalogRefResolver.js).
const HOMING_REF_KINDS = ['universe', 'series', 'creative-director'];
const HOMING_REF_KINDS_SQL = HOMING_REF_KINDS.map((k) => `'${k}'`).join(', ');

// EXISTS predicate (over the `r` alias) that the named ref points at a LIVE
// target of its kind. One source of truth for both HAS_LIVE_HOMING_REF and the
// facets bucket's live_count FILTER — keep the two call sites in sync by reusing
// this rather than re-inlining the per-kind clauses.
const liveHomingTargetSql = (r) => `(
       (${r}.ref_kind = 'universe'          AND EXISTS (SELECT 1 FROM universes u                  WHERE u.id = ${r}.ref_id AND u.deleted = false))
    OR (${r}.ref_kind = 'series'            AND EXISTS (SELECT 1 FROM pipeline_series s            WHERE s.id = ${r}.ref_id AND s.deleted = false))
    OR (${r}.ref_kind = 'creative-director' AND EXISTS (SELECT 1 FROM creative_director_projects p WHERE p.id = ${r}.ref_id AND p.deleted = false)))`;

// SQL predicate matching ingredients that have at least one LIVE homing ref
// (target row still resolves).
const HAS_LIVE_HOMING_REF = `EXISTS (
    SELECT 1 FROM catalog_ingredient_refs r
     WHERE r.ingredient_id = catalog_ingredients.id AND r.deleted = false
       AND ${liveHomingTargetSql('r')})`;

// At least one homing ref row exists (live OR dangling) — distinguishes
// "orphaned" (has a ref, none resolve) from "unlinked" (no ref at all).
const HAS_ANY_HOMING_REF = `EXISTS (
    SELECT 1 FROM catalog_ingredient_refs r
     WHERE r.ingredient_id = catalog_ingredients.id AND r.deleted = false
       AND r.ref_kind IN (${HOMING_REF_KINDS_SQL}))`;

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

// Catalog ingredient `type` → series ref role (#1761). Anything outside this
// map (idea/scene/user-defined types) links as a generic 'mentioned' ref.
// Lives here, next to the link primitive, so every remix target that attaches
// ingredients to a series shares one role vocabulary instead of inlining its own.
const SERIES_REF_ROLE_BY_TYPE = Object.freeze({
  character: 'cast',
  place: 'canon-place',
  object: 'canon-object',
});
export const seriesRefRoleForType = (type) => SERIES_REF_ROLE_BY_TYPE[type] || 'mentioned';

// Link a batch of already-resolved catalog ingredients to a series via
// catalog_ingredient_refs (#1761) — the convergence contract's single data
// model. The inserts are mutually independent, so they fan out. Returns the
// ingredients actually linked (those with an id).
export async function linkIngredientsToSeries(seriesId, ingredients = []) {
  const list = Array.isArray(ingredients) ? ingredients.filter((ing) => ing && ing.id) : [];
  if (list.length === 0) return [];
  await Promise.all(list.map((ing) => linkIngredientToRef(ing.id, 'series', seriesId, seriesRefRoleForType(ing.type))));
  return list;
}

// Catalog ingredient `type` → Creative Director ref role (#1808). CD projects
// reuse the same convergence data model (catalog_ingredient_refs) as series; the
// role vocabulary is CD-flavored (location/prop) so the Catalog "Appears in"
// panel and any future casting UI can label a CD link meaningfully. Anything
// outside this map (idea/concept/user-defined types) links as a generic
// 'reference'. Lives next to seriesRefRoleForType so every remix target shares
// one role-vocabulary home.
const CD_REF_ROLE_BY_TYPE = Object.freeze({
  character: 'cast',
  place: 'location',
  object: 'prop',
  scene: 'scene',
});
export const cdRefRoleForType = (type) => CD_REF_ROLE_BY_TYPE[type] || 'reference';

// Link a batch of already-resolved catalog ingredients to a Creative Director
// project via catalog_ingredient_refs with ref_kind='creative-director' (#1808)
// — the reserved-but-previously-unwritten ref kind. Mirrors
// linkIngredientsToSeries; the inserts are independent so they fan out. Returns
// the ingredients actually linked (those with an id).
export async function linkIngredientsToCreativeDirector(projectId, ingredients = []) {
  const list = Array.isArray(ingredients) ? ingredients.filter((ing) => ing && ing.id) : [];
  if (list.length === 0) return [];
  await Promise.all(list.map((ing) => linkIngredientToRef(ing.id, 'creative-director', projectId, cdRefRoleForType(ing.type))));
  return list;
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

// Like listRefsForIngredient, but drops refs whose TARGET no longer resolves to
// a live record (#1812). A ref row stays live (`deleted = false`) when its
// universe/series/creative-director/issue/work target is soft-deleted — that's
// intentional (the orphan is recoverable via the Orphaned album) — but the
// detail page's "Appears in" panel must not render a chip that deep-links to a
// 404'd target. Resolution goes through the shared resolver (REF_TARGET_TABLES),
// so every ref kind is filtered uniformly. resolveRefs preserves input order and
// de-dupes its target probes, so the filter is a positional zip.
export async function listLiveRefsForIngredient(ingredientId) {
  const refs = await listRefsForIngredient(ingredientId);
  if (refs.length === 0) return refs;
  const resolved = await resolveRefs(refs);
  return refs.filter((_, i) => resolved[i]?.resolved === true);
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
    // Count only parent/standalone scraps — child chunk rows are an internal
    // extraction detail and would inflate the user-facing scrap count.
    query(`SELECT COUNT(*) AS count FROM catalog_scraps WHERE deleted = false AND parent_scrap_id IS NULL`),
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

// Faceted counts driving the Catalog filter dropdowns + album headers (#1762)
// in one round-trip. Distinguishes three mutually-exclusive per-ingredient
// buckets: LINKED (≥1 live universe/series ref — rolls up into the universes/
// series facet arrays), UNLINKED (no universe/series ref at all → "Raw" album),
// and ORPHANED (has a universe/series ref but none resolve to a live target →
// "Orphaned" album). Only live universes/series appear in the facet arrays; the
// joins on `deleted = false` enforce the same live predicate the resolver uses.
export async function getCatalogFacets() {
  const [typeRows, uniRows, serRows, tagRows, bucketRows] = await Promise.all([
    query(`SELECT type, COUNT(*)::int AS count
             FROM catalog_ingredients WHERE deleted = false
            GROUP BY type ORDER BY count DESC, type`),
    // Universe membership rolls up its series' members (decision #1), so the
    // album header count matches what the universe album/filter actually lists:
    // distinct ingredients linked to the universe OR to a live series under it.
    query(`SELECT u.id AS ref_id, u.name, COUNT(DISTINCT r.ingredient_id)::int AS count
             FROM universes u
             JOIN catalog_ingredient_refs r ON r.deleted = false AND (
                  (r.ref_kind = 'universe' AND r.ref_id = u.id)
                  OR (r.ref_kind = 'series' AND r.ref_id IN (
                        SELECT s.id FROM pipeline_series s WHERE s.universe_id = u.id AND s.deleted = false)))
             JOIN catalog_ingredients i ON i.id = r.ingredient_id AND i.deleted = false
            WHERE u.deleted = false
            GROUP BY u.id, u.name ORDER BY count DESC, u.name`),
    query(`SELECT s.id AS ref_id, s.name, s.universe_id, COUNT(DISTINCT r.ingredient_id)::int AS count
             FROM catalog_ingredient_refs r
             JOIN catalog_ingredients i ON i.id = r.ingredient_id AND i.deleted = false
             JOIN pipeline_series s ON s.id = r.ref_id AND s.deleted = false
            WHERE r.deleted = false AND r.ref_kind = 'series'
            GROUP BY s.id, s.name, s.universe_id ORDER BY count DESC, s.name`),
    query(`SELECT tag, COUNT(*)::int AS count
             FROM (SELECT unnest(tags) AS tag FROM catalog_ingredients WHERE deleted = false) t
            GROUP BY tag ORDER BY count DESC, tag`),
    // Per-ingredient bucket classification. ref_count = live homing ref ROWS
    // (universe/series/creative-director); live_count = those whose target still
    // resolves. unlinked = ref_count 0; orphaned = ref_count > 0 but live_count 0;
    // linked = live_count > 0. Same homing-ref set + live predicate as the
    // listIngredients orphaned/unlinked filters, so the bucket counts and the
    // album listings can't drift.
    query(`SELECT
              COUNT(*) FILTER (WHERE ref_count = 0)::int AS unlinked,
              COUNT(*) FILTER (WHERE ref_count > 0 AND live_count = 0)::int AS orphaned,
              COUNT(*) FILTER (WHERE live_count > 0)::int AS linked
            FROM (
              SELECT i.id,
                COUNT(r.ref_id) AS ref_count,
                COUNT(r.ref_id) FILTER (WHERE ${liveHomingTargetSql('r')}) AS live_count
              FROM catalog_ingredients i
              LEFT JOIN catalog_ingredient_refs r
                ON r.ingredient_id = i.id AND r.deleted = false AND r.ref_kind IN (${HOMING_REF_KINDS_SQL})
              WHERE i.deleted = false
              GROUP BY i.id
            ) sub`),
  ]);
  const types = typeRows.rows.map((r) => ({ type: r.type, count: r.count }));
  const total = types.reduce((sum, t) => sum + t.count, 0);
  const buckets = bucketRows.rows[0] || {};
  return {
    types,
    universes: uniRows.rows.map((r) => ({ refId: r.ref_id, name: r.name, count: r.count })),
    series: serRows.rows.map((r) => ({ refId: r.ref_id, name: r.name, universeId: r.universe_id, count: r.count })),
    tags: tagRows.rows.map((r) => ({ tag: r.tag, count: r.count })),
    unlinkedCount: buckets.unlinked ?? 0,
    orphanedCount: buckets.orphaned ?? 0,
    total,
  };
}
