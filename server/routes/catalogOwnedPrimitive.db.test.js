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
const refFault = vi.hoisted(() => ({ failCanonLink: false, failReferenceLink: false }));
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
    if ((refFault.failCanonLink && args[3] === 'canon-character') || (refFault.failReferenceLink && args[3] === 'reference')) {
      throw new Error('Injected membership link failure');
    }
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
const { default: forkCanonMigration } = await import('../../scripts/migrations/452-fork-canon-membership.js');
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
const scrapIds = new Set();
const mergeIds = new Set();

afterAll(async () => {
  if (ready) {
    if (receiptKeys.size) await query('DELETE FROM catalog_commit_receipts WHERE operation_key = ANY($1::uuid[])', [[...receiptKeys]]);
    if (mergeIds.size) await query('DELETE FROM catalog_ingredient_merges WHERE id = ANY($1)', [[...mergeIds]]);
    for (const id of scrapIds) await catalogDB.deleteScrap(id, { hard: true });
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

describe.skipIf(!runDb)('PUT /api/catalog/ingredients/:id/owner', () => {
  const assign = (id, universeId) => request(app).put(`/api/catalog/ingredients/${id}/owner`).send({ universeId });

  it('does not rewrite existing catalog records or their history when other kinds join the same universe', async () => {
    const universe = await makeUniverse();
    const snapshots = [];
    for (const type of ['character', 'place', 'object', 'character']) {
      const record = await catalogDB.createIngredient({ type, name: `Example ${type}`, payload: {}, tags: [] });
      ingredientIds.add(record.id);
      expect((await assign(record.id, universe.id)).status).toBe(200);
      for (const snapshot of snapshots) {
        expect(await catalogDB.getIngredient(snapshot.id)).toEqual(snapshot.record);
        expect(await catalogDB.listIngredientRevisions(snapshot.id)).toEqual(snapshot.revisions);
      }
      const saved = await catalogDB.getIngredient(record.id);
      expect(saved.payload.schemaVersion).toBeDefined();
      snapshots.push({ id: record.id, record: saved, revisions: await catalogDB.listIngredientRevisions(record.id) });
    }
  });

  it('treats a constructor-named custom item as a reference rather than canon', async () => {
    const universe = await makeUniverse();
    const record = await catalogDB.createIngredient({ id: `cat-custom-${randomUUID()}`, type: 'constructor', name: 'Example custom item', payload: {}, tags: [] });
    ingredientIds.add(record.id);
    const response = await assign(record.id, universe.id);
    expect(response.status).toBe(200);
    expect(await liveUniverseRefs(record.id)).toEqual(['owner', 'reference']);
  });

  it('keeps the canonical catalog clock when assigning through a locally merged alias', async () => {
    const universe = await makeUniverse();
    const source = await catalogDB.createIngredient({ type: 'character', name: 'Example original', payload: {}, tags: [] });
    const survivor = await catalogDB.createIngredient({ type: 'character', name: 'Example survivor', payload: {}, tags: [] });
    ingredientIds.add(source.id);
    ingredientIds.add(survivor.id);
    await query("UPDATE catalog_ingredients SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = $1", [survivor.id]);
    const mergeId = randomUUID();
    mergeIds.add(mergeId);
    await query(`INSERT INTO catalog_ingredient_merges (id, source_id, survivor_id, before_state, after_fingerprint)
      VALUES ($1, $2, $3, '{}'::jsonb, 'fixture')`, [mergeId, source.id, survivor.id]);
    const before = await catalogDB.getIngredient(survivor.id);
    expect((await assign(source.id, universe.id)).status).toBe(200);
    const entry = (await getUniverse(universe.id)).characters.find((item) => item.ingredientId === survivor.id);
    expect(entry.updatedAt).toBe(before.updatedAt);
    expect(await catalogDB.getIngredient(survivor.id)).toEqual(before);
  });

  it('adds canon once, preserves existing references and history, and leaves a later removal intact on retry', async () => {
    const universe = await makeUniverse();
    const other = await makeUniverse();
    const record = await catalogDB.createIngredient({ type: 'object', name: 'Example Lantern', payload: { description: 'A brass lantern.' }, tags: [] });
    ingredientIds.add(record.id);
    await catalogDB.linkIngredientToRef(record.id, 'universe', other.id, 'reference');
    const before = await catalogDB.getIngredient(record.id);
    const revisions = await catalogDB.listIngredientRevisions(record.id);
    const first = await assign(record.id, universe.id);
    expect(first.status).toBe(200);
    expect(first.body.owner.refId).toBe(universe.id);
    expect(first.body.refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ refId: universe.id, role: 'canon-object' }),
      expect.objectContaining({ refId: other.id, role: 'reference' }),
    ]));
    const objects = () => getUniverse(universe.id).then((saved) => saved.objects.filter((entry) => entry.ingredientId === record.id));
    expect(await objects()).toMatchObject([{ name: 'Example Lantern', description: 'A brass lantern.', locked: false }]);
    expect((await assign(record.id, universe.id)).status).toBe(200);
    expect(await objects()).toHaveLength(1);
    expect(await catalogDB.getIngredient(record.id)).toEqual(before);
    expect(await catalogDB.listIngredientRevisions(record.id)).toEqual(revisions);
    expect((await assign(record.id, other.id)).status).toBe(409);
    expect((await assign(record.id, null)).status).toBe(400);
    expect((await assign(record.id, 'invalid/id')).status).toBe(404);
    expect((await request(app).delete(`/api/catalog/ingredients/${record.id}/link`)
      .send({ refKind: 'universe', refId: universe.id, role: 'canon-object' })).status).toBe(204);
    expect((await assign(record.id, universe.id)).status).toBe(200);
    expect(await objects()).toEqual([]);
    expect(await liveUniverseRefs(record.id)).toEqual(['owner', 'reference']);
  });

  it('serializes competing ownership choices and keeps only the winner in canon', async () => {
    const first = await makeUniverse();
    const second = await makeUniverse();
    const record = await catalogDB.createIngredient({ type: 'character', name: 'Example courier', payload: {}, tags: [] });
    ingredientIds.add(record.id);
    const results = await Promise.all([assign(record.id, first.id), assign(record.id, second.id)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const winner = results.find((result) => result.status === 200).body.owner.refId;
    for (const universe of [first, second]) {
      const entries = (await getUniverse(universe.id)).characters.filter((entry) => entry.ingredientId === record.id);
      expect(entries).toHaveLength(universe.id === winner ? 1 : 0);
    }
    expect(await liveUniverseRefs(record.id)).toEqual(['canon-character', 'owner']);
  });

  it('rolls back both owner and canon when the bucket is full or a membership link fails', async () => {
    const universe = await makeUniverse();
    const record = await catalogDB.createIngredient({ type: 'character', name: 'Example full bucket', payload: {}, tags: [] });
    ingredientIds.add(record.id);
    await updateUniverse(universe.id, { characters: Array.from({ length: BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX }, (_, i) => ({ id: `full-${i}`, name: `Existing ${i}` })) });
    const full = await assign(record.id, universe.id);
    expect(full.status).toBe(409);
    expect(full.body.code).toBe('UNIVERSE_CANON_FULL');
    expect(await liveUniverseRefs(record.id)).toEqual([]);
    await updateUniverse(universe.id, { characters: [] });
    const beforeEpoch = getUniverseMutationEpoch();
    refFault.failCanonLink = true;
    const failed = await Promise.resolve(assign(record.id, universe.id)).finally(() => { refFault.failCanonLink = false; });
    expect(failed.status).toBe(500);
    expect(await liveUniverseRefs(record.id)).toEqual([]);
    expect((await getUniverse(universe.id)).characters).toEqual([]);
    expect(getUniverseMutationEpoch()).toBe(beforeEpoch);
  });
});

describe.skipIf(!runDb)('non-canon items in a universe', () => {
  it('creates and forks with a reference, without reviving a removed reference on replay', async () => {
    const universe = await makeUniverse();
    const input = { type: 'idea', name: 'Example premise', payload: { summary: 'A small idea.' }, operationKey: randomUUID() };
    const created = await createInUniverse(universe.id, input);
    expect(await liveUniverseRefs(created.id)).toEqual(['owner', 'reference']);
    const forkInput = { universeId: universe.id, operationKey: randomUUID() };
    receiptKeys.add(forkInput.operationKey);
    const forkPath = `/api/catalog/ingredients/${created.id}/fork`;
    const fork = await request(app).post(forkPath).send(forkInput);
    expect(fork.status).toBe(201);
    ingredientIds.add(fork.body.id);
    expect(await liveUniverseRefs(fork.body.id)).toEqual(['owner', 'reference']);
    for (const id of [created.id, fork.body.id]) {
      expect((await request(app).delete(`/api/catalog/ingredients/${id}/link`)
        .send({ refKind: 'universe', refId: universe.id, role: 'reference' })).status).toBe(204);
    }
    expect((await createInUniverse(universe.id, input)).id).toBe(created.id);
    expect((await request(app).post(forkPath).send(forkInput)).body.id).toBe(fork.body.id);
    expect(await liveUniverseRefs(created.id)).toEqual(['owner']);
    expect(await liveUniverseRefs(fork.body.id)).toEqual(['owner']);
  });

  it('rolls back non-canon creation and forks when the reference write fails', async () => {
    const universe = await makeUniverse();
    const source = await createInUniverse(universe.id, { type: 'idea', name: 'Example source idea', payload: {} });
    const createName = `Failed idea ${randomUUID()}`;
    const forkName = `Failed idea fork ${randomUUID()}`;
    const createKey = randomUUID();
    const forkKey = randomUUID();
    receiptKeys.add(createKey);
    receiptKeys.add(forkKey);
    refFault.failReferenceLink = true;
    const responses = await Promise.all([
      request(app).post('/api/catalog/ingredients').send({ type: 'idea', name: createName, payload: {}, universeId: universe.id, operationKey: createKey }),
      request(app).post(`/api/catalog/ingredients/${source.id}/fork`).send({ universeId: universe.id, name: forkName, operationKey: forkKey }),
    ]).finally(() => { refFault.failReferenceLink = false; });
    expect(responses.map((response) => response.status)).toEqual([500, 500]);
    expect((await query('SELECT id FROM catalog_ingredients WHERE name = ANY($1)', [[createName, forkName]])).rows).toEqual([]);
    expect((await query('SELECT operation_key FROM catalog_commit_receipts WHERE operation_key = ANY($1::uuid[])', [[createKey, forkKey]])).rows).toEqual([]);
    expect(await liveUniverseRefs(source.id)).toEqual(['owner', 'reference']);
  });
});

// Regression: scrap refs alone were invisible to universe canon pickers.
describe.skipIf(!runDb)('POST /api/catalog/scraps/:id/commit universe canon', () => {
  it('projects each bible type once, heals an interrupted projection on replay, and preserves removals', async () => {
    const universe = await makeUniverse();
    const scrap = await catalogDB.createScrap({ rawText: 'Ada carries a lantern through the harbor.' });
    scrapIds.add(scrap.id);
    const body = { operationKey: randomUUID(), universeRef: universe.id,
      accepted: ['character', 'place', 'object'].map((type) => ({ type, name: `Example ${type}`, payload: {} })) };
    receiptKeys.add(body.operationKey);
    const commit = () => request(app).post(`/api/catalog/scraps/${scrap.id}/commit`).send(body);
    const first = await commit();
    expect(first.status).toBe(201);
    for (const ingredient of first.body.ingredients) ingredientIds.add(ingredient.id);
    const fields = { character: 'characters', place: 'places', object: 'objects' };
    const assertCanon = async () => {
      const saved = await getUniverse(universe.id);
      for (const ingredient of first.body.ingredients) {
        expect(saved[fields[ingredient.type]].filter((entry) => entry.ingredientId === ingredient.id))
          .toMatchObject([{ ingredientId: ingredient.id, locked: false }]);
        expect(saved[fields[ingredient.type]]).toHaveLength(1);
      }
    };
    await assertCanon();
    // Simulate the durable receipt surviving a crash before projection.
    await query("UPDATE universes SET data = data || '{\"objects\":[]}'::jsonb WHERE id = $1", [universe.id]);
    const replay = await commit();
    expect(replay.status).toBe(201);
    expect(replay.body.ingredients.map((i) => i.id)).toEqual(first.body.ingredients.map((i) => i.id));
    await assertCanon();
    const character = first.body.ingredients.find((i) => i.type === 'character');
    const [removed, concurrentReplay] = await Promise.all([
      request(app).delete(`/api/catalog/ingredients/${character.id}/link`)
        .send({ refKind: 'universe', refId: universe.id, role: 'canon-character' }),
      commit(),
    ]);
    expect(removed.status).toBe(204);
    expect(concurrentReplay.status).toBe(201);
    expect((await commit()).status).toBe(201);
    expect((await getUniverse(universe.id)).characters).toEqual([]);
  });

  it('rolls back the entire batch when canon is full, even without an operation key', async () => {
    const universe = await makeUniverse();
    const scrap = await catalogDB.createScrap({ rawText: 'A rejected batch.' });
    scrapIds.add(scrap.id);
    await query("UPDATE universes SET data = jsonb_set(data, '{objects}', $2::jsonb) WHERE id = $1", [universe.id,
      toPgJson(Array.from({ length: BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX }, (_, i) => ({ id: `full-${i}`, name: `Existing ${i}` })))]);
    const prefix = `Rollback scrap ${randomUUID()}`;
    const response = await request(app).post(`/api/catalog/scraps/${scrap.id}/commit`).send({
      universeRef: universe.id, accepted: ['character', 'object'].map((type) => ({ type, name: `${prefix} ${type}`, payload: {} })),
    });
    const { rows } = await query('SELECT id FROM catalog_ingredients WHERE name = ANY($1)', [[`${prefix} character`, `${prefix} object`]]);
    for (const row of rows) ingredientIds.add(row.id);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('UNIVERSE_CANON_FULL');
    expect(rows).toEqual([]);
    expect((await getUniverse(universe.id)).characters).toEqual([]);
    expect((await query('SELECT ingredient_id FROM catalog_ingredient_sources WHERE scrap_id = $1', [scrap.id])).rows).toEqual([]);
  });

  it('keeps a caller-selected non-canon role out of the canon lists', async () => {
    const universe = await makeUniverse();
    const scrap = await catalogDB.createScrap({ rawText: 'A background character.' });
    scrapIds.add(scrap.id);
    const response = await request(app).post(`/api/catalog/scraps/${scrap.id}/commit`).send({
      universeRef: universe.id, role: 'reference', accepted: [{ type: 'character', name: 'Background', payload: {} }],
    });
    expect(response.status).toBe(201);
    for (const ingredient of response.body.ingredients) ingredientIds.add(ingredient.id);
    expect((await getUniverse(universe.id)).characters).toEqual([]);
  });
});

describe.skipIf(!runDb)('POST /api/catalog/ingredients/:id/fork canon membership', () => {
  const fork = async (sourceId, body) => {
    receiptKeys.add(body.operationKey);
    const res = await request(app).post(`/api/catalog/ingredients/${sourceId}/fork`).send(body);
    expect(res.status).toBe(201);
    ingredientIds.add(res.body.id);
    return res.body;
  };

  it('adds a forked character to its universe canon once, across a replay', async () => {
    const universe = await makeUniverse();
    const source = await createInUniverse(universe.id, { type: 'character', name: 'Ada Source', payload: { physicalDescription: 'Brass goggles.' } });
    const body = { universeId: universe.id, name: 'Ada v2', operationKey: randomUUID() };
    const created = await fork(source.id, body);
    expect(await liveUniverseRefs(created.id)).toEqual(['canon-character', 'owner']);
    const entries = () => getUniverse(universe.id).then((saved) => saved.characters.filter((entry) => entry.ingredientId === created.id));
    expect(await entries()).toMatchObject([{ name: 'Ada v2', locked: false, physicalDescription: 'Brass goggles.' }]);
    expect((await fork(source.id, body)).id).toBe(created.id);
    expect(await entries()).toHaveLength(1);
  });

  it('migration 452 adds legacy owner-only forks to canon and leaves a removed membership removed', async () => {
    const universe = await makeUniverse();
    const source = await createInUniverse(universe.id, { type: 'character', name: 'Ada Legacy Source', payload: {} });
    const legacy = async (name) => {
      const record = await catalogDB.createIngredient({ type: 'character', name, payload: { locked: false }, tags: [] });
      ingredientIds.add(record.id);
      await catalogDB.linkIngredientToRef(record.id, 'universe', universe.id, 'owner');
      await query(`INSERT INTO catalog_ingredient_relations (from_id, to_id, kind) VALUES ($1, $2, 'forked-from')`, [record.id, source.id]);
      return record;
    };
    const ownerOnly = await legacy('Ada Legacy Fork');
    const removed = await legacy('Ada Removed Fork');
    await request(app).post(`/api/catalog/ingredients/${removed.id}/link`).send({ refKind: 'universe', refId: universe.id, role: 'canon-character' });
    await request(app).delete(`/api/catalog/ingredients/${removed.id}/link`).send({ refKind: 'universe', refId: universe.id, role: 'canon-character' });

    const result = await forkCanonMigration.up();
    expect(result.repaired).toBeGreaterThanOrEqual(1);
    const saved = await getUniverse(universe.id);
    expect(saved.characters.filter((entry) => entry.ingredientId === ownerOnly.id)).toMatchObject([{ name: 'Ada Legacy Fork', locked: false }]);
    expect(saved.characters.filter((entry) => entry.ingredientId === removed.id)).toHaveLength(0);
    expect(await liveUniverseRefs(ownerOnly.id)).toEqual(['canon-character', 'owner']);
    expect(await liveUniverseRefs(removed.id)).toEqual(['owner']);
    await forkCanonMigration.up();
    expect((await getUniverse(universe.id)).characters.filter((entry) => entry.ingredientId === ownerOnly.id)).toHaveLength(1);
  });
});
