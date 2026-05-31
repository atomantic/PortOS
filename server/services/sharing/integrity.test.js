import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock peerFetch so no network calls go out.
vi.mock('../../lib/peerHttpClient.js', async () => ({
  peerFetch: vi.fn(),
  peerSocketOptions: {},
}));

// Mock peerUrl for deterministic base URL generation.
vi.mock('../../lib/peerUrl.js', async () => ({
  peerBaseUrl: vi.fn((peer) => `http://${peer.instanceId}.test:5555`),
}));

// Mock instances.js — peer list is controlled per test.
vi.mock('../instances.js', async () => ({
  UNKNOWN_INSTANCE_ID: 'unknown',
  getInstanceId: vi.fn().mockResolvedValue('local-instance'),
  getPeers: vi.fn(),
}));

// Mock peerSync.js — we test integrity.js logic, not asset hashing.
vi.mock('./peerSync.js', async () => ({
  assetIntegrityForRecord: vi.fn().mockResolvedValue({ assetHashes: [], metadataMissing: false }),
  assetShaListForRecord: vi.fn().mockResolvedValue([]),
  PEER_SUBSCRIBABLE_KINDS: ['universe', 'series', 'mediaCollection'],
}));

// Mock mediaCollections, universeBuilder, series so tests control the record set.
vi.mock('../mediaCollections.js', async () => ({
  listCollections: vi.fn(),
}));
vi.mock('../universeBuilder.js', async () => ({
  listUniverses: vi.fn(),
}));
vi.mock('../pipeline/series.js', async () => ({
  listSeries: vi.fn(),
}));

import { peerFetch } from '../../lib/peerHttpClient.js';
import { getPeers } from '../instances.js';
import { assetIntegrityForRecord } from './peerSync.js';
import { listCollections } from '../mediaCollections.js';
import { listUniverses } from '../universeBuilder.js';
import { listSeries } from '../pipeline/series.js';
import { buildLocalManifest, getPeerIntegrity } from './integrity.js';
import { INTEGRITY_STATUS } from '../../lib/syncIntegrity.js';

const makeCollection = (overrides = {}) => ({
  id: 'col-1',
  name: 'My Collection',
  updatedAt: '2026-05-23T00:00:00.000Z',
  deleted: false,
  items: [],
  ...overrides,
});

const makePeer = (id = 'peer-x') => ({ instanceId: id, name: `Peer ${id}` });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPeers).mockResolvedValue([]);
  vi.mocked(listCollections).mockResolvedValue([]);
  vi.mocked(listUniverses).mockResolvedValue([]);
  vi.mocked(listSeries).mockResolvedValue([]);
});

describe('buildLocalManifest', () => {
  it('returns an empty array when no records exist', async () => {
    vi.mocked(listCollections).mockResolvedValue([]);
    const result = await buildLocalManifest('mediaCollection');
    expect(result).toEqual([]);
  });

  it('returns one row per collection with the correct shape', async () => {
    const col = makeCollection();
    vi.mocked(listCollections).mockResolvedValue([col]);
    vi.mocked(assetIntegrityForRecord).mockResolvedValue({ assetHashes: ['aabb', 'ccdd'], metadataMissing: true });

    const result = await buildLocalManifest('mediaCollection');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'col-1',
      name: 'My Collection',
      updatedAt: '2026-05-23T00:00:00.000Z',
      deleted: false,
      assetHashes: ['aabb', 'ccdd'],
      metadataMissing: true,
    });
    expect(assetIntegrityForRecord).toHaveBeenCalledWith('mediaCollection', col);
  });

  it('marks deleted collections as deleted:true and skips asset hashing for them', async () => {
    const col = makeCollection({ deleted: true });
    vi.mocked(listCollections).mockResolvedValue([col]);

    const result = await buildLocalManifest('mediaCollection');
    expect(result[0].deleted).toBe(true);
    // Tombstones are never hashed — computeRecordIntegrity ignores assets for
    // deleted records, so the file I/O would be wasted.
    expect(result[0].assetHashes).toEqual([]);
    expect(assetIntegrityForRecord).not.toHaveBeenCalled();
  });

  it('passes includeDeleted:true so listCollections returns tombstones', async () => {
    await buildLocalManifest('mediaCollection');
    expect(listCollections).toHaveBeenCalledWith({ includeDeleted: true });
  });

  it('passes includeDeleted:true to listUniverses', async () => {
    await buildLocalManifest('universe');
    expect(listUniverses).toHaveBeenCalledWith({ includeDeleted: true });
  });

  it('passes includeDeleted:true to listSeries', async () => {
    await buildLocalManifest('series');
    expect(listSeries).toHaveBeenCalledWith({ includeDeleted: true });
  });

  it('returns empty array for an unrecognised kind', async () => {
    const result = await buildLocalManifest('unknown-kind');
    expect(result).toEqual([]);
  });

  it('handles multiple collections and calls assetIntegrityForRecord for each', async () => {
    const col1 = makeCollection({ id: 'c1', name: 'C1' });
    const col2 = makeCollection({ id: 'c2', name: 'C2' });
    vi.mocked(listCollections).mockResolvedValue([col1, col2]);
    vi.mocked(assetIntegrityForRecord)
      .mockResolvedValueOnce({ assetHashes: ['hash-a'], metadataMissing: false })
      .mockResolvedValueOnce({ assetHashes: ['hash-b'], metadataMissing: true });

    const result = await buildLocalManifest('mediaCollection');
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.id === 'c1').assetHashes).toEqual(['hash-a']);
    expect(result.find((r) => r.id === 'c2').assetHashes).toEqual(['hash-b']);
    expect(result.find((r) => r.id === 'c2').metadataMissing).toBe(true);
  });
});

