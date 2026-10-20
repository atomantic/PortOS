import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy, mockNoPeers, mockNoPeerSync,
} from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('canon-ordering-') }));
vi.mock('./instances.js', () => mockNoPeers());
vi.mock('./sharing/peerSync.js', () => mockNoPeerSync());
vi.mock('./catalogDB/identityAccess.js', () => ({ getCatalogIdentityAccess: vi.fn(async () => null) }));
vi.mock('./catalogDB.js', () => ({
  getIngredient: vi.fn(),
  getIngredientIdentityIds: vi.fn(async (id) => [id]),
  listRefsForIngredient: vi.fn(),
  getIngredientTimestamps: vi.fn(),
  updateIngredientIfFresh: vi.fn(),
}));

const catalog = await import('./catalogDB.js');
const { projectToCanon } = await import('./catalogCanonProjection.js');
const { updateUniverse, getUniverse } = await import('./universeBuilder/crud.js');
const { store } = await import('./universeBuilder/storeFacade.js');
const { sanitizeTemplate } = await import('./universeBuilder/sanitize.js');
const { default: router } = await import('../routes/universeBuilder/crud.js');
const app = express().use('/universes', router);
const universeId = 'example-universe';
const ingredientId = 'example-ingredient';
const BASE = '2026-01-01T00:00:00.000Z';
const OLD = '2026-01-02T00:00:00.000Z';
const NEW = '2026-01-03T00:00:00.000Z';
let row;

function barrier() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function commit(name, updatedAt, payload = {}) {
  row = { id: ingredientId, name, updatedAt, payload };
  return structuredClone(row);
}
async function persistedEntry() {
  const disk = JSON.parse(await readFile(join(lazyTempDataRoot('canon-ordering-'), 'universes', universeId, 'index.json'), 'utf8'));
  const response = await request(app).get(`/universes/${universeId}`);
  expect(response.status).toBe(200);
  expect(response.body.characters[0]).toEqual(disk.characters[0]);
  return disk.characters[0];
}
async function holdFirstRefRead() {
  const entered = barrier();
  const release = barrier();
  catalog.listRefsForIngredient.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return [{ refKind: 'universe', refId: universeId }];
  });
  return { entered, release };
}

beforeEach(async () => {
  vi.clearAllMocks();
  commit('Initial', BASE);
  catalog.getIngredient.mockImplementation(async () => structuredClone(row));
  catalog.getIngredientTimestamps.mockImplementation(async () => new Map([[ingredientId, row.updatedAt]]));
  catalog.updateIngredientIfFresh.mockImplementation(async (_id, patch) => {
    row = { ...row, ...structuredClone(patch), updatedAt: new Date().toISOString() };
    return { status: 'written', ingredient: structuredClone(row) };
  });
  catalog.listRefsForIngredient.mockResolvedValue([{ refKind: 'universe', refId: universeId }]);
  await store().writeRecord(universeId, sanitizeTemplate({
    id: universeId, name: 'Example Universe', createdAt: BASE, updatedAt: BASE,
    characters: [{ id: 'example-character', ingredientId, name: 'Initial',
      createdAt: BASE, updatedAt: BASE, physicalDescription: 'Remove this description' }],
  }));
});
afterAll(cleanupTempDataRoots);

describe('catalog projection ordering through persisted universe writes', () => {
  it.each([NEW, OLD])('keeps New when Old completes last (New clock %s)', async (newAt) => {
    const { entered, release } = await holdFirstRefRead();
    const oldProjection = projectToCanon(ingredientId, commit('Old', OLD));
    try {
      await entered.promise;
      expect(await projectToCanon(ingredientId, commit('New', newAt))).toMatchObject({ written: 1 });
    } finally {
      release.resolve();
      await oldProjection;
    }
    expect(row.name).toBe('New');
    expect(await persistedEntry()).toMatchObject({ name: 'New', updatedAt: newAt });
    expect(catalog.updateIngredientIfFresh).not.toHaveBeenCalled();
  });

  it('rechecks the catalog after entering the universe queue', async () => {
    const entered = barrier();
    const release = barrier();
    const queued = barrier();
    const blocker = updateUniverse(universeId, async () => {
      entered.resolve();
      await release.promise;
      return null;
    });
    await entered.promise;
    const projection = projectToCanon(ingredientId, commit('Old', OLD), {
      updateUniverse: (...args) => {
        const pending = updateUniverse(...args);
        queued.resolve();
        return pending;
      },
    });
    try {
      await queued.promise;
      commit('New', NEW);
    } finally {
      release.resolve();
      await blocker;
    }
    expect(await projection).toEqual({ universes: 1, written: 0, skipped: 1 });
    expect(await persistedEntry()).toMatchObject({ name: 'Initial', updatedAt: BASE });
    expect(row.name).toBe('New');
  });

  it('preserves a genuine newer embedded edit while a forward projection is delayed', async () => {
    const { entered, release } = await holdFirstRefRead();
    const projection = projectToCanon(ingredientId, commit('Catalog edit', OLD));
    let edited;
    try {
      await entered.promise;
      edited = await updateUniverse(universeId, (cur) => ({
        characters: cur.characters.map((entry) => ({ ...entry, name: 'Universe edit' })),
      }));
      expect(row.name).toBe('Universe edit');
      expect(catalog.updateIngredientIfFresh).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await projection;
    }
    expect(await persistedEntry()).toMatchObject({ name: 'Universe edit', updatedAt: edited.characters[0].updatedAt });
    expect(row.name).toBe('Universe edit');
  });

  it('keeps the source clock and field removals so a later save cannot resurrect stale catalog content', async () => {
    const projected = commit('Catalog edit', OLD, { role: 'Hero' });
    expect(await projectToCanon(ingredientId, projected)).toMatchObject({ written: 1 });
    const entry = await persistedEntry();
    expect(entry).toMatchObject({ id: 'example-character', ingredientId, createdAt: BASE,
      updatedAt: OLD, name: 'Catalog edit', role: 'Hero', physicalDescription: '' });
    expect(catalog.updateIngredientIfFresh).not.toHaveBeenCalled();
    commit('Later catalog edit', NEW);
    await updateUniverse(universeId, (cur) => ({
      characters: [...cur.characters, { id: 'example-other', name: 'Other character', updatedAt: BASE }],
    }));
    expect((await getUniverse(universeId)).characters[1].updatedAt > BASE).toBe(true);
    expect(await persistedEntry()).toMatchObject({ updatedAt: OLD, name: 'Catalog edit' });
    expect(row.name).toBe('Later catalog edit');
    expect(catalog.updateIngredientIfFresh).not.toHaveBeenCalled();
  });
});
