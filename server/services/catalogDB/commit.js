/**
 * Creative Ingredients Catalog — multi-row commit orchestration.
 *
 * Keeps transaction ownership inside the catalog data layer so HTTP callers
 * cannot accidentally persist only part of a scrap's accepted extraction.
 */

import { createHash } from 'node:crypto';
import { canonicalStringify } from '../../lib/objects.js';
import { ServerError } from '../../lib/errorHandler.js';
import { catalogScrapCommitSchema } from '../../lib/catalogValidation.js';
import { query, withTransaction } from '../../lib/db.js';
import { createIngredient } from './ingredients.js';
import { linkIngredientToSource, linkIngredientToRef, linkIngredientRelation, universeRefRoleForType } from './refs.js';

// Legacy same-batch `related-to` edges connect a single scrap's extractions into one
// cluster instead of N isolated nodes (#7615). Bounded: a batch above this
// size mints none — the schema allows up to 200 accepted rows, which would be
// 19,900 edges for every unordered pair at the cap.
const RELATION_BATCH_LIMIT = 25;

function commitFingerprint({ scrapId, accepted = [], universeRef = null, role = null, relationships }) {
  if (relationships !== undefined) {
    ({ accepted, relationships } = catalogScrapCommitSchema.parse({ accepted, relationships }));
  }
  // Derived embedding output never changes a reviewed submission's identity.
  return createHash('sha256').update(canonicalStringify({ scrapId, accepted, universeRef, role, relationships })).digest('hex');
}

async function readReceipt(exec, operationKey, fingerprint) {
  const { rows: [receipt] } = await exec(
    'SELECT fingerprint, ingredients FROM catalog_commit_receipts WHERE operation_key = $1', [operationKey],
  );
  if (!receipt) return null;
  if (receipt.fingerprint !== fingerprint) {
    throw new ServerError('Commit operation key was already used for a different submission', { status: 409 });
  }
  return receipt.ingredients;
}

// Fast replay before provider work. The transactional claim below remains the
// authority when two requests race before either has a committed receipt.
export async function getScrapCommitReceipt(input) {
  if (!input.operationKey) return null;
  return readReceipt(query, input.operationKey, commitFingerprint(input));
}

/**
 * Persist every accepted extraction draft and its source link atomically.
 * Embeddings are prepared by the caller before this DB-only transaction starts.
 *
 * `universeRef` (+ optional `role`) binds every created ingredient to the
 * given universe via catalog_ingredient_refs, in the same transaction, so a
 * mid-batch failure rolls back ingredients, refs, and relations together.
 * Omitting it reproduces prior behavior exactly (source link only).
 */
export async function commitScrap({ scrapId, accepted = [], embeds = [], universeRef = null, role = null, relationships, operationKey } = {}) {
  // Service callers receive the same pre-write guarantees as HTTP callers.
  if (relationships !== undefined) {
    ({ accepted, relationships } = catalogScrapCommitSchema.parse({ accepted, relationships }));
  }
  const fingerprint = operationKey
    ? commitFingerprint({ scrapId, accepted, universeRef, role, relationships })
    : null;
  return withTransaction(async (client) => {
    if (operationKey) {
      // A competing INSERT waits for the owner to commit or roll back. The
      // following SELECT gets a fresh READ COMMITTED snapshot of its receipt.
      const claim = await client.query(
        `INSERT INTO catalog_commit_receipts (operation_key, fingerprint)
         VALUES ($1, $2) ON CONFLICT (operation_key) DO NOTHING RETURNING operation_key`,
        [operationKey, fingerprint],
      );
      if (!claim.rowCount) {
        return readReceipt(client.query.bind(client), operationKey, fingerprint);
      }
    }
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

    if (operationKey) {
      await client.query(
        'UPDATE catalog_commit_receipts SET ingredients = $2::jsonb WHERE operation_key = $1',
        [operationKey, JSON.stringify(created)],
      );
    }
    return created;
  });
}
