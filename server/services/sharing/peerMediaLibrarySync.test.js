import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

let tempRoot;
vi.mock('../../lib/fileUtils.js', async importOriginal => makePathsProxy(await importOriginal(), { dataRoot: () => tempRoot }));
vi.mock('../../lib/paths.js', async importOriginal => makePathsProxy(await importOriginal(), { dataRoot: () => tempRoot }));
vi.mock('../instances.js', () => ({ getPeers: vi.fn(async () => []) }));
vi.mock('../../lib/peerHttpClient.js', async importOriginal => ({ ...(await importOriginal()), peerFetch: vi.fn() }));
vi.mock('./peerSyncAssets.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, diffAssetManifestAgainstLocal: vi.fn(actual.diffAssetManifestAgainstLocal) };
});
vi.mock('../../lib/databaseMaintenanceJournal.js', async importOriginal => ({ ...(await importOriginal()), assertDatabaseAdmission: () => {} }));

const indexAdapter = vi.hoisted(() => ({ reconcile: vi.fn(), indexImage: vi.fn() }));
vi.mock('../mediaAssetIndex/index.js', () => ({ reconcileMediaAssets: indexAdapter.reconcile, indexImage: indexAdapter.indexImage }));

// Load after the temp redirect exists; no production peers, files or DB are used.
tempRoot = createTempDataRoot('portos-library-repair-');
const { PORTOS_SCHEMA_VERSIONS } = await import('../../lib/schemaVersions.js');
const { PATHS } = await import('../../lib/fileUtils.js');
const { getPeers } = await import('../instances.js');
const { peerFetch } = await import('../../lib/peerHttpClient.js');
const { syncMediaLibraryFromPeer } = await import('./peerMediaLibrarySync.js');
const { diffAssetManifestAgainstLocal } = await import('./peerSyncAssets.js');
const { acquireBackupSnapshotCut } = await import('../../lib/backupSnapshotBoundary.js');

const rows = new Map();
const bytes = Buffer.from('synthetic-peer-image');
let sequence = 0;
const peer = () => ({ instanceId: `repair-peer-${++sequence}`, address: '192.0.2.10', port: 5555, fullSync: true });
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
async function repairIndex() {
  for (const filename of await readdir(PATHS.images)) {
    if (filename.endsWith('.png')) rows.set(filename, await readFile(join(PATHS.images, filename)));
  }
  return { ok: true, skippedPrune: [] };
}
function advertise(peers, filenames = ['repair.png']) {
  vi.mocked(getPeers).mockResolvedValue(peers);
  const manifest = {
    schemaVersion: PORTOS_SCHEMA_VERSIONS.mediaLibrary, manifestHash: 'a'.repeat(64),
    assets: filenames.map(filename => ({ kind: 'image', filename, sha256: createHash('sha256').update(bytes).digest('hex') })),
  };
  vi.mocked(peerFetch).mockImplementation(async url => {
    if (String(url).endsWith('/library-manifest')) return { ok: true, json: async () => manifest };
    if (String(url).endsWith('.png')) return { ok: true, headers: new Headers({ 'content-length': String(bytes.length) }), arrayBuffer: async () => bytes };
    return { ok: false }; // no optional metadata sidecar
  });
}
const imageDownloads = () => vi.mocked(peerFetch).mock.calls.filter(([url]) => String(url).endsWith('.png')).length;

beforeEach(async () => {
  rows.clear();
  await mkdir(PATHS.images, { recursive: true });
  vi.mocked(peerFetch).mockReset();
  vi.mocked(diffAssetManifestAgainstLocal).mockClear();
  indexAdapter.indexImage.mockReset().mockRejectedValue(new Error('synthetic publication index outage'));
  indexAdapter.reconcile.mockReset().mockImplementation(repairIndex);
  vi.doMock('../mediaAssetIndex/index.js', () => ({ reconcileMediaAssets: indexAdapter.reconcile, indexImage: indexAdapter.indexImage }));
});
afterEach(async () => {
  await rm(PATHS.images, { recursive: true, force: true });
});
afterAll(async () => { await rm(tempRoot, { recursive: true, force: true }); });

