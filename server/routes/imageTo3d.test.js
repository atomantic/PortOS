import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Mock the service so the route test is deterministic regardless of the test
// host's real arch/memory.
vi.mock('../services/imageTo3d/targets.js', () => ({
  detectHostCapabilities: vi.fn(() => ({ appleSilicon: true, unifiedMemoryGb: 128, cuda: false })),
  listTargets: vi.fn((caps) => [
    {
      id: 'trellis2',
      label: 'TRELLIS.2',
      executionLane: 'local-mps',
      outputKind: 'glb-mesh',
      available: caps.appleSilicon && caps.unifiedMemoryGb >= 24,
      unavailableReason: null,
    },
  ]),
}));

import routes from './imageTo3d.js';

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/image-to-3d', routes);
  app.use(errorMiddleware);
  return app;
};

describe('image-to-3d routes', () => {
  it('GET /targets returns host capabilities and annotated targets', async () => {
    const res = await request(makeApp()).get('/api/image-to-3d/targets');
    expect(res.status).toBe(200);
    expect(res.body.capabilities).toMatchObject({ appleSilicon: true, unifiedMemoryGb: 128 });
    expect(Array.isArray(res.body.targets)).toBe(true);
    expect(res.body.targets[0]).toMatchObject({ id: 'trellis2', available: true });
  });
});
