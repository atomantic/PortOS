import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { request } from '../lib/testHelper.js';
import * as memory from '../services/memoryBackend.js';
import { flushBM25Index } from '../services/memory.js';
import { generateQueryEmbedding } from '../services/memoryEmbeddings.js';
import memoryRoutes from './memory.js';

vi.mock('../lib/fileUtils.js', async importOriginal =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-memory-search-') }));
vi.mock('../services/memoryEmbeddings.js', () => ({
  generateQueryEmbedding: vi.fn(),
  getActiveEmbeddingModel: vi.fn().mockResolvedValue('example-embed'),
}));

describe('POST /api/memory/search with the file backend', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/memory', memoryRoutes);
  app.use(errorMiddleware);

  const content = 'Observatory notes from the mountain.';
  const query = 'observatory unmatched';
  const sourceAppId = 'example-app';
  const embedding = [1, 0.1];
  const eligibleIds = [];

  beforeAll(async () => {
    vi.stubEnv('MEMORY_BACKEND', 'file');
    await memory.createMemory({ content, type: 'preference', sourceAppId }, [1, 0]);
    await memory.createMemory({ content, type: 'fact', sourceAppId: 'brain' }, [1, 0]);
    await memory.createMemory({ content, type: 'fact', sourceAppId, status: 'archived' }, [1, 0]);
    for (let index = 0; index < 3; index += 1) {
      const { id } = await memory.createMemory({ content, type: 'fact', sourceAppId }, embedding);
      eligibleIds.push(id);
    }
    eligibleIds.sort();
    await flushBM25Index();
  });

  afterAll(async () => {
    try {
      await flushBM25Index();
    } finally {
      vi.unstubAllEnvs();
      cleanupTempDataRoots();
    }
  });

  it('pages filtered lexical hits with a query-wide total', async () => {
    const searchMode = 'lexical';
    generateQueryEmbedding.mockResolvedValue(null);
    const filters = { query, types: ['fact'], appId: '__not_brain', limit: 1 };

    for (const offset of [0, 1, 2, 3, 1]) {
      const response = await request(app).post('/api/memory/search').send({ ...filters, offset });
      expect(response.status).toBe(200);
      expect(response.body.searchMode).toBe(searchMode);
      expect(response.body.total).toBe(3);
      expect(response.body.memories.map(hit => hit.id)).toEqual(eligibleIds.slice(offset, offset + 1));
      if (response.body.memories.length) {
        expect(response.body.memories[0]).toMatchObject({
          bm25Rank: offset + 1, rrfScore: 0.4 / (61 + offset), searchMethod: 'bm25',
        });
      }
    }
  });

  it('finds an exact keyword in a memory that has no embedding while semantic search is available', async () => {
    const { id } = await memory.createMemory({ content: 'Telescope calibration checklist.', type: 'fact', sourceAppId }, null);
    await flushBM25Index();
    // Orthogonal to every stored vector, so only the keyword can match.
    generateQueryEmbedding.mockResolvedValue([0, 1]);

    const response = await request(app).post('/api/memory/search')
      .send({ query: 'telescope', types: ['fact'], appId: '__not_brain' });

    expect(response.status).toBe(200);
    expect(response.body.searchMode).toBe('hybrid');
    expect(response.body.memories.map(hit => hit.id)).toEqual([id]);
  });
});
