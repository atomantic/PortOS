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
vi.mock('./mediaAssetIndex/index.js', () => ({ unindexVideo: async () => {}, unindexImage: async () => {}, indexImage: async () => {} }));
vi.mock('../lib/pythonSetup.js', () => ({ resolveFlux2Python: () => null, FLUX2_VENV_DEFAULT: '/fake/venv/bin/python3' }));
vi.mock('./musicVideo/mediaPool.js', () => ({ forgetDeletedMusicVideoAssets: async () => {} }));
vi.mock('../lib/trashFiles.js', () => ({ trashFiles: vi.fn(async () => {}) }));

const { PATHS, readJSONFile, atomicWrite } = await import('../lib/fileUtils.js');
const { peerFetch } = await import('../lib/peerHttpClient.js');
const { trashFiles } = await import('../lib/trashFiles.js');
const { instanceEvents } = await import('./instanceEvents.js');
const { peerSyncBus } = await import('./peerSyncEventBus.js');
const { listMediaTombstones } = await import('./mediaTombstones.js');
const dataSync = await import('./dataSync.js');
const notifications = await import('./notifications.js');
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
const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
// The armed listener itself, so a test can await the work it starts.
const listenerFor = (event) => instanceEvents.listeners(event).at(-1);
const deleteFrames = [];
const onFrame = (event) => { if (event.op === 'delete') deleteFrames.push(event); };
peerSyncBus.on('event', onFrame);
const historyDeletes = [];
const onHistory = (change) => { if (change.op === 'delete') historyDeletes.push(...change.ids); };
peerSyncBus.on('media-history-changed', onHistory);
// A delete announces on a detached chain after it resolves; a few macrotask
// turns let that chain run without a wall-clock wait.
const flushTurns = async () => {
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
};

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
  historyDeletes.length = 0;
});

let disarmQueue = null;
afterEach(() => {
  disarmQueue?.();
  disarmQueue = null;
  vi.useRealTimers();
});

afterAll(() => {
  peerSyncBus.off('event', onFrame);
  peerSyncBus.off('media-history-changed', onHistory);
  cleanup();
});

