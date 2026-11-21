import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const root = mkdtempSync(join(tmpdir(), 'catalog-bytes-'));
const dirs = { images: join(root, 'images'), imageRefs: join(root, 'image-refs'), audio: join(root, 'audio'), videos: join(root, 'videos'), models: join(root, 'models') };
Object.values(dirs).forEach((d) => mkdirSync(d, { recursive: true }));

vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { get images() { return dirs.images; }, get imageRefs() { return dirs.imageRefs; }, get audio() { return dirs.audio; }, get videos() { return dirs.videos; }, get models() { return dirs.models; } },
  resolveImageInputPath: (key) => [dirs.images, dirs.imageRefs].map((d) => join(d, key)).find((p) => existsSyncReal(p)) ?? null,
}));
vi.mock('./catalogDB.js', () => ({ listLiveMediaFileKeys: vi.fn() }));
vi.mock('../sharing/peerSyncAssets.js', () => ({ pullMissingAssetsFromPeer: vi.fn() }));
vi.mock('../peerHostedMedia.js', () => ({ releasedHostedKeys: vi.fn() }));

import { existsSync as existsSyncReal } from 'fs';
import { listLiveMediaFileKeys } from './catalogDB.js';
import { pullMissingAssetsFromPeer } from '../sharing/peerSyncAssets.js';
import { releasedHostedKeys } from '../peerHostedMedia.js';
import { pullMissingCatalogMediaBytes, resetCatalogMediaBytesSyncForTests, CATALOG_BYTES_RETRY_MS } from './catalogMediaBytesSync.js';

const peer = { instanceId: 'peer-a', name: 'Peer A' };
const rows = [
  { mediaKey: 'upload-1.png', kind: 'reference' },
  { mediaKey: 'have.png', kind: 'portrait' },
  { mediaKey: 'memo.webm', kind: 'audio' },
];

describe('pullMissingCatalogMediaBytes', () => {
  beforeEach(() => {
    resetCatalogMediaBytesSyncForTests();
    vi.clearAllMocks();
    Object.values(dirs).forEach((d) => { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); });
    writeFileSync(join(dirs.images, 'have.png'), 'x');
    listLiveMediaFileKeys.mockResolvedValue(rows);
    pullMissingAssetsFromPeer.mockResolvedValue(undefined);
    releasedHostedKeys.mockResolvedValue(new Set());
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('pulls only the files the catalog names that are absent locally', async () => {
    const remaining = await pullMissingCatalogMediaBytes(peer, { applied: 1 });
    const firstPull = pullMissingAssetsFromPeer.mock.calls[0];
    expect(firstPull[0]).toBe('peer-a');
    expect(firstPull[1].map((e) => `${e.kind}:${e.filename}`).sort()).toEqual(['audio:memo.webm', 'image:upload-1.png']);
    // The gallery pull left the image missing, so image-refs is asked next.
    expect(pullMissingAssetsFromPeer.mock.calls[1][1].map((e) => `${e.kind}:${e.filename}`)).toEqual(['image-ref:upload-1.png']);
    expect(remaining).toBe(2);
  });

  it('leaves a file released to a Make-primary host on that host', async () => {
    listLiveMediaFileKeys.mockResolvedValue([...rows, { mediaKey: 'clip.mp4', kind: 'video' }]);
    releasedHostedKeys.mockResolvedValue(new Set(['image:upload-1.png', 'video:clip.mp4']));
    const remaining = await pullMissingCatalogMediaBytes(peer, { applied: 1 });
    expect(pullMissingAssetsFromPeer.mock.calls.flatMap((call) => call[1]).map((e) => `${e.kind}:${e.filename}`)).toEqual(['audio:memo.webm']);
    expect(remaining).toBe(1);
  });

  it('stops asking once the files landed', async () => {
    pullMissingAssetsFromPeer.mockImplementation(async (_id, entries) => {
      for (const e of entries) writeFileSync(join(e.kind === 'audio' ? dirs.audio : dirs.images, e.filename), 'x');
    });
    expect(await pullMissingCatalogMediaBytes(peer, { applied: 1 })).toBe(0);
    expect(pullMissingAssetsFromPeer).toHaveBeenCalledTimes(1);
  });

  it('does not re-ask for a file the peer could not supply until the retry window passes', async () => {
    const t0 = 1_000_000;
    await pullMissingCatalogMediaBytes(peer, { applied: 1, now: t0 });
    pullMissingAssetsFromPeer.mockClear();
    await pullMissingCatalogMediaBytes(peer, { applied: 1, now: t0 + 1000 });
    expect(pullMissingAssetsFromPeer).not.toHaveBeenCalled();
    await pullMissingCatalogMediaBytes(peer, { applied: 1, now: t0 + CATALOG_BYTES_RETRY_MS });
    expect(pullMissingAssetsFromPeer).toHaveBeenCalled();
  });

  it('skips a quiet sweep inside the interval but runs one right after applied rows', async () => {
    await pullMissingCatalogMediaBytes(peer, { applied: 0, now: 5_000_000 });
    listLiveMediaFileKeys.mockClear();
    expect(await pullMissingCatalogMediaBytes(peer, { applied: 0, now: 5_000_100 })).toBeNull();
    expect(listLiveMediaFileKeys).not.toHaveBeenCalled();
    await pullMissingCatalogMediaBytes(peer, { applied: 3, now: 5_000_200 });
    expect(listLiveMediaFileKeys).toHaveBeenCalled();
  });

  it('never throws when the catalog read fails', async () => {
    listLiveMediaFileKeys.mockRejectedValue(new Error('db down'));
    expect(await pullMissingCatalogMediaBytes(peer, { applied: 1 })).toBeNull();
  });
});
