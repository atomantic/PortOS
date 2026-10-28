/**
 * A character/place/object created inside a universe through the catalog API
 * (Casting > New, New from prompt, Catalog > New) is the user's own record:
 * it must come out unlocked, join the universe's canon so it appears in the
 * universe's Cast/Environments/Objects lists and pickers, and preview a
 * reference sheet.
 *
 * Real Postgres (portos_test) for the catalog rows and refs; the universe
 * store runs on its test file backend under a temp data root, with a matching
 * `universes` row so the catalog's ownership checks see a live universe.
 */

import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { mockNoPeerSync, mockNoPeers, mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-owned-primitive-' });
vi.mock('../lib/fileUtils.js', async () => makeProxy(await vi.importActual('../lib/fileUtils.js')));
vi.mock('../services/instances.js', () => mockNoPeers());
vi.mock('../services/sharing/peerSync.js', () => mockNoPeerSync());
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
const catalogDB = await import('../services/catalogDB.js');
const { createUniverse, getUniverse } = await import('../services/universeBuilder.js');
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

afterAll(async () => {
  if (ready) {
    for (const id of ingredientIds) await catalogDB.deleteIngredient(id, { hard: true }).catch(() => {});
    if (universeIds.size) await query('DELETE FROM universes WHERE id = ANY($1)', [[...universeIds]]);
    await close();
  }
  cleanup();
});

async function makeUniverse() {
  const universe = await createUniverse({ name: `Example Universe ${randomUUID().slice(0, 8)}` });
  universeIds.add(universe.id);
  await query('INSERT INTO universes (id, name, data) VALUES ($1, $2, $3::jsonb)', [universe.id, universe.name, toPgJson({})]);
  return universe;
}

async function createInUniverse(universeId, body) {
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
    const created = await createInUniverse(universe.id, {
      type: 'character', name: 'Ada', payload: { physicalDescription: 'Short grey hair, brass goggles.' },
    });

    expect(created.payload.locked).toBe(false);
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

  it('keeps an explicit lock the creator asked for', async () => {
    const universe = await makeUniverse();
    const created = await createInUniverse(universe.id, { type: 'character', name: 'Ada Locked', payload: { locked: true } });
    expect(created.payload.locked).toBe(true);
    expect((await getUniverse(universe.id)).characters.find((entry) => entry.ingredientId === created.id).locked).toBe(true);
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
