import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-media-remote-delete-' });
const registry = vi.hoisted(() => ({ peers: [] }));
const net = vi.hoisted(() => ({ fetch: null }));

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});
vi.mock('./instances.js', async () => {
  const actual = await vi.importActual('./instances.js');
  return { ...actual, getPeers: async () => registry.peers };
});
vi.mock('../lib/peerHttpClient.js', async (importOriginal) => ({
  ...(await importOriginal()),
  peerFetch: vi.fn((...args) => net.fetch(...args)),
}));
vi.mock('./instanceIdentity.js', () => ({ UNKNOWN_INSTANCE_ID: 'unknown', getInstanceId: async () => 'local-inst' }));
vi.mock('./mediaAssetIndex/index.js', () => ({ unindexVideo: async () => {} }));
vi.mock('./musicVideo/mediaPool.js', () => ({ forgetDeletedMusicVideoAssets: async () => {} }));
vi.mock('../lib/trashFiles.js', () => ({ trashFiles: vi.fn(async () => {}) }));

const { PATHS, readJSONFile, atomicWrite } = await import('../lib/fileUtils.js');
const { peerFetch } = await import('../lib/peerHttpClient.js');
const { trashFiles } = await import('../lib/trashFiles.js');
const { instanceEvents } = await import('./instanceEvents.js');
const { peerSyncBus } = await import('./peerSyncEventBus.js');
const { listMediaTombstones } = await import('./mediaTombstones.js');
const dataSync = await import('./dataSync.js');
const {
  deleteMediaAnywhere, cancelPendingDelete, initMediaRemoteDelete, MEDIA_DELETE_QUEUE_TTL_MS,
} = await import('./mediaRemoteDelete.js');

const HISTORY = join(PATHS.data, 'video-history.json');
const QUEUE = join(PATHS.data, 'media-delete-queue.json');
const PAIR = 's'.repeat(40);
const peer = (id, instanceId, extra = {}) => ({
  id, name: `Example ${id}`, instanceId, enabled: true, status: 'online', syncSecret: PAIR,
  address: '192.0.2.10', port: 5555, ...extra,
});
const row = (id, extra = {}) => ({ id, filename: `${id}.mp4`, createdAt: '2026-05-01T00:00:00.000Z', ...extra });
const readRows = async () => readJSONFile(HISTORY, []);
const listMediaDeleteQueue = async () => (await readJSONFile(QUEUE, { entries: [] })).entries;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ownerAck = (key) => json(200, { ok: true, tombstone: { key, deletedAt: new Date().toISOString() } });
const unreachable = () => Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
const deleteFrames = [];
const onFrame = (event) => { if (event.op === 'delete') deleteFrames.push(event); };
peerSyncBus.on('event', onFrame);

beforeEach(async () => {
  mkdirSync(PATHS.videos, { recursive: true });
  mkdirSync(PATHS.videoThumbnails, { recursive: true });
  await atomicWrite(HISTORY, []);
  await atomicWrite(join(PATHS.data, 'media-tombstones.json'), { version: 1, video: [], image: [] });
  await atomicWrite(QUEUE, { version: 1, entries: [] });
  registry.peers = [peer('rec-owner', 'peer-o')];
  net.fetch = vi.fn(async () => { throw new Error('unexpected network call'); });
  peerFetch.mockClear();
  trashFiles.mockClear();
  deleteFrames.length = 0;
});

let disarmQueue = null;
afterEach(() => {
  disarmQueue?.();
  disarmQueue = null;
  vi.useRealTimers();
});

afterAll(() => {
  peerSyncBus.off('event', onFrame);
  cleanup();
});

