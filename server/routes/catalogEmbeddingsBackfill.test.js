import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

const config = { provider: 'ollama', model: 'nomic-embed-text' };
vi.mock('../services/embeddings.js', () => ({
  getEmbeddingsConfig: vi.fn(async () => config),
  embedBatch: vi.fn(),
  ingredientEmbedSeed: vi.fn((i) => i),
  embedIngredient: vi.fn(),
}));
vi.mock('../services/catalog/catalogDB.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, listIngredients: vi.fn(), updateIngredient: vi.fn(async () => ({})) };
});

import * as catalogDB from '../services/catalog/catalogDB.js';
import { embedBatch } from '../services/embeddings.js';
import router from './catalog.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const app = express();
app.use(express.json());
app.use('/api/catalog', router);
app.use(errorMiddleware);

describe('POST /api/catalog/embeddings/backfill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.provider = 'ollama';
    config.model = 'nomic-embed-text';
  });

  it('refuses with EMBEDDINGS_DISABLED when the provider is none', async () => {
    config.provider = 'none';
    const res = await request(app).post('/api/catalog/embeddings/backfill').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EMBEDDINGS_DISABLED');
    expect(catalogDB.listIngredients).not.toHaveBeenCalled();
    expect(embedBatch).not.toHaveBeenCalled();
  });

  it('embeds only missing rows by default', async () => {
    catalogDB.listIngredients.mockResolvedValue({ items: [{ id: 'a' }] });
    embedBatch.mockResolvedValue([{ embedding: [0.1], model: 'nomic-embed-text' }]);
    const res = await request(app).post('/api/catalog/embeddings/backfill').send({});
    expect(res.body).toEqual({ processed: 1, embedded: 1, failed: 0, staleModel: null });
    expect(catalogDB.listIngredients).toHaveBeenCalledWith(expect.objectContaining({ embeddingMissing: true, staleEmbeddingModel: null }));
  });

  it('includeStale re-embeds rows from a different model and counts failures', async () => {
    catalogDB.listIngredients.mockResolvedValue({ items: [{ id: 'a' }, { id: 'b' }] });
    embedBatch.mockResolvedValue([{ embedding: [0.1], model: 'nomic-embed-text' }, null]);
    const res = await request(app).post('/api/catalog/embeddings/backfill').send({ includeStale: true, limit: 2 });
    expect(res.body).toEqual({ processed: 2, embedded: 1, failed: 1, staleModel: 'nomic-embed-text' });
    expect(catalogDB.listIngredients).toHaveBeenCalledWith(expect.objectContaining({ limit: 2, embeddingMissing: false, staleEmbeddingModel: 'nomic-embed-text' }));
  });
});
