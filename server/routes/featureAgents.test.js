import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/featureAgents.js', () => ({
  getAllFeatureAgents: vi.fn(),
  getFeatureAgentRuns: vi.fn(),
}));

import * as featureAgents from '../services/featureAgents.js';
import featureAgentRoutes from './featureAgents.js';

const app = express();
app.use(express.json());
app.use('/api/feature-agents', featureAgentRoutes);
app.use(errorMiddleware);

describe('GET /api/feature-agents/:id/runs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('400s on a repeated limit key and never reads runs', async () => {
    const res = await request(app).get('/api/feature-agents/agent-1/runs?limit=1&limit=2');
    expect(res.status).toBe(400);
    expect(featureAgents.getFeatureAgentRuns).not.toHaveBeenCalled();
  });

  it('defaults the limit to 20 and clamps to 500', async () => {
    featureAgents.getFeatureAgentRuns.mockResolvedValue([]);
    await request(app).get('/api/feature-agents/agent-1/runs');
    expect(featureAgents.getFeatureAgentRuns).toHaveBeenLastCalledWith('agent-1', 20);
    await request(app).get('/api/feature-agents/agent-1/runs?limit=9999');
    expect(featureAgents.getFeatureAgentRuns).toHaveBeenLastCalledWith('agent-1', 500);
  });
});
