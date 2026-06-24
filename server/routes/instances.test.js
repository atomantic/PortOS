import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Only GET /api/instances/sync-status is exercised here — it's the forPeer
// validation that regressed (a non-GUID peer probe threw a 500 every sync
// cycle). Heavy service deps are mocked so importing the router is cheap.
vi.mock('../services/syncOrchestrator.js', () => ({
  getSyncStatus: vi.fn(),
  syncWithPeer: vi.fn(),
}));
vi.mock('../services/instances.js', () => ({}));
vi.mock('../services/sharing/peerSync.js', () => ({
  getFullSyncCoverageForPeer: vi.fn(),
}));
vi.mock('../services/certProvisioner.js', () => ({
  provisionTailscaleCert: vi.fn(),
}));
vi.mock('../lib/tailscale.js', () => ({
  findTailscale: vi.fn(() => null),
}));

import { getSyncStatus } from '../services/syncOrchestrator.js';
import instancesRoutes from './instances.js';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/instances', instancesRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('GET /api/instances/sync-status — forPeer scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSyncStatus.mockResolvedValue({ local: { brainSeq: 0, memorySeq: 0, checksums: {} } });
  });

  it('threads a canonical GUID forPeer through to getSyncStatus', async () => {
    const id = '191aaece-a492-41ee-a66d-d4661eadc132';
    const res = await request(buildApp()).get(`/api/instances/sync-status?forPeer=${id}`);
    expect(res.status).toBe(200);
    expect(getSyncStatus).toHaveBeenCalledWith({ includeChecksums: true, forPeer: id });
  });

  it('accepts a non-GUID forPeer (older PortOS / `unknown` sentinel) instead of throwing a 500', async () => {
    // Regression: an older PortOS or a prober carrying the `unknown` instance-id
    // sentinel hits us with a non-GUID value. The route must degrade
    // gracefully, not throw a ServerError on every probe cycle.
    const res = await request(buildApp()).get('/api/instances/sync-status?forPeer=unknown');
    expect(res.status).toBe(200);
    expect(getSyncStatus).toHaveBeenCalledWith({ includeChecksums: true, forPeer: 'unknown' });
  });

  it('accepts a bare empty ?forPeer= (the value z.string().guid() used to 500 on) → undefined', async () => {
    const res = await request(buildApp()).get('/api/instances/sync-status?forPeer=');
    expect(res.status).toBe(200);
    expect(getSyncStatus).toHaveBeenCalledWith({ includeChecksums: true, forPeer: undefined });
  });

  it('trims whitespace and caps an oversized forPeer at 128 chars', async () => {
    const long = 'x'.repeat(200);
    const res = await request(buildApp()).get(`/api/instances/sync-status?forPeer=%20${long}%20`);
    expect(res.status).toBe(200);
    expect(getSyncStatus).toHaveBeenCalledWith({ includeChecksums: true, forPeer: 'x'.repeat(128) });
  });

  it('drops a blank/whitespace-only forPeer to undefined (unscoped self-view)', async () => {
    const res = await request(buildApp()).get('/api/instances/sync-status?forPeer=%20%20');
    expect(res.status).toBe(200);
    expect(getSyncStatus).toHaveBeenCalledWith({ includeChecksums: true, forPeer: undefined });
  });

  it('drops a repeated forPeer (array) to undefined so only a scalar id scopes', async () => {
    const res = await request(buildApp()).get('/api/instances/sync-status?forPeer=a&forPeer=b');
    expect(res.status).toBe(200);
    expect(getSyncStatus).toHaveBeenCalledWith({ includeChecksums: true, forPeer: undefined });
  });

  it('omits forPeer entirely (legacy inbound-only shape) → undefined', async () => {
    const res = await request(buildApp()).get('/api/instances/sync-status');
    expect(res.status).toBe(200);
    expect(getSyncStatus).toHaveBeenCalledWith({ includeChecksums: true, forPeer: undefined });
  });

  it('surfaces cursorForYou only when getSyncStatus returns one', async () => {
    getSyncStatus.mockResolvedValue({
      local: { brainSeq: 3, memorySeq: 5, checksums: { universe: 'abc' } },
      cursorForYou: 42,
    });
    const res = await request(buildApp()).get('/api/instances/sync-status?forPeer=peer-1');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ brainSeq: 3, memorySeq: 5, cursorForYou: 42 });
  });
});
