/**
 * Route tests for /api/branch-reconcile.
 * The service is mocked — we only verify routing (POST /run forces a run,
 * GET /status returns the last summary).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/branchReconcileScheduler.js', () => ({
  runBranchReconcile: vi.fn(async () => ({ cleaned: ['old'], dispatched: true })),
  getLastRun: vi.fn(() => ({ at: '2026-07-06T00:00:00.000Z', dispatched: false }))
}));

import branchReconcileRoutes from './branchReconcile.js';
import { runBranchReconcile, getLastRun } from '../services/branchReconcileScheduler.js';

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/branch-reconcile', branchReconcileRoutes);
  app.use(errorMiddleware);
  return app;
};

beforeEach(() => vi.clearAllMocks());

describe('POST /api/branch-reconcile/run', () => {
  it('forces a run and returns the summary', async () => {
    const res = await request(makeApp()).post('/api/branch-reconcile/run').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cleaned: ['old'], dispatched: true });
    expect(runBranchReconcile).toHaveBeenCalledWith({ force: true });
  });
});

describe('GET /api/branch-reconcile/status', () => {
  it('returns the last run summary', async () => {
    const res = await request(makeApp()).get('/api/branch-reconcile/status');
    expect(res.status).toBe(200);
    expect(res.body.lastRun.dispatched).toBe(false);
    expect(getLastRun).toHaveBeenCalled();
  });
});
