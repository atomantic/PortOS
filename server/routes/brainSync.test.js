import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Heavy service deps are mocked so route wiring + validation stays cheap and
// never reaches the live brain store or a real peer.
vi.mock('../services/brainMemoryBridge.js', () => ({
  syncAllBrainData: vi.fn(),
  getEmbeddingCoverage: vi.fn(),
}));
vi.mock('../services/brainSyncLog.js', () => ({
  getChangesSince: vi.fn(),
}));
vi.mock('../services/brainSync.js', () => ({
  applyRemoteChanges: vi.fn(),
}));
vi.mock('../services/brainReconcile.js', () => ({
  getBrainChecksum: vi.fn(),
  getBrainSnapshot: vi.fn(),
}));
vi.mock('../services/brainParity.js', () => ({
  buildBrainManifest: vi.fn(),
  getBrainParityReports: vi.fn(),
  runBrainParityCheck: vi.fn(),
}));

import * as brainParity from '../services/brainParity.js';
import * as brainSync from '../services/brainSync.js';
import brainSyncRoutes from './brainSync.js';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/brain', brainSyncRoutes);
  app.use(errorMiddleware);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/brain/sync', () => {
  it.each(['not-a-date', 42, { value: '2026-10-15' }])('rejects malformed record clocks before applying changes: %j', async (updatedAt) => {
    const res = await request(buildApp()).post('/api/brain/sync').send({ changes: [{
      seq: 1, op: 'update', type: 'people', id: 'peer-person',
      record: { name: 'Remote person', updatedAt }, ts: '2026-10-15T00:00:00Z',
    }] });

    expect(res.status).toBe(400);
    expect(brainSync.applyRemoteChanges).not.toHaveBeenCalled();
  });

  it('preserves legacy clock formats and unknown record fields', async () => {
    brainSync.applyRemoteChanges.mockResolvedValue({ updated: 1 });
    const change = {
      seq: 1, op: 'update', type: 'people', id: 'peer-person',
      record: { name: 'Remote person', updatedAt: '2026-10-15T12:00:00+02:00', futureField: { keep: true } },
      ts: '2026-10-15T10:00:00Z',
    };

    const res = await request(buildApp()).post('/api/brain/sync').send({ changes: [change] });

    expect(res.status).toBe(200);
    expect(brainSync.applyRemoteChanges).toHaveBeenCalledWith([change]);
  });
});

describe('GET /api/brain/reconcile/manifest', () => {
  it('serves the parity manifest a peer audits against', async () => {
    brainParity.buildBrainManifest.mockResolvedValue({ types: { people: [{ id: 'p1', updatedAt: 'T1', deleted: false }] } });

    const res = await request(buildApp()).get('/api/brain/reconcile/manifest');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ types: { people: [{ id: 'p1', updatedAt: 'T1', deleted: false }] } });
  });
});

describe('GET /api/brain/reconcile/parity', () => {
  it('returns the stored per-peer reports without contacting a peer', async () => {
    brainParity.getBrainParityReports.mockResolvedValue({ 'inst-peer-1': { summary: { total: 2 } } });

    const res = await request(buildApp()).get('/api/brain/reconcile/parity');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reports: { 'inst-peer-1': { summary: { total: 2 } } } });
    expect(brainParity.runBrainParityCheck).not.toHaveBeenCalled();
  });
});

describe('POST /api/brain/reconcile/parity', () => {
  beforeEach(() => {
    brainParity.runBrainParityCheck.mockResolvedValue({ reports: [] });
  });

  it('runs the check for one peer', async () => {
    const res = await request(buildApp())
      .post('/api/brain/reconcile/parity')
      .send({ peerId: 'peer-local-1' });

    expect(res.status).toBe(200);
    expect(brainParity.runBrainParityCheck).toHaveBeenCalledWith({ peerId: 'peer-local-1' });
  });

  it('sweeps every peer when peerId is omitted', async () => {
    const res = await request(buildApp()).post('/api/brain/reconcile/parity').send({});

    expect(res.status).toBe(200);
    expect(brainParity.runBrainParityCheck).toHaveBeenCalledWith({ peerId: undefined });
  });

  it('accepts a body-less POST', async () => {
    const res = await request(buildApp()).post('/api/brain/reconcile/parity');

    expect(res.status).toBe(200);
    expect(brainParity.runBrainParityCheck).toHaveBeenCalledWith({ peerId: undefined });
  });

  it('rejects a non-string peerId', async () => {
    const res = await request(buildApp())
      .post('/api/brain/reconcile/parity')
      .send({ peerId: 42 });

    expect(res.status).toBe(400);
    expect(brainParity.runBrainParityCheck).not.toHaveBeenCalled();
  });

  it('rejects an empty peerId rather than silently sweeping every peer', async () => {
    const res = await request(buildApp())
      .post('/api/brain/reconcile/parity')
      .send({ peerId: '' });

    expect(res.status).toBe(400);
    expect(brainParity.runBrainParityCheck).not.toHaveBeenCalled();
  });
});
