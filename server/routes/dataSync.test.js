import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Only the tombstone-sweep helpers are exercised here — the snapshot-sync
// routes have their own coverage via `dataSync` service tests + the
// peer-sync integration tests.
vi.mock('../services/sharing/tombstoneGc.js', () => ({
  sweepTombstones: vi.fn(),
  getSweepStatus: vi.fn(),
  TOMBSTONE_GRACE_MS: 24 * 60 * 60 * 1000,
}));
vi.mock('../services/dataSync.js', () => ({
  getChecksum: vi.fn(),
  getSnapshot: vi.fn(),
  applyRemote: vi.fn(),
  getSupportedCategories: vi.fn(() => []),
}));

import { sweepTombstones, getSweepStatus } from '../services/sharing/tombstoneGc.js';
import { getChecksum, getSnapshot } from '../services/dataSync.js';
import dataSyncRoutes from './dataSync.js';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/sync', dataSyncRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('GET /api/sync/tombstones/status', () => {
  beforeEach(() => vi.clearAllMocks());

  it('proxies the dry-run status straight through', async () => {
    getSweepStatus.mockResolvedValue({ refused: ['universe'] });
    const res = await request(buildApp()).get('/api/sync/tombstones/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ refused: ['universe'] });
    expect(getSweepStatus).toHaveBeenCalledOnce();
  });

  it("wins the lookup against /:category/* (literal 'tombstones' is not a category)", async () => {
    // Regression: if the tombstone routes were declared AFTER `/:category/*`,
    // Express would try to parse "tombstones" as a category and the Zod
    // enum check would 400 before our handler runs.
    getSweepStatus.mockResolvedValue({ refused: [] });
    const res = await request(buildApp()).get('/api/sync/tombstones/status');
    expect(res.status).toBe(200);
  });
});

describe('POST /api/sync/tombstones/sweep', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the per-kind prune counts + refused list with no body (default graceMs)', async () => {
    sweepTombstones.mockResolvedValue({ universes: 3, series: 1, issues: 7, refused: [] });
    const res = await request(buildApp()).post('/api/sync/tombstones/sweep').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ universes: 3, series: 1, issues: 7, refused: [] });
    expect(sweepTombstones).toHaveBeenCalledWith({});
  });

  it('forwards graceMs:0 to the service so the UI button can skip the 24h buffer', async () => {
    sweepTombstones.mockResolvedValue({ universes: 0, series: 0, issues: 0, refused: [] });
    const res = await request(buildApp()).post('/api/sync/tombstones/sweep').send({ graceMs: 0 });
    expect(res.status).toBe(200);
    expect(sweepTombstones).toHaveBeenCalledWith({ graceMs: 0 });
  });

  it('rejects graceMs > 24h so the manual trigger can only SHRINK the grace', async () => {
    const tooBig = 25 * 60 * 60 * 1000;
    const res = await request(buildApp()).post('/api/sync/tombstones/sweep').send({ graceMs: tooBig });
    expect(res.status).toBe(400);
    expect(sweepTombstones).not.toHaveBeenCalled();
  });

  it('rejects negative graceMs', async () => {
    const res = await request(buildApp()).post('/api/sync/tombstones/sweep').send({ graceMs: -1 });
    expect(res.status).toBe(400);
    expect(sweepTombstones).not.toHaveBeenCalled();
  });

  it('rejects unknown fields (strict schema — prevents typos like graceMS from silently no-op-ing)', async () => {
    const res = await request(buildApp()).post('/api/sync/tombstones/sweep').send({ graceMS: 0 });
    expect(res.status).toBe(400);
    expect(sweepTombstones).not.toHaveBeenCalled();
  });
});

describe('GET /api/sync/:category/checksum — forPeer scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getChecksum.mockResolvedValue({ checksum: 'abc' });
    getSnapshot.mockResolvedValue({ data: {}, checksum: 'abc' });
  });

  it('threads a trimmed forPeer to getChecksum as forPeerId', async () => {
    const res = await request(buildApp()).get('/api/sync/universe/checksum?forPeer=%20peer-1%20');
    expect(res.status).toBe(200);
    expect(getChecksum).toHaveBeenCalledWith('universe', { forPeerId: 'peer-1' });
  });

  it('drops a blank/whitespace-only forPeer to undefined (full snapshot)', async () => {
    const res = await request(buildApp()).get('/api/sync/universe/checksum?forPeer=%20%20');
    expect(res.status).toBe(200);
    expect(getChecksum).toHaveBeenCalledWith('universe', { forPeerId: undefined });
  });

  it('drops a repeated forPeer (array) to undefined so only a scalar id scopes', async () => {
    const res = await request(buildApp()).get('/api/sync/universe/checksum?forPeer=a&forPeer=b');
    expect(res.status).toBe(200);
    expect(getChecksum).toHaveBeenCalledWith('universe', { forPeerId: undefined });
  });

  // The category enum is hand-maintained and MUST cover every category the
  // service supports (a missing one 400s before the snapshot handler runs —
  // the latent bug #730 hit for `storyBuilder`). Assert each known snapshot
  // category is accepted (non-400) so a future addition that forgets the enum
  // is caught here.
  it.each([
    'goals', 'character', 'digitalTwin', 'meatspace',
    'universe', 'pipeline', 'mediaCollections', 'videoHistory', 'storyBuilder',
  ])('accepts the %s category (enum parity with getSupportedCategories)', async (category) => {
    const res = await request(buildApp()).get(`/api/sync/${category}/checksum`);
    expect(res.status).not.toBe(400);
  });
});
