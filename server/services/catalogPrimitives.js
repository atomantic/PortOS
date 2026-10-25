import { createHash, randomUUID } from 'node:crypto';
import { query, withTransaction } from '../lib/db.js';
import { ServerError } from '../lib/errorHandler.js';
import { canonicalStringify } from '../lib/objects.js';
import { toPgJson } from '../lib/pgJson.js';
import { CATALOG_OWNER_ROLE, catalogUniverseContext } from '../lib/catalogUniverseContext.js';
import { ingredientIdPrefix } from '../lib/catalogTypes.js';
import { BIBLE_LIMITS } from '../lib/storyBible.js';
import { createIngredient, getIngredient, getIngredientIdentityIds } from './catalogDB/ingredients.js';
import { assertCatalogIdentityWritable, assertCatalogAssociationRemovable, getCatalogIdentityAccess } from './catalogDB/identityAccess.js';
import { linkIngredientToRef, unlinkIngredientFromRef } from './catalogDB/refs.js';
import { describeCatalogRefs } from './catalogRefResolver.js';
import { catalogEvents } from './catalogEvents.js';

const fail = (message, code = 'CATALOG_UNIVERSE_CONFLICT', status = 409) => {
  throw new ServerError(message, { status, code });
};

async function refsFor(id, exec = query) {
  const { rows } = await exec(`SELECT ref_kind AS "refKind", ref_id AS "refId",
    CASE WHEN role = 'owner' AND ingredient_id <> catalog_canonical_ingredient_id($1) THEN 'retained-owner' ELSE role END AS role,
    identity_retained AS retained,
    CASE WHEN ref_kind = 'universe' THEN EXISTS(SELECT 1 FROM universes u WHERE u.id = ref_id AND u.deleted = false) ELSE true END AS resolved
    FROM catalog_identity_read_refs WHERE ingredient_id = ANY(catalog_identity_member_ids($1)) AND deleted = false`, [id]);
  return rows;
}

export async function getPrimitiveContext(id) {
  const directRefs = await describeCatalogRefs(await refsFor(id));
  const { listPrimitiveUsages } = await import('./catalogPrimitiveUsage.js');
  const derived = await listPrimitiveUsages(id, directRefs);
  const refs = [...directRefs, ...await describeCatalogRefs(derived)];
  return { ...catalogUniverseContext(refs), refs };
}

async function requireUniverse(client, id) {
  const { rows } = await client.query('SELECT id FROM universes WHERE id = $1 AND deleted = false FOR SHARE', [id]);
  if (!rows.length) fail('Destination universe not found', 'UNIVERSE_NOT_FOUND', 404);
}

// The row lock serializes overlapping explicit ownership decisions. Conflicts
// arriving later through federation remain visible rather than picking a winner.
export async function setPrimitiveOwner(id, universeId) {
  await withTransaction(async (client) => {
    await assertCatalogIdentityWritable(id, { client });
    const { rows } = await client.query('SELECT id FROM catalog_ingredients WHERE id = catalog_canonical_ingredient_id($1) AND deleted = false FOR UPDATE', [id]);
    if (!rows.length) fail('Ingredient not found', 'CATALOG_NOT_FOUND', 404);
    id = rows[0].id;
    await requireUniverse(client, universeId);
    const refs = await refsFor(id, client.query.bind(client));
    const context = catalogUniverseContext(refs);
    if (context.owner && context.owner.refId !== universeId) {
      fail('This primitive already has an owning universe. Fork it to use a different universe.');
    }
    await client.query(`UPDATE catalog_ingredient_refs SET deleted = true, deleted_at = NOW()
      WHERE ingredient_id = $1 AND ref_kind = 'universe' AND role = $2 AND ref_id <> $3 AND deleted = false`,
    [id, CATALOG_OWNER_ROLE, universeId]);
    await linkIngredientToRef(id, 'universe', universeId, CATALOG_OWNER_ROLE, { client });
  });
  const context = await getPrimitiveContext(id);
  catalogEvents.emit('primitive-changed', { ingredientId: id });
  return context;
}

