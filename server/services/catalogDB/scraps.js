/**
 * Creative Ingredients Catalog — scrap CRUD.
 *
 * catalog_scraps: raw source text (paste/import). A long paste chunks into a
 * parent row (full text, chunk_index 0) + N child rows the extractor reads in
 * document order. Thin SQL wrappers over `catalog_scraps`; no business logic.
 */

import { query, withTransaction, arrayToPgvector } from '../../lib/db.js';
import { chunkRawText } from '../../lib/catalogChunking.js';
import { getInstanceId } from '../instances.js';
import { newScrapId, rowToScrap } from './shared.js';

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
