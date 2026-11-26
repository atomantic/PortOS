/**
 * Make primary's handling of a holder's answers that the two-machine e2e cannot
 * stage: a holder that cannot reach the primary yet, and a second Make primary
 * on the same file while one is running.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-media-holders-' });
const registry = vi.hoisted(() => ({ peers: [] }));
const fetchPeer = vi.hoisted(() => vi.fn());

vi.mock('../lib/fileUtils.js', async () => makeProxy(await vi.importActual('../lib/fileUtils.js')));
vi.mock('./instances.js', async () => ({ ...(await vi.importActual('./instances.js')), getPeers: async () => registry.peers }));
vi.mock('./instanceIdentity.js', () => ({ UNKNOWN_INSTANCE_ID: 'unknown', getInstanceId: async () => 'local-inst' }));
vi.mock('../lib/peerHttpClient.js', async () => ({
  ...(await vi.importActual('../lib/peerHttpClient.js')),
  peerFetch: (...args) => fetchPeer(...args),
  readPeerBody: async (res) => res.json(),
}));
vi.mock('../lib/trashFiles.js', () => ({ trashFiles: vi.fn(async () => {}) }));

const { PATHS, atomicWrite, readJSONFile } = await import('../lib/fileUtils.js');
const { listMediaHolders, makeMediaPrimary, recordPeerInventory, recordPeerReport, readPeerReports } = await import('./mediaHolders.js');
const { hostFileOn, listHostedEntries } = await import('./peerHostedMedia.js');

const STORE = join(PATHS.data, 'media-holders.json');
const HOLDER = { id: 'rec-a', instanceId: 'inst-a', name: 'Machine A', address: '192.0.2.10', port: 5555, enabled: true, status: 'online', syncSecret: 's'.repeat(40) };
const answer = (status, body) => ({ ok: status < 300, status, headers: new Headers(), json: async () => body });

beforeEach(async () => {
  mkdirSync(PATHS.videos, { recursive: true });
  writeFileSync(join(PATHS.videos, 'v1.mp4'), 'bytes');
  await atomicWrite(join(PATHS.data, 'video-history.json'), [{ id: 'v1', filename: 'v1.mp4', createdAt: '2026-05-01T00:00:00.000Z' }]);
  await atomicWrite(STORE, { version: 1, holdings: { 'inst-a': { video: { 'v1.mp4': '2026-05-02T00:00:00.000Z' } } }, releases: [] });
  registry.peers = [HOLDER];
  fetchPeer.mockReset();
});

afterAll(cleanup);

describe('listMediaHolders', () => {
  it('reports primary designations from current and legacy image sidecars', async () => {
    mkdirSync(PATHS.images, { recursive: true });
    writeFileSync(join(PATHS.images, 'no-sidecar.png'), 'bytes');
    await atomicWrite(join(PATHS.images, 'current.metadata.json'), { primaryInstanceId: 'inst-a' });
    await atomicWrite(join(PATHS.images, 'legacy.png.metadata.json'), { primaryInstanceId: 'inst-a' });
    await atomicWrite(STORE, {
      version: 1,
      holdings: { 'inst-a': { image: { 'current.png': true, 'legacy.png': true, 'no-sidecar.png': true } } },
      releases: [],
    });

    const { self, items } = await listMediaHolders();

    const peer = { instanceId: 'inst-a', name: 'Machine A', self: false, primary: true, releasePending: false };
    expect(self).toBe('local-inst');
    expect(items).toEqual({
      'image:current.png': { kind: 'image', filename: 'current.png', cardKeys: ['image:current.png'], primaryInstanceId: 'inst-a', holders: [peer] },
      'image:legacy.png': { kind: 'image', filename: 'legacy.png', cardKeys: ['image:legacy.png'], primaryInstanceId: 'inst-a', holders: [peer] },
      'image:no-sidecar.png': {
        kind: 'image',
        filename: 'no-sidecar.png',
        cardKeys: ['image:no-sidecar.png'],
        primaryInstanceId: null,
        holders: [
          { instanceId: 'local-inst', name: 'This machine', self: true, primary: false, releasePending: false },
          { ...peer, primary: false },
        ],
      },
    });
  });
});

describe('makeMediaPrimary', () => {
  it('queues the release when the holder cannot reach the primary yet', async () => {
    fetchPeer.mockResolvedValue(answer(409, { code: 'PRIMARY_UNREACHABLE' }));

    const result = await makeMediaPrimary({ kind: 'video', filename: 'v1.mp4', instanceId: 'local-inst' });

    expect(result).toMatchObject({ released: [], pending: [{ name: 'Machine A' }], kept: [] });
    expect((await readJSONFile(STORE, null)).releases).toEqual([expect.objectContaining({ peerId: 'rec-a', filename: 'v1.mp4', primaryInstanceId: 'local-inst' })]);
  });

  it('refuses a second Make primary for the same file while one is running', async () => {
    let answerRelease;
    fetchPeer.mockReturnValue(new Promise((resolve) => { answerRelease = resolve; }));
    const first = makeMediaPrimary({ kind: 'video', filename: 'v1.mp4', instanceId: 'local-inst' });
    await vi.waitFor(() => expect(fetchPeer).toHaveBeenCalled());

    await expect(makeMediaPrimary({ kind: 'video', filename: 'v1.mp4', instanceId: 'local-inst' })).rejects.toMatchObject({ code: 'MEDIA_BUSY' });
    answerRelease(answer(200, { ok: true, released: true }));
    expect(await first).toMatchObject({ released: [{ name: 'Machine A' }] });
  });

  it('releases nothing here when the chosen primary does not confirm (it is mid-change itself)', async () => {
    const { trashFiles } = await import('../lib/trashFiles.js');
    fetchPeer.mockImplementation(async (url, opts) => (opts?.method === 'HEAD'
      ? answer(200, null)
      : answer(409, { code: 'MEDIA_BUSY' })));

    await expect(makeMediaPrimary({ kind: 'video', filename: 'v1.mp4', instanceId: 'inst-a' })).rejects.toMatchObject({ code: 'PRIMARY_NOT_CONFIRMED' });
    expect(trashFiles).not.toHaveBeenCalled();
  });
});

describe('recordPeerInventory', () => {
  it('stops streaming from a primary whose inventory no longer lists the file, and ignores a malformed report', async () => {
    await hostFileOn('video', 'kept.mp4', 'inst-a');
    expect(await recordPeerInventory('inst-a', 'video', ['../bad'], ['kept.mp4'])).toBe(false);
    expect(await listHostedEntries()).toHaveProperty(['video:kept.mp4']);

    await recordPeerInventory('inst-a', 'video', [], ['kept.mp4']);
    expect(await listHostedEntries()).not.toHaveProperty(['video:kept.mp4']);
  });
});

describe('recordPeerReport', () => {
  it('renews identical reports after an hour and stores changes immediately', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-05-23T00:00:00Z'));
      const report = { mtimes: { 'v1.mp4': 123 }, checked: ['v1.mp4'] };
      const record = (data = report) => recordPeerReport('inst-a', 'video', 'history', data);
      expect(await record()).toBe(true);
      vi.setSystemTime(new Date('2026-05-23T00:59:00Z'));
      expect(await record({ mtimes: { ...report.mtimes, 'bad.mp4': -1 }, checked: [...report.checked, '../bad'] })).toBe(false);
      vi.setSystemTime(new Date('2026-05-23T01:00:00Z'));
      expect(await record()).toBe(true);
      expect((await readPeerReports())['inst-a'].video.history.at).toBe('2026-05-23T01:00:00.000Z');
      expect(await record({ ...report, complete: true })).toBe(true);
      expect(await record({ ...report, complete: true, mtimes: { 'v1.mp4': 456 } })).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renews an unchanged scope if it supersedes newer conflicting evidence', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-05-23T00:00:00Z'));
      const report = { mtimes: { 'cover.png': 123 }, checked: ['cover.png'] };
      const record = () => recordPeerReport('inst-a', 'image', 'mediaCollections', report);
      expect(await record()).toBe(true);
      vi.setSystemTime(new Date('2026-05-23T00:01:00Z'));
      await recordPeerReport('inst-a', 'image', 'imageLibrary', { ...report, complete: true });
      expect(await record()).toBe(false);
      await recordPeerReport('inst-a', 'image', 'imageLibrary', { mtimes: {}, checked: [], complete: true });
      vi.setSystemTime(new Date('2026-05-23T00:02:00Z'));
      expect(await record()).toBe(true);
      expect((await readPeerReports())['inst-a'].image.mediaCollections.at).toBe('2026-05-23T00:02:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });
});
