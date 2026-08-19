import { describe, it, expect, vi, beforeEach } from 'vitest';

// brainStorage / brainReconcile / instances are the data + transport layers;
// mock them so the parity diff is exercised in isolation, matching the mock
// style the other brain sync suites use.
vi.mock('./brainStorage.js', () => ({
  BRAIN_ENTITY_TYPES: ['people', 'projects', 'ideas', 'admin', 'memories', 'links', 'buckets', 'journals', 'inbox', 'songs'],
  getRawRecords: vi.fn(),
}));
vi.mock('./brainReconcile.js', () => ({
  getBrainChecksum: vi.fn().mockResolvedValue('local-checksum'),
}));
vi.mock('./instances.js', () => ({
  getPeers: vi.fn().mockResolvedValue([]),
}));
vi.mock('../lib/peerUrl.js', () => ({
  peerBaseUrl: (peer) => `https://${peer.host}:5555`,
}));
vi.mock('../lib/peerHttpClient.js', () => ({
  peerFetch: vi.fn(),
}));
vi.mock('../lib/fileUtils.js', () => ({
  readJSONFile: vi.fn().mockResolvedValue({}),
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn().mockResolvedValue(undefined),
  dataPath: (name) => `/tmp/portos-test-data/${name}`,
  PATHS: { data: '/tmp/portos-test-data' },
}));

import * as brainStorage from './brainStorage.js';
import * as brainReconcile from './brainReconcile.js';
import { getPeers } from './instances.js';
import { peerFetch } from '../lib/peerHttpClient.js';
import { readJSONFile, atomicWrite } from '../lib/fileUtils.js';
import {
  buildBrainManifest,
  diffBrainManifests,
  checkPeerBrainParity,
  runBrainParityCheck,
  getBrainParityReports,
} from './brainParity.js';

const PEER = { id: 'peer-local-1', instanceId: 'inst-peer-1', name: 'Example Peer', host: 'peer.example.com', syncEnabled: true };

// Default: every store empty unless a test overrides a specific type.
function stores(overrides = {}) {
  brainStorage.getRawRecords.mockImplementation(async (type) => overrides[type] ?? {});
}

// Build a fetch response double. `peerFetch` resolves it; a null resolution
// models an unreachable peer.
const jsonResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/**
 * Route peerFetch by URL suffix so a test only declares the endpoints it cares
 * about. Anything undeclared 404s (i.e. "peer too old for that route").
 */