describe('deleteMediaAnywhere', () => {
  it('deletes a row this machine owns locally and announces it', async () => {
    await atomicWrite(HISTORY, [row('v1', { originInstanceId: 'local-inst' })]);
    expect(await deleteMediaAnywhere('video', 'v1')).toEqual({ ok: true, status: 'deleted' });
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
    expect(await pending).toEqual({ status: 'deleted', peerName: 'Example rec-owner' });
    expect(await readRows()).toEqual([]);
    expect((await listMediaTombstones('video')).map((t) => t.key)).toEqual(['v1']);
    expect(trashFiles).toHaveBeenCalledTimes(1);
    // The owner announces its own delete; the initiator never emits a tombstone
    // frame. The local view's delete event comes first on the same chain.
    await vi.waitFor(() => expect(historyDeletes).toEqual(['v1']));
    await flushTurns();
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
    // The entry is dropped only after the copy here is retired.
    await vi.waitFor(async () => expect(await listMediaDeleteQueue()).toEqual([]));
    expect(await readRows()).toEqual([]);
    expect((await listMediaTombstones('video')).map((t) => t.key)).toEqual(['v1']);
    expect(deleteFrames).toEqual([]);
  });

  it('keeps the owner ack when retiring the copy here fails, and retires it on the next drain', async () => {
    await atomicWrite(HISTORY, [row('v1', { originInstanceId: 'peer-o' })]);
    net.fetch = vi.fn(unreachable);
    await deleteMediaAnywhere('video', 'v1');
    net.fetch = vi.fn(async () => ownerAck('v1'));
    trashFiles.mockRejectedValueOnce(new Error('disk busy'));
    disarmQueue = initMediaRemoteDelete();
    await listenerFor('peer:online')(registry.peers[0]);
    const [kept] = await listMediaDeleteQueue();
    expect(kept).toMatchObject({ key: 'v1', ackTombstone: { key: 'v1' } });
    expect((await readRows()).map((r) => r.id)).toEqual(['v1']);
    // The owner no longer holds it; the retry must use the stored ack, not re-send.
    net.fetch = vi.fn(async () => json(404, { code: 'MEDIA_NOT_HELD' }));
    await listenerFor('peer:online')(registry.peers[0]);
    expect(net.fetch).not.toHaveBeenCalled();
    expect(await readRows()).toEqual([]);
    expect(await listMediaDeleteQueue()).toEqual([]);
  });

  // Uniquely catches a pre-upgrade row (no origin, file already gone) that a
  // single-machine install could only ever hide.
  it('deletes an origin-less row whose file is missing on a machine with no peers', async () => {
    registry.peers = [];
    await atomicWrite(HISTORY, [row('v1')]);
    expect(await deleteMediaAnywhere('video', 'v1')).toEqual({ ok: true, status: 'deleted' });
    expect(await readRows()).toEqual([]);
    expect((await listMediaTombstones('video')).map((t) => t.key)).toEqual(['v1']);
    expect(peerFetch).not.toHaveBeenCalled();
    expect(await listMediaDeleteQueue()).toEqual([]);
  });

  it('deletes a row here when its origin peer is no longer registered', async () => {
    await atomicWrite(HISTORY, [row('v1', { originInstanceId: 'peer-gone' })]);
    expect((await deleteMediaAnywhere('video', 'v1')).status).toBe('deleted');
    expect(await readRows()).toEqual([]);
    expect(peerFetch).not.toHaveBeenCalled();
  });

  it('deletes an origin-less row with a local file and no remote candidate here', async () => {
    await atomicWrite(HISTORY, [row('v1')]);
    writeFileSync(join(PATHS.videos, 'v1.mp4'), 'example');
    expect((await deleteMediaAnywhere('video', 'v1')).status).toBe('deleted');
    expect(await readRows()).toEqual([]);
    expect(peerFetch).not.toHaveBeenCalled();
  });

  it('refuses with 409 when the registered owner is not paired, and changes nothing', async () => {
    registry.peers = [peer('rec-owner', 'peer-o', { syncSecret: undefined })];
    await atomicWrite(HISTORY, [row('v1', { originInstanceId: 'peer-o' })]);
    await expect(deleteMediaAnywhere('video', 'v1')).rejects.toMatchObject({ status: 409, code: 'MEDIA_OWNER_NOT_PAIRED' });
    const [stored] = await readRows();
    expect(stored.hidden).toBeUndefined();
    expect(stored.pendingDelete).toBeUndefined();
    expect(await listMediaTombstones('video')).toEqual([]);
    expect(peerFetch).not.toHaveBeenCalled();
  });

  it('refuses with 409 when the registered owner is turned off here', async () => {
    registry.peers = [peer('rec-owner', 'peer-o', { enabled: false })];
    await atomicWrite(HISTORY, [row('v1', { originInstanceId: 'peer-o' })]);
    await expect(deleteMediaAnywhere('video', 'v1')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('back on') });
    expect((await readRows()).map((r) => r.id)).toEqual(['v1']);
  });

  it('hides the row here only when every owner candidate says it does not hold it', async () => {
    await atomicWrite(HISTORY, [row('v1', { originInstanceId: 'peer-o' })]);
    net.fetch = vi.fn(async () => json(404, { error: 'not held', code: 'MEDIA_NOT_HELD' }));
    expect(await deleteMediaAnywhere('video', 'v1')).toEqual({ status: 'owner-unknown' });
    const [stored] = await readRows();
    expect(stored.hidden).toBe(true);
    expect(stored.pendingDelete).toBeUndefined();
    expect(await listMediaTombstones('video')).toEqual([]);
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
    await atomicWrite(HISTORY, ['v-old', 'v-fresh', 'v-unpaired'].map((id) => row(id, { originInstanceId: id === 'v-unpaired' ? 'peer-removed' : 'peer-o', pendingDelete: { peerId: 'rec-owner', queuedAt: fresh } })));
    await atomicWrite(QUEUE, { version: 1, entries: [queueEntry('v-old', old), queueEntry('v-fresh', fresh), queueEntry('v-unpaired', fresh, 'rec-removed')] });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    disarmQueue = initMediaRemoteDelete();
    // Await the listener's own settling promise: the queue is rewritten before
    // the dropped rows' flags are cleared, so polling the queue alone races.
    await listenerFor('peers:updated')(registry.peers);
    expect((await listMediaDeleteQueue()).map((e) => e.key)).toEqual(['v-fresh']);
    const flags = Object.fromEntries((await readRows()).map((r) => [r.id, Boolean(r.pendingDelete)]));
    expect(flags).toEqual({ 'v-old': false, 'v-fresh': true, 'v-unpaired': false });
  });

  it('drops an entry whose row was re-created after the delete was queued', async () => {
    const queuedAt = '2026-06-01T00:00:00.000Z';
    await atomicWrite(HISTORY, [row('v1', { createdAt: '2026-06-02T00:00:00.000Z' })]);
    await atomicWrite(QUEUE, { version: 1, entries: [queueEntry('v1', queuedAt)] });
    disarmQueue = initMediaRemoteDelete();
    await listenerFor('peers:updated')(registry.peers);
    expect(await listMediaDeleteQueue()).toEqual([]);
  });

  it('a drained not-held answer for a row deleted meanwhile is not logged as a failure', async () => {
    const queuedAt = new Date().toISOString();
    await atomicWrite(HISTORY, [row('v1', { originInstanceId: 'peer-o', pendingDelete: { peerId: 'rec-owner', queuedAt } })]);
    await atomicWrite(QUEUE, { version: 1, entries: [queueEntry('v1', queuedAt)] });
    const dial = deferred();
    net.fetch = vi.fn(() => dial.promise);
    const errors = vi.spyOn(console, 'error');
    disarmQueue = initMediaRemoteDelete();
    const drained = listenerFor('peer:online')(registry.peers[0]);
    await vi.waitFor(() => expect(net.fetch).toHaveBeenCalledTimes(1));
    await atomicWrite(HISTORY, []);
    dial.resolve(json(404, { error: 'not held', code: 'MEDIA_NOT_HELD' }));
    await drained;
    expect(errors).not.toHaveBeenCalled();
    expect(await listMediaDeleteQueue()).toEqual([]);
    errors.mockRestore();
  });

  describe('notifies the user when a queued delete is dropped at drain time', () => {
    const queued = async (extra = {}) => {
      const queuedAt = new Date().toISOString();
      await atomicWrite(HISTORY, [row('v1', { originInstanceId: 'peer-o', prompt: 'a red fox', pendingDelete: { peerId: 'rec-owner', queuedAt }, ...extra })]);
      await atomicWrite(QUEUE, { version: 1, entries: [queueEntry('v1', queuedAt)] });
      disarmQueue = initMediaRemoteDelete();
    };
    const recorded = async () => (await notifications.getNotifications()).filter((n) => n.type === 'media_delete_failed');

    beforeEach(() => notifications.clearAll());

    it.each([
      ['refused', json(403, { code: 'MEDIA_DELETE_FORBIDDEN' }), 'refused the delete'],
      ['not held', json(404, { code: 'MEDIA_NOT_HELD' }), 'does not hold it'],
      ['unusable reply', json(200, { ok: true, tombstone: { key: 'other', deletedAt: new Date().toISOString() } }), 'without a usable confirmation'],
    ])('records one notification naming the peer and reason: %s', async (_name, response, phrase) => {
      await queued();
      net.fetch = vi.fn(async () => response);
      await listenerFor('peer:online')(registry.peers[0]);
      const found = await recorded();
      expect(found).toHaveLength(1);
      expect(found[0].description).toContain('Example rec-owner');
      expect(found[0].description).toContain(phrase);
      expect(found[0].description).toContain('a red fox');
    });

    it('records none while the owner is still unreachable or after a successful drain', async () => {
      await queued();
      net.fetch = vi.fn(unreachable);
      await listenerFor('peer:online')(registry.peers[0]);
      expect(await recorded()).toEqual([]);
      net.fetch = vi.fn(async () => ownerAck('v1'));
      await listenerFor('peer:online')(registry.peers[0]);
      expect(await listMediaDeleteQueue()).toEqual([]);
      expect(await recorded()).toEqual([]);
    });
  });

  it('prunes a removed peer\'s entries when the registry changes', async () => {
    const queuedAt = new Date().toISOString();
    await atomicWrite(HISTORY, [row('v1', { originInstanceId: 'peer-o' })]);
    await atomicWrite(QUEUE, { version: 1, entries: [queueEntry('v1', queuedAt)] });
    disarmQueue = initMediaRemoteDelete();
    await listenerFor('peers:updated')([]);
    expect(await listMediaDeleteQueue()).toEqual([]);
  });
});

