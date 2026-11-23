import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

// The three POST analytics/policy endpoints now call the module that DECLARES
// each entry point instead of a convenience re-export off meatspacePost.js
// (#5690). Mocking the declaring modules proves the route is wired to them —
// with the meatspacePost.js mock stubbing only what the router itself still
// touches, so a re-added re-export would not silently satisfy these.
vi.mock('../services/meatspace/meatspacePostStats.js', () => ({ getPostStats: vi.fn() }));
vi.mock('../services/meatspace/meatspacePostRecommendations.js', () => ({ getPostRecommendations: vi.fn() }));
vi.mock('../services/meatspace/meatspacePostAdaptive.js', () => ({
  resolveDrillConfig: vi.fn(),
  getAdaptivePreview: vi.fn(),
}));
vi.mock('../services/meatspace/meatspacePost.js', () => ({
  getPostConfig: vi.fn(),
  updatePostConfig: vi.fn(),
  generateDrill: vi.fn(),
  getPostReviewReps: vi.fn(),
}));
vi.mock('../services/meatspace/meatspacePostDrillCache.js', () => ({
  getCacheStats: vi.fn(() => ({})),
  requestCacheFill: vi.fn(),
  getCachedDrill: vi.fn(() => null),
  triggerReplenish: vi.fn(),
}));

import { getPostStats } from '../services/meatspace/meatspacePostStats.js';
import { getPostRecommendations } from '../services/meatspace/meatspacePostRecommendations.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import meatspacePostRoutes from './meatspacePostRoutes.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/meatspace', meatspacePostRoutes);
  app.use(errorMiddleware);
  return app;
}

describe('GET /api/meatspace/post/stats', () => {
  let app;
  beforeEach(() => {
    app = makeApp();
    vi.clearAllMocks();
    getPostStats.mockResolvedValue({ sessionCount: 3 });
  });

  it('reads the aggregates from meatspacePostStats and defaults the window to 30 days', async () => {
    const res = await request(app).get('/api/meatspace/post/stats');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessionCount: 3 });
    expect(getPostStats).toHaveBeenCalledWith(30);
  });

  it('clamps an over-long window to a year and a non-positive one to all-time', async () => {
    await request(app).get('/api/meatspace/post/stats?days=4000');
    expect(getPostStats).toHaveBeenCalledWith(365);
    await request(app).get('/api/meatspace/post/stats?days=0');
    expect(getPostStats).toHaveBeenCalledWith(0);
    await request(app).get('/api/meatspace/post/stats?days=-7');
    expect(getPostStats).toHaveBeenCalledWith(0);
  });

  it('falls back to the 30-day default when days is not a number', async () => {
    await request(app).get('/api/meatspace/post/stats?days=abc');
    expect(getPostStats).toHaveBeenCalledWith(30);
  });
});

describe('meatspace post query validation (repeated keys are refused)', () => {
  it('GET /post/stats 400s on a repeated days key and never reads stats', async () => {
    vi.clearAllMocks();
    const res = await request(makeApp()).get('/api/meatspace/post/stats?days=7&days=30');
    expect(res.status).toBe(400);
    expect(getPostStats).not.toHaveBeenCalled();
  });

  it('GET /post/recommendations 400s on a repeated limit key and never computes', async () => {
    vi.clearAllMocks();
    const res = await request(makeApp()).get('/api/meatspace/post/recommendations?limit=1&limit=2');
    expect(res.status).toBe(400);
    expect(getPostRecommendations).not.toHaveBeenCalled();
  });

  it('GET /post/sessions 400s on a repeated from key', async () => {
    const res = await request(makeApp()).get('/api/meatspace/post/sessions?from=2026-01-01&from=2026-02-01');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/meatspace/post/recommendations', () => {
  let app;
  beforeEach(() => {
    app = makeApp();
    vi.clearAllMocks();
    getPostRecommendations.mockResolvedValue({ recommendations: [] });
  });

  it('delegates to meatspacePostRecommendations with no limit by default', async () => {
    const res = await request(app).get('/api/meatspace/post/recommendations');
    expect(res.status).toBe(200);
    expect(getPostRecommendations).toHaveBeenCalledWith({});
  });

  it('clamps the requested limit into 1..10', async () => {
    await request(app).get('/api/meatspace/post/recommendations?limit=99');
    expect(getPostRecommendations).toHaveBeenCalledWith({ limit: 10 });
    await request(app).get('/api/meatspace/post/recommendations?limit=0');
    expect(getPostRecommendations).toHaveBeenCalledWith({ limit: 1 });
  });
});
