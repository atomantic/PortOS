import { createHash, randomUUID } from 'node:crypto';
import { query, withTransaction } from '../lib/db.js';
import { ServerError } from '../lib/errorHandler.js';
import { canonicalStringify } from '../lib/objects.js';
import { toPgJson } from '../lib/pgJson.js';
import { CATALOG_OWNER_ROLE, catalogUniverseContext } from '../lib/catalogUniverseContext.js';
import { ingredientIdPrefix } from '../lib/catalogTypes.js';
import { BIBLE_LIMITS } from '../lib/storyBible.js';
import { CATALOG_REDESIGN_FIELDS } from '../lib/catalogRedesign.js';
import { normalizeLibrary } from '../lib/catalogMediaLibrary.js';
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

export async function getPrimitiveContext(id, { includeDerived = true } = {}) {
  const directRefs = await describeCatalogRefs(await refsFor(id));
  if (!includeDerived) return { ...catalogUniverseContext(directRefs), refs: directRefs, usageComplete: false };
  const { listPrimitiveUsages } = await import('./catalogPrimitiveUsage.js');
  const derived = await listPrimitiveUsages(id, directRefs);
  const refs = [...directRefs, ...await describeCatalogRefs(derived)];
  return { ...catalogUniverseContext(refs), refs, usageComplete: true };
}

async function requireUniverse(client, id) {
  const { rows } = await client.query('SELECT id FROM universes WHERE id = $1 AND deleted = false FOR SHARE', [id]);
  if (!rows.length) fail('Destination universe not found', 'UNIVERSE_NOT_FOUND', 404);
}

// Resolve ownership and the initial membership together. Retrying an existing
// owner does not undo a later, deliberate removal from its universe's canon.
export async function setPrimitiveOwner(id, universeId) {
  const [{ updateUniverse }, { isValidUniverseId }] = await Promise.all([
    import('./universeBuilder.js'), import('./universeBuilder/store.js'),
  ]);
  if (!isValidUniverseId(universeId)) fail('Destination universe not found', 'UNIVERSE_NOT_FOUND', 404);
  const identityIds = [];
  let membershipRole = null;
  await updateUniverse(universeId, async (current, { client }) => {
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
    if (context.owner?.refId === universeId) return null;
    await client.query(`UPDATE catalog_ingredient_refs SET deleted = true, deleted_at = NOW()
      WHERE ingredient_id = $1 AND ref_kind = 'universe' AND role = $2 AND ref_id <> $3 AND deleted = false`,
    [id, CATALOG_OWNER_ROLE, universeId]);
    await linkIngredientToRef(id, 'universe', universeId, CATALOG_OWNER_ROLE, { client });
    const ingredient = await getIngredient(id, { client });
    if (!ingredient) fail('Ingredient not found', 'CATALOG_NOT_FOUND', 404);
    const field = CANON_FIELD[ingredient.type];
    membershipRole = field ? `canon-${ingredient.type}` : 'reference';
    if (!field) return null;
    const members = await client.query('SELECT unnest(catalog_identity_member_ids($1)) AS id', [id]);
    identityIds.push(...members.rows.map((row) => row.id));
    const list = current[field] || [];
    if (list.some((entry) => identityIds.includes(entry.ingredientId))) return null;
    if (list.length >= BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX) fail('This universe’s canon bucket is full. Remove a membership before adding another.', 'UNIVERSE_CANON_FULL');
    return { [field]: [...list, canonEntryFor(ingredient)] };
  }, { transactional: true, canonProjectionGuard: id, canonProjectionIdentityIds: identityIds,
    afterWrite: (_universe, { client }) => membershipRole
      ? linkIngredientToRef(id, 'universe', universeId, membershipRole, { client }) : Promise.resolve() }).catch((error) => {
    if (error.code === 'NOT_FOUND') fail('Destination universe not found', 'UNIVERSE_NOT_FOUND', 404);
    throw error;
  });
  catalogEvents.emit('primitive-changed', { ingredientId: id });
  // The assignment is committed; a failed derived-usage lookup must not make
  // it look as if the assignment failed. The panel can retry detailed usage.
  return getPrimitiveContext(id).catch(() => getPrimitiveContext(id, { includeDerived: false }));
}