describe('getPeerIntegrity', () => {
  it('returns available:false with reason peer-not-found when peer is unknown', async () => {
    vi.mocked(getPeers).mockResolvedValue([]);
    const result = await getPeerIntegrity({ peerId: 'no-such-peer', kind: 'mediaCollection' });
    expect(result).toEqual({ available: false, reason: 'peer-not-found', records: [] });
  });

  it('returns available:false with reason peer-too-old on 404 from peer', async () => {
    const peer = makePeer('peer-x');
    vi.mocked(getPeers).mockResolvedValue([peer]);
    vi.mocked(peerFetch).mockResolvedValue({ ok: false, status: 404 });

    const result = await getPeerIntegrity({ peerId: 'peer-x', kind: 'mediaCollection' });
    expect(result).toEqual({ available: false, reason: 'peer-too-old', records: [] });
  });

  it('returns available:false with reason peer-unreachable when peerFetch throws', async () => {
    const peer = makePeer('peer-x');
    vi.mocked(getPeers).mockResolvedValue([peer]);
    vi.mocked(peerFetch).mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await getPeerIntegrity({ peerId: 'peer-x', kind: 'mediaCollection' });
    expect(result).toEqual({ available: false, reason: 'peer-unreachable', records: [] });
  });

  it('returns available:false with reason fetch-failed on non-404 error status', async () => {
    const peer = makePeer('peer-x');
    vi.mocked(getPeers).mockResolvedValue([peer]);
    vi.mocked(peerFetch).mockResolvedValue({ ok: false, status: 500 });

    const result = await getPeerIntegrity({ peerId: 'peer-x', kind: 'mediaCollection' });
    expect(result).toEqual({ available: false, reason: 'fetch-failed', records: [] });
  });

  it('returns available:true with classified records when peer responds ok', async () => {
    const peer = makePeer('peer-x');
    vi.mocked(getPeers).mockResolvedValue([peer]);

    const ts = '2026-05-23T00:00:00.000Z';
    const localCol = makeCollection({ id: 'col-1', updatedAt: ts });
    vi.mocked(listCollections).mockResolvedValue([localCol]);
    vi.mocked(assetIntegrityForRecord).mockResolvedValue({ assetHashes: [], metadataMissing: false });

    const remoteRecords = [
      { id: 'col-1', name: 'My Collection', updatedAt: ts, deleted: false, assetHashes: [] },
    ];
    vi.mocked(peerFetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ records: remoteRecords }),
    });

    const result = await getPeerIntegrity({ peerId: 'peer-x', kind: 'mediaCollection' });
    expect(result.available).toBe(true);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      id: 'col-1',
      status: INTEGRITY_STATUS.IN_PARITY,
    });
  });

  it('does not throw on a hostile/malformed peer manifest (nulls, scalars, id-less objects)', async () => {
    const peer = makePeer('peer-x');
    vi.mocked(getPeers).mockResolvedValue([peer]);
    const ts = '2026-05-23T00:00:00.000Z';
    vi.mocked(listCollections).mockResolvedValue([makeCollection({ id: 'col-1', updatedAt: ts })]);
    vi.mocked(assetIntegrityForRecord).mockResolvedValue({ assetHashes: [], metadataMissing: false });
    vi.mocked(peerFetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ records: [
        null,
        'not-an-object',
        42,
        { name: 'no id here' },          // missing id
        { id: 42 },                       // non-string id
        { id: 'col-1', name: 'My Collection', updatedAt: ts, deleted: false, assetHashes: [] }, // the only valid one
      ] }),
    });

    const result = await getPeerIntegrity({ peerId: 'peer-x', kind: 'mediaCollection' });
    expect(result.available).toBe(true);
    // Only the one well-formed remote row is diffed; the junk is filtered out.
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ id: 'col-1', status: INTEGRITY_STATUS.IN_PARITY });
  });

  it('surfaces PEER_ONLY records from peer that are absent locally', async () => {
    const peer = makePeer('peer-x');
    vi.mocked(getPeers).mockResolvedValue([peer]);
    vi.mocked(listCollections).mockResolvedValue([]);

    const remoteRecords = [
      {
        id: 'col-remote',
        name: 'Remote Only',
        updatedAt: '2026-05-23T00:00:00.000Z',
        deleted: false,
        assetHashes: [],
      },
    ];
    vi.mocked(peerFetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ records: remoteRecords }),
    });

    const result = await getPeerIntegrity({ peerId: 'peer-x', kind: 'mediaCollection' });
    expect(result.available).toBe(true);
    expect(result.records[0]).toMatchObject({
      id: 'col-remote',
      status: INTEGRITY_STATUS.PEER_ONLY,
    });
  });

  it('treats malformed peer body (no records array) as empty remote list', async () => {
    const peer = makePeer('peer-x');
    vi.mocked(getPeers).mockResolvedValue([peer]);
    vi.mocked(listCollections).mockResolvedValue([]);

    vi.mocked(peerFetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ unexpected: 'shape' }),
    });

    const result = await getPeerIntegrity({ peerId: 'peer-x', kind: 'mediaCollection' });
    expect(result.available).toBe(true);
    expect(result.records).toEqual([]);
  });
});