export async function createOwnedPrimitive(input, universeId, operationKey) {
  return withTransaction(async (client) => {
    const fingerprint = createHash('sha256').update(canonicalStringify({ action: 'create-primitive', universeId,
      type: input.type, name: input.name, payload: input.payload, tags: input.tags })).digest('hex');
    if (operationKey) {
      const claim = await client.query(`INSERT INTO catalog_commit_receipts (operation_key, fingerprint)
        VALUES ($1, $2) ON CONFLICT (operation_key) DO NOTHING RETURNING operation_key`, [operationKey, fingerprint]);
      if (!claim.rowCount) {
        const { rows: [receipt] } = await client.query('SELECT fingerprint, ingredients FROM catalog_commit_receipts WHERE operation_key = $1', [operationKey]);
        if (receipt.fingerprint !== fingerprint) fail('Operation key was already used for a different request', 'CATALOG_CREATE_REPLAY_CONFLICT');
        return receipt.ingredients[0];
      }
    }
    await requireUniverse(client, universeId);
    const ingredient = await createIngredient(input, { client });
    await linkIngredientToRef(ingredient.id, 'universe', universeId, CATALOG_OWNER_ROLE, { client });
    if (operationKey) await client.query('UPDATE catalog_commit_receipts SET ingredients = $2::jsonb WHERE operation_key = $1', [operationKey, toPgJson([ingredient])]);
    return ingredient;
  });
}

// Container links preserve legacy records, but new cross-universe use of an
// explicitly owned identity requires an intentional fork.
async function assertPrimitiveUniverse(id, universeId, { client, role } = {}) {
  const refs = await refsFor(id, client ? client.query.bind(client) : query);
  if (role && refs.some((ref) => ref.refKind === 'universe' && ref.refId === universeId && ref.role === role && !ref.retained)) return;
  const context = catalogUniverseContext(refs);
  if (!context.owner) fail('Resolve this primitive’s ownership before adding it to another universe.');
  if (context.owner && context.owner.refId !== universeId) fail('Fork this primitive into the destination universe before adding it.');
}

export async function addPrimitiveToUniverse(id, universeId, role) {
  await assertCatalogIdentityWritable(id);
  await assertPrimitiveUniverse(id, universeId, { role });
  const ingredient = await getIngredient(id);
  if (!ingredient) fail('Ingredient not found', 'CATALOG_NOT_FOUND', 404);
  const identityIds = new Set(await getIngredientIdentityIds(ingredient.id));
  const field = { character: 'characters', place: 'places', object: 'objects' }[ingredient.type];
  let universe = null;
  if (field && role === `canon-${ingredient.type}`) {
    const { updateUniverse } = await import('./universeBuilder.js');
    universe = await updateUniverse(universeId, async (current) => {
      await assertCatalogIdentityWritable(id);
      await assertPrimitiveUniverse(id, universeId, { role });
      const list = current[field] || [];
      if (list.some((entry) => identityIds.has(entry.ingredientId))) return null;
      if (list.length >= BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX) fail('This universe’s canon bucket is full. Remove a membership before adding another.', 'UNIVERSE_CANON_FULL');
      const payload = structuredClone(ingredient.payload);
      for (const key of ['id', 'ingredientId', 'createdAt', 'updatedAt']) delete payload[key];
      return { [field]: [...list, { ...payload, id: `${ingredient.type}-${randomUUID()}`,
        ingredientId: ingredient.id, name: ingredient.name, updatedAt: ingredient.updatedAt }] };
    }, { afterWrite: () => linkIngredientToRef(ingredient.id, 'universe', universeId, role) });
  } else await linkIngredientToRef(ingredient.id, 'universe', universeId, role);
  catalogEvents.emit('primitive-changed', { ingredientId: ingredient.id });
  return { success: true, universe };
}

export async function removePrimitiveFromUniverse(id, universeId, role) {
  await assertCatalogIdentityWritable(id);
  await assertCatalogAssociationRemovable(id, 'refs', ['universe', universeId, role]);
  const ingredient = await getIngredient(id);
  if (!ingredient) fail('Ingredient not found', 'CATALOG_NOT_FOUND', 404);
  const identityIds = new Set(await getIngredientIdentityIds(ingredient.id));
  const { rows: containers } = await query('SELECT id FROM universes WHERE id = $1 AND deleted = false', [universeId]);
  const field = { character: 'characters', place: 'places', object: 'objects' }[ingredient.type];
  if (containers.length && field && role === `canon-${ingredient.type}`) {
    const { updateUniverse } = await import('./universeBuilder.js');
    await updateUniverse(universeId, async (current) => {
      const list = current[field] || [];
      const { assertCanonRemovable } = await import('./catalogPrimitiveUsage.js');
      for (const entry of list.filter((entry) => identityIds.has(entry.ingredientId))) await assertCanonRemovable(universeId, ingredient.type, entry.id);
      return list.some((entry) => identityIds.has(entry.ingredientId))
        ? { [field]: list.filter((entry) => !identityIds.has(entry.ingredientId)) } : null;
    }, { afterWrite: () => unlinkIngredientFromRef(ingredient.id, 'universe', universeId, role) });
  } else await unlinkIngredientFromRef(ingredient.id, 'universe', universeId, role);
  catalogEvents.emit('primitive-changed', { ingredientId: ingredient.id });
}

