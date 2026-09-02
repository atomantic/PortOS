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

// Stub only the two leaves the REAL peer-pull gate reads — the peer registry
// and the settings file — so `findPeerById` / `peerAllowsOutbound` and the
// warn-first ramp all run for real here. Mocking `authorizePeerPull` itself
// would let the route and the gate drift, which is the whole bug (#5663).
const peers = [];
vi.mock('../services/instances.js', async () => ({
  // Keep the REAL resolveEffectiveCategories + shipped category defaults: a
  // hand-written stand-in would let the gate's idea of "enabled for this peer"
  // drift from the sync loop's and the settings UI's.
  ...(await vi.importActual('../services/instances.js')),
  getPeers: async () => peers,
}));
let settings = {};
vi.mock('../services/settings.js', () => ({
  getSettings: async () => settings,
}));

import { sweepTombstones, getSweepStatus } from '../services/sharing/tombstoneGc.js';
import { getChecksum, getSnapshot } from '../services/dataSync.js';
import { PEER_INSTANCE_ID_HEADER, __resetPullWarnThrottleForTests } from '../services/sharing/peerPullAuthorization.js';
import dataSyncRoutes from './dataSync.js';

const PEER_ID = 'peer-a-instance-id';
// Obviously-fake peer record. `fullSync` stands in for "the user ticked every
// category for this peer" — the snapshot gate's unit of consent is the sync
// CATEGORY, so a fixture without one would be denied on category grounds and
// the identity assertions below would pass for the wrong reason.
const allowedPeer = (overrides = {}) => ({
  instanceId: PEER_ID,
  name: 'Example Peer',
  enabled: true,
  syncEnabled: true,
  fullSync: true,
  directions: ['outbound', 'inbound'],
  ...overrides,
});
const setPeers = (...next) => {
  peers.length = 0;
  peers.push(...next);
};

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
    settings = {};
    setPeers(allowedPeer());
    __resetPullWarnThrottleForTests();
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
    'universe', 'pipeline', 'mediaCollections', 'videoHistory', 'storyBuilder', 'usage',
  ])('accepts the %s category (enum parity with getSupportedCategories)', async (category) => {
    // Identified as a configured peer so the PII categories clear the pull gate
    // (#5663) and this stays a test of the ENUM, not of authorization.
    const res = await request(buildApp())
      .get(`/api/sync/${category}/checksum`)
      .set(PEER_INSTANCE_ID_HEADER, PEER_ID);
    expect(res.status).not.toBe(400);
  });
});

// #5663 — the snapshot transport predates the peer-pull gate #3659 added to
// `/api/peer-sync/*`, so it served the user's identity record to anything that
// could reach the port.
describe('GET /api/sync/:category — peer-pull authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings = {};
    setPeers(allowedPeer());
    __resetPullWarnThrottleForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    getChecksum.mockResolvedValue({ checksum: 'abc' });
    getSnapshot.mockResolvedValue({ data: { identity: 'redacted' }, checksum: 'abc' });
  });

  it('403s the digitalTwin snapshot for a caller with no X-PortOS-Instance-Id', async () => {
    const res = await request(buildApp()).get('/api/sync/digitalTwin/snapshot');
    expect(res.status).toBe(403);
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it('403s the digitalTwin snapshot for an id that matches no configured peer', async () => {
    const res = await request(buildApp())
      .get('/api/sync/digitalTwin/snapshot')
      .set(PEER_INSTANCE_ID_HEADER, 'some-other-instance');
    expect(res.status).toBe(403);
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it('403s the digitalTwin snapshot for a peer the user disabled sync for', async () => {
    setPeers(allowedPeer({ fullSync: false, syncEnabled: false, syncCategories: { digitalTwin: true } }));
    const res = await request(buildApp())
      .get('/api/sync/digitalTwin/snapshot')
      .set(PEER_INSTANCE_ID_HEADER, PEER_ID);
    expect(res.status).toBe(403);
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it('403s the digitalTwin snapshot for a peer the user only enabled for universe', async () => {
    // Per-category consent, not just per-peer: this is the record-side hole
    // #3659 closed, applied to the snapshot transport's unit of sharing.
    setPeers(allowedPeer({ fullSync: false, syncCategories: { universe: true } }));
    const res = await request(buildApp())
      .get('/api/sync/digitalTwin/snapshot')
      .set(PEER_INSTANCE_ID_HEADER, PEER_ID);
    expect(res.status).toBe(403);
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it('403s a peer that only ANNOUNCED itself (inbound-only, never approved here)', async () => {
    setPeers(allowedPeer({ directions: ['inbound'] }));
    const res = await request(buildApp())
      .get('/api/sync/digitalTwin/snapshot')
      .set(PEER_INSTANCE_ID_HEADER, PEER_ID);
    expect(res.status).toBe(403);
  });

  it('keeps serving the default-ON usage category to a peer whose other sync is off', async () => {
    // `usage` survives the master switch by design; folding the switch into the
    // resolved category map (rather than checking it separately) is what keeps
    // that true here. Non-PII, so this is the warn-first tier.
    settings = { federation: { strictPullAuthorization: true } };
    setPeers(allowedPeer({ fullSync: false, syncEnabled: false }));
    const res = await request(buildApp())
      .get('/api/sync/usage/snapshot')
      .set(PEER_INSTANCE_ID_HEADER, PEER_ID);
    expect(res.status).toBe(200);
  });

  it.each(['digitalTwin', 'meatspace', 'character'])(
    '403s the %s checksum too — a checksum must not be the weaker door',
    async (category) => {
      const res = await request(buildApp()).get(`/api/sync/${category}/checksum`);
      expect(res.status).toBe(403);
      expect(getChecksum).not.toHaveBeenCalled();
    },
  );

  it('refuses a PII category even with strictPullAuthorization explicitly off', async () => {
    settings = { federation: { strictPullAuthorization: false } };
    const res = await request(buildApp()).get('/api/sync/meatspace/snapshot');
    expect(res.status).toBe(403);
  });

  it('serves the digitalTwin snapshot to a configured, outbound-allowed peer', async () => {
    const res = await request(buildApp())
      .get('/api/sync/digitalTwin/snapshot')
      .set(PEER_INSTANCE_ID_HEADER, PEER_ID);
    expect(res.status).toBe(200);
    expect(getSnapshot).toHaveBeenCalledWith('digitalTwin', { forPeerId: undefined });
  });

  it('still serves a non-PII snapshot to an unidentified caller, warning once', async () => {
    const app = buildApp();
    expect((await request(app).get('/api/sync/universe/snapshot')).status).toBe(200);
    expect((await request(app).get('/api/sync/universe/snapshot')).status).toBe(200);
    expect(getSnapshot).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('403s a non-PII snapshot once the user opts into strict enforcement', async () => {
    settings = { federation: { strictPullAuthorization: true } };
    const res = await request(buildApp()).get('/api/sync/universe/snapshot');
    expect(res.status).toBe(403);
  });

  it('leaves the write direction alone — apply is gated by its schema-version check, not this', async () => {
    const { applyRemote } = await import('../services/dataSync.js');
    applyRemote.mockResolvedValue({ applied: true, count: 1 });
    const res = await request(buildApp()).post('/api/sync/digitalTwin/apply').send({ data: { a: 1 } });
    expect(res.status).toBe(200);
    expect(applyRemote).toHaveBeenCalled();
  });
});
