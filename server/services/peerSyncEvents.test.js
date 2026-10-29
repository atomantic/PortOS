import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-peer-sync-events-' });
const registry = vi.hoisted(() => ({ peers: [] }));

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});
vi.mock('./instances.js', async () => {
  const actual = await vi.importActual('./instances.js');
  return { ...actual, getPeers: async () => registry.peers };
});
vi.mock('./instanceIdentity.js', () => ({ UNKNOWN_INSTANCE_ID: 'unknown', getInstanceId: async () => 'local-inst' }));
vi.mock('./mediaAssetIndex/index.js', () => ({ unindexVideo: async () => {} }));
vi.mock('./musicVideo/mediaPool.js', () => ({ forgetDeletedMusicVideoAssets: vi.fn(async () => {}) }));
vi.mock('../lib/trashFiles.js', () => ({ trashFiles: vi.fn(async () => {}) }));

const { PATHS, readJSONFile, atomicWrite } = await import('../lib/fileUtils.js');
const { applyPeerSyncEvent } = await import('./peerSyncEvents.js');
const { peerSyncBus } = await import('./peerSyncEventBus.js');
const { deleteHistoryItem } = await import('./videoGen/historyOps.js');
const { mutateVideoHistory } = await import('./videoGen/history.js');
const { listMediaTombstones } = await import('./mediaTombstones.js');
const { forgetDeletedMusicVideoAssets } = await import('./musicVideo/mediaPool.js');
const { trashFiles } = await import('../lib/trashFiles.js');

const HISTORY = join(PATHS.data, 'video-history.json');
const PAIR = 's'.repeat(40);
const peer = (id, instanceId, extra = {}) => ({ id, name: id, instanceId, enabled: true, syncSecret: PAIR, syncCategories: { videoHistory: true }, ...extra });
const row = (id, extra = {}) => ({ id, filename: `${id}.mp4`, createdAt: '2026-05-01T00:00:00.000Z', ...extra });
const deleteFrame = (id, origin = 'peer-o') => ({ v: 1, category: 'videoHistory', op: 'delete', id, tombstone: { key: id, deletedAt: '2026-06-01T00:00:00.000Z' }, originInstanceId: origin });
const readRows = async () => readJSONFile(HISTORY, []);
const nextBusEvent = (name) => new Promise((resolve) => peerSyncBus.once(name, resolve));

beforeEach(async () => {
  mkdirSync(PATHS.videos, { recursive: true });
  mkdirSync(PATHS.videoThumbnails, { recursive: true });
  await atomicWrite(HISTORY, []);
  await atomicWrite(join(PATHS.data, 'media-tombstones.json'), { version: 1, video: [], image: [] });
  registry.peers = [peer('rec-origin', 'peer-o'), peer('rec-other', 'peer-x')];
  trashFiles.mockClear();
});

