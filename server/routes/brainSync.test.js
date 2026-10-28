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
vi.mock('../services/brainReconcile.js', () => ({
  getBrainChecksum: vi.fn(),
  getBrainSnapshot: vi.fn(),
}));
vi.mock('../services/brainParity.js', () => ({
  buildBrainManifest: vi.fn(),
  getBrainParityReports: vi.fn(),
  runBrainParityCheck: vi.fn(),
}));
// The real peer-pull gate runs; only the peer registry and settings it reads
// are stubbed, as in routes/dataSync.test.js.
const peers = [];
vi.mock('../services/instances.js', async () => ({
  ...(await vi.importActual('../services/instances.js')),
  getPeers: async () => peers,
}));
let settings = {};
vi.mock('../services/settings.js', async () => ({
  ...(await vi.importActual('../services/settings.js')),
  getSettings: async () => settings,
}));

import * as brainParity from '../services/brainParity.js';
import * as brainSyncLog from '../services/brainSyncLog.js';
import * as brainReconcile from '../services/brainReconcile.js';
import { PEER_INSTANCE_ID_HEADER, __resetPullWarnThrottleForTests } from '../services/sharing/peerPullAuthorization.js';
import brainSyncRoutes from './brainSync.js';

const buildApp = (authContext = null) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.portosAuthContext = authContext; next(); });
  app.use('/api/brain', brainSyncRoutes);
  app.use(errorMiddleware);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
  peers.length = 0;
  settings = {};
  __resetPullWarnThrottleForTests();
});

describe('brain pulls honor the per-peer brain category', () => {
  const PEER_ID = 'peer-a-instance-id';
  const peer = (syncCategories) => ({
    instanceId: PEER_ID, name: 'Example Peer', enabled: true, syncEnabled: true,
    directions: ['outbound', 'inbound'], syncCategories,
  });
  const reads = [
    ['/api/brain/sync', () => brainSyncLog.getChangesSince],
    ['/api/brain/reconcile/checksum', () => brainReconcile.getBrainChecksum],
    ['/api/brain/reconcile/snapshot', () => brainReconcile.getBrainSnapshot],
    ['/api/brain/reconcile/manifest', () => brainParity.buildBrainManifest],
  ];
  beforeEach(() => {
    brainSyncLog.getChangesSince.mockResolvedValue({ changes: [], maxSeq: 0, hasMore: false });
    brainReconcile.getBrainChecksum.mockResolvedValue('abc');
    brainReconcile.getBrainSnapshot.mockResolvedValue({ records: {} });
    brainParity.buildBrainManifest.mockResolvedValue({ types: {} });
  });

  it.each(reads)('refuses %s to a peer paired without brain sync by default', async (path, read) => {
    peers.push(peer({ brain: false, catalog: true }));

    const res = await request(buildApp()).get(path).set(PEER_INSTANCE_ID_HEADER, PEER_ID);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PEER_PULL_FORBIDDEN');
    expect(read()).not.toHaveBeenCalled();
  });

  it.each(reads)('serves %s to a peer the user shares brain with', async (path, read) => {
    peers.push(peer({ brain: true }));

    const res = await request(buildApp()).get(path).set(PEER_INSTANCE_ID_HEADER, PEER_ID);

    expect(res.status).toBe(200);
    expect(read()).toHaveBeenCalledOnce();
  });

  it.each(reads)('refuses unidentified and unknown callers of %s', async (path, read) => {
    for (const instanceId of [null, 'unknown-instance']) {
      const pending = request(buildApp()).get(path);
      const res = await (instanceId ? pending.set(PEER_INSTANCE_ID_HEADER, instanceId) : pending);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PEER_PULL_FORBIDDEN');
    }
    expect(read()).not.toHaveBeenCalled();
  });

  it.each(reads)('preserves local and delegated operator reads of %s', async (path, read) => {
    for (const auth of [
      { enabled: false, authenticated: false, method: null },
      { enabled: true, authenticated: true, method: 'session' },
    ]) {
      const res = await request(buildApp(auth)).get(path);
      expect(res.status).toBe(200);
    }
    expect(read()).toHaveBeenCalledTimes(2);
  });

  it.each(reads)('serves %s when fullSync grants the category', async (path, read) => {
    peers.push({ ...peer({ brain: false }), fullSync: true });
    const res = await request(buildApp()).get(path).set(PEER_INSTANCE_ID_HEADER, PEER_ID);
    expect(res.status).toBe(200);
    expect(read()).toHaveBeenCalledOnce();
  });
});

describe('GET /api/brain/reconcile/manifest', () => {
  it('serves the parity manifest a peer audits against', async () => {
    brainParity.buildBrainManifest.mockResolvedValue({ types: { people: [{ id: 'p1', updatedAt: 'T1', deleted: false }] } });

    peers.push({ instanceId: 'manifest-peer', enabled: true, fullSync: true });
    const res = await request(buildApp()).get('/api/brain/reconcile/manifest').set(PEER_INSTANCE_ID_HEADER, 'manifest-peer');

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
