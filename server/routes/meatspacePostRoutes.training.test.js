import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

vi.mock('../services/meatspace/meatspacePostTraining.js', () => ({
  submitTrainingEntry: vi.fn(),
  submitTrainingRun: vi.fn(),
  getTrainingStats: vi.fn(),
}));

import * as trainingService from '../services/meatspace/meatspacePostTraining.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import meatspacePostRoutes from './meatspacePostRoutes.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/meatspace', meatspacePostRoutes);
  app.use(errorMiddleware);
  return app;
}

const run = (overrides = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  mode: 'training',
  attempts: [{
    id: 'attempt-1', module: 'mental-math', drillType: 'multiplication',
    questionCount: 2, correctCount: 1, latencyMs: 1200,
  }],
  ...overrides,
});

describe('POST /api/meatspace/post/training/runs (#4441)', () => {
  let app;
  beforeEach(() => {
    app = makeApp();
    vi.clearAllMocks();
    trainingService.submitTrainingRun.mockResolvedValue({ id: run().id, attemptCount: 1 });
  });

  it('validates the complete batch before delegating', async () => {
    const response = await request(app).post('/api/meatspace/post/training/runs').send(run());
    expect(response.status).toBe(201);
    expect(trainingService.submitTrainingRun).toHaveBeenCalledWith(expect.objectContaining({
      id: run().id,
      attempts: [expect.objectContaining({ id: 'attempt-1', correctCount: 1 })],
    }));
  });

  it('rejects an invalid later attempt without calling the service', async () => {
    const response = await request(app).post('/api/meatspace/post/training/runs').send(run({
      attempts: [run().attempts[0], { ...run().attempts[0], id: 'attempt-2', correctCount: 3 }],
    }));
    expect(response.status).toBe(400);
    expect(trainingService.submitTrainingRun).not.toHaveBeenCalled();
  });

  it('rejects duplicate attempt ids before storage', async () => {
    const response = await request(app).post('/api/meatspace/post/training/runs').send(run({
      attempts: [run().attempts[0], { ...run().attempts[0] }],
    }));
    expect(response.status).toBe(400);
    expect(trainingService.submitTrainingRun).not.toHaveBeenCalled();
  });
});

describe('GET /api/meatspace/post/training reads', () => {
  it('stats 400s on a repeated days key and never reads stats', async () => {
    const res = await request(makeApp()).get('/api/meatspace/post/training/stats?days=7&days=30');
    expect(res.status).toBe(400);
    expect(trainingService.getTrainingStats).not.toHaveBeenCalled();
  });

});
