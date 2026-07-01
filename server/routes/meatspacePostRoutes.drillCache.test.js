import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

// Scoped to the two new drill-cache endpoints — only the cache service is
// mocked, since it's the only dependency these routes exercise. The rest of
// meatspacePostRoutes.js already imports several other services with no
// dedicated test file of its own; broadening this file to cover them is out
// of scope for the drill-cache consent change that added these two routes.
vi.mock('../services/meatspacePostDrillCache.js', () => ({
  // postValidation.js's postDrillCacheFillSchema enum-validates against this.
  CACHEABLE_TYPES: ['compound-chain', 'bridge-word', 'double-meaning', 'idiom-twist'],
  getCacheStats: vi.fn(() => ({
    'compound-chain': { count: 3, cold: false },
    'bridge-word': { count: 0, cold: true },
  })),
  requestCacheFill: vi.fn((types) => types || ['compound-chain', 'bridge-word', 'double-meaning', 'idiom-twist']),
  getCachedDrill: vi.fn(() => null),
  triggerReplenish: vi.fn(),
}));

import { getCacheStats, requestCacheFill } from '../services/meatspacePostDrillCache.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import meatspacePostRoutes from './meatspacePostRoutes.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/meatspace', meatspacePostRoutes);
  app.use(errorMiddleware);
  return app;
}

describe('meatspace POST drill-cache routes', () => {
  let app;
  beforeEach(() => { app = makeApp(); vi.clearAllMocks(); });

  describe('GET /post/drill-cache/status', () => {
    it('returns the per-type cache stats', async () => {
      const r = await request(app).get('/api/meatspace/post/drill-cache/status');
      expect(r.status).toBe(200);
      expect(r.body['compound-chain']).toEqual({ count: 3, cold: false });
      expect(r.body['bridge-word']).toEqual({ count: 0, cold: true });
    });
  });

  describe('POST /post/drill-cache/fill', () => {
    it('rejects an unknown drill type', async () => {
      const r = await request(app).post('/api/meatspace/post/drill-cache/fill').send({ types: ['not-a-real-type'] });
      expect(r.status).toBe(400);
      expect(requestCacheFill).not.toHaveBeenCalled();
    });

    it('rejects an empty types array', async () => {
      const r = await request(app).post('/api/meatspace/post/drill-cache/fill').send({ types: [] });
      expect(r.status).toBe(400);
      expect(requestCacheFill).not.toHaveBeenCalled();
    });

    it('triggers a fill for the requested types with the given provider/model', async () => {
      const r = await request(app).post('/api/meatspace/post/drill-cache/fill')
        .send({ types: ['compound-chain'], providerId: 'test-provider', model: 'test-model' });
      expect(r.status).toBe(200);
      expect(requestCacheFill).toHaveBeenCalledWith(['compound-chain'], 'test-provider', 'test-model');
      expect(r.body).toEqual({ triggered: ['compound-chain'] });
    });

    it('defaults to all cacheable types when types is omitted', async () => {
      const r = await request(app).post('/api/meatspace/post/drill-cache/fill').send({});
      expect(r.status).toBe(200);
      expect(requestCacheFill).toHaveBeenCalledWith(undefined, undefined, undefined);
      expect(r.body.triggered).toEqual(['compound-chain', 'bridge-word', 'double-meaning', 'idiom-twist']);
    });
  });
});
