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
const { makeMediaPrimary } = await import('./mediaHolders.js');

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