// Keep creative values, not identity, story bindings, runtime state or approval.
function forkPayload(type, source, copyImages) {
  const payload = structuredClone(source || {});
  for (const key of ['id', 'ingredientId', 'createdAt', 'updatedAt', 'sourceSeriesId', 'firstAppearance', 'evolution',
    'relationshipLinks', 'attachments', 'voiceId', 'referenceSheetImageRef', 'referenceSheets', 'referenceSheetRequests']) delete payload[key];
  for (const key of Object.keys(payload)) if (/request|session|provider|execution|consent|export/i.test(key)) delete payload[key];
  for (const key of ['wardrobes', 'forms', 'stats', 'colorPalette', 'props', 'expressions', 'handGestures']) {
    if (Array.isArray(payload[key])) payload[key] = payload[key].map((item) => ({ ...item, id: `fork-${randomUUID().slice(0, 16)}` }));
  }
  if (type === 'character' && payload.voiceCanon) payload.voiceCanon = { ...payload.voiceCanon, approved: false };
  if (payload.identityPack) payload.identityPack = { ...payload.identityPack,
    assets: copyImages && Array.isArray(payload.identityPack.assets) ? payload.identityPack.assets.map((asset) => ({ ...asset, approved: false })) : [] };
  if (!copyImages) {
    payload.imageRefs = []; payload.primaryImageRef = null;
    if (Array.isArray(payload.props)) for (const prop of payload.props) delete prop.imageRef;
  }
  payload.locked = false;
  return payload;
}

export async function forkPrimitive(sourceId, { universeId, name, copyImages = false, operationKey }) {
  const fingerprint = createHash('sha256').update(canonicalStringify({ action: 'fork-primitive', sourceId, universeId, name, copyImages })).digest('hex');
  const fork = await withTransaction(async (client) => {
    const claim = await client.query(`INSERT INTO catalog_commit_receipts (operation_key, fingerprint)
      VALUES ($1, $2) ON CONFLICT (operation_key) DO NOTHING RETURNING operation_key`, [operationKey, fingerprint]);
    if (!claim.rowCount) {
      const { rows: [receipt] } = await client.query('SELECT fingerprint, ingredients FROM catalog_commit_receipts WHERE operation_key = $1', [operationKey]);
      if (receipt.fingerprint !== fingerprint) fail('Operation key was already used for a different request', 'CATALOG_FORK_REPLAY_CONFLICT');
      return receipt.ingredients[0];
    }
    await requireUniverse(client, universeId);
    await client.query('SELECT id FROM catalog_ingredients WHERE id = catalog_canonical_ingredient_id($1) AND deleted = false FOR SHARE', [sourceId]);
    const access = await getCatalogIdentityAccess(sourceId, { client });
    if (access?.reason === 'CATALOG_IDENTITY_FENCED') fail('Wait for the shared identity transition to complete before creating a fork', 'CATALOG_IDENTITY_FENCED');
    const source = await getIngredient(sourceId, { client });
    if (!source) fail('Source ingredient not found', 'CATALOG_NOT_FOUND', 404);
    const sourceContext = catalogUniverseContext(await refsFor(source.id, client.query.bind(client)));
    if (sourceContext.owner?.refId === universeId) fail('Choose a different universe for this fork');
    const fork = await createIngredient({ id: `cat-${ingredientIdPrefix(source.type)}-${randomUUID()}`,
      type: source.type, name: name || source.name, tags: source.tags,
      payload: forkPayload(source.type, source.payload, copyImages) },
    { client, source: 'user', actor: `fork:${source.id}@${source.syncSequence}`.slice(0, 120) });
    await linkIngredientToRef(fork.id, 'universe', universeId, CATALOG_OWNER_ROLE, { client });
    await client.query(`INSERT INTO catalog_ingredient_relations (from_id, to_id, kind) VALUES ($1, $2, 'forked-from')`, [fork.id, source.id]);
    if (copyImages) {
      // New association rows share immutable managed-image bytes only. Runtime,
      // voice media, approvals and source form/wardrobe role bindings stay out.
      await client.query(`INSERT INTO catalog_ingredient_media (ingredient_id, media_key, kind, role, caption, metadata, library)
        SELECT $1, media_key, kind, 'fork-reference', caption, metadata, '{}'::jsonb
        FROM catalog_identity_read_media WHERE ingredient_id = ANY(catalog_identity_member_ids($2))
          AND deleted = false AND kind IN ('portrait', 'reference')
        ON CONFLICT (ingredient_id, media_key, kind) DO NOTHING`, [fork.id, source.id]);
    }
    await client.query('UPDATE catalog_commit_receipts SET ingredients = $2::jsonb WHERE operation_key = $1', [operationKey, toPgJson([fork])]);
    return fork;
  });
  catalogEvents.emit('primitive-changed', { ingredientId: fork.id });
  return fork;
}