describe('applyPeerSyncEvent', () => {
  it('upsert event adds a row through the shared merge', async () => {
    const result = await applyPeerSyncEvent({ id: 'rec-origin' }, {
      v: 1, category: 'videoHistory', op: 'upsert', id: 'v1',
      record: row('v1', { originInstanceId: 'peer-o', hidden: true, suppliedByInstanceId: 'forged' }),
      originInstanceId: 'peer-o',
    });
    expect(result.applied).toBe(true);
    const [stored] = await readRows();
    expect(stored).toMatchObject({ id: 'v1', originInstanceId: 'peer-o', suppliedByInstanceId: 'peer-o' });
    expect(stored).not.toHaveProperty('hidden');
  });

  it('delete event from origin removes row', async () => {
    await atomicWrite(HISTORY, [row('v1', { originInstanceId: 'peer-o' })]);
    const result = await applyPeerSyncEvent({ id: 'rec-origin' }, deleteFrame('v1'));
    expect(result.applied).toBe(true);
    expect(await readRows()).toEqual([]);
    expect((await listMediaTombstones('video')).map((t) => t.key)).toEqual(['v1']);
  });

  it('delete event from a non-owner peer is ignored', async () => {
    await atomicWrite(HISTORY, [row('v1', { originInstanceId: 'peer-o' })]);
    const result = await applyPeerSyncEvent({ id: 'rec-other' }, deleteFrame('v1', 'peer-x'));
    expect(result.applied).toBe(false);
    expect((await readRows()).map((r) => r.id)).toEqual(['v1']);
    expect(await listMediaTombstones('video')).toEqual([]);
  });

  it('delete event from a peer with media delete turned off is ignored', async () => {
    registry.peers = [peer('rec-origin', 'peer-o', { mediaDeleteAllowed: false })];
    await atomicWrite(HISTORY, [row('v1', { originInstanceId: 'peer-o' })]);
    const result = await applyPeerSyncEvent({ id: 'rec-origin' }, deleteFrame('v1'));
    expect(result.applied).toBe(false);
    expect((await readRows()).map((r) => r.id)).toEqual(['v1']);
  });

  it('delete for a row not held here only records the tombstone', async () => {
    const result = await applyPeerSyncEvent({ id: 'rec-other' }, deleteFrame('ghost', 'peer-x'));
    expect(result.reason).toBe('tombstone-only');
    expect((await listMediaTombstones('video')).map((t) => t.key)).toEqual(['ghost']);
  });

  it('delete for an unknown row is not recorded unless the sender is its origin', async () => {
    const result = await applyPeerSyncEvent({ id: 'rec-other' }, deleteFrame('ghost', 'peer-o'));
    expect(result.applied).toBe(false);
    expect(await listMediaTombstones('video')).toEqual([]);
  });

  it('ignores a future-dated delete even from the origin', async () => {
    await atomicWrite(HISTORY, [row('v1', { originInstanceId: 'peer-o' })]);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    for (const id of ['v1', 'ghost']) {
      const frame = { ...deleteFrame(id), tombstone: { key: id, deletedAt: future } };
      expect((await applyPeerSyncEvent({ id: 'rec-origin' }, frame)).applied).toBe(false);
    }
    expect((await readRows()).map((r) => r.id)).toEqual(['v1']);
    expect(await listMediaTombstones('video')).toEqual([]);
  });

  it('ignores an upsert for a row the sender does not originate', async () => {
    const frame = { v: 1, category: 'videoHistory', op: 'upsert', id: 'v1', record: row('v1'), originInstanceId: 'peer-x' };
    expect((await applyPeerSyncEvent({ id: 'rec-origin' }, frame)).applied).toBe(false);
    expect(await readRows()).toEqual([]);
  });

  // Uniquely catches a merge that lets a sender claim an origin-less row and then delete it.
  it('a newer upsert never gives a held origin-less row the sender\'s origin', async () => {
    await atomicWrite(HISTORY, [row('v1')]);
    const upsert = { v: 1, category: 'videoHistory', op: 'upsert', id: 'v1',
      record: row('v1', { createdAt: '2026-07-01T00:00:00.000Z', prompt: 'example newer' }), originInstanceId: 'peer-o' };
    expect((await applyPeerSyncEvent({ id: 'rec-origin' }, upsert)).applied).toBe(true);
    const [stored] = await readRows();
    expect(stored.prompt).toBe('example newer');
    expect(stored).not.toHaveProperty('originInstanceId');
    expect(stored).not.toHaveProperty('suppliedByInstanceId');
    const frame = { ...deleteFrame('v1'), tombstone: { key: 'v1', deletedAt: '2026-08-01T00:00:00.000Z' } };
    expect((await applyPeerSyncEvent({ id: 'rec-origin' }, frame)).applied).toBe(false);
    expect((await readRows()).map((r) => r.id)).toEqual(['v1']);
    expect(trashFiles).not.toHaveBeenCalled();
  });

  it('malformed frame does not throw', async () => {
    const frames = [null, 'frame', 42, [], {}, { v: 2, category: 'videoHistory', op: 'upsert', id: 'v1', record: row('v1'), originInstanceId: 'peer-o' },
      { ...deleteFrame('v1'), extra: true }, { ...deleteFrame('v1'), tombstone: { key: 'other', deletedAt: '2026-06-01T00:00:00.000Z' } }];
    for (const frame of frames) {
      await expect(applyPeerSyncEvent({ id: 'rec-origin' }, frame)).resolves.toMatchObject({ applied: false });
    }
    await expect(applyPeerSyncEvent({ id: 'rec-missing' }, deleteFrame('v1'))).resolves.toMatchObject({ applied: false });
  });

  it('ignores a peer this install does not sync video history with', async () => {
    registry.peers = [peer('rec-origin', 'peer-o', { syncCategories: { videoHistory: false } })];
    const frame = { v: 1, category: 'videoHistory', op: 'upsert', id: 'v1', record: row('v1'), originInstanceId: 'peer-o' };
    expect((await applyPeerSyncEvent({ id: 'rec-origin' }, frame)).applied).toBe(false);
    expect(await readRows()).toEqual([]);
  });
});

describe('local emission', () => {
  it('a locally added row is announced as an upsert with machine-local fields stripped', async () => {
    const emitted = nextBusEvent('event');
    await mutateVideoHistory((h) => { h.unshift(row('mine', { hidden: true })); return h; });
    const event = await emitted;
    expect(event).toMatchObject({ op: 'upsert', id: 'mine', originInstanceId: 'local-inst' });
    expect(event.record).not.toHaveProperty('hidden');
  });

  it('an owner delete emits its tombstone', async () => {
    await atomicWrite(HISTORY, [row('v1', { originInstanceId: 'local-inst' })]);
    const emitted = nextBusEvent('event');
    await deleteHistoryItem('v1');
    expect(await emitted).toMatchObject({ op: 'delete', id: 'v1', tombstone: { key: 'v1' } });
  });

  it('an owner delete is still announced when the music-video forget fails', async () => {
    await atomicWrite(HISTORY, [row('v1', { originInstanceId: 'local-inst' })]);
    forgetDeletedMusicVideoAssets.mockRejectedValueOnce(new Error('example forget failure'));
    const emitted = nextBusEvent('event');
    await expect(deleteHistoryItem('v1')).resolves.toEqual({ ok: true });
    expect(await emitted).toMatchObject({ op: 'delete', id: 'v1' });
  });

  it('fromRemoteTombstone delete does not emit', async () => {
    await atomicWrite(HISTORY, [row('v1', { originInstanceId: 'local-inst' })]);
    const onEvent = vi.fn();
    peerSyncBus.on('event', onEvent);
    const changed = nextBusEvent('media-history-changed');
    await deleteHistoryItem('v1', { fromRemoteTombstone: true });
    expect(await changed).toMatchObject({ kind: 'video', op: 'delete', ids: ['v1'] });
    await new Promise((resolve) => setImmediate(resolve));
    peerSyncBus.off('event', onEvent);
    expect(onEvent).not.toHaveBeenCalled();
  });
});

afterAll(cleanup);
