import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-datasync-vtomb-' });

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});
vi.mock('./instances.js', async () => {
  const actual = await vi.importActual('./instances.js');
  return { ...actual, getPeers: async () => [] };
});
vi.mock('./mediaAssetIndex/index.js', () => ({ unindexVideo: async () => {} }));
vi.mock('./musicVideo/mediaPool.js', () => ({ forgetDeletedMusicVideoAssets: async () => {} }));
vi.mock('../lib/trashFiles.js', () => ({ trashFiles: vi.fn(async () => {}) }));

const { PATHS, readJSONFile, atomicWrite } = await import('../lib/fileUtils.js');
const dataSync = await import('./dataSync.js');
const { deleteHistoryItem } = await import('./videoGen/historyOps.js');
const { listMediaTombstones, recordMediaTombstone } = await import('./mediaTombstones.js');
const { trashFiles } = await import('../lib/trashFiles.js');

const HISTORY = join(PATHS.data, 'video-history.json');
const row = (id, createdAt = '2026-05-01T00:00:00.000Z') => ({ id, filename: `${id}.mp4`, createdAt });
const readHistory = async () => (await readJSONFile(HISTORY, [])).map((r) => r.id).sort();

beforeEach(async () => {
  mkdirSync(PATHS.videos, { recursive: true });
  mkdirSync(PATHS.videoThumbnails, { recursive: true });
  await atomicWrite(HISTORY, []);
  await atomicWrite(join(PATHS.data, 'media-tombstones.json'), { version: 1, video: [], image: [] });
  trashFiles.mockClear();
});

describe('video delete durability', () => {
  it('deleting a video records a tombstone', async () => {
    await atomicWrite(HISTORY, [row('v1')]);
    await deleteHistoryItem('v1');
    expect((await listMediaTombstones('video')).map((t) => t.key)).toEqual(['v1']);
    expect(await readHistory()).toEqual([]);
  });

  it('fromRemoteTombstone does not re-record the tombstone', async () => {
    await atomicWrite(HISTORY, [row('v1')]);
    await deleteHistoryItem('v1', { fromRemoteTombstone: true });
    expect(await listMediaTombstones('video')).toEqual([]);
  });

  it('snapshot from a peer with a tombstone removes the local row and files', async () => {
    await atomicWrite(HISTORY, [row('v1'), row('v2')]);
    const result = await dataSync.applyRemote('videoHistory', {
      videos: [],
      tombstones: [{ key: 'v1', deletedAt: '2026-06-01T00:00:00.000Z' }],
    }, { peerId: 'peer-a' });
    expect(await readHistory()).toEqual(['v2']);
    expect(trashFiles).toHaveBeenCalled();
    expect(trashFiles.mock.calls[0][0].some((f) => f.endsWith('v1.mp4'))).toBe(true);
    expect((await listMediaTombstones('video')).map((t) => t.key)).toEqual(['v1']);
    expect(result.applied).toBe(true);
  });

  it('peer snapshot without the tombstone does not resurrect a deleted row', async () => {
    await atomicWrite(HISTORY, [row('v1')]);
    await deleteHistoryItem('v1');
    await dataSync.applyRemote('videoHistory', { videos: [row('v1'), row('v3')] }, { peerId: 'peer-a' });
    expect(await readHistory()).toEqual(['v3']);
  });

  it('re-created row with newer createdAt survives its tombstone', async () => {
    await recordMediaTombstone('video', 'v1', '2026-06-01T00:00:00.000Z');
    await dataSync.applyRemote('videoHistory', {
      videos: [row('v1', '2026-07-01T00:00:00.000Z'), row('v2', '2026-05-01T00:00:00.000Z')],
    }, { peerId: 'peer-a' });
    expect(await readHistory()).toEqual(['v1', 'v2']);
  });

  it('checksum is stable across tombstone insertion order', async () => {
    const a = '2026-06-01T00:00:00.000Z';
    const b = '2026-06-02T00:00:00.000Z';
    const file = join(PATHS.data, 'media-tombstones.json');
    await atomicWrite(file, { version: 1, video: [{ key: 'a', deletedAt: a }, { key: 'b', deletedAt: b }], image: [] });
    const first = await dataSync.getSnapshot('videoHistory');
    await atomicWrite(file, { version: 1, video: [{ key: 'b', deletedAt: b }, { key: 'a', deletedAt: a }], image: [] });
    const second = await dataSync.getSnapshot('videoHistory');
    expect(first.checksum).toBe(second.checksum);
    expect(first.data.tombstones.map((t) => t.key)).toEqual(['a', 'b']);
  });

  it('omits tombstones from the snapshot when there are none', async () => {
    const snap = await dataSync.getSnapshot('videoHistory');
    expect(snap.data).not.toHaveProperty('tombstones');
  });
});

afterAll(cleanup);
