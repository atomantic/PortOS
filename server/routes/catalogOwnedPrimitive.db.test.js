/**
 * A character/place/object created inside a universe through the catalog API
 * (Casting > New, New from prompt, Catalog > New) is the user's own record:
 * it must come out unlocked, join the universe's canon so it appears in the
 * universe's Cast/Environments/Objects lists and pickers, and preview a
 * reference sheet.
 *
 * Real Postgres (portos_test) for both catalog and universe stores, so the
 * transaction across creation and canon membership is exercised end to end.
 */

import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { mockNoPeerSync, mockNoPeers, mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-owned-primitive-' });
const refFault = vi.hoisted(() => ({ failCanonLink: false }));
const dbFault = vi.hoisted(() => ({ forbidUniversePoolRead: false }));
vi.mock('../lib/fileUtils.js', async () => makeProxy(await vi.importActual('../lib/fileUtils.js')));
vi.mock('../lib/db.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, query: async (sql, ...args) => {
    if (dbFault.forbidUniversePoolRead && /SELECT data FROM universes WHERE id = \$1/.test(sql)) {
      throw new Error('Universe read attempted to acquire a second pool connection');
    }
    return actual.query(sql, ...args);
  } };
});
vi.mock('../lib/pgFileFacade.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isFileBackend: () => false,
    createPgFileFacade: (options) => actual.createPgFileFacade({ ...options, isFile: () => false }) };
});
vi.mock('../services/instances.js', () => mockNoPeers());
vi.mock('../services/sharing/peerSync.js', () => mockNoPeerSync());
vi.mock('../services/catalogDB/refs.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, linkIngredientToRef: async (...args) => {
    if (refFault.failCanonLink && args[3] === 'canon-character') throw new Error('Injected canon link failure');
    return actual.linkIngredientToRef(...args);
  } };
});
vi.mock('../services/embeddings.js', () => ({
  embedBatch: vi.fn(async (seeds) => (seeds || []).map(() => ({ embedding: null, model: null }))),
  ingredientEmbedSeed: vi.fn((e) => e),
  embedIngredient: vi.fn(async () => ({})),
}));

const { request } = await import('../lib/testHelper.js');
const { errorMiddleware } = await import('../lib/errorHandler.js');
const { checkHealth, ensureSchema, close, query } = await import('../lib/db.js');
const { requireDbOrSkip } = await import('../lib/dbTestGate.js');
const { toPgJson } = await import('../lib/pgJson.js');
const { canonicalStringify } = await import('../lib/objects.js');
const { BIBLE_LIMITS } = await import('../lib/storyBible.js');
const catalogDB = await import('../services/catalogDB.js');
const { createUniverse, getUniverse, updateUniverse } = await import('../services/universeBuilder.js');
const { getUniverseMutationEpoch } = await import('../services/universeBuilder/store.js');
const { setPrimitiveOwner } = await import('../services/catalogPrimitives.js');
const catalogRouter = (await import('./catalog.js')).default;
const sheetRouter = (await import('./catalogSheets.js')).default;

const health = await checkHealth().catch((error) => ({ connected: false, error: error.message }));
let ready = health.connected;
if (ready) {
  await ensureSchema();
  ready = (await checkHealth()).hasCatalogSchema === true;
}
const runDb = requireDbOrSkip('routes/catalogOwnedPrimitive.db.test', ready, health.error || 'catalog schema not present');

const app = express();
app.use(express.json());
app.use('/api/catalog', catalogRouter);
app.use('/api/catalog', sheetRouter);
app.use(errorMiddleware);

const ingredientIds = new Set();
const universeIds = new Set();
const receiptKeys = new Set();

afterAll(async () => {
  if (ready) {
    if (receiptKeys.size) await query('DELETE FROM catalog_commit_receipts WHERE operation_key = ANY($1::uuid[])', [[...receiptKeys]]);
    for (const id of ingredientIds) await catalogDB.deleteIngredient(id, { hard: true }).catch(() => {});
    if (universeIds.size) await query('DELETE FROM universes WHERE id = ANY($1)', [[...universeIds]]);
    await close();
  }
  cleanup();
});

async function makeUniverse() {
  const universe = await createUniverse({ name: `Example Universe ${randomUUID().slice(0, 8)}`, ephemeral: true });
  universeIds.add(universe.id);
  return universe;
}

async function createInUniverse(universeId, body) {
  if (body.operationKey) receiptKeys.add(body.operationKey);
  const res = await request(app).post('/api/catalog/ingredients').send({ tags: [], universeId, ...body });
  expect(res.status).toBe(201);
  ingredientIds.add(res.body.id);
  return res.body;
}

const liveUniverseRefs = async (id) => (await catalogDB.listRefsForIngredient(id))
  .filter((ref) => ref.refKind === 'universe' && !ref.deleted)
  .map((ref) => ref.role)
  .sort();