function peerRoutes(routes) {
  peerFetch.mockImplementation(async (url) => {
    for (const [suffix, response] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return typeof response === 'function' ? response() : response;
    }
    return jsonResponse(null, 404);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  brainReconcile.getBrainChecksum.mockResolvedValue('local-checksum');
  // Fresh object per read: the service does a read-modify-write per peer, so a
  // shared literal would let one write alias another and hide the per-peer save.
  readJSONFile.mockImplementation(async () => ({}));
  stores();
});

describe('buildBrainManifest', () => {
  it('emits id + updatedAt + deleted per record, tombstones included', async () => {
    stores({
      people: {
        p2: { id: 'p2', updatedAt: '2026-01-02T00:00:00.000Z', name: 'Bob' },
        p1: { id: 'p1', updatedAt: '2026-01-01T00:00:00.000Z', name: 'Alice' },
        p3: { _deleted: true, updatedAt: '2026-01-03T00:00:00.000Z', deletedAt: '2026-01-03T00:00:00.000Z' },
      },
    });

    const { types } = await buildBrainManifest();

    // Sorted by id so two installs serialize identically.
    expect(types.people).toEqual([
      { id: 'p1', updatedAt: '2026-01-01T00:00:00.000Z', deleted: false },
      { id: 'p2', updatedAt: '2026-01-02T00:00:00.000Z', deleted: false },
      { id: 'p3', updatedAt: '2026-01-03T00:00:00.000Z', deleted: true },
    ]);
  });

  it('carries no record content — ids and clocks only', async () => {
    stores({ ideas: { i1: { id: 'i1', updatedAt: '2026-01-01T00:00:00.000Z', title: 'Secret idea', body: 'private' } } });

    const { types } = await buildBrainManifest();

    expect(Object.keys(types.ideas[0]).sort()).toEqual(['deleted', 'id', 'updatedAt']);
    expect(JSON.stringify(types)).not.toContain('Secret idea');
  });

  it('covers every brain entity type', async () => {
    const { types } = await buildBrainManifest();
    expect(Object.keys(types).sort()).toEqual([...brainStorage.BRAIN_ENTITY_TYPES].sort());
  });
});

describe('diffBrainManifests', () => {
  const row = (id, updatedAt, deleted = false) => ({ id, updatedAt, deleted });

  it('reports zero divergence for identical manifests', () => {
    const manifest = { people: [row('p1', 'T1'), row('p2', 'T2')] };
    const { summary, byType } = diffBrainManifests(manifest, manifest);

    expect(summary.total).toBe(2);
    expect(summary['in-parity']).toBe(2);
    expect(summary['local-only']).toBe(0);
    expect(summary['peer-only']).toBe(0);
    expect(summary.diverged).toBe(0);
    // The type IS reported (checked-and-clean), but with no actionable records.
    expect(byType).toEqual([{ type: 'people', counts: summary, records: [] }]);
  });

  it('classifies local-only, peer-only, and diverged records', () => {
    const { summary, byType } = diffBrainManifests(
      { people: [row('shared', 'T1'), row('ours', 'T1'), row('drift', 'T1')] },
      { people: [row('shared', 'T1'), row('theirs', 'T1'), row('drift', 'T9')] },
    );

    expect(summary).toMatchObject({ total: 4, 'in-parity': 1, 'local-only': 1, 'peer-only': 1, diverged: 1 });
    expect(byType[0].records).toEqual(
      expect.arrayContaining([
        { id: 'ours', status: 'local-only' },
        { id: 'theirs', status: 'peer-only' },
        { id: 'drift', status: 'diverged' },
      ]),
    );
    // In-parity records are omitted from the actionable list.
    expect(byType[0].records).toHaveLength(3);
  });

  it('does not pair same-id records across different types', () => {
    // `dup` exists as a person locally and as an idea remotely. A single flat
    // diff would call that in-parity; per-type diffing reports two real gaps.
    const { summary } = diffBrainManifests(
      { people: [row('dup', 'T1')] },
      { ideas: [row('dup', 'T1')] },
    );

    expect(summary).toMatchObject({ 'local-only': 1, 'peer-only': 1, 'in-parity': 0 });
  });

  it('treats a delete both sides applied as agreement, not divergence', () => {
    const { summary, byType } = diffBrainManifests(
      { people: [row('gone', 'T1', true)] },
      { people: [row('gone', 'T1', true)] },
    );

    expect(summary.total).toBe(0);
    expect(byType).toEqual([{ type: 'people', counts: expect.objectContaining({ total: 0 }), records: [] }]);
  });

  it('surfaces a delete only one side applied', () => {
    const { summary } = diffBrainManifests(
      { people: [row('gone', 'T2', true)] },
      { people: [row('gone', 'T1', false)] },
    );

    expect(summary).toMatchObject({ 'peer-only': 1, 'local-only': 0 });
  });

  it('skips types empty on both sides', () => {
    const { byType } = diffBrainManifests({ people: [] }, { people: [] });
    expect(byType).toEqual([]);
  });
});

describe('checkPeerBrainParity', () => {
  it('reports the divergence when a record exists only on the peer', async () => {
    stores({ people: { p1: { id: 'p1', updatedAt: 'T1' } } });
    peerRoutes({
      '/api/brain/reconcile/manifest': jsonResponse({
        types: { people: [{ id: 'p1', updatedAt: 'T1', deleted: false }, { id: 'p2', updatedAt: 'T2', deleted: false }] },
      }),
      '/api/brain/reconcile/checksum': jsonResponse({ checksum: 'peer-checksum' }),
    });

    const report = await checkPeerBrainParity(PEER);

    expect(report.available).toBe(true);
    expect(report.summary).toMatchObject({ total: 2, 'in-parity': 1, 'peer-only': 1 });
    expect(report.byType.find((t) => t.type === 'people').records).toEqual([{ id: 'p2', status: 'peer-only' }]);
    expect(report.checksums).toEqual({ local: 'local-checksum', peer: 'peer-checksum', match: false });
    expect(report.peerInstanceId).toBe('inst-peer-1');
  });

  it('reports a clean bill of health for two fully-synced peers', async () => {
    stores({ people: { p1: { id: 'p1', updatedAt: 'T1' } } });
    peerRoutes({
      '/api/brain/reconcile/manifest': jsonResponse({ types: { people: [{ id: 'p1', updatedAt: 'T1', deleted: false }] } }),
      '/api/brain/reconcile/checksum': jsonResponse({ checksum: 'local-checksum' }),
    });

    const report = await checkPeerBrainParity(PEER);

    expect(report.available).toBe(true);
    expect(report.summary).toMatchObject({ total: 1, 'in-parity': 1, 'local-only': 0, 'peer-only': 0, diverged: 0 });
    expect(report.checksums.match).toBe(true);
  });

  it('flags a checksum mismatch even when every id and clock matches', async () => {
    // The body-level divergence a manifest cannot see: same ids, same
    // updatedAt, different record contents (a partial write on one side).
    stores({ people: { p1: { id: 'p1', updatedAt: 'T1' } } });
    peerRoutes({
      '/api/brain/reconcile/manifest': jsonResponse({ types: { people: [{ id: 'p1', updatedAt: 'T1', deleted: false }] } }),
      '/api/brain/reconcile/checksum': jsonResponse({ checksum: 'different-checksum' }),
    });

    const report = await checkPeerBrainParity(PEER);

    expect(report.summary.diverged).toBe(0);
    expect(report.checksums.match).toBe(false);
  });

  it('falls back to the reconcile snapshot when the peer has no manifest route', async () => {
    stores({ people: { p1: { id: 'p1', updatedAt: 'T1' } } });
    peerRoutes({
      '/api/brain/reconcile/snapshot': jsonResponse({
        records: { people: { p1: { updatedAt: 'T1' }, p2: { updatedAt: 'T2' } } },
      }),
      '/api/brain/reconcile/checksum': jsonResponse({ checksum: 'peer-checksum' }),
    });

    const report = await checkPeerBrainParity(PEER);

    expect(report.available).toBe(true);
    expect(report.summary).toMatchObject({ 'peer-only': 1, 'in-parity': 1 });
  });

  it('distinguishes an unreachable peer from one running older code', async () => {
    peerFetch.mockResolvedValue(null);
    expect(await checkPeerBrainParity(PEER)).toMatchObject({ available: false, reason: 'peer-unreachable' });

    peerRoutes({}); // every route 404s → no reconcile support at all
    expect(await checkPeerBrainParity(PEER)).toMatchObject({ available: false, reason: 'peer-too-old' });
  });

  it('treats a 200 with a malformed manifest body (missing types) as fetch-failed rather than divergence', async () => {
    stores({ people: { p1: { id: 'p1', updatedAt: 'T1' } } });
    peerRoutes({
      '/api/brain/reconcile/manifest': jsonResponse({ ok: true }),
    });

    const report = await checkPeerBrainParity(PEER);

    expect(report.available).toBe(false);
    expect(report.reason).toBe('fetch-failed');
    expect(report.summary.total).toBe(0);
  });

  it('preserves empty-but-valid manifest { types: {} } as valid parity check reporting local-only', async () => {
    stores({ people: { p1: { id: 'p1', updatedAt: 'T1' } } });
    peerRoutes({
      '/api/brain/reconcile/manifest': jsonResponse({ types: {} }),
      '/api/brain/reconcile/checksum': jsonResponse({ checksum: 'peer-checksum' }),
    });

    const report = await checkPeerBrainParity(PEER);

    expect(report.available).toBe(true);
    expect(report.summary).toMatchObject({ total: 1, 'local-only': 1 });
  });

  it('treats a 200 with an array-shaped types property as fetch-failed', async () => {
    stores({ people: { p1: { id: 'p1', updatedAt: 'T1' } } });
    peerRoutes({
      '/api/brain/reconcile/manifest': jsonResponse({ types: [] }),
    });

    const report = await checkPeerBrainParity(PEER);

    expect(report.available).toBe(false);
    expect(report.reason).toBe('fetch-failed');
  });

  it('treats a malformed snapshot fallback body (missing or array records) as fetch-failed', async () => {
    stores({ people: { p1: { id: 'p1', updatedAt: 'T1' } } });
    peerRoutes({
      '/api/brain/reconcile/snapshot': jsonResponse({ records: [] }),
    });

    const report = await checkPeerBrainParity(PEER);

    expect(report.available).toBe(false);
    expect(report.reason).toBe('fetch-failed');
  });

  it('ignores malformed peer manifest rows instead of throwing', async () => {
    stores({ people: { p1: { id: 'p1', updatedAt: 'T1' } } });
    peerRoutes({
      '/api/brain/reconcile/manifest': jsonResponse({
        types: { people: [null, 42, { updatedAt: 'T1' }, { id: 'p1', updatedAt: 'T1', deleted: false }], bogusType: [{ id: 'x' }] },
      }),
      '/api/brain/reconcile/checksum': jsonResponse({ checksum: 'local-checksum' }),
    });

    const report = await checkPeerBrainParity(PEER);

    expect(report.available).toBe(true);
    expect(report.summary).toMatchObject({ total: 1, 'in-parity': 1 });
  });

  it('ignores asset fields a peer smuggles into a manifest row', async () => {
    // computeRecordIntegrity also grades assetHashes/metadataMissing. Brain has
    // neither, so a peer sending them could otherwise push a record into an
    // asset status this audit has no counter for — silently listed, never
    // tallied. The row must be rebuilt from id + clock + tombstone only.
    stores({ people: { p1: { id: 'p1', updatedAt: 'T1' } } });
    peerRoutes({
      '/api/brain/reconcile/manifest': jsonResponse({
        types: { people: [{ id: 'p1', updatedAt: 'T1', deleted: false, assetHashes: ['sneaky'], metadataMissing: true }] },
      }),
      '/api/brain/reconcile/checksum': jsonResponse({ checksum: 'local-checksum' }),
    });

    const report = await checkPeerBrainParity(PEER);

    expect(report.summary).toMatchObject({ total: 1, 'in-parity': 1 });
    expect(report.byType.find((t) => t.type === 'people').records).toEqual([]);
  });

  it('leaves the checksum comparison unknown when the peer is too old to serve one', async () => {
    stores({ people: { p1: { id: 'p1', updatedAt: 'T1' } } });
    peerRoutes({
      '/api/brain/reconcile/manifest': jsonResponse({ types: { people: [{ id: 'p1', updatedAt: 'T1', deleted: false }] } }),
    });

    const report = await checkPeerBrainParity(PEER);

    expect(report.checksums).toEqual({ local: 'local-checksum', peer: null, match: null });
  });

  it('does not read local brain stores when the peer is unreachable', async () => {
    peerFetch.mockResolvedValue(null);
    await checkPeerBrainParity(PEER);
    expect(brainStorage.getRawRecords).not.toHaveBeenCalled();
  });
});

describe('runBrainParityCheck', () => {
  it('flags an unreadable peer registry instead of reporting a peerless sweep', async () => {
    getPeers.mockRejectedValue(new Error('peer registry read failed'));

    const result = await runBrainParityCheck();

    expect(result.peerRegistryUnavailable).toBe(true);
    expect(result.reports).toEqual([]);
    expect(peerFetch).not.toHaveBeenCalled();
  });

  it('treats a non-array peer registry as unreadable rather than throwing on filter', async () => {
    getPeers.mockResolvedValue(undefined);

    const result = await runBrainParityCheck();

    expect(result.peerRegistryUnavailable).toBe(true);
    expect(result.reports).toEqual([]);
  });

  it('leaves peerRegistryUnavailable unset for a genuinely peerless install', async () => {
    getPeers.mockResolvedValue([]);

    const result = await runBrainParityCheck();

    expect(result.peerRegistryUnavailable).toBeUndefined();
    expect(result.reports).toEqual([]);
  });

  it('returns peer-not-found for an unknown peer id without contacting anyone', async () => {
    getPeers.mockResolvedValue([PEER]);

    const { reports } = await runBrainParityCheck({ peerId: 'nope' });

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ peerId: 'nope', available: false, reason: 'peer-not-found' });
    expect(peerFetch).not.toHaveBeenCalled();
    expect(atomicWrite).not.toHaveBeenCalled();
  });

  it('persists the report keyed by peer instanceId', async () => {
    getPeers.mockResolvedValue([PEER]);
    stores({ people: { p1: { id: 'p1', updatedAt: 'T1' } } });
    peerRoutes({
      '/api/brain/reconcile/manifest': jsonResponse({ types: { people: [{ id: 'p2', updatedAt: 'T2', deleted: false }] } }),
      '/api/brain/reconcile/checksum': jsonResponse({ checksum: 'peer-checksum' }),
    });

    await runBrainParityCheck({ peerId: 'peer-local-1' });

    const [, written] = atomicWrite.mock.calls[0];
    expect(Object.keys(written)).toEqual(['inst-peer-1']);
    expect(written['inst-peer-1'].summary).toMatchObject({ 'local-only': 1, 'peer-only': 1 });
  });

  it('caps the stored record list per type and marks it truncated', async () => {
    getPeers.mockResolvedValue([PEER]);
    const many = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`p${i}`, { id: `p${i}`, updatedAt: 'T1' }]),
    );
    stores({ people: many });
    peerRoutes({
      '/api/brain/reconcile/manifest': jsonResponse({ types: { people: [] } }),
      '/api/brain/reconcile/checksum': jsonResponse({ checksum: 'peer-checksum' }),
    });

    const { reports } = await runBrainParityCheck({ peerId: 'peer-local-1' });

    // Live response is complete; only the persisted copy is capped.
    expect(reports[0].byType.find((t) => t.type === 'people').records).toHaveLength(40);
    const stored = atomicWrite.mock.calls[0][1]['inst-peer-1'].byType.find((t) => t.type === 'people');
    expect(stored.records).toHaveLength(25);
    expect(stored.truncated).toBe(true);
  });

  it('sweeps every federating peer when no peerId is given, skipping un-probed ones', async () => {
    getPeers.mockResolvedValue([
      PEER,
      { id: 'peer-local-2', instanceId: 'inst-peer-2', name: 'Second Peer', host: 'peer2.example.com', syncEnabled: true },
      { id: 'peer-local-3', instanceId: null, name: 'Never Probed', host: 'peer3.example.com', syncEnabled: true },
      { id: 'peer-local-4', instanceId: 'inst-peer-4', name: 'Sync Off', host: 'peer4.example.com', syncEnabled: false },
    ]);
    peerFetch.mockResolvedValue(null);

    const { reports } = await runBrainParityCheck();

    expect(reports.map((r) => r.peerId)).toEqual(['peer-local-1', 'peer-local-2']);
  });

  it('files an un-probed peer under its local registry id', async () => {
    getPeers.mockResolvedValue([{ ...PEER, instanceId: null }]);
    peerFetch.mockResolvedValue(null);

    await runBrainParityCheck({ peerId: 'peer-local-1' });

    expect(Object.keys(atomicWrite.mock.calls[0][1])).toEqual(['peer-local-1']);
  });

  it('persists each peer as it finishes rather than once at the end', async () => {
    getPeers.mockResolvedValue([
      PEER,
      { id: 'peer-local-2', instanceId: 'inst-peer-2', name: 'Second Peer', host: 'peer2.example.com', syncEnabled: true },
    ]);
    peerFetch.mockResolvedValue(null);

    await runBrainParityCheck();

    // One write per peer — an interrupted sweep keeps the peers it got through.
    expect(atomicWrite).toHaveBeenCalledTimes(2);
    expect(Object.keys(atomicWrite.mock.calls[0][1])).toEqual(['inst-peer-1']);
  });

  it('preserves reports for peers this run did not check', async () => {
    readJSONFile.mockResolvedValue({ 'inst-other': { peerId: 'peer-other', summary: { total: 3 } } });
    getPeers.mockResolvedValue([PEER]);
    peerFetch.mockResolvedValue(null);

    await runBrainParityCheck({ peerId: 'peer-local-1' });

    expect(Object.keys(atomicWrite.mock.calls[0][1]).sort()).toEqual(['inst-other', 'inst-peer-1']);
  });
});

describe('getBrainParityReports', () => {
  it('returns an empty object when the store holds a non-object', async () => {
    readJSONFile.mockResolvedValue([]);
    expect(await getBrainParityReports()).toEqual({});
  });

  it('returns the stored reports', async () => {
    readJSONFile.mockResolvedValue({ 'inst-peer-1': { summary: { total: 1 } } });
    expect(await getBrainParityReports()).toEqual({ 'inst-peer-1': { summary: { total: 1 } } });
  });
});
