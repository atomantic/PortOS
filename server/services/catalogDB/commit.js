/**
 * Creative Ingredients Catalog — multi-row commit orchestration.
 *
 * Keeps transaction ownership inside the catalog data layer so HTTP callers
 * cannot accidentally persist only part of a scrap's accepted extraction.
 *
 * Storage: `db-primary` — machine-local, never federated. `catalog_commit_receipts` pin a
 * unique operation UUID, request fingerprint and original response, committed atomically
 * with the batch and retained indefinitely to preserve retry identity; covered by
 * PostgreSQL backup, no seed.
 */

import { createHash } from 'node:crypto';
import { canonicalStringify } from '../../lib/objects.js';
import { ServerError } from '../../lib/errorHandler.js';
import { catalogScrapCommitSchema } from '../../lib/catalog/catalogValidation.js';
import { collectUniverseCanonIngredientIds } from '../../lib/catalog/catalogUniverseContext.js';
import { query, withTransaction } from '../../lib/db.js';
import { createScrapIngredients } from './ingredients.js';
import { linkIngredientRelation, universeRefRoleForType } from './refs.js';
import { BIBLE_LIMITS } from '../../lib/storyBible.js';
import { assertCatalogIdentitiesWritable } from './identityAccess.js';
import { announceAssetsChanged } from './shared.js';
import { toPgJson } from '../../lib/pgJson.js';

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
  const ingredients = await readReceipt(query, input.operationKey, commitFingerprint(input));
  if (ingredients) await withScrapCanon(input, async () => ({ ingredients, replayed: true }));
  return ingredients;
}

const CANON_FIELD = Object.freeze({ character: 'characters', place: 'places', object: 'objects' });

async function replayCanonIngredients(client, ids) {
  await assertCatalogIdentitiesWritable(ids, { client });
  const { rows } = await client.query(`SELECT requested.id AS requested_id,
      i.id, i.type, i.name, i.payload, i.updated_at, catalog_identity_member_ids(i.id) AS identity_ids
    FROM unnest($1::text[]) AS requested(id)
    JOIN catalog_ingredients i ON i.id = catalog_canonical_ingredient_id(requested.id) AND i.deleted = false`, [ids]);
  return new Map(rows.map((row) => [row.requested_id, {
    ingredient: { id: row.id, type: row.type, name: row.name, payload: row.payload || {}, updatedAt: row.updated_at.toISOString() },
    identityIds: row.identity_ids,
  }]));
}

// Creation and receipt replay share the universe write queue with membership
// removal. The catalog rows, receipt and canon patch commit together, including
// requests without an operation key: a failed projection leaves no partial batch.
async function withScrapCanon({ universeRef, role, accepted = [] }, produce) {
  const eligible = (type) => Object.hasOwn(CANON_FIELD, type) && (!role || role === `canon-${type}`);
  if (!universeRef || !accepted.some((draft) => eligible(draft.type))) {
    return withTransaction(async (client) => (await produce(client)).ingredients);
  }
  const { updateUniverse } = await import('../universeBuilder.js');
  const { canonEntryFor } = await import('../catalog/catalogPrimitives.js');
  const projectionIdentityIds = [];
  let ingredients;
  await updateUniverse(universeRef, async (current, { client }) => {
    const result = await produce(client);
    ingredients = result.ingredients;
    const candidates = ingredients.filter((ingredient) => eligible(ingredient.type));
    if (!candidates.length) return null;
    const { rows } = await client.query(`SELECT ingredient_id, role FROM catalog_ingredient_refs
      WHERE ingredient_id = ANY($1::text[]) AND ref_kind = 'universe' AND ref_id = $2
        AND role = ANY($3::text[]) AND deleted = false FOR SHARE`, [
      candidates.map(({ id }) => id), universeRef, [...new Set(candidates.map(({ type }) => `canon-${type}`))],
    ]);
    const membershipKeys = new Set(rows.map((row) => `${row.ingredient_id}:${row.role}`));
    const members = candidates.filter(({ id, type }) => membershipKeys.has(`${id}:canon-${type}`));
    if (!members.length) return null;
    const replay = result.replayed ? await replayCanonIngredients(client, members.map(({ id }) => id)) : null;
    const patch = {};
    for (const member of members) {
      // Only a replay can name an existing identity with aliases or newer content.
      const projection = replay ? replay.get(member.id) : { ingredient: member, identityIds: [member.id] };
      if (!projection) continue;
      const { ingredient, identityIds } = projection;
      const field = CANON_FIELD[ingredient.type];
      const list = patch[field] || current[field] || [];
      if (list.some((entry) => identityIds.includes(entry.ingredientId))) continue;
      if (list.length >= BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX) {
        throw new ServerError('This universe’s canon bucket is full. Remove a membership before adding another.', { status: 409, code: 'UNIVERSE_CANON_FULL' });
      }
      projectionIdentityIds.push(ingredient.id, ...identityIds);
      patch[field] = [...list, canonEntryFor(ingredient)];
    }
    if (!Object.keys(patch).length) return null;
    projectionIdentityIds.push(...collectUniverseCanonIngredientIds(current));
    return patch;
  }, { transactional: true, canonProjectionIdentityIds: projectionIdentityIds }).catch((error) => {
    if (error.code === 'NOT_FOUND') throw new ServerError('Owning universe not found', { status: 404 });
    throw error;
  });
  return ingredients;
}