describe('peer library index recovery', () => {
  it.each(['write rejection', 'incomplete authoritative read'])('repairs landed images on the identical next sweep after %s, then resumes unchanged shortcuts', async failure => {
    const source = peer();
    advertise([source]);
    if (failure === 'write rejection') indexAdapter.reconcile.mockRejectedValueOnce(new Error('synthetic index write outage'));
    else indexAdapter.reconcile.mockResolvedValueOnce({ ok: true, indexed: 0, skippedPrune: ['images'] });

    expect(await syncMediaLibraryFromPeer(source)).toEqual({ pulled: 1, missing: 0 });
    expect(await readFile(join(PATHS.images, 'repair.png'))).toEqual(bytes);
    expect(rows.size).toBe(0);

    expect(await syncMediaLibraryFromPeer(source)).toEqual({ pulled: 0 });
    expect(rows.get('repair.png')).toEqual(bytes);
    expect(imageDownloads()).toBe(1);
    expect(indexAdapter.reconcile).toHaveBeenCalledTimes(2);
    expect(indexAdapter.reconcile).toHaveBeenLastCalledWith({ requireComplete: true });
    for (let tick = 0; tick < 3; tick++) expect((await syncMediaLibraryFromPeer(source)).skipped).toBe('unchanged');
    expect(indexAdapter.reconcile).toHaveBeenCalledTimes(2);
  });

  it('recovers when the index module cannot load, without losing pending repair or downloading again', async () => {
    const source = peer();
    advertise([source]);
    vi.doMock('../mediaAssetIndex/index.js', () => { throw new Error('synthetic unavailable index module'); });
    expect(await syncMediaLibraryFromPeer(source)).toEqual({ pulled: 1, missing: 0 });
    expect(rows.size).toBe(0);
    vi.doMock('../mediaAssetIndex/index.js', () => ({ reconcileMediaAssets: indexAdapter.reconcile, indexImage: indexAdapter.indexImage }));
    expect(await syncMediaLibraryFromPeer(source)).toEqual({ pulled: 0 });
    expect(rows.get('repair.png')).toEqual(bytes);
    expect(imageDownloads()).toBe(1);
    expect((await syncMediaLibraryFromPeer(source)).skipped).toBe('unchanged');
  });

  it('waits for backup admission before repairing already landed bytes', async () => {
    const source = peer();
    advertise([source]);
    indexAdapter.reconcile.mockRejectedValueOnce(new Error('synthetic outage'));
    await syncMediaLibraryFromPeer(source);
    const release = await acquireBackupSnapshotCut();
    let retry;
    try {
      retry = syncMediaLibraryFromPeer(source);
      await vi.waitFor(() => expect(peerFetch).toHaveBeenCalledTimes(4));
      // Drain the request/import continuation; its index write is awaiting the cut.
      await new Promise(resolve => setImmediate(resolve));
      expect(indexAdapter.reconcile).toHaveBeenCalledTimes(1);
      expect(rows.size).toBe(0);
    } finally { release(); }
    await retry;
    expect(rows.get('repair.png')).toEqual(bytes);
    expect(indexAdapter.reconcile).toHaveBeenCalledTimes(2);
    expect(imageDownloads()).toBe(1);
  });

  it('queues a fresh repair for bytes that land after an active repair read disk', async () => {
    const sources = [peer(), peer()];
    advertise(sources, ['repair-before.png']);
    const readFinished = deferred();
    const finishFirst = deferred();
    indexAdapter.reconcile.mockImplementationOnce(async () => {
      const result = await repairIndex();
      readFinished.resolve();
      await finishFirst.promise;
      return result;
    });
    const first = syncMediaLibraryFromPeer(sources[0]);
    await readFinished.promise;
    advertise(sources, ['repair-after.png']);
    const second = syncMediaLibraryFromPeer(sources[1]);
    await vi.waitFor(() => expect(vi.mocked(diffAssetManifestAgainstLocal).mock.settledResults.filter(result => result.type === 'fulfilled')).toHaveLength(4));
    await new Promise(resolve => setImmediate(resolve));
    expect(rows.has('repair-after.png')).toBe(false);
    finishFirst.resolve();
    await Promise.all([first, second]);
    expect(rows.get('repair-after.png')).toEqual(bytes);
    expect(indexAdapter.reconcile).toHaveBeenCalledTimes(2);
    expect((await syncMediaLibraryFromPeer(sources[1])).skipped).toBe('unchanged');
  });

  it('serializes active repairs and coalesces queued peers while retaining failure-to-retry state', async () => {
    const sources = [peer(), peer(), peer()];
    // Distinct files ensure each peer has landed bytes and owns a pending repair.
    indexAdapter.reconcile.mockRejectedValue(new Error('synthetic outage'));
    for (let i = 0; i < sources.length; i++) {
      advertise(sources, [`repair-${i}.png`]);
      await syncMediaLibraryFromPeer(sources[i]);
    }
    advertise(sources, ['repair-0.png', 'repair-1.png', 'repair-2.png']);
    const firstStarted = deferred();
    const firstRelease = deferred();
    indexAdapter.reconcile.mockReset().mockImplementationOnce(async () => {
      firstStarted.resolve();
      await firstRelease.promise;
      return repairIndex();
    }).mockImplementation(repairIndex);
    const first = syncMediaLibraryFromPeer(sources[0]);
    await firstStarted.promise;
    const queued = sources.slice(1).map(syncMediaLibraryFromPeer);
    await vi.waitFor(() => expect(vi.mocked(diffAssetManifestAgainstLocal).mock.settledResults.filter(result => result.type === 'fulfilled')).toHaveLength(9));
    await new Promise(resolve => setImmediate(resolve));
    expect(indexAdapter.reconcile).toHaveBeenCalledTimes(1);
    firstRelease.resolve();
    await Promise.all([first, ...queued]);
    expect(indexAdapter.reconcile).toHaveBeenCalledTimes(2);
    expect([...rows.keys()].sort()).toEqual(['repair-0.png', 'repair-1.png', 'repair-2.png']);
    expect(imageDownloads()).toBe(3);
    for (const source of sources) expect((await syncMediaLibraryFromPeer(source)).skipped).toBe('unchanged');
  });
});