describe('removing the peer a delete is queued on', () => {
  const queuedAt = new Date().toISOString();
  const seed = async (rowExtra = {}) => {
    registry.peers = [peer('rec-a', 'peer-a'), peer('rec-b', 'peer-b')];
    await atomicWrite(HISTORY, [row('v1', {
      originInstanceId: 'peer-a', suppliedByInstanceId: 'peer-b', pendingDelete: { peerId: 'rec-a', queuedAt }, ...rowExtra,
    })]);
    await atomicWrite(QUEUE, { version: 1, entries: [{ peerId: 'rec-a', kind: 'video', key: 'v1', queuedAt }] });
    disarmQueue = initMediaRemoteDelete();
  };
  const offline = (peers) => peers.map((p) => ({ ...p, status: 'offline' }));

  // Uniquely catches a delete silently cancelled when one of several holders is unpaired.
  it('re-targets the entry and the pending flag to the next holder, keeping queuedAt, then drops it when none remain', async () => {
    await seed();
    await listenerFor('peers:updated')(offline([registry.peers[1]]));
    expect(await listMediaDeleteQueue()).toEqual([{ peerId: 'rec-b', kind: 'video', key: 'v1', queuedAt }]);
    expect((await readRows())[0].pendingDelete).toEqual({ peerId: 'rec-b', queuedAt });

    await listenerFor('peers:updated')([]);
    expect(await listMediaDeleteQueue()).toEqual([]);
    expect((await readRows())[0].pendingDelete).toBeUndefined();
  });

  it('does not re-target to an unpaired holder, and does not move an origin still owed a holder delete', async () => {
    await seed();
    await listenerFor('peers:updated')(offline([{ ...registry.peers[1], syncSecret: undefined }]));
    expect(await listMediaDeleteQueue()).toEqual([]);

    await atomicWrite(QUEUE, { version: 1, entries: [{ peerId: 'rec-a', kind: 'video', key: 'v1', queuedAt, holderDeleted: true }] });
    await listenerFor('peers:updated')(offline([registry.peers[1]]));
    expect(await listMediaDeleteQueue()).toEqual([]);
  });
});

