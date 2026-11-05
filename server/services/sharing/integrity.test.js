import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock peerFetch so no network calls go out.
vi.mock('../../lib/peerHttpClient.js', async (importOriginal) => ({
  readPeerBody: (await importOriginal()).readPeerBody,
  peerFetch: vi.fn(),
  peerSocketOptions: {},
}));

// Mock peerUrl for deterministic base URL generation.
vi.mock('../../lib/peerUrl.js', async () => ({
  peerBaseUrl: vi.fn((peer) => `http://${peer.instanceId}.test:5555`),
}));

// Mock instances.js — peer list is controlled per test.
vi.mock('../instances.js', async () => ({
  getPeers: vi.fn(),
  resolveEffectiveCategories: vi.fn(),
}));

// Mock instanceIdentity.js — deterministic local id for manifest assertions.
vi.mock('../instanceIdentity.js', async () => ({
  UNKNOWN_INSTANCE_ID: 'unknown',
  getInstanceId: vi.fn().mockResolvedValue('local-instance'),
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
vi.mock('../fableLoom/index.js', () => ({ listLooms: vi.fn() }));
vi.mock('../authors/index.js', () => ({ listAuthors: vi.fn() }));
vi.mock('../artists/index.js', () => ({ listArtists: vi.fn() }));
vi.mock('../albums/index.js', () => ({ listAlbums: vi.fn() }));
vi.mock('../tracks/index.js', () => ({ listTracks: vi.fn() }));
vi.mock('../creativeDirector/local.js', () => ({ listProjects: vi.fn() }));
vi.mock('../moodBoard/index.js', () => ({ listBoards: vi.fn() }));
vi.mock('../musicVideo/projects.js', () => ({ listProjects: vi.fn() }));
vi.mock('../writersRoom/sync.js', () => ({
  listWorksForIntegrity: vi.fn(), listFoldersForIntegrity: vi.fn(), listExercisesForIntegrity: vi.fn(),
  buildWorkBodyManifest: vi.fn().mockResolvedValue([]),
}));
vi.mock('../writersRoom/bibleSync.js', () => ({ buildWorkBibleManifest: vi.fn().mockResolvedValue([]) }));
vi.mock('../creativeCommissions/feedbackStore.js', () => ({ listCommissionFeedbackForIntegrity: vi.fn() }));
vi.mock('../creativeCommissions/store.js', () => ({ listCommissionsForIntegrity: vi.fn() }));
vi.mock('../decks.js', () => ({ listDecksForIntegrity: vi.fn() }));
vi.mock('../storyboards/sync.js', () => ({ listStoryboardsForIntegrity: vi.fn() }));

import { peerFetch } from '../../lib/peerHttpClient.js';
import { getPeers } from '../instances.js';
import { assetIntegrityForRecord } from './peerSync.js';
import { listCollections } from '../mediaCollections.js';
import { listUniverses } from '../universeBuilder.js';
import { listSeries } from '../pipeline/series.js';
import { listLooms } from '../fableLoom/index.js';
import { listAuthors } from '../authors/index.js';
import { listArtists } from '../artists/index.js';
import { listAlbums } from '../albums/index.js';
import { listTracks } from '../tracks/index.js';
import { listProjects as listCreativeDirectorProjects } from '../creativeDirector/local.js';
import { listBoards } from '../moodBoard/index.js';
import { listProjects as listMusicVideoProjects } from '../musicVideo/projects.js';
import { listWorksForIntegrity, listFoldersForIntegrity, listExercisesForIntegrity, buildWorkBodyManifest } from '../writersRoom/sync.js';
import { buildWorkBibleManifest } from '../writersRoom/bibleSync.js';
import { listCommissionFeedbackForIntegrity } from '../creativeCommissions/feedbackStore.js';
import { listCommissionsForIntegrity } from '../creativeCommissions/store.js';
import { listDecksForIntegrity } from '../decks.js';
import { listStoryboardsForIntegrity } from '../storyboards/sync.js';
import { PEER_SUBSCRIBABLE_KINDS } from './peerSyncShared.js';
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

const kindListers = {
  universe: listUniverses, series: listSeries, mediaCollection: listCollections,
  author: listAuthors, artist: listArtists, album: listAlbums, track: listTracks,
  creativeDirectorProject: listCreativeDirectorProjects, moodBoard: listBoards, fableLoom: listLooms,
  writersRoomWork: listWorksForIntegrity, writersRoomFolder: listFoldersForIntegrity,
  writersRoomExercise: listExercisesForIntegrity, musicVideoProject: listMusicVideoProjects,
  commissionFeedback: listCommissionFeedbackForIntegrity, creativeCommission: listCommissionsForIntegrity,
  deck: listDecksForIntegrity, storyboard: listStoryboardsForIntegrity,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPeers).mockResolvedValue([]);
  vi.mocked(listCollections).mockResolvedValue([]);
  vi.mocked(listUniverses).mockResolvedValue([]);
  vi.mocked(listSeries).mockResolvedValue([]);
  for (const lister of Object.values(kindListers)) vi.mocked(lister).mockResolvedValue([]);
  vi.mocked(assetIntegrityForRecord).mockResolvedValue({ assetHashes: [], metadataMissing: false });
  vi.mocked(buildWorkBodyManifest).mockResolvedValue([]);
  vi.mocked(buildWorkBibleManifest).mockResolvedValue([]);
});

describe('buildLocalManifest', () => {
  it('covers each subscribable kind with live records and tombstones', async () => {
    expect(Object.keys(kindListers).sort()).toEqual([...PEER_SUBSCRIBABLE_KINDS].sort());
    for (const kind of PEER_SUBSCRIBABLE_KINDS) {
      const live = { id: `${kind}-live`, title: 'Title', updatedAt: '2026-01-01', cards: [{ imageRefs: ['card.png'] }] };
      const tombstone = { id: `${kind}-deleted`, updatedAt: '2026-01-02', deleted: true };
      vi.mocked(kindListers[kind]).mockResolvedValue([live, tombstone]);
      const manifest = await buildLocalManifest(kind);
      expect(manifest).toEqual([
        { id: live.id, name: 'Title', updatedAt: live.updatedAt, deleted: false, assetHashes: [], metadataMissing: false },
        { id: tombstone.id, name: undefined, updatedAt: tombstone.updatedAt, deleted: true, assetHashes: [], metadataMissing: false },
      ]);
      if (kind !== 'writersRoomWork') expect(assetIntegrityForRecord).toHaveBeenCalledWith(kind, live);
      expect(assetIntegrityForRecord).not.toHaveBeenCalledWith(kind, tombstone);
    }
  });

  it('omits live ephemeral records without hashing them but retains their tombstones', async () => {
    const live = makeCollection({ id: 'private', ephemeral: true });
    const tombstone = makeCollection({ id: 'deleted', ephemeral: true, deleted: true });
    vi.mocked(listUniverses).mockResolvedValue([live, tombstone]);
    expect(await buildLocalManifest('universe')).toEqual([expect.objectContaining({ id: 'deleted', deleted: true })]);
    expect(assetIntegrityForRecord).not.toHaveBeenCalled();
  });

  it('includes draft and bible hashes for live works in sorted asset hashes', async () => {
    vi.mocked(listWorksForIntegrity).mockResolvedValue([{ id: 'work', updatedAt: '2026-01-01' }]);
    vi.mocked(buildWorkBodyManifest).mockResolvedValue([{ sha256: 'z' }, { sha256: 'a' }]);
    vi.mocked(buildWorkBibleManifest).mockResolvedValue([{ sha256: 'm' }]);
    expect(await buildLocalManifest('writersRoomWork')).toEqual([expect.objectContaining({ assetHashes: ['a', 'm', 'z'] })]);
    expect(assetIntegrityForRecord).not.toHaveBeenCalled();
  });
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
  afterEach(() => vi.useRealTimers());

  it('treats unsupported older peer inventories as unavailable while accepting current manifests', async () => {
    vi.mocked(getPeers).mockResolvedValue([makePeer()]);
    vi.mocked(listAuthors).mockResolvedValue([{ id: 'author-1', updatedAt: '2026-01-01' }]);
    vi.mocked(peerFetch).mockResolvedValue({ ok: true, status: 200, json: async () => ({ records: [] }) });
    expect(await getPeerIntegrity({ peerId: 'peer-x', kind: 'author' })).toEqual({
      available: false, reason: 'peer-too-old', records: [],
    });
    expect(listAuthors).not.toHaveBeenCalled();
    vi.mocked(peerFetch).mockResolvedValue({ ok: true, status: 200, json: async () => ({ manifestVersion: 1, records: [] }) });
    expect(await getPeerIntegrity({ peerId: 'peer-x', kind: 'author' })).toEqual({
      available: true, records: [{ id: 'author-1', name: 'author-1', status: INTEGRITY_STATUS.LOCAL_ONLY }],
    });
  });

  it('reports differing work bibles even when the work clock matches', async () => {
    vi.mocked(getPeers).mockResolvedValue([makePeer()]);
    vi.mocked(listWorksForIntegrity).mockResolvedValue([{ id: 'work', updatedAt: '2026-01-01' }]);
    vi.mocked(buildWorkBibleManifest).mockResolvedValue([{ sha256: 'local-bible' }]);
    vi.mocked(peerFetch).mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ manifestVersion: 1, records: [{ id: 'work', updatedAt: '2026-01-01', assetHashes: ['peer-bible'] }] }),
    });
    expect(await getPeerIntegrity({ peerId: 'peer-x', kind: 'writersRoomWork' })).toEqual({
      available: true, records: [{ id: 'work', name: 'work', status: INTEGRITY_STATUS.ASSETS_MISSING }],
    });
  });

  it.each(['stalled', 'oversized'])('rejects a %s manifest body without computing a misleading diff', async (failure) => {
    vi.useFakeTimers();
    vi.mocked(getPeers).mockResolvedValue([makePeer()]);
    const cancel = vi.fn();
    let started;
    const bodyStarted = new Promise(resolve => { started = resolve; });
    const stream = new ReadableStream({
      start(controller) {
        if (failure === 'oversized') controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
      },
      pull() { started(); },
      cancel,
    });
    vi.mocked(peerFetch).mockResolvedValue(new Response(stream));
    const pending = getPeerIntegrity({ peerId: 'peer-x', kind: 'mediaCollection' });
    await bodyStarted;
    if (failure === 'stalled') await vi.advanceTimersByTimeAsync(15000);
    expect(await pending).toEqual({ available: false, reason: 'fetch-failed', records: [] });
    expect(cancel).toHaveBeenCalled();
    expect(listCollections).not.toHaveBeenCalled();
    const [, options] = vi.mocked(peerFetch).mock.calls.at(-1);
    expect(options.maxBytes).toBe(16 * 1024 * 1024);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(vi.getTimerCount()).toBe(0);
  });

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

  it('passes a timeout signal to peerFetch', async () => {
    const peer = makePeer('peer-x');
    vi.mocked(getPeers).mockResolvedValue([peer]);
    vi.mocked(peerFetch).mockResolvedValue({ ok: false, status: 503 });

    await getPeerIntegrity({ peerId: 'peer-x', kind: 'mediaCollection' });

    const [, options] = vi.mocked(peerFetch).mock.calls.at(-1);
    expect(options.signal).toBeInstanceOf(AbortSignal);
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

  it('reports a malformed peer body as unavailable instead of an empty inventory', async () => {
    const peer = makePeer('peer-x');
    vi.mocked(getPeers).mockResolvedValue([peer]);
    vi.mocked(listCollections).mockResolvedValue([]);

    vi.mocked(peerFetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ unexpected: 'shape' }),
    });

    const result = await getPeerIntegrity({ peerId: 'peer-x', kind: 'mediaCollection' });
    expect(result).toEqual({ available: false, reason: 'fetch-failed', records: [] });
    expect(listCollections).not.toHaveBeenCalled();
  });

  it('returns unavailable when peer json parsing fails', async () => {
    const peer = makePeer('peer-x');
    vi.mocked(getPeers).mockResolvedValue([peer]);
    vi.mocked(listCollections).mockResolvedValue([]);
    vi.mocked(peerFetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new Error('invalid json'); },
    });

    const result = await getPeerIntegrity({ peerId: 'peer-x', kind: 'mediaCollection' });
    expect(result).toEqual({ available: false, reason: 'fetch-failed', records: [] });
  });
});