// Only used for rows minted inside this transaction. Existing-identity writes
// still go through the checked link helpers, and the DB identity fence still
// runs for every inserted row.
async function linkScrapIngredients(client, ingredients, accepted, scrapId, universeRef, role) {
  if (!ingredients.length) return;
  const ids = ingredients.map(({ id }) => id);
  await client.query(`INSERT INTO catalog_ingredient_sources (ingredient_id, scrap_id, span)
    SELECT ingredient_id, $3, span FROM unnest($1::text[], $2::jsonb[]) AS sources(ingredient_id, span)
    ON CONFLICT (ingredient_id, scrap_id) DO UPDATE SET span = EXCLUDED.span`, [
    ids, accepted.map(({ span }) => span ? toPgJson(span) : null), scrapId,
  ]);
  if (!universeRef) return;
  const roles = ingredients.map(({ type }) => role || universeRefRoleForType(type));
  await client.query(`INSERT INTO catalog_ingredient_refs (ingredient_id, ref_kind, ref_id, role)
    SELECT ingredient_id, 'universe', $3, role
      FROM unnest($1::text[], $2::text[]) AS refs(ingredient_id, ref_role)
      CROSS JOIN LATERAL (SELECT 'owner' AS role UNION SELECT ref_role) AS roles
    ON CONFLICT (ingredient_id, ref_kind, ref_id, role) DO UPDATE SET deleted = false, deleted_at = NULL`, [
    ids, roles, universeRef,
  ]);
  for (const id of ids) announceAssetsChanged(id, client);
}

async function linkAutoRelations(client, ingredients) {
  if (ingredients.length < 2 || ingredients.length > RELATION_BATCH_LIMIT) return;
  const ids = ingredients.map(({ id }) => id).sort();
  const fromIds = [];
  const toIds = [];
  for (const [i, fromId] of ids.entries()) {
    for (const toId of ids.slice(i + 1)) {
      fromIds.push(fromId);
      toIds.push(toId);
    }
  }
  await client.query(`INSERT INTO catalog_ingredient_relations (from_id, to_id, kind)
    SELECT from_id, to_id, 'related-to' FROM unnest($1::text[], $2::text[]) AS pairs(from_id, to_id)
    ON CONFLICT (from_id, to_id, kind) DO UPDATE SET deleted = false, deleted_at = NULL`, [fromIds, toIds]);
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
  return withScrapCanon({ universeRef, role, accepted }, async (client) => {
    if (operationKey) {
      // A competing INSERT waits for the owner to commit or roll back. The
      // following SELECT gets a fresh READ COMMITTED snapshot of its receipt.
      const claim = await client.query(
        `INSERT INTO catalog_commit_receipts (operation_key, fingerprint)
         VALUES ($1, $2) ON CONFLICT (operation_key) DO NOTHING RETURNING operation_key`,
        [operationKey, fingerprint],
      );
      if (!claim.rowCount) {
        return { ingredients: await readReceipt(client.query.bind(client), operationKey, fingerprint), replayed: true };
      }
    }
    if (universeRef) {
      const { rows } = await client.query('SELECT id FROM universes WHERE id = $1 AND deleted = false FOR SHARE', [universeRef]);
      if (!rows.length) throw new ServerError('Owning universe not found', { status: 404 });
    }
    const created = await createScrapIngredients(accepted.map((draft, i) => ({
      type: draft.type,
      name: draft.name,
      payload: draft.payload || {},
      tags: draft.tags || [],
      embedding: embeds[i]?.embedding ?? null,
      embeddingModel: embeds[i]?.model ?? null,
    })), { client });
    await linkScrapIngredients(client, created, accepted, scrapId, universeRef, role);

    // Mint one `related-to` edge per unordered pair among this batch's
    // ingredients, so a single source's extractions form a connected cluster.
    // Deterministic direction: from_id = the lexicographically smaller id —
    // the PK is (from_id, to_id, kind), so an arbitrary direction would let a
    // re-commit create a reciprocal duplicate instead of reviving the same row.
    if (relationships !== undefined) {
      const ids = new Map(accepted.map(({ draftId }, i) => [draftId, created[i].id]));
      for (const edge of relationships) {
        await linkIngredientRelation(ids.get(edge.fromDraftId), ids.get(edge.toDraftId), edge.kind, { client });
      }
    } else {
      await linkAutoRelations(client, created);
    }

    if (operationKey) {
      await client.query(
        'UPDATE catalog_commit_receipts SET ingredients = $2::jsonb WHERE operation_key = $1',
        [operationKey, toPgJson(created)],
      );
    }
    return { ingredients: created, replayed: false };
  });
}