describe('owner acknowledgements', () => {
  const ownedRows = () => atomicWrite(HISTORY, [row('v1', { originInstanceId: 'peer-o' }), row('v2', { originInstanceId: 'peer-o' })]);
  const expectNothingDeleted = async () => {
    const rows = await readRows();
    expect(rows.map((r) => r.id)).toEqual(['v1', 'v2']);
    expect(rows.every((r) => r.pendingDelete === undefined && r.hidden === undefined)).toBe(true);
    expect(await listMediaTombstones('video')).toEqual([]);
    expect(await listMediaDeleteQueue()).toEqual([]);
    expect(trashFiles).not.toHaveBeenCalled();
  };

  // Uniquely catches an initiator that deletes whatever row the owner's reply names.
  it('an ack naming a different row deletes neither row and fails the delete', async () => {
    await ownedRows();
    net.fetch = vi.fn(async () => ownerAck('v2'));
    await expect(deleteMediaAnywhere('video', 'v1')).rejects.toMatchObject({ status: 502, code: 'MEDIA_DELETE_FAILED' });
    await expectNothingDeleted();
  });

  it('an ack without a tombstone, or one dated in the future, deletes nothing', async () => {
    await ownedRows();
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    for (const body of [{ ok: true }, { ok: true, tombstone: { key: 'v1' } }, { ok: true, tombstone: { key: 'v1', deletedAt: future } }]) {
      net.fetch = vi.fn(async () => json(200, body));
      await expect(deleteMediaAnywhere('video', 'v1'), JSON.stringify(body)).rejects.toMatchObject({ status: 502, code: 'MEDIA_DELETE_FAILED' });
    }
    await expectNothingDeleted();
  });

  it('reports deleted-remote when the owner deleted but the copy here was re-created after it', async () => {
    await atomicWrite(HISTORY, [row('v1', { originInstanceId: 'peer-o' })]);
    net.fetch = vi.fn(async () => json(200, { ok: true, tombstone: { key: 'v1', deletedAt: '2026-04-01T00:00:00.000Z' } }));
    expect(await deleteMediaAnywhere('video', 'v1')).toEqual({ status: 'deleted-remote', hiddenHere: false, peerName: 'Example rec-owner' });
    const [stored] = await readRows();
    expect(stored.pendingDelete).toBeUndefined();
    expect(stored.hidden).toBeUndefined();
    expect(trashFiles).not.toHaveBeenCalled();
  });

  it('reports deleted-remote and only hides the copy when this machine refuses that owner\'s tombstones', async () => {
    registry.peers = [peer('rec-owner', 'peer-o', { mediaDeleteAllowed: false })];
    await atomicWrite(HISTORY, [row('v1', { originInstanceId: 'peer-o' })]);
    net.fetch = vi.fn(async () => ownerAck('v1'));
    expect(await deleteMediaAnywhere('video', 'v1')).toMatchObject({ status: 'deleted-remote', hiddenHere: true });
    const [stored] = await readRows();
    expect(stored.hidden).toBe(true);
    expect(await listMediaTombstones('video')).toEqual([]);
    expect(trashFiles).not.toHaveBeenCalled();
  });
});

