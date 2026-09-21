/**
 * Creative Ingredients Catalog — multi-row commit orchestration.
 *
 * Keeps transaction ownership inside the catalog data layer so HTTP callers
 * cannot accidentally persist only part of a scrap's accepted extraction.
 */

import { catalogScrapCommitSchema } from '../../lib/catalogValidation.js';
import { withTransaction } from '../../lib/db.js';
import { createIngredient } from './ingredients.js';
import { linkIngredientToSource, linkIngredientToRef, linkIngredientRelation, universeRefRoleForType } from './refs.js';

// Legacy same-batch `related-to` edges connect a single scrap's extractions into one
// cluster instead of N isolated nodes (#7615). Bounded: a batch above this
// size mints none — the schema allows up to 200 accepted rows, which would be
// 19,900 edges for every unordered pair at the cap.
const RELATION_BATCH_LIMIT = 25;

/**
 * Persist every accepted extraction draft and its source link atomically.
 * Embeddings are prepared by the caller before this DB-only transaction starts.
 *
 * `universeRef` (+ optional `role`) binds every created ingredient to the
 * given universe via catalog_ingredient_refs, in the same transaction, so a
 * mid-batch failure rolls back ingredients, refs, and relations together.
 * Omitting it reproduces prior behavior exactly (source link only).
 */
export async function commitScrap({ scrapId, accepted = [], embeds = [], universeRef = null, role = null, relationships } = {}) {
  // Service callers receive the same pre-write guarantees as HTTP callers.
  if (relationships !== undefined) {
    ({ accepted, relationships } = catalogScrapCommitSchema.parse({ accepted, relationships }));
  }
  return withTransaction(async (client) => {
    const created = [];
    const ids = new Map();
    for (let i = 0; i < accepted.length; i++) {
      const draft = accepted[i];
      const embedding = embeds[i];
      const ingredient = await createIngredient({
        type: draft.type,
        name: draft.name,
        payload: draft.payload || {},
        tags: draft.tags || [],
        embedding: embedding?.embedding ?? null,
        embeddingModel: embedding?.model ?? null,
      }, { client, source: 'extract' });
      await linkIngredientToSource(ingredient.id, scrapId, draft.span || null, { client });
      if (universeRef) {
        await linkIngredientToRef(
          ingredient.id,
          'universe',
          universeRef,
          role || universeRefRoleForType(draft.type),
          { client },
        );
      }
      created.push(ingredient);
      if (draft.draftId) ids.set(draft.draftId, ingredient.id);
    }

    // Mint one `related-to` edge per unordered pair among this batch's
    // ingredients, so a single source's extractions form a connected cluster.
    // Deterministic direction: from_id = the lexicographically smaller id —
    // the PK is (from_id, to_id, kind), so an arbitrary direction would let a
    // re-commit create a reciprocal duplicate instead of reviving the same row.
    if (relationships !== undefined) {
      for (const edge of relationships) {
        await linkIngredientRelation(ids.get(edge.fromDraftId), ids.get(edge.toDraftId), edge.kind, { client });
      }
    } else if (created.length >= 2 && created.length <= RELATION_BATCH_LIMIT) {
      for (let i = 0; i < created.length; i++) {
        for (let j = i + 1; j < created.length; j++) {
          const [fromId, toId] = created[i].id < created[j].id
            ? [created[i].id, created[j].id]
            : [created[j].id, created[i].id];
          await linkIngredientRelation(fromId, toId, 'related-to', { client });
        }
      }
    }

    return created;
  });
}
