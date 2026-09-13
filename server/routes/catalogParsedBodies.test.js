/**
 * Route-boundary regression tests for Catalog write-body normalization.
 *
 * Zod returns a parsed copy rather than mutating req.body. These tests keep the
 * storage and embedding boundaries mocked so they catch any route that validates
 * one value but forwards the original wire body.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const mocks = vi.hoisted(() => ({
  createIngredient: vi.fn(),
  getIngredient: vi.fn(),
  getIngredientRevision: vi.fn(),
  listRefsForIngredient: vi.fn(),
  updateIngredient: vi.fn(),
  linkIngredientToRef: vi.fn(),
  unlinkIngredientFromRef: vi.fn(),
  getScrap: vi.fn(),
  commitScrap: vi.fn(),
  embedIngredient: vi.fn(),
  embedBatch: vi.fn(),
  ingredientEmbedSeed: vi.fn((entry) => entry),
  updateUniverse: vi.fn(),
}));

vi.mock('../services/catalogDB.js', () => ({
  createIngredient: mocks.createIngredient,
  getIngredient: mocks.getIngredient,
  getIngredientRevision: mocks.getIngredientRevision,
  listRefsForIngredient: mocks.listRefsForIngredient,
  updateIngredient: mocks.updateIngredient,
  linkIngredientToRef: mocks.linkIngredientToRef,
  unlinkIngredientFromRef: mocks.unlinkIngredientFromRef,
  getScrap: mocks.getScrap,
  commitScrap: mocks.commitScrap,
}));
vi.mock('../services/catalogSync.js', () => ({}));
vi.mock('../services/universeBuilder.js', () => ({ updateUniverse: mocks.updateUniverse }));
vi.mock('../services/embeddings.js', () => ({
  embedIngredient: mocks.embedIngredient,
  embedBatch: mocks.embedBatch,
  ingredientEmbedSeed: mocks.ingredientEmbedSeed,
}));

const router = (await import('./catalog.js')).default;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/catalog', router);
  app.use(errorMiddleware);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createIngredient.mockImplementation(async (body) => ({ id: 'ing-1', ...body }));
  mocks.getIngredient.mockResolvedValue({ id: 'ing-1', name: 'Before', payload: {} });
  mocks.getIngredientRevision.mockResolvedValue(null);
  mocks.listRefsForIngredient.mockResolvedValue([]);
  mocks.updateIngredient.mockImplementation(async (id, patch) => ({ id, ...patch }));
  mocks.getScrap.mockResolvedValue({ id: 'scrap-1' });
  mocks.commitScrap.mockResolvedValue([]);
  mocks.embedIngredient.mockResolvedValue({});
  mocks.embedBatch.mockResolvedValue([]);
  mocks.updateUniverse.mockResolvedValue(null);
});

describe('Catalog parsed write bodies', () => {
  it('creates with the normalized type and does not persist or embed an unknown type', async () => {
    const created = await request(makeApp())
      .post('/api/catalog/ingredients')
      .send({ type: ' idea ', name: ' Example ', tags: [' tag '] });

    expect(created.status).toBe(201);
    expect(mocks.embedIngredient).toHaveBeenCalledWith({ type: 'idea', name: 'Example', tags: ['tag'] });
    expect(mocks.createIngredient).toHaveBeenCalledWith({
      type: 'idea',
      name: 'Example',
      payload: {},
      tags: ['tag'],
    });

    vi.clearAllMocks();
    const rejected = await request(makeApp())
      .post('/api/catalog/ingredients')
      .send({ type: ' unknown ', name: 'Example' });

    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBeTruthy();
    expect(mocks.embedIngredient).not.toHaveBeenCalled();
    expect(mocks.createIngredient).not.toHaveBeenCalled();
  });

  it('forwards identical normalized reference values to link and unlink', async () => {
    const wireBody = { refKind: 'universe', refId: ' universe-1 ', role: `${' '.repeat(65)}cast` };
    const linked = await request(makeApp())
      .post('/api/catalog/ingredients/ing-1/link')
      .send(wireBody);
    const unlinked = await request(makeApp())
      .delete('/api/catalog/ingredients/ing-1/link')
      .send(wireBody);

    expect(linked.status).toBe(201);
    expect(unlinked.status).toBe(204);
    expect(mocks.linkIngredientToRef).toHaveBeenCalledWith('ing-1', 'universe', 'universe-1', 'cast');
    expect(mocks.unlinkIngredientFromRef).toHaveBeenCalledWith('ing-1', 'universe', 'universe-1', 'cast');

    const rejected = await request(makeApp())
      .post('/api/catalog/ingredients/ing-1/link')
      .send({ refKind: 'universe', refId: 'universe-1', role: 'x'.repeat(65) });
    expect(rejected.status).toBe(400);
    expect(mocks.linkIngredientToRef).toHaveBeenCalledTimes(1);
  });

  it('uses parsed PATCH metadata and fields', async () => {
    const response = await request(makeApp())
      .patch('/api/catalog/ingredients/ing-1')
      .send({ name: ' After ', tags: [' revised '], source: 'user', actor: ' editor ' });

    expect(response.status).toBe(200);
    expect(mocks.updateIngredient).toHaveBeenCalledWith(
      'ing-1',
      { name: 'After', tags: ['revised'] },
      { source: 'user', actor: 'editor' },
    );
  });

  it('creates, edits, and restores a linked character through Catalog and universe canon', async () => {
    let ingredient;
    let canon = { characters: [] };
    const revisions = [];
    const snapshot = (source, actor = null) => revisions.push({
      id: `rev-${revisions.length + 1}`,
      ingredientId: ingredient.id,
      name: ingredient.name,
      payload: structuredClone(ingredient.payload),
      tags: [...ingredient.tags],
      source,
      actor,
    });
    mocks.createIngredient.mockImplementation(async (body) => {
      ingredient = { id: 'ing-1', ...body, updatedAt: '2026-09-12T00:00:00.000Z' };
      snapshot('user');
      return ingredient;
    });
    mocks.linkIngredientToRef.mockImplementation(async () => {
      canon.characters = [{
        id: 'canon-1', ingredientId: ingredient.id, name: ingredient.name,
        ...ingredient.payload, createdAt: '2026-09-12T00:00:00.000Z',
      }];
    });
    mocks.listRefsForIngredient.mockResolvedValue([
      { refKind: 'universe', refId: 'universe-1' },
    ]);
    mocks.updateIngredient.mockImplementation(async (id, patch, context = {}) => {
      ingredient = { ...ingredient, ...patch, id, updatedAt: new Date().toISOString() };
      snapshot(context.source || 'user', context.actor);
      return ingredient;
    });
    mocks.getIngredientRevision.mockImplementation(async (id) => revisions.find((r) => r.id === id));
    mocks.updateUniverse.mockImplementation(async (_id, mutator) => {
      const patch = mutator(canon);
      if (!patch) return null;
      canon = { ...canon, ...patch };
      return canon;
    });

    const created = await request(makeApp()).post('/api/catalog/ingredients').send({
      type: 'character', name: 'Earlier Name',
      payload: { schemaVersion: 0, description: 'Earlier description' },
      tags: ['earlier'],
    });
    expect(created.status).toBe(201);
    await request(makeApp()).post('/api/catalog/ingredients/ing-1/link').send({
      refKind: 'universe', refId: 'universe-1', role: 'canon-character',
    });
    const edited = await request(makeApp()).patch('/api/catalog/ingredients/ing-1').send({
      name: 'Newer Name', payload: { schemaVersion: 1, description: 'Newer description', staleField: 'remove' },
    });
    expect(edited.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(canon.characters[0]).toMatchObject({ name: 'Newer Name', staleField: 'remove' });

    const restored = await request(makeApp())
      .post('/api/catalog/ingredients/ing-1/revisions/rev-1/restore')
      .send({ source: 'user', actor: ' editor ' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(restored.status).toBe(200);
    expect(restored.body.payload).toEqual({ schemaVersion: 0, description: 'Earlier description' });
    expect(canon.characters[0]).toMatchObject({
      id: 'canon-1', ingredientId: 'ing-1', name: 'Earlier Name',
      description: 'Earlier description', createdAt: '2026-09-12T00:00:00.000Z',
    });
    expect(canon.characters[0]).not.toHaveProperty('staleField');
    expect(revisions).toHaveLength(3);
    expect(revisions.at(-1)).toMatchObject({
      ingredientId: 'ing-1', name: 'Earlier Name',
      payload: { schemaVersion: 0, description: 'Earlier description' },
      source: 'user', actor: 'editor',
    });
  });

  it('does not write or project a missing or wrong-owner revision', async () => {
    for (const revision of [null, { id: 'rev-1', ingredientId: 'ing-other' }]) {
      vi.clearAllMocks();
      mocks.getIngredientRevision.mockResolvedValue(revision);

      const response = await request(makeApp())
        .post('/api/catalog/ingredients/ing-1/revisions/rev-1/restore')
        .send({});

      expect(response.status).toBe(404);
      expect(mocks.updateIngredient).not.toHaveBeenCalled();
      expect(mocks.listRefsForIngredient).not.toHaveBeenCalled();
    }
  });

  it('keeps a completed restore successful when canon projection rejects', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getIngredientRevision.mockResolvedValue({
      id: 'rev-1', ingredientId: 'ing-1', name: 'Earlier', payload: { schemaVersion: 1 }, tags: [],
    });
    mocks.updateIngredient.mockResolvedValue({ id: 'ing-1', name: 'Earlier', payload: { schemaVersion: 1 } });
    mocks.listRefsForIngredient.mockRejectedValue(new Error('universe lookup failed'));

    const response = await request(makeApp())
      .post('/api/catalog/ingredients/ing-1/revisions/rev-1/restore')
      .send({});
    await new Promise((resolve) => setImmediate(resolve));

    expect(response.status).toBe(200);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('universe lookup failed'));
    log.mockRestore();
  });

  it('embeds and commits the same parsed scrap drafts', async () => {
    mocks.embedBatch.mockResolvedValue([{ embedding: null, model: null }]);
    const response = await request(makeApp())
      .post('/api/catalog/scraps/scrap-1/commit')
      .send({ accepted: [{ type: ' idea ', name: ' Draft ', tags: [' raw '] }] });

    const accepted = [{ type: 'idea', name: 'Draft', tags: ['raw'] }];
    expect(response.status).toBe(201);
    expect(mocks.ingredientEmbedSeed).toHaveBeenCalledWith(accepted[0]);
    expect(mocks.commitScrap).toHaveBeenCalledWith({
      scrapId: 'scrap-1',
      accepted,
      embeds: [{ embedding: null, model: null }],
    });
  });
});