describe('deleteMediaAnywhere', () => {
  it('deletes a row this machine owns locally and announces it', async () => {
    await atomicWrite(HISTORY, [row('v1', { originInstanceId: 'local-inst' })]);
    expect(await deleteMediaAnywhere('video', 'v1')).toEqual({ status: 'deleted' });
    expect(await readRows()).toEqual([]);
    expect(peerFetch).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(deleteFrames.map((e) => e.id)).toEqual(['v1']));
  });

  it('delete of a row owned by an online peer sends the command and records the tombstone only after success', async () => {
    await atomicWrite(HISTORY, [row('v1', { originInstanceId: 'peer-o' })]);
    let answer;
    net.fetch = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
    const pending = deleteMediaAnywhere('video', 'v1');
    await vi.waitFor(() => expect(net.fetch).toHaveBeenCalledTimes(1));
    const [url, options, target] = net.fetch.mock.calls[0];
    expect(url).toBe('http://192.0.2.10:5555/api/peer-media/delete');
    expect(JSON.parse(options.body)).toEqual({ kind: 'video', key: 'v1' });
    expect(target.id).toBe('rec-owner');
    // In flight: pending here, nothing recorded or trashed yet.
    expect((await readRows())[0].pendingDelete).toMatchObject({ peerId: 'rec-owner' });
    expect(await listMediaTombstones('video')).toEqual([]);
    expect(trashFiles).not.toHaveBeenCalled();

    answer(ownerAck('v1'));
    expect(await pending).toEqual({ status: 'deleted' });
    expect(await readRows()).toEqual([]);
    expect((await listMediaTombstones('video')).map((t) => t.key)).toEqual(['v1']);
    expect(trashFiles).toHaveBeenCalledTimes(1);
    // The owner announces its own delete; the initiator never emits a tombstone frame.
    await new Promise((r) => setTimeout(r, 20));
    expect(deleteFrames).toEqual([]);
  });

  it('unreachable owner queues, marks pending, and does not emit a tombstone', async () => {
    await atomicWrite(HISTORY, [row('v1', { originInstanceId: 'peer-o' })]);
    net.fetch = vi.fn(unreachable);
    const result = await deleteMediaAnywhere('video', 'v1');
    expect(result).toMatchObject({ status: 'pending', peerName: 'Example rec-owner', pendingDelete: { peerId: 'rec-owner' } });
    const queue = await listMediaDeleteQueue();
    expect(queue).toEqual([{ peerId: 'rec-owner', kind: 'video', key: 'v1', queuedAt: result.pendingDelete.queuedAt }]);
    const [stored] = await readRows();
    expect(stored.pendingDelete).toEqual(result.pendingDelete);
    expect(stored.hidden).toBeUndefined();
    expect(await listMediaTombstones('video')).toEqual([]);
    expect(trashFiles).not.toHaveBeenCalled();
    expect(deleteFrames).toEqual([]);
  });

  it('queues an offline owner without dialing it', async () => {
    registry.peers = [peer('rec-owner', 'peer-o', { status: 'offline' })];
    await atomicWrite(HISTORY, [row('v1', { originInstanceId: 'peer-o' })]);
    expect((await deleteMediaAnywhere('video', 'v1')).status).toBe('pending');
    expect(peerFetch).not.toHaveBeenCalled();
  });

  it('queue drains on peer:online', async () => {
    await atomicWrite(HISTORY, [row('v1', { originInstanceId: 'peer-o' })]);
    net.fetch = vi.fn(unreachable);
    await deleteMediaAnywhere('video', 'v1');
    net.fetch = vi.fn(async () => ownerAck('v1'));
    disarmQueue = initMediaRemoteDelete();
    instanceEvents.emit('peer:online', registry.peers[0]);
    await vi.waitFor(async () => expect(await readRows()).toEqual([]));
    expect(await listMediaDeleteQueue()).toEqual([]);
    expect((await listMediaTombstones('video')).map((t) => t.key)).toEqual(['v1']);
    expect(deleteFrames).toEqual([]);
  });

  it('owner-unknown hides locally and sends nothing', async () => {
    // No origin, no hosted entry, no supplier and no local file: nobody to ask.
    await atomicWrite(HISTORY, [row('v1')]);
    expect(await deleteMediaAnywhere('video', 'v1')).toEqual({ status: 'owner-unknown' });
    const [stored] = await readRows();
    expect(stored.hidden).toBe(true);
    expect(stored.pendingDelete).toBeUndefined();
    expect(peerFetch).not.toHaveBeenCalled();
    expect(await listMediaTombstones('video')).toEqual([]);
    expect(await listMediaDeleteQueue()).toEqual([]);
  });

  it('treats a candidate that is not a registered peer as owner-unknown', async () => {
    await atomicWrite(HISTORY, [row('v1', { originInstanceId: 'peer-gone' })]);
    expect((await deleteMediaAnywhere('video', 'v1')).status).toBe('owner-unknown');
    expect(peerFetch).not.toHaveBeenCalled();
  });

  it('deletes an origin-less row with a local file and no remote candidate here', async () => {
    await atomicWrite(HISTORY, [row('v1')]);
    writeFileSync(join(PATHS.videos, 'v1.mp4'), 'example');
    expect((await deleteMediaAnywhere('video', 'v1')).status).toBe('deleted');
    expect(await readRows()).toEqual([]);
    expect(peerFetch).not.toHaveBeenCalled();
  });

  it('403 from owner un-hides and surfaces the error', async () => {
    await atomicWrite(HISTORY, [row('v1', { originInstanceId: 'peer-o' })]);
    net.fetch = vi.fn(async () => json(403, { error: 'off', code: 'MEDIA_DELETE_FORBIDDEN' }));
    await expect(deleteMediaAnywhere('video', 'v1')).rejects.toMatchObject({ status: 403, code: 'MEDIA_DELETE_FORBIDDEN' });
    const [stored] = await readRows();
    expect(stored.pendingDelete).toBeUndefined();
    expect(stored.hidden).toBeUndefined();
    expect(await listMediaDeleteQueue()).toEqual([]);
    expect(await listMediaTombstones('video')).toEqual([]);
    expect(trashFiles).not.toHaveBeenCalled();
  });

  it('cancelPendingDelete removes the queue entry and the pending flag', async () => {
    await atomicWrite(HISTORY, [row('v1', { originInstanceId: 'peer-o' })]);
    net.fetch = vi.fn(unreachable);
    await deleteMediaAnywhere('video', 'v1');
    expect(await cancelPendingDelete('video', 'v1')).toEqual({ ok: true, cancelled: true });
    expect(await listMediaDeleteQueue()).toEqual([]);
    expect((await readRows())[0].pendingDelete).toBeUndefined();
  });

  it('pending flag is not in the snapshot', async () => {
    await atomicWrite(HISTORY, [row('v1', { originInstanceId: 'peer-o' })]);
    const before = await dataSync.getSnapshot('videoHistory');
    net.fetch = vi.fn(unreachable);
    await deleteMediaAnywhere('video', 'v1');
    expect((await readRows())[0].pendingDelete).toBeTruthy();
    const after = await dataSync.getSnapshot('videoHistory');
    expect(after.data.videos[0]).not.toHaveProperty('pendingDelete');
    expect(after.checksum).toBe(before.checksum);
  });

  it('a peer row carrying a pendingDelete never lands it here', async () => {
    await dataSync.mergeVideoRows([row('v2', { originInstanceId: 'peer-o', pendingDelete: { peerId: 'x', queuedAt: '2026-05-02T00:00:00.000Z' } })], { peerId: 'peer-o' });
    expect((await readRows())[0]).not.toHaveProperty('pendingDelete');
  });
});

