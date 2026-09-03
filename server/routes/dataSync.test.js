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
// The three I/O entry points are stubbed so the route test never touches real
// stores — but `getSupportedCategories` delegates to the REAL export (#5705).
// It is a pure `Object.keys(CATEGORIES)` with no I/O, and it is the source of
// truth the route's hand-maintained `categoryParam` enum has to match; a stub
// would make the parity tests below compare the route to a copy of itself.
vi.mock('../services/dataSync.js', async () => ({
  getChecksum: vi.fn(),
  getSnapshot: vi.fn(),
  getManifest: vi.fn(),
  applyRemote: vi.fn(),
  getSupportedCategories: (await vi.importActual('../services/dataSync.js')).getSupportedCategories,
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
// Spreads the real module rather than listing one export: pulling the real
// `getSupportedCategories` above loads the whole dataSync graph, which reaches
// modules importing other settings exports — a hand-listed stub would break
// again the next time that graph grows an import.
vi.mock('../services/settings.js', async () => ({
  ...(await vi.importActual('../services/settings.js')),
  getSettings: async () => settings,
}));

import { sweepTombstones, getSweepStatus } from '../services/sharing/tombstoneGc.js';
import { getChecksum, getSnapshot, getManifest, applyRemote, getSupportedCategories } from '../services/dataSync.js';
import { PEER_INSTANCE_ID_HEADER, __resetPullWarnThrottleForTests } from '../services/sharing/peerPullAuthorization.js';
import { MAX_MANIFEST_SLOTS } from '../lib/syncManifest.js';
import dataSyncRoutes, { categoryParam } from './dataSync.js';

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
});

// The route's `categoryParam` enum is hand-maintained and has to match
// `dataSync.getSupportedCategories()` exactly. Drift in either direction is a
// live bug: a service category missing from the enum 400s before its handler
// can run (#730 hit that for `storyBuilder`), and an enum entry the service
// retired lets a request through to a 404 at the service. Both directions are
// asserted against the REAL export here — the earlier version of this suite
// stubbed it and iterated a hardcoded copy of the enum, so it compared the
// route to itself and could not catch either (#5705).
describe('/api/sync/:category — enum parity with getSupportedCategories()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings = {};
    // A configured, fully-shared peer so the PII categories clear the pull gate
    // (#5663) and this stays a test of the ENUM, not of authorization.
    setPeers(allowedPeer());
    __resetPullWarnThrottleForTests();
    getChecksum.mockResolvedValue({ checksum: 'abc' });
  });

  it('matches the service category list exactly', () => {
    // Symmetric on purpose: a missing entry also trips the sweep below, but
    // only this gives a stale entry (a category the service retired, which now
    // reaches a 404 at the service) a failure at all — and it names the drift
    // in the diff instead of as N route errors.
    expect([...categoryParam.options].sort()).toEqual([...getSupportedCategories()].sort());
  });

  it.each(getSupportedCategories())('serves a checksum for the %s category', async (category) => {
    const res = await request(buildApp())
      .get(`/api/sync/${category}/checksum`)
      .set(PEER_INSTANCE_ID_HEADER, PEER_ID);
    expect(res.status).toBe(200);
    expect(getChecksum).toHaveBeenCalledWith(category, { forPeerId: undefined });
  });
});

// #5759 — the manifest leg that lets a puller fetch only the per-instance slots
// that moved, instead of the whole digest map every 60s cycle.
describe('GET /api/sync/:category/manifest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings = {};
    setPeers(allowedPeer());
    __resetPullWarnThrottleForTests();
    getSnapshot.mockResolvedValue({ data: {}, checksum: 'abc' });
    getManifest.mockResolvedValue({ data: { instances: { 'inst-a': '2026-09-01T10:00:00.000Z' }, tombstones: [] }, checksum: 'abc' });
  });

  it('serves the version map for a manifest category', async () => {
    const res = await request(buildApp())
      .get('/api/sync/usage/manifest')
      .set(PEER_INSTANCE_ID_HEADER, PEER_ID);
    expect(res.status).toBe(200);
    expect(res.body.data.instances).toEqual({ 'inst-a': '2026-09-01T10:00:00.000Z' });
  });

  // The puller reads a 404 as "no manifest here" and falls back to the whole
  // snapshot — the same signal a pre-manifest peer gives by not having the route.
  it('404s a category that serves no manifest', async () => {
    getManifest.mockResolvedValue(null);
    const res = await request(buildApp())
      .get('/api/sync/goals/manifest')
      .set(PEER_INSTANCE_ID_HEADER, PEER_ID);
    expect(res.status).toBe(404);
  });

  it('runs the same peer-pull gate as the other two reads', async () => {
    // A manifest is a fingerprint of the same payload, so it must not become
    // the weaker door (#5663).
    const res = await request(buildApp()).get('/api/sync/digitalTwin/manifest');
    expect(res.status).toBe(403);
    expect(getManifest).not.toHaveBeenCalled();
  });
});

describe('GET /api/sync/:category/snapshot — slots scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings = {};
    setPeers(allowedPeer());
    __resetPullWarnThrottleForTests();
    getSnapshot.mockResolvedValue({ data: {}, checksum: 'abc' });
  });

  const getSlots = async (qs) => {
    const res = await request(buildApp())
      .get(`/api/sync/usage/snapshot${qs}`)
      .set(PEER_INSTANCE_ID_HEADER, PEER_ID);
    expect(res.status).toBe(200);
    return getSnapshot.mock.calls.at(-1)[1].slots;
  };

  it('threads trimmed, comma-separated slot ids through to the service', async () => {
    expect(await getSlots('?slots=inst-a%2C%20inst-b')).toEqual(['inst-a', 'inst-b']);
  });

  it('serves the whole payload when slots is absent, blank, or repeated', async () => {
    expect(await getSlots('')).toBeUndefined();
    expect(await getSlots('?slots=%20%2C%20')).toBeUndefined();
    expect(await getSlots('?slots=a&slots=b')).toBeUndefined();
  });

  it('caps the slot count so a hostile query string cannot become an unbounded set', async () => {
    const many = Array.from({ length: MAX_MANIFEST_SLOTS * 2 }, (_, i) => `inst-${i}`).join(',');
    expect(await getSlots(`?slots=${many}`)).toHaveLength(MAX_MANIFEST_SLOTS);
  });

  it('caps each id length', async () => {
    const slots = await getSlots(`?slots=${'x'.repeat(500)}`);
    expect(slots[0]).toHaveLength(128);
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
    expect(getSnapshot).toHaveBeenCalledWith('digitalTwin', { forPeerId: undefined, slots: undefined });
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
    applyRemote.mockResolvedValue({ applied: true, count: 1 });
    const res = await request(buildApp()).post('/api/sync/digitalTwin/apply').send({ data: { a: 1 } });
    expect(res.status).toBe(200);
    expect(applyRemote).toHaveBeenCalledWith('digitalTwin', { a: 1 }, { portosMeta: undefined });
  });
});