describe('the origin is the authority', () => {
  const twoHolders = (originExtra = {}) => {
    registry.peers = [peer('rec-owner', 'peer-o', originExtra), peer('rec-sup', 'peer-s')];
    return atomicWrite(HISTORY, [row('v1', { originInstanceId: 'peer-o', suppliedByInstanceId: 'peer-s' })]);
  };
  const dialed = () => net.fetch.mock.calls.map(([, , target]) => target.id);

  // Uniquely catches a delete reported done because a supplier acked while the
  // origin, which refuses other machines' tombstones, never heard of it.
  it('queues the unreachable origin even after a supplier acks, and reports pending', async () => {
    await twoHolders();
    net.fetch = vi.fn((url, options, target) => (target.id === 'rec-sup' ? Promise.resolve(ownerAck('v1')) : unreachable()));
    const result = await deleteMediaAnywhere('video', 'v1');
    expect(dialed()).toEqual(['rec-owner', 'rec-sup']);
    expect(result).toMatchObject({
      status: 'pending', peerName: 'Example rec-owner', deletedOn: 'Example rec-sup', removedHere: true,
      pendingDelete: { peerId: 'rec-owner' },
    });
    // The supplier's delete stands: the copy here went with its tombstone.
    expect(await readRows()).toEqual([]);
    expect((await listMediaTombstones('video')).map((t) => t.key)).toEqual(['v1']);
    expect(await listMediaDeleteQueue()).toEqual([
      { peerId: 'rec-owner', kind: 'video', key: 'v1', queuedAt: result.pendingDelete.queuedAt, holderDeleted: true },
    ]);

    // The queued command outlives the row here and completes on the origin.
    disarmQueue = initMediaRemoteDelete();
    await listenerFor('peers:updated')(registry.peers.map((p) => ({ ...p, status: 'offline' })));
    expect(await listMediaDeleteQueue()).toHaveLength(1);
    net.fetch = vi.fn(async () => ownerAck('v1'));
    expect(await listenerFor('peer:online')(registry.peers[0])).toBe(1);
    expect(dialed()).toEqual(['rec-owner']);
    expect(await listMediaDeleteQueue()).toEqual([]);
  });

  it('reports deleted when the origin acks, without dialing other holders', async () => {
    await twoHolders();
    net.fetch = vi.fn(async () => ownerAck('v1'));
    expect(await deleteMediaAnywhere('video', 'v1')).toEqual({ status: 'deleted', peerName: 'Example rec-owner' });
    expect(dialed()).toEqual(['rec-owner']);
    expect(await listMediaDeleteQueue()).toEqual([]);
  });

  it('surfaces the origin\'s 403 without asking other holders', async () => {
    await twoHolders();
    net.fetch = vi.fn(async () => json(403, { error: 'off', code: 'MEDIA_DELETE_FORBIDDEN' }));
    await expect(deleteMediaAnywhere('video', 'v1')).rejects.toMatchObject({ status: 403, code: 'MEDIA_DELETE_FORBIDDEN' });
    expect(dialed()).toEqual(['rec-owner']);
    expect((await readRows())[0].pendingDelete).toBeUndefined();
    expect(await listMediaDeleteQueue()).toEqual([]);
  });

  it('refuses with 409 when the origin is unpaired, even with a paired holder', async () => {
    await twoHolders({ syncSecret: undefined });
    await expect(deleteMediaAnywhere('video', 'v1')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Example rec-owner') });
    expect(peerFetch).not.toHaveBeenCalled();
  });
});

describe('cancel races', () => {
  it('a cancel during the first dial is not undone by the unreachable result', async () => {
    await atomicWrite(HISTORY, [row('v1', { originInstanceId: 'peer-o' })]);
    const dial = deferred();
    net.fetch = vi.fn(() => dial.promise);
    const attempt = deleteMediaAnywhere('video', 'v1');
    await vi.waitFor(() => expect(net.fetch).toHaveBeenCalledTimes(1));
    expect(await cancelPendingDelete('video', 'v1')).toEqual({ ok: true, cancelled: true });
    dial.reject(new Error('connect ECONNREFUSED'));
    expect(await attempt).toEqual({ status: 'cancelled' });
    expect(await listMediaDeleteQueue()).toEqual([]);
    expect((await readRows())[0].pendingDelete).toBeUndefined();
  });

  it('a cancel during the dial does not undo an owner that already deleted', async () => {
    await atomicWrite(HISTORY, [row('v1', { originInstanceId: 'peer-o' })]);
    const dial = deferred();
    net.fetch = vi.fn(() => dial.promise);
    const attempt = deleteMediaAnywhere('video', 'v1');
    await vi.waitFor(() => expect(net.fetch).toHaveBeenCalledTimes(1));
    await cancelPendingDelete('video', 'v1');
    dial.resolve(ownerAck('v1'));
    expect((await attempt).status).toBe('deleted');
    expect(await readRows()).toEqual([]);
  });

  it('a drain skips an entry cancelled while an earlier entry was being sent', async () => {
    const queuedAt = new Date().toISOString();
    const pendingDelete = { peerId: 'rec-owner', queuedAt };
    await atomicWrite(HISTORY, [row('v1', { originInstanceId: 'peer-o', pendingDelete }), row('v2', { originInstanceId: 'peer-o', pendingDelete })]);
    await atomicWrite(QUEUE, { version: 1, entries: ['v1', 'v2'].map((key) => ({ peerId: 'rec-owner', kind: 'video', key, queuedAt })) });
    const first = deferred();
    net.fetch = vi.fn(() => first.promise);
    disarmQueue = initMediaRemoteDelete();
    const drained = listenerFor('peer:online')(registry.peers[0]);
    await vi.waitFor(() => expect(net.fetch).toHaveBeenCalledTimes(1));
    await cancelPendingDelete('video', 'v2');
    first.resolve(ownerAck('v1'));
    await drained;
    expect(net.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(net.fetch.mock.calls[0][1].body).key).toBe('v1');
    const rows = await readRows();
    expect(rows.map((r) => r.id)).toEqual(['v2']);
    expect(rows[0].pendingDelete).toBeUndefined();
    expect(await listMediaDeleteQueue()).toEqual([]);
  });
});

describe('deleteMediaAnywhere for gallery images', () => {
  const sidecarFile = (filename) => join(PATHS.images, filename.replace(/\.png$/, '.metadata.json'));
  const seedImage = (filename, sidecar) => {
    mkdirSync(PATHS.images, { recursive: true });
    writeFileSync(join(PATHS.images, filename), 'synthetic');
    writeFileSync(sidecarFile(filename), JSON.stringify({ prompt: 'p', createdAt: '2026-05-01T00:00:00.000Z', ...sidecar }));
  };
  const sidecar = (filename) => readJSONFile(sidecarFile(filename), null);
  const trashedImage = (filename) => trashFiles.mock.calls.some(([paths]) => paths.includes(join(PATHS.images, filename)));

  it('deletes an image this machine owns here and announces it', async () => {
    seedImage('mine.png', { originInstanceId: 'local-inst' });
    expect(await deleteMediaAnywhere('image', 'mine.png')).toMatchObject({ ok: true, status: 'deleted' });
    expect(trashedImage('mine.png')).toBe(true);
    expect((await listMediaTombstones('image')).map((t) => t.key)).toEqual(['mine.png']);
    expect(peerFetch).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(deleteFrames).toEqual([expect.objectContaining({ category: 'imageHistory', id: 'mine.png' })]));
  });

  it("sends a peer's image delete to its owner and retires the copy here only on the ack", async () => {
    seedImage('theirs.png', { originInstanceId: 'peer-o' });
    let answer;
    net.fetch = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
    const pending = deleteMediaAnywhere('image', 'theirs.png');
    await vi.waitFor(() => expect(net.fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(net.fetch.mock.calls[0][1].body)).toEqual({ kind: 'image', key: 'theirs.png' });
    expect((await sidecar('theirs.png')).pendingDelete).toMatchObject({ peerId: 'rec-owner' });
    expect(await listMediaTombstones('image')).toEqual([]);
    expect(trashFiles).not.toHaveBeenCalled();

    answer(ownerAck('theirs.png'));
    // trashFiles is a stub, so the bytes stay on disk: the copy here was asked to go.
    expect((await pending).peerName).toBe('Example rec-owner');
    expect(trashedImage('theirs.png')).toBe(true);
    expect((await listMediaTombstones('image')).map((t) => t.key)).toEqual(['theirs.png']);
    await vi.waitFor(() => expect(historyDeletes).toEqual(['theirs.png']));
    await flushTurns();
    expect(deleteFrames).toEqual([]);
  });

  it('queues an unreachable owner with a machine-local pending flag, and cancels it', async () => {
    seedImage('theirs.png', { originInstanceId: 'peer-o' });
    net.fetch = vi.fn(unreachable);
    const result = await deleteMediaAnywhere('image', 'theirs.png');
    expect(result).toMatchObject({ status: 'pending', pendingDelete: { peerId: 'rec-owner' } });
    expect(await listMediaDeleteQueue()).toEqual([{ peerId: 'rec-owner', kind: 'image', key: 'theirs.png', queuedAt: result.pendingDelete.queuedAt }]);
    expect((await sidecar('theirs.png')).pendingDelete).toEqual(result.pendingDelete);
    expect(await listMediaTombstones('image')).toEqual([]);

    expect(await cancelPendingDelete('image', 'theirs.png')).toEqual({ ok: true, cancelled: true });
    expect(await listMediaDeleteQueue()).toEqual([]);
    expect((await sidecar('theirs.png')).pendingDelete).toBeUndefined();
  });

  it('drains a queued image delete when its owner comes online', async () => {
    seedImage('theirs.png', { originInstanceId: 'peer-o' });
    net.fetch = vi.fn(unreachable);
    await deleteMediaAnywhere('image', 'theirs.png');
    net.fetch = vi.fn(async () => ownerAck('theirs.png'));
    disarmQueue = initMediaRemoteDelete();
    await listenerFor('peer:online')(registry.peers[0]);
    expect(trashedImage('theirs.png')).toBe(true);
    expect(await listMediaDeleteQueue()).toEqual([]);
  });

  describe('an image only a host-mode peer holds', () => {
    const HOSTED = join(PATHS.data, 'peer-hosted-media.json');
    const hostedEntries = async () => (await readJSONFile(HOSTED, { entries: {} })).entries;
    const seedHosted = (filename) => atomicWrite(HOSTED, {
      version: 1,
      entries: { [`image:${filename}`]: { peerId: 'peer-o', at: '2026-05-01T00:00:00.000Z', revision: 'r1' } },
    });

    it('sends the delete to the host, shows pending while it is offline, and forgets the entry on the drain ack', async () => {
      await seedHosted('hosted.png');
      net.fetch = vi.fn(unreachable);
      const result = await deleteMediaAnywhere('image', 'hosted.png');
      expect(result).toMatchObject({ status: 'pending', pendingDelete: { peerId: 'rec-owner' } });
      expect(JSON.parse(net.fetch.mock.calls[0][1].body)).toEqual({ kind: 'image', key: 'hosted.png' });
      // Nothing is reported deleted before the ack.
      expect(Object.keys(await hostedEntries())).toEqual(['image:hosted.png']);
      expect(await listMediaTombstones('image')).toEqual([]);
      const { resolveMediaLocations } = await import('./peerHostedMedia.js');
      expect(await resolveMediaLocations([{ kind: 'image', ref: 'hosted.png' }])).toEqual([
        expect.objectContaining({ location: 'remote', pendingDelete: result.pendingDelete }),
      ]);

      net.fetch = vi.fn(async () => ownerAck('hosted.png'));
      disarmQueue = initMediaRemoteDelete();
      await listenerFor('peer:online')(registry.peers[0]);
      expect(await hostedEntries()).toEqual({});
      expect(await listMediaDeleteQueue()).toEqual([]);
      expect((await listMediaTombstones('image')).map((t) => t.key)).toEqual(['hosted.png']);
    });

    it('forgets the entry at once when the host acks the first command', async () => {
      await seedHosted('hosted.png');
      net.fetch = vi.fn(async () => ownerAck('hosted.png'));
      expect(await deleteMediaAnywhere('image', 'hosted.png')).toMatchObject({ status: 'deleted' });
      expect(await hostedEntries()).toEqual({});
    });

    it('cancels a queued hosted delete', async () => {
      await seedHosted('hosted.png');
      net.fetch = vi.fn(unreachable);
      await deleteMediaAnywhere('image', 'hosted.png');
      expect(await cancelPendingDelete('image', 'hosted.png')).toEqual({ ok: true, cancelled: true });
      expect(await listMediaDeleteQueue()).toEqual([]);
    });
  });

  it('deletes an image here whose origin peer is no longer registered', async () => {
    seedImage('orphan.png', { originInstanceId: 'peer-gone' });
    expect(await deleteMediaAnywhere('image', 'orphan.png')).toMatchObject({ ok: true, status: 'deleted' });
    expect(trashedImage('orphan.png')).toBe(true);
    expect((await listMediaTombstones('image')).map((t) => t.key)).toEqual(['orphan.png']);
    expect(peerFetch).not.toHaveBeenCalled();
  });

  it('refuses a key that is not a gallery image filename', async () => {
    await expect(deleteMediaAnywhere('image', '../escape.png')).rejects.toMatchObject({ status: 400 });
    await expect(deleteMediaAnywhere('image', 'clip.mp4')).rejects.toMatchObject({ status: 400 });
  });
});

describe('retrying an online owner', () => {
  it('retries a queued delete for an online owner on registry updates at most once a minute', async () => {
    const t0 = Date.now() + 365 * 24 * 60 * 60 * 1000;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    const queuedAt = new Date(t0 - 1000).toISOString();
    await atomicWrite(HISTORY, [row('v1', { originInstanceId: 'peer-o', createdAt: new Date(t0 - 5000).toISOString(), pendingDelete: { peerId: 'rec-owner', queuedAt } })]);
    await atomicWrite(QUEUE, { version: 1, entries: [{ peerId: 'rec-owner', kind: 'video', key: 'v1', queuedAt }] });
    net.fetch = vi.fn(async () => json(503, { error: 'busy' }));
    disarmQueue = initMediaRemoteDelete();
    const onPeers = listenerFor('peers:updated');

    await onPeers(registry.peers);
    expect(net.fetch).toHaveBeenCalledTimes(1);
    vi.setSystemTime(t0 + 30_000);
    await onPeers(registry.peers);
    expect(net.fetch).toHaveBeenCalledTimes(1);
    vi.setSystemTime(t0 + 61_000);
    await onPeers(registry.peers);
    expect(net.fetch).toHaveBeenCalledTimes(2);
    expect((await listMediaDeleteQueue()).map((e) => e.key)).toEqual(['v1']);

    // An offline owner is left for its peer:online.
    vi.setSystemTime(t0 + 200_000);
    await onPeers([{ ...registry.peers[0], status: 'offline' }]);
    expect(net.fetch).toHaveBeenCalledTimes(2);
  });

  it('skips the history read when the queue is empty', async () => {
    disarmQueue = initMediaRemoteDelete();
    const fileUtils = await import('../lib/fileUtils.js');
    const spy = vi.spyOn(fileUtils, 'readJSONFile');
    await listenerFor('peers:updated')(registry.peers);
    expect(spy.mock.calls.filter(([file]) => String(file).endsWith('video-history.json'))).toEqual([]);
    spy.mockRestore();
  });
});