describe.skipIf(!runDb)('POST /api/catalog/ingredients inside a universe', () => {
  it('creates an unlocked character that joins the universe cast and previews its sheet', async () => {
    const universe = await makeUniverse();
    const beforeEpoch = getUniverseMutationEpoch();
    const created = await createInUniverse(universe.id, {
      type: 'character', name: 'Ada', payload: { physicalDescription: 'Short grey hair, brass goggles.' },
    });

    expect(created.payload.locked).toBe(false);
    expect(getUniverseMutationEpoch()).toBeGreaterThan(beforeEpoch);
    expect(await liveUniverseRefs(created.id)).toEqual(['canon-character', 'owner']);
    const cast = (await getUniverse(universe.id)).characters.filter((entry) => entry.ingredientId === created.id);
    expect(cast).toHaveLength(1);
    expect(cast[0]).toMatchObject({ name: 'Ada', locked: false, physicalDescription: 'Short grey hair, brass goggles.' });
    // The canon→catalog projection must not write a default lock back.
    expect((await catalogDB.getIngredient(created.id)).payload.locked).toBe(false);

    const preview = await request(app).post(`/api/catalog/ingredients/${created.id}/sheets/preview`).send({});
    expect(preview.status).toBe(200);
    expect(preview.body.preview.sentPrompt).toContain('Ada');
  });

  it('joins places and objects to the universe canon the same way', async () => {
    const universe = await makeUniverse();
    const place = await createInUniverse(universe.id, { type: 'place', name: 'Example Harbor', payload: { description: 'Fog over piers.' } });
    const object = await createInUniverse(universe.id, { type: 'object', name: 'Example Lantern', payload: {} });

    const saved = await getUniverse(universe.id);
    expect(saved.places.filter((entry) => entry.ingredientId === place.id)).toMatchObject([{ name: 'Example Harbor', locked: false }]);
    expect(saved.objects.filter((entry) => entry.ingredientId === object.id)).toMatchObject([{ name: 'Example Lantern', locked: false }]);
    expect(await liveUniverseRefs(place.id)).toEqual(['canon-place', 'owner']);
    expect(await liveUniverseRefs(object.id)).toEqual(['canon-object', 'owner']);
  });

  // The Universe Builder create flow sends an operation key and then links the
  // record to canon itself; neither a replay nor that link may add a twin entry.
  it('keeps one canon entry across a receipt replay and the explicit canon link', async () => {
    const universe = await makeUniverse();
    const body = { type: 'character', name: 'Ada Twin Check', payload: { locked: false }, operationKey: randomUUID() };
    const first = await createInUniverse(universe.id, body);
    const replay = await createInUniverse(universe.id, body);
    expect(replay.id).toBe(first.id);
    const link = await request(app).post(`/api/catalog/ingredients/${first.id}/link`)
      .send({ refKind: 'universe', refId: universe.id, role: 'canon-character' });
    expect(link.status).toBe(201);

    const cast = (await getUniverse(universe.id)).characters.filter((entry) => entry.ingredientId === first.id);
    expect(cast).toHaveLength(1);
  });

  it('accepts a retry recorded before the unlocked default was added', async () => {
    const universe = await makeUniverse();
    const operationKey = randomUUID();
    const input = { type: 'character', name: 'Ada Legacy Retry', payload: {}, tags: [] };
    const original = await catalogDB.createIngredient(input);
    ingredientIds.add(original.id);
    receiptKeys.add(operationKey);
    await setPrimitiveOwner(original.id, universe.id);
    const fingerprint = createHash('sha256').update(canonicalStringify({ action: 'create-primitive', universeId: universe.id, ...input })).digest('hex');
    await query('INSERT INTO catalog_commit_receipts (operation_key, fingerprint, ingredients) VALUES ($1, $2, $3::jsonb)',
      [operationKey, fingerprint, toPgJson([original])]);

    const replay = await createInUniverse(universe.id, { ...input, operationKey });
    expect(replay.id).toBe(original.id);
    expect((await getUniverse(universe.id)).characters.filter((entry) => entry.ingredientId === original.id)).toHaveLength(1);
    const different = await request(app).post('/api/catalog/ingredients')
      .send({ ...input, name: 'Different request', universeId: universe.id, operationKey });
    expect(different.status).toBe(409);
    expect(different.body.code).toBe('CATALOG_CREATE_REPLAY_CONFLICT');
  });

  it('does not restore a canon membership removed after a completed creation', async () => {
    const universe = await makeUniverse();
    const body = { type: 'character', name: 'Ada Removed', payload: {}, operationKey: randomUUID() };
    const first = await createInUniverse(universe.id, body);
    const removed = await request(app).delete(`/api/catalog/ingredients/${first.id}/link`)
      .send({ refKind: 'universe', refId: universe.id, role: 'canon-character' });
    expect(removed.status).toBe(204);
    const replay = await createInUniverse(universe.id, body);
    expect(replay.id).toBe(first.id);
    expect((await getUniverse(universe.id)).characters.filter((entry) => entry.ingredientId === first.id)).toHaveLength(0);
    expect(await liveUniverseRefs(first.id)).toEqual(['owner']);
  });

  it('serializes competing creates for the last canon slot without leaving a failed record', async () => {
    const universe = await makeUniverse();
    await updateUniverse(universe.id, { characters: Array.from({ length: BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX - 1 }, (_, i) => ({ id: `slot-${i}`, name: `Slot ${i}` })) });
    const prefix = `Last slot ${randomUUID()}`;
    const responses = await Promise.all(['A', 'B'].map((suffix) => request(app).post('/api/catalog/ingredients')
      .send({ type: 'character', name: `${prefix} ${suffix}`, payload: {}, universeId: universe.id })));
    const { rows } = await query('SELECT id, name FROM catalog_ingredients WHERE name = ANY($1)', [[`${prefix} A`, `${prefix} B`]]);
    for (const row of rows) ingredientIds.add(row.id);
    expect(responses.map((res) => res.status).sort()).toEqual([201, 409]);
    expect(rows).toHaveLength(1);
    expect((await getUniverse(universe.id)).characters).toHaveLength(BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX);
  });

  it('rolls back the universe, catalog record and receipt when the canon link fails', async () => {
    const universe = await makeUniverse();
    const beforeEpoch = getUniverseMutationEpoch();
    const name = `Failed link ${randomUUID()}`;
    const operationKey = randomUUID();
    receiptKeys.add(operationKey);
    refFault.failCanonLink = true;
    const response = await Promise.resolve(request(app).post('/api/catalog/ingredients')
      .send({ type: 'character', name, payload: {}, universeId: universe.id, operationKey }))
      .finally(() => { refFault.failCanonLink = false; });
    const { rows } = await query('SELECT id FROM catalog_ingredients WHERE name = $1', [name]);
    for (const row of rows) ingredientIds.add(row.id);
    expect(response.status).toBe(500);
    expect(rows).toEqual([]);
    expect((await getUniverse(universe.id)).characters).toEqual([]);
    expect((await query('SELECT operation_key FROM catalog_commit_receipts WHERE operation_key = $1', [operationKey])).rows).toEqual([]);
    expect(getUniverseMutationEpoch()).toBe(beforeEpoch);
  });

  it('creates without acquiring a second connection to read the universe inside its transaction', async () => {
    const universe = await makeUniverse();
    const name = `Pool-safe character ${randomUUID()}`;
    dbFault.forbidUniversePoolRead = true;
    const response = await Promise.resolve(request(app).post('/api/catalog/ingredients')
      .send({ type: 'character', name, payload: {}, universeId: universe.id }))
      .finally(() => { dbFault.forbidUniversePoolRead = false; });
    const { rows } = await query('SELECT id FROM catalog_ingredients WHERE name = $1', [name]);
    for (const row of rows) ingredientIds.add(row.id);
    expect(response.status).toBe(201);
    expect((await getUniverse(universe.id)).characters).toMatchObject([{ ingredientId: response.body.id }]);
  });

  it('keeps an explicit lock the creator asked for', async () => {
    const universe = await makeUniverse();
    const created = await createInUniverse(universe.id, { type: 'character', name: 'Ada Locked', payload: { locked: true } });
    expect(created.payload.locked).toBe(true);
    expect((await getUniverse(universe.id)).characters.find((entry) => entry.ingredientId === created.id).locked).toBe(true);
  });

  it('returns the catalog missing-universe error without creating a record', async () => {
    const name = `Missing universe ${randomUUID()}`;
    const response = await request(app).post('/api/catalog/ingredients')
      .send({ type: 'character', name, payload: {}, universeId: randomUUID() });
    const { rows } = await query('SELECT id FROM catalog_ingredients WHERE name = $1', [name]);
    for (const row of rows) ingredientIds.add(row.id);
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('UNIVERSE_NOT_FOUND');
    expect(rows).toEqual([]);
  });

  // The original lock source: a record with no lock bit joined canon, the
  // universe default-locked the new entry, and the projection wrote it back.
  it('adding an existing record without a lock bit to canon leaves it unlocked', async () => {
    const universe = await makeUniverse();
    const plain = await catalogDB.createIngredient({ type: 'character', name: 'Ada Plain', payload: {} });
    ingredientIds.add(plain.id);
    await setPrimitiveOwner(plain.id, universe.id);
    const link = await request(app).post(`/api/catalog/ingredients/${plain.id}/link`)
      .send({ refKind: 'universe', refId: universe.id, role: 'canon-character' });
    expect(link.status).toBe(201);
    expect(link.body.universe.characters.find((entry) => entry.ingredientId === plain.id).locked).toBe(false);
    expect((await catalogDB.getIngredient(plain.id)).payload.locked).not.toBe(true);
    const preview = await request(app).post(`/api/catalog/ingredients/${plain.id}/sheets/preview`).send({});
    expect(preview.status).toBe(200);
  });

  it('creates an unlocked record outside a universe', async () => {
    const res = await request(app).post('/api/catalog/ingredients').send({ type: 'place', name: 'Example Plain Room', payload: {}, tags: [] });
    expect(res.status).toBe(201);
    ingredientIds.add(res.body.id);
    expect(res.body.payload.locked).toBe(false);
  });
});
