/**
 * Two paired machines holding pre-upgrade copies converge on the creator's
 * origin (#14133): by adoption from an owner candidate, and by the earliest
 * holder's file time in the exchanged inventory. Real files under a temp data root.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-origin-reconcile-' });
vi.mock('../lib/fileUtils.js', async () => makeProxy(await vi.importActual('../lib/fileUtils.js')));
const SECRET = 's'.repeat(40);
const peers = vi.hoisted(() => ({ list: [] }));
vi.mock('./instances.js', async () => ({
  ...(await vi.importActual('./instances.js')),
  getPeers: async () => peers.list,
}));
vi.mock('./instanceIdentity.js', () => ({ UNKNOWN_INSTANCE_ID: 'unknown', getInstanceId: async () => 'me' }));
vi.mock('./mediaAssetIndex/index.js', () => ({ indexImage: async () => {} }));

const dataSync = await import('./dataSync.js');
const { loadHistory, saveHistory } = await import('./videoGen/history.js');
const { PATHS } = await import('../lib/fileUtils.js');
const { editImageSidecar } = await import('./imageGen/sidecarStore.js');
const { heldImageAdoptsOrigin } = await import('./sharing/sidecarSync.js');
const { reconcileMediaOrigins, recordPeerHoldings } = await import('./mediaOriginReconcile.js');

afterAll(cleanup);

const DAY = 86_400_000;
const T = Date.parse('2026-06-01T00:00:00Z');
const peer = (instanceId, extra = {}) => ({ instanceId, enabled: true, syncSecret: SECRET, ...extra });
const touch = (path, ms) => utimesSync(path, new Date(ms), new Date(ms));
const videoRow = { id: 'v1', filename: 'v1.mp4', createdAt: '2026-05-22T00:00:00Z' };

beforeEach(async () => {
  mkdirSync(PATHS.videos, { recursive: true });
  mkdirSync(PATHS.images, { recursive: true });
  for (const name of ['peer-hosted-media.json', 'peer-media-holdings.json', 'video-history.json']) rmSync(join(PATHS.data, name), { force: true });
  writeFileSync(join(PATHS.videos, 'v1.mp4'), 'bytes');
  peers.list = [peer('a'), peer('b')];
  await saveHistory([{ ...videoRow }]);
});

afterEach(() => vi.restoreAllMocks());

const originOf = async () => (await loadHistory()).find((r) => r.id === 'v1')?.originInstanceId;

describe('adopting a sender-named origin', () => {
  it('lets a supplier name the origin of an origin-less copy and keeps the checksums equal', async () => {
    await saveHistory([{ ...videoRow, suppliedByInstanceId: 'a' }]);
    await dataSync.applyRemote('videoHistory', { videos: [{ ...videoRow, originInstanceId: 'creator' }] }, { peerId: 'a' });
    expect(await originOf()).toBe('creator');
  });

  it('refuses a sender that is not an owner candidate', async () => {
    await saveHistory([{ ...videoRow, suppliedByInstanceId: 'a' }]);
    await dataSync.applyRemote('videoHistory', { videos: [{ ...videoRow, originInstanceId: 'b' }] }, { peerId: 'b' });
    expect(await originOf()).toBeUndefined();
    await saveHistory([{ ...videoRow }]);
    await dataSync.applyRemote('videoHistory', { videos: [{ ...videoRow, originInstanceId: 'a' }] }, { peerId: 'a' });
    expect(await originOf()).toBeUndefined();
  });

  it('adopts an image origin only from an owner candidate', () => {
    const local = { suppliedByInstanceId: 'a', prompt: 'p' };
    expect(heldImageAdoptsOrigin(local, { instanceId: 'a' }, 'i.png', {})).toBe(true);
    expect(heldImageAdoptsOrigin(local, { instanceId: 'b' }, 'i.png', {})).toBe(false);
    expect(heldImageAdoptsOrigin({ prompt: 'p' }, { instanceId: 'a' }, 'i.png', {})).toBe(false);
    expect(heldImageAdoptsOrigin({ ...local, originInstanceId: 'x' }, { instanceId: 'a' }, 'i.png', {})).toBe(false);
    expect(heldImageAdoptsOrigin({ prompt: 'p' }, { instanceId: 'a' }, 'i.png', { 'image:i.png': { peerId: 'a' } })).toBe(true);
  });
});

describe('earliest holder of a pre-upgrade video', () => {
  it('serves file times in the hosted inventory', async () => {
    touch(join(PATHS.videos, 'v1.mp4'), T);
    expect((await dataSync.getHostedMediaInventory('videoHistory')).mtimes).toEqual({ 'v1.mp4': T });
  });

  const report = (id, ms) => recordPeerHoldings(id, 'video', ms === undefined ? {} : { 'v1.mp4': ms });

  it('stamps this machine when its file predates every holder, once all peers reported', async () => {
    touch(join(PATHS.videos, 'v1.mp4'), T);
    await report('a', T + DAY);
    expect(await reconcileMediaOrigins('video')).toBe(0); // b has not reported
    await report('b', T + 2 * DAY);
    expect(await reconcileMediaOrigins('video')).toBe(1);
    expect(await originOf()).toBe('me');
  });

  it('adopts a peer that wrote its bytes first, but not one that may not delete media here', async () => {
    touch(join(PATHS.videos, 'v1.mp4'), T + DAY);
    await report('a', T);
    await report('b', undefined);
    peers.list = [peer('a', { mediaDeleteAllowed: false }), peer('b')];
    expect(await reconcileMediaOrigins('video')).toBe(0);
    peers.list = [peer('a'), peer('b')];
    expect(await reconcileMediaOrigins('video')).toBe(1);
    expect(await originOf()).toBe('a');
  });

  it('claims nothing on a tie, and never touches a copy that records a supplier', async () => {
    touch(join(PATHS.videos, 'v1.mp4'), T);
    await report('a', T);
    await report('b', undefined);
    expect(await reconcileMediaOrigins('video')).toBe(0);
    await report('a', T + DAY);
    await saveHistory([{ ...videoRow, suppliedByInstanceId: 'b' }]);
    expect(await reconcileMediaOrigins('video')).toBe(0);
    expect(await originOf()).toBeUndefined();
  });
});

describe('earliest holder of a pre-upgrade collection image', () => {
  it('stamps the image sidecar, leaving a supplied image alone', async () => {
    writeFileSync(join(PATHS.images, 'i1.png'), 'png');
    writeFileSync(join(PATHS.images, 'i1.metadata.json'), JSON.stringify({ prompt: 'p' }));
    touch(join(PATHS.images, 'i1.png'), T);
    vi.spyOn(dataSync, 'getHostedMediaInventory').mockResolvedValue({ filenames: ['i1.png'] });
    await recordPeerHoldings('a', 'image', { 'i1.png': T + DAY });
    await recordPeerHoldings('b', 'image', { 'i1.png': T + 2 * DAY });
    expect(await reconcileMediaOrigins('image')).toBe(1);
    expect(JSON.parse(await readFile(join(PATHS.images, 'i1.metadata.json'), 'utf8')).originInstanceId).toBe('me');
    await editImageSidecar('i1.png', (m) => { delete m.originInstanceId; m.suppliedByInstanceId = 'a'; return true; });
    expect(await reconcileMediaOrigins('image')).toBe(0);
  });
});
