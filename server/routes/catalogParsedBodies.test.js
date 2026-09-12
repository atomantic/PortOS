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
  updateIngredient: vi.fn(),
  linkIngredientToRef: vi.fn(),
  unlinkIngredientFromRef: vi.fn(),
  getScrap: vi.fn(),
  commitScrap: vi.fn(),
  embedIngredient: vi.fn(),
  embedBatch: vi.fn(),
  ingredientEmbedSeed: vi.fn((entry) => entry),
}));

vi.mock('../services/catalogDB.js', () => ({
  createIngredient: mocks.createIngredient,
  getIngredient: mocks.getIngredient,
  updateIngredient: mocks.updateIngredient,
  linkIngredientToRef: mocks.linkIngredientToRef,
  unlinkIngredientFromRef: mocks.unlinkIngredientFromRef,
  getScrap: mocks.getScrap,
  commitScrap: mocks.commitScrap,
}));
vi.mock('../services/catalogSync.js', () => ({}));
vi.mock('../services/catalogCanonProjection.js', () => ({ projectToCanon: vi.fn(async () => {}) }));
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
  mocks.updateIngredient.mockImplementation(async (id, patch) => ({ id, ...patch }));
  mocks.getScrap.mockResolvedValue({ id: 'scrap-1' });
  mocks.commitScrap.mockResolvedValue([]);
  mocks.embedIngredient.mockResolvedValue({});
  mocks.embedBatch.mockResolvedValue([]);
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
