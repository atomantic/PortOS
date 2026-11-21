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
vi.mock('../peerHostedMedia.js', () => ({
  releasedHostedKeys: vi.fn(), hostedKeysOf: vi.fn(), markHosted: vi.fn(), peerServesFile: vi.fn(),
  hostedKey: (kind, filename) => `${kind}:${filename}`,
}));

import { existsSync as existsSyncReal } from 'fs';
import { listLiveMediaFileKeys } from './catalogDB.js';
import { pullMissingAssetsFromPeer } from '../sharing/peerSyncAssets.js';
import { releasedHostedKeys, hostedKeysOf, markHosted, peerServesFile } from '../peerHostedMedia.js';
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
    hostedKeysOf.mockResolvedValue(new Set());
    markHosted.mockResolvedValue(0);
    peerServesFile.mockResolvedValue('held');
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
    expect(peerServesFile).not.toHaveBeenCalled();
    expect(markHosted).not.toHaveBeenCalled();
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

  describe('from a host-mode peer', () => {
    const hostPeer = { ...peer, mediaSyncMode: 'host' };
    const hostRows = [...rows, { mediaKey: 'ship.glb', kind: 'model' }, { mediaKey: 'clip.mp4', kind: 'video' }];
    const marked = () => markHosted.mock.calls.flatMap((call) => call[1]).map((e) => `${e.kind}:${e.filename}`).sort();

    it('records each file the peer serves as hosted and copies none of them', async () => {
      listLiveMediaFileKeys.mockResolvedValue(hostRows);
      // The reference is an upload: the peer has no gallery copy, only image-refs.
      peerServesFile.mockImplementation(async (_peer, kind, filename) => (filename === 'upload-1.png' && kind === 'image' ? 'not-held' : 'held'));
      expect(await pullMissingCatalogMediaBytes(hostPeer, { applied: 1 })).toBe(0);
      expect(pullMissingAssetsFromPeer).not.toHaveBeenCalled();
      expect(markHosted.mock.calls[0][0]).toBe('peer-a');
      expect(marked()).toEqual(['audio:memo.webm', 'image-ref:upload-1.png', 'model:ship.glb', 'video:clip.mp4']);
      // The local file is never probed; the upload is asked for as a gallery file first.
      const probes = peerServesFile.mock.calls.map(([, kind, filename]) => `${kind}:${filename}`);
      expect(probes).not.toContain('image:have.png');
      expect(probes.indexOf('image:upload-1.png')).toBeLessThan(probes.indexOf('image-ref:upload-1.png'));
    });

    it('does not probe a file this peer is already recorded as hosting', async () => {
      hostedKeysOf.mockResolvedValue(new Set(['image-ref:upload-1.png', 'audio:memo.webm']));
      expect(await pullMissingCatalogMediaBytes(hostPeer, { applied: 1 })).toBe(0);
      expect(hostedKeysOf).toHaveBeenCalledWith('peer-a');
      expect(peerServesFile).not.toHaveBeenCalled();
      expect(pullMissingAssetsFromPeer).not.toHaveBeenCalled();
    });

    it('leaves a file released to a Make-primary host alone', async () => {
      releasedHostedKeys.mockResolvedValue(new Set(['image:upload-1.png']));
      expect(await pullMissingCatalogMediaBytes(hostPeer, { applied: 1 })).toBe(0);
      expect(marked()).toEqual(['audio:memo.webm']);
    });

    it('counts a file the peer does not serve as missing, re-probes it only after the retry window, and still copies it in copy mode', async () => {
      const t0 = 9_000_000;
      peerServesFile.mockImplementation(async (_peer, kind) => (kind === 'audio' ? 'unreachable' : 'not-held'));
      expect(await pullMissingCatalogMediaBytes(hostPeer, { applied: 1, now: t0 })).toBe(2);
      // Unreachable stops at the first kind; not-held tries both image locations.
      expect(peerServesFile).toHaveBeenCalledTimes(3);
      expect(pullMissingAssetsFromPeer).not.toHaveBeenCalled();
      peerServesFile.mockClear();
      expect(await pullMissingCatalogMediaBytes(hostPeer, { applied: 1, now: t0 + 1000 })).toBe(2);
      expect(peerServesFile).not.toHaveBeenCalled();
      // A failed probe never holds back a copy-mode pull of the same file.
      await pullMissingCatalogMediaBytes(peer, { applied: 1, now: t0 + 2000 });
      expect(pullMissingAssetsFromPeer).toHaveBeenCalled();
      await pullMissingCatalogMediaBytes(hostPeer, { applied: 1, now: t0 + CATALOG_BYTES_RETRY_MS });
      expect(peerServesFile).toHaveBeenCalled();
    });
  });

  it('never throws when the catalog read fails', async () => {
    listLiveMediaFileKeys.mockRejectedValue(new Error('db down'));
    expect(await pullMissingCatalogMediaBytes(peer, { applied: 1 })).toBeNull();
  });
});