describe('media delete queue upkeep', () => {
  const queueEntry = (key, queuedAt, peerId = 'rec-owner') => ({ peerId, kind: 'video', key, queuedAt });

  it('queue entries expire after 30 days and on unpair', async () => {
    const now = Date.parse('2026-08-01T00:00:00.000Z');
    const old = new Date(now - MEDIA_DELETE_QUEUE_TTL_MS - 1000).toISOString();
    const fresh = new Date(now - 1000).toISOString();
    await atomicWrite(HISTORY, ['v-old', 'v-fresh', 'v-unpaired'].map((id) => row(id, { originInstanceId: 'peer-o', pendingDelete: { peerId: 'rec-owner', queuedAt: fresh } })));
    await atomicWrite(QUEUE, { version: 1, entries: [queueEntry('v-old', old), queueEntry('v-fresh', fresh), queueEntry('v-unpaired', fresh, 'rec-removed')] });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    disarmQueue = initMediaRemoteDelete();
    instanceEvents.emit('peers:updated', registry.peers);
    await vi.waitFor(async () => expect((await listMediaDeleteQueue()).map((e) => e.key)).toEqual(['v-fresh']));
    const flags = Object.fromEntries((await readRows()).map((r) => [r.id, Boolean(r.pendingDelete)]));
    expect(flags).toEqual({ 'v-old': false, 'v-fresh': true, 'v-unpaired': false });
  });

  it('drops an entry whose row was re-created after the delete was queued', async () => {
    const queuedAt = '2026-06-01T00:00:00.000Z';
    await atomicWrite(HISTORY, [row('v1', { createdAt: '2026-06-02T00:00:00.000Z' })]);
    await atomicWrite(QUEUE, { version: 1, entries: [queueEntry('v1', queuedAt)] });
    disarmQueue = initMediaRemoteDelete();
    instanceEvents.emit('peers:updated', registry.peers);
    await vi.waitFor(async () => expect(await listMediaDeleteQueue()).toEqual([]));
  });

  it('prunes a removed peer\'s entries when the registry changes', async () => {
    const queuedAt = new Date().toISOString();
    await atomicWrite(HISTORY, [row('v1', { originInstanceId: 'peer-o' })]);
    await atomicWrite(QUEUE, { version: 1, entries: [queueEntry('v1', queuedAt)] });
    disarmQueue = initMediaRemoteDelete();
    instanceEvents.emit('peers:updated', []);
    await vi.waitFor(async () => expect(await listMediaDeleteQueue()).toEqual([]));
  });
});
