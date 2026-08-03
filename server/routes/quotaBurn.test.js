import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/quotaBurnStore.js', () => ({
  getQuotaBurnConfig: vi.fn(),
  saveQuotaBurnConfig: vi.fn(),
}));
vi.mock('../services/quotaBurnRunner.js', () => ({
  getQuotaBurnStatus: vi.fn(),
  runQuotaBurnCycle: vi.fn(),
}));
vi.mock('../services/apps.js', () => ({ getActiveApps: vi.fn() }));
vi.mock('../services/universeBuilder.js', () => ({ listUniverseNames: vi.fn() }));

import { getQuotaBurnConfig, saveQuotaBurnConfig } from '../services/quotaBurnStore.js';
import { getQuotaBurnStatus, runQuotaBurnCycle } from '../services/quotaBurnRunner.js';
import { getActiveApps } from '../services/apps.js';
import { listUniverseNames } from '../services/universeBuilder.js';
import quotaBurnRoutes from './quotaBurn.js';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/quota-burn', quotaBurnRoutes);
  app.use(errorMiddleware);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
  getQuotaBurnStatus.mockResolvedValue({
    config: { enabled: false, checkIntervalMinutes: 30, families: {} },
    status: { running: false, families: [], runs: [] },
  });
  getActiveApps.mockResolvedValue([{ id: 'a1', name: 'App One', secret: 'do-not-leak' }]);
  listUniverseNames.mockResolvedValue([{ id: 'u1', name: 'Example Universe' }]);
});

describe('GET /api/quota-burn', () => {
  it('returns the plan and its live status', async () => {
    const res = await request(buildApp()).get('/api/quota-burn');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      config: { enabled: false, checkIntervalMinutes: 30, families: {} },
      status: { running: false, families: [], runs: [] },
    });
    // The status read carries the config, so the route must NOT read the file again.
    expect(getQuotaBurnConfig).not.toHaveBeenCalled();
    expect(getQuotaBurnStatus).toHaveBeenCalledWith({ refresh: false });
  });

  it('passes ?refresh through to the quota scrape', async () => {
    await request(buildApp()).get('/api/quota-burn?refresh=1');
    expect(getQuotaBurnStatus).toHaveBeenCalledWith({ refresh: true });
  });
});

describe('GET /api/quota-burn/catalog', () => {
  it('projects apps and universes down to id + name', async () => {
    const res = await request(buildApp()).get('/api/quota-burn/catalog');
    expect(res.status).toBe(200);
    expect(res.body.apps).toEqual([{ id: 'a1', name: 'App One' }]);
    expect(res.body.universes).toEqual([{ id: 'u1', name: 'Example Universe' }]);
    expect(res.body.jobTypes.map((type) => type.id)).toContain('universe-bible-images');
  });

  it('still renders when the universe store is unavailable', async () => {
    // The universe job simply has nothing to pick from — that must not 500 the
    // whole config page.
    listUniverseNames.mockRejectedValue(new Error('store down'));
    const res = await request(buildApp()).get('/api/quota-burn/catalog');
    expect(res.status).toBe(200);
    expect(res.body.universes).toEqual([]);
  });
});

describe('PUT /api/quota-burn', () => {
  it('saves a partial plan', async () => {
    saveQuotaBurnConfig.mockResolvedValue({ enabled: true });
    const res = await request(buildApp()).put('/api/quota-burn')
      .send({ families: { grok: { enabled: true, jobs: [{ jobType: 'agent-prompt', params: { appId: 'a1' } }] } } });
    expect(res.status).toBe(200);
    expect(saveQuotaBurnConfig).toHaveBeenCalledWith({
      families: { grok: { enabled: true, jobs: [{ jobType: 'agent-prompt', params: { appId: 'a1' } }] } },
    });
  });

  it('rejects an unknown family, an unknown job type, and an out-of-range interval', async () => {
    const app = buildApp();
    expect((await request(app).put('/api/quota-burn').send({ families: { nope: { enabled: true } } })).status).toBe(400);
    expect((await request(app).put('/api/quota-burn').send({ families: { grok: { jobs: [{ jobType: 'rm-rf' }] } } })).status).toBe(400);
    expect((await request(app).put('/api/quota-burn').send({ checkIntervalMinutes: 1 })).status).toBe(400);
    expect(saveQuotaBurnConfig).not.toHaveBeenCalled();
  });
});

describe('POST /api/quota-burn/run', () => {
  it('evaluates now with no body', async () => {
    runQuotaBurnCycle.mockResolvedValue({ dispatched: false, reason: 'nothing' });
    const res = await request(buildApp()).post('/api/quota-burn/run').send({});
    expect(res.status).toBe(200);
    expect(runQuotaBurnCycle).toHaveBeenCalledWith({ trigger: 'manual', familyId: null, jobId: null, force: false });
  });

  it('refuses force without a family', async () => {
    // force bypasses a SPECIFIC family's quota gates; unscoped it would mean
    // "ignore every gate on every family", which no button should be able to ask for.
    const res = await request(buildApp()).post('/api/quota-burn/run').send({ force: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('QUOTA_BURN_FORCE_NEEDS_FAMILY');
    expect(runQuotaBurnCycle).not.toHaveBeenCalled();
  });
});