const CANON_FIELD = Object.freeze({ character: 'characters', place: 'places', object: 'objects' });

/**
 * A record the user creates themselves starts unlocked. The bit is stamped
 * explicitly because an absent `locked` reads as locked on a universe canon
 * entry (default-lock contract) and as not-yet-unlocked to merge/identity flows.
 */
export function withUserCreatedLock(input) {
  if (!CANON_FIELD[input?.type]) return input;
  const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};
  return typeof payload.locked === 'boolean' ? input : { ...input, payload: { ...payload, locked: false } };
}

export function canonEntryFor(ingredient) {
  const payload = structuredClone(ingredient.payload);
  for (const key of ['id', 'ingredientId', 'createdAt', 'updatedAt']) delete payload[key];
  return { ...payload, locked: payload.locked === true, id: `${ingredient.type}-${randomUUID()}`,
    ingredientId: ingredient.id, name: ingredient.name, updatedAt: ingredient.updatedAt };
}

// Creation, ownership and canon membership share one DB transaction inside the
// universe write queue. A full bucket or failed link therefore cannot leave a
// record behind after the caller receives an error.
export async function createOwnedPrimitive(rawInput, universeId, operationKey) {
  const input = withUserCreatedLock(rawInput);
  const field = CANON_FIELD[input.type];
  if (!field) {
    const result = await withTransaction(async (client) => {
      const created = await createOwnedRecord(input, rawInput, universeId, operationKey, client);
      if (!created.replayed) await linkIngredientToRef(created.ingredient.id, 'universe', universeId, 'reference', { client });
      return created;
    });
    return result.ingredient;
  }
  const role = `canon-${input.type}`;
  const { updateUniverse } = await import('./universeBuilder.js');
  let saved;
  let skipLink = false;
  await updateUniverse(universeId, async (current, { client }) => {
    const { ingredient: receiptIngredient, replayed } = await createOwnedRecord(input, rawInput, universeId, operationKey, client);
    const ingredient = await getIngredient(receiptIngredient.id, { client });
    if (!ingredient) fail('Ingredient not found', 'CATALOG_NOT_FOUND', 404);
    saved = ingredient;
    await assertCatalogIdentityWritable(ingredient.id, { client });
    await assertPrimitiveUniverse(ingredient.id, universeId, { client, role });
    if (replayed) {
      const { rows } = await client.query(`SELECT 1 FROM catalog_ingredient_refs
        WHERE ingredient_id = ANY(catalog_identity_member_ids($1)) AND ref_kind = 'universe'
          AND ref_id = $2 AND role = $3 AND deleted = true`, [ingredient.id, universeId, role]);
      if (rows.length) {
        skipLink = true;
        return null;
      }
    }
    const { rows } = await client.query('SELECT unnest(catalog_identity_member_ids($1)) AS id', [ingredient.id]);
    const identityIds = new Set(rows.map((row) => row.id));
    const list = current[field] || [];
    if (list.some((entry) => identityIds.has(entry.ingredientId))) return null;
    if (list.length >= BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX) fail('This universe’s canon bucket is full. Remove a membership before adding another.', 'UNIVERSE_CANON_FULL');
    return { [field]: [...list, canonEntryFor(ingredient)] };
  }, { transactional: true, afterWrite: (_universe, { client }) => skipLink
    ? Promise.resolve() : linkIngredientToRef(saved.id, 'universe', universeId, role, { client }) }).catch((error) => {
    if (error.code === 'NOT_FOUND') fail('Destination universe not found', 'UNIVERSE_NOT_FOUND', 404);
    throw error;
  });
  catalogEvents.emit('primitive-changed', { ingredientId: saved.id });
  // The transaction has committed; a failed refresh must not turn a completed
  // create into an apparent failure that a caller without a key might repeat.
  const refreshed = await getIngredient(saved.id).catch((error) => {
    console.warn(`⚠️ catalog create refresh failed: ${error.message}`);
    return null;
  });
  return refreshed || saved;
}

async function createOwnedRecord(input, rawInput, universeId, operationKey, client) {
  // The fingerprint describes the caller's request, before applying defaults.
  // Existing receipts were recorded from that same input before the explicit
  // unlocked default was introduced.
  const fingerprint = createHash('sha256').update(canonicalStringify({ action: 'create-primitive', universeId,
    type: rawInput.type, name: rawInput.name, payload: rawInput.payload, tags: rawInput.tags })).digest('hex');
  if (operationKey) {
    const claim = await client.query(`INSERT INTO catalog_commit_receipts (operation_key, fingerprint)
      VALUES ($1, $2) ON CONFLICT (operation_key) DO NOTHING RETURNING operation_key`, [operationKey, fingerprint]);
    if (!claim.rowCount) {
      const { rows: [receipt] } = await client.query('SELECT fingerprint, ingredients FROM catalog_commit_receipts WHERE operation_key = $1', [operationKey]);
      if (receipt.fingerprint !== fingerprint) fail('Operation key was already used for a different request', 'CATALOG_CREATE_REPLAY_CONFLICT');
      return { ingredient: receipt.ingredients[0], replayed: true };
    }
  }
  await requireUniverse(client, universeId);
  const ingredient = await createIngredient(input, { client });
  await linkIngredientToRef(ingredient.id, 'universe', universeId, CATALOG_OWNER_ROLE, { client });
  if (operationKey) await client.query('UPDATE catalog_commit_receipts SET ingredients = $2::jsonb WHERE operation_key = $1', [operationKey, toPgJson([ingredient])]);
  return { ingredient, replayed: false };
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
  const field = CANON_FIELD[ingredient.type];
  let universe = null;
  if (field && role === `canon-${ingredient.type}`) {
    const { updateUniverse } = await import('./universeBuilder.js');
    universe = await updateUniverse(universeId, async (current) => {
      await assertCatalogIdentityWritable(id);
      await assertPrimitiveUniverse(id, universeId, { role });
      const list = current[field] || [];
      if (list.some((entry) => identityIds.has(entry.ingredientId))) return null;
      if (list.length >= BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX) fail('This universe’s canon bucket is full. Remove a membership before adding another.', 'UNIVERSE_CANON_FULL');
      // Joining canon never changes the record's lock. Without an explicit bit
      // the universe default-locks the new entry and the canon→catalog
      // projection writes that lock back onto the record.
      return { [field]: [...list, canonEntryFor(ingredient)] };
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
  const field = CANON_FIELD[ingredient.type];
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
// `keepImage(filename)` decides which image pointers survive: none, all, or the
// seed images picked for the fork. Returns the old→new ids of re-keyed lists so
// copied media tags can follow their age/look onto the fork.
function forkPayload(type, source, keepImage) {
  const payload = structuredClone(source || {});
  for (const key of ['id', 'ingredientId', 'createdAt', 'updatedAt', 'sourceSeriesId', 'firstAppearance', 'evolution',
    'relationshipLinks', 'attachments', 'voiceId', 'referenceSheetImageRef', 'referenceSheets', 'referenceSheetRequests']) delete payload[key];
  for (const key of Object.keys(payload)) if (/request|session|provider|execution|consent|export/i.test(key)) delete payload[key];
  const idMap = {};
  for (const key of ['wardrobes', 'forms', 'stats', 'colorPalette', 'props', 'expressions', 'handGestures']) {
    if (!Array.isArray(payload[key])) continue;
    idMap[key] = new Map();
    payload[key] = payload[key].map((item) => {
      const id = `fork-${randomUUID().slice(0, 16)}`;
      if (item?.id) idMap[key].set(item.id, id);
      return { ...item, id };
    });
  }
  if (type === 'character' && payload.voiceCanon) payload.voiceCanon = { ...payload.voiceCanon, approved: false };
  if (payload.identityPack) payload.identityPack = { ...payload.identityPack,
    assets: Array.isArray(payload.identityPack.assets)
      ? payload.identityPack.assets.filter((asset) => keepImage(asset?.imageRef)).map((asset) => ({ ...asset, approved: false })) : [] };
  payload.imageRefs = Array.isArray(payload.imageRefs) ? payload.imageRefs.filter(keepImage) : [];
  if (!keepImage(payload.primaryImageRef)) payload.primaryImageRef = payload.imageRefs[0] || null;
  if (Array.isArray(payload.props)) for (const prop of payload.props) if (!keepImage(prop.imageRef)) delete prop.imageRef;
  payload.locked = false;
  return { payload, idMap };
}

// A redesign saved as a fork lands on the fork, never the source. Only the
// fields the redesign assistant may propose are accepted.
function applyRedesignFields(type, payload, fields) {
  const allowed = CATALOG_REDESIGN_FIELDS[type] || {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (!allowed[key]) fail(`${key} is not a redesign field`, 'CATALOG_FORK_FIELD_INVALID', 400);
    if (value.length > allowed[key]) fail(`${key} is ${value.length} characters; the limit is ${allowed[key]}`, 'CATALOG_FORK_FIELD_INVALID', 400);
    payload[key] = value;
  }
}

// Carry an image's age/look tags onto the fork's re-keyed forms and wardrobes.
// Review ratings and derivation links describe the source record and stay there.
function forkLibrary(library, idMap) {
  const { review, derivedFrom, ...rest } = normalizeLibrary(library);
  const variant = rest.variant ? { ...rest.variant } : null;
  if (variant?.formId) variant.formId = idMap.forms?.get(variant.formId);
  if (variant?.wardrobeId) variant.wardrobeId = idMap.wardrobes?.get(variant.wardrobeId);
  if (variant) for (const key of Object.keys(variant)) if (variant[key] === undefined) delete variant[key];
  const out = { ...rest };
  if (variant && Object.keys(variant).length) out.variant = variant; else delete out.variant;
  return out;
}

// A character, place or object fork joins its universe's canon in the same
// transaction that creates it, as createOwnedPrimitive does; ownership alone
// leaves it without the canon entry its story, voice and sheet actions edit.
export async function forkPrimitive(sourceId, request) {
  const { rows: [sourceRow] } = await query('SELECT type FROM catalog_ingredients WHERE id = catalog_canonical_ingredient_id($1)', [sourceId]);
  const field = CANON_FIELD[sourceRow?.type];
  if (!field) {
    const { fork } = await withTransaction(async (client) => {
      const result = await forkRecord(client, sourceId, request);
      if (!result.replayed) await linkIngredientToRef(result.fork.id, 'universe', request.universeId, 'reference', { client });
      return result;
    });
    catalogEvents.emit('primitive-changed', { ingredientId: fork.id });
    return fork;
  }
  const { universeId } = request;
  const role = `canon-${sourceRow.type}`;
  const { updateUniverse } = await import('./universeBuilder.js');
  let result;
  await updateUniverse(universeId, async (current, { client }) => {
    result = await forkRecord(client, sourceId, request);
    if (result.replayed) return null;
    const list = current[field] || [];
    if (list.length >= BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX) fail('This universe’s canon bucket is full. Remove a membership before adding another.', 'UNIVERSE_CANON_FULL');
    return { [field]: [...list, canonEntryFor(result.fork)] };
  }, { transactional: true, afterWrite: (_universe, { client }) => result?.replayed
    ? Promise.resolve() : linkIngredientToRef(result.fork.id, 'universe', universeId, role, { client }) }).catch((error) => {
    if (error.code === 'NOT_FOUND') fail('Destination universe not found', 'UNIVERSE_NOT_FOUND', 404);
    throw error;
  });
  catalogEvents.emit('primitive-changed', { ingredientId: result.fork.id });
  if (result.replayed) return result.fork;
  const refreshed = await getIngredient(result.fork.id).catch((error) => {
    console.warn(`⚠️ catalog fork refresh failed: ${error.message}`);
    return null;
  });
  return refreshed || result.fork;
}

async function forkRecord(client, sourceId, { universeId, name, copyImages = false, seedImages, fields, operationKey }) {
  const seeds = seedImages?.length ? [...new Set(seedImages)].sort() : null;
  const fingerprint = createHash('sha256').update(canonicalStringify({ action: 'fork-primitive', sourceId, universeId, name, copyImages,
    ...(seeds ? { seedImages: seeds } : {}), ...(fields && Object.keys(fields).length ? { fields } : {}) })).digest('hex');
  const claim = await client.query(`INSERT INTO catalog_commit_receipts (operation_key, fingerprint)
    VALUES ($1, $2) ON CONFLICT (operation_key) DO NOTHING RETURNING operation_key`, [operationKey, fingerprint]);
  if (!claim.rowCount) {
    const { rows: [receipt] } = await client.query('SELECT fingerprint, ingredients FROM catalog_commit_receipts WHERE operation_key = $1', [operationKey]);
    if (receipt.fingerprint !== fingerprint) fail('Operation key was already used for a different request', 'CATALOG_FORK_REPLAY_CONFLICT');
    return { fork: receipt.ingredients[0], replayed: true };
  }
  await requireUniverse(client, universeId);
  await client.query('SELECT id FROM catalog_ingredients WHERE id = catalog_canonical_ingredient_id($1) AND deleted = false FOR SHARE', [sourceId]);
  const access = await getCatalogIdentityAccess(sourceId, { client });
  if (access?.reason === 'CATALOG_IDENTITY_FENCED') fail('Wait for the shared identity transition to complete before creating a fork', 'CATALOG_IDENTITY_FENCED');
  const source = await getIngredient(sourceId, { client });
  if (!source) fail('Source ingredient not found', 'CATALOG_NOT_FOUND', 404);
  const seedSet = seeds ? new Set(seeds) : null;
  const keepImage = (filename) => typeof filename === 'string' && !!filename && (seedSet ? seedSet.has(filename) : copyImages);
  const { payload, idMap } = forkPayload(source.type, source.payload, keepImage);
  applyRedesignFields(source.type, payload, fields);
  // Images come from live source rows, read before the fork exists so a
  // picked image that is no longer on the source refuses the whole fork.
  let images = [];
  if (seedSet || copyImages) {
    const { rows } = await client.query(`SELECT media_key, kind, caption, metadata, library
      FROM catalog_identity_read_media WHERE ingredient_id = ANY(catalog_identity_member_ids($1))
        AND deleted = false AND kind IN ('portrait', 'reference')`, [source.id]);
    images = seedSet ? rows.filter((row) => seedSet.has(row.media_key)) : rows;
    // Canon pointers (e.g. a Universe Builder "set as reference") can exist
    // without a media row; they seed through the kept payload imageRefs.
    const canonRefs = new Set([source.payload?.primaryImageRef, ...(Array.isArray(source.payload?.imageRefs) ? source.payload.imageRefs : [])]);
    const missing = seeds?.filter((key) => !canonRefs.has(key) && !images.some((row) => row.media_key === key)) || [];
    if (missing.length) fail(`${missing.length} picked image${missing.length === 1 ? ' is' : 's are'} no longer on ${source.name}`, 'CATALOG_FORK_SEED_MISSING');
  }
  const fork = await createIngredient({ id: `cat-${ingredientIdPrefix(source.type)}-${randomUUID()}`,
    type: source.type, name: name || source.name, tags: source.tags, payload },
  { client, source: 'user', actor: `fork:${source.id}@${source.syncSequence}`.slice(0, 120) });
  await linkIngredientToRef(fork.id, 'universe', universeId, CATALOG_OWNER_ROLE, { client });
  await client.query(`INSERT INTO catalog_ingredient_relations (from_id, to_id, kind) VALUES ($1, $2, 'forked-from')`, [fork.id, source.id]);
  // New association rows share immutable managed-image bytes only. Runtime,
  // voice media, approvals and sheet/plate/look role bindings stay out; an
  // image's age and look tags follow the re-keyed forms and wardrobes.
  for (const row of images) {
    await client.query(`INSERT INTO catalog_ingredient_media (ingredient_id, media_key, kind, role, caption, metadata, library)
      VALUES ($1, $2, $3, 'fork-reference', $4, $5::jsonb, $6::jsonb)
      ON CONFLICT (ingredient_id, media_key, kind) DO NOTHING`,
    [fork.id, row.media_key, row.kind, row.caption, toPgJson(row.metadata || {}), toPgJson(forkLibrary(row.library, idMap))]);
  }
  await client.query('UPDATE catalog_commit_receipts SET ingredients = $2::jsonb WHERE operation_key = $1', [operationKey, toPgJson([fork])]);
  return { fork, replayed: false };
}
