import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { Readable } from 'stream';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-datasync-vhosted-' });
vi.mock('../lib/fileUtils.js', async () => makeProxy(await vi.importActual('../lib/fileUtils.js')));
const peers = vi.hoisted(() => ({ list: [] }));
vi.mock('./instances.js', async () => ({
  ...(await vi.importActual('./instances.js')),
  getPeers: async () => peers.list,
}));

const streamPeer = vi.hoisted(() => vi.fn());
const fetchPeer = vi.hoisted(() => vi.fn());
vi.mock('../lib/peerHttpClient.js', async (importOriginal) => ({
  ...(await importOriginal()),
  peerStreamRequest: streamPeer,
  peerFetch: fetchPeer,
}));
vi.mock('../lib/ffmpeg.js', async (importOriginal) => ({
  ...(await importOriginal()),
  generateThumbnail: vi.fn().mockResolvedValue(null),
}));

const dataSync = await import('./dataSync.js');
const { markHosted, resolveMediaLocations, hostedAssetFallback, listHostedEntries } = await import('./peerHostedMedia.js');
const { PATHS } = await import('../lib/fileUtils.js');
const { buildCollectionAssetManifest, buildAssetManifestWithCollection, buildAssetManifestForSeries } = await import('./sharing/peerSyncAssets.js');
const row = { id: 'v1', filename: 'v1.mp4', createdAt: '2026-05-22T00:00:00Z' };
const location = async () => (await resolveMediaLocations([{ kind: 'video', ref: 'v1.mp4' }]))[0];
const inventory = (peerId, filenames, portosMeta) => dataSync.applyRemote('videoHistory', { version: 1, filenames, checked: ['v1.mp4'] }, { peerId, inventory: true, portosMeta });
const imported = { ...row, id: 'imported-id', filename: 'imported.webm' };
const importedCollection = {
  id: 'imported-clips', name: 'Imported clips',
  createdAt: row.createdAt, updatedAt: row.createdAt,
  items: [{ kind: 'video', ref: imported.id, addedAt: row.createdAt }],
};
const importedLocation = async () => (await resolveMediaLocations(importedCollection.items))[0];
const syncImportedCollection = () => dataSync.applyRemote('mediaCollections', { collections: [importedCollection] }, { peerId: 'a' });
const syncImportedHistory = () => dataSync.applyRemote('videoHistory', { videos: [imported] }, { peerId: 'a' });
const importedInventory = (category) => {
  const filenames = [imported.filename, 'unrelated.webm'];
  return dataSync.applyRemote(category, { version: 1, filenames, checked: filenames }, { peerId: 'a', inventory: true });
};

describe('video history peer ownership', () => {
  beforeEach(() => {
    rmSync(join(PATHS.data, 'peer-hosted-media.json'), { force: true });
    rmSync(join(PATHS.data, 'video-history.json'), { force: true });
    rmSync(join(PATHS.videos, 'v1.mp4'), { force: true });
    rmSync(join(PATHS.videos, imported.filename), { force: true });
    fetchPeer.mockReset();
    peers.list = ['a', 'b', 'c'].map(instanceId => ({
      instanceId, mediaSyncMode: 'host', host: `${instanceId}.example.com`, port: 5555,
      syncCategories: { mediaCollections: true },
    }));
  });

  it('does not treat relayed history as ownership and repairs it on unchanged history', async () => {
    await markHosted('b', [{ kind: 'video', filename: 'v1.mp4' }]);
    await dataSync.applyRemote('videoHistory', { videos: [row] }, { peerId: 'a' });
    expect(await location()).toMatchObject({ location: 'remote', hostPeerId: 'b' });
    streamPeer.mockImplementation(async (_url, _options, peer) => ({
      status: peer.instanceId === 'b' ? 200 : 404,
      headers: { 'content-type': 'video/mp4' },
      stream: Readable.from([Buffer.from('owner bytes')]),
    }));
    const app = express();
    app.use('/data/videos', hostedAssetFallback('/data/videos'));
    const response = await request(app).get('/data/videos/v1.mp4');
    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe('owner bytes');
    expect(streamPeer.mock.calls.at(-1)[2].instanceId).toBe('b');
    await inventory('a', []);
    expect(await location()).toMatchObject({ location: 'remote', hostPeerId: 'b' });
    await markHosted('a', [{ kind: 'video', filename: 'v1.mp4' }]); // old incorrect index
    await inventory('b', ['v1.mp4']);
    expect(await location()).toMatchObject({ location: 'remote', hostPeerId: 'b' });
    await inventory('a', []); // an old non-owner cannot remove b's entry
    expect(await location()).toMatchObject({ location: 'remote', hostPeerId: 'b' });
    await inventory('b', []); // authoritative deletion
    expect(await location()).toEqual({ location: 'missing' });
  });

  it('retains a confirmed alternate and switches to it when the first host deletes the file', async () => {
    await dataSync.applyRemote('videoHistory', { videos: [row] }, { peerId: 'a' });
    await inventory('b', ['v1.mp4']);
    await inventory('c', ['v1.mp4']);
    expect(await location()).toMatchObject({ hostPeerId: 'b' });
    await inventory('b', []);
    expect(await location()).toMatchObject({ hostPeerId: 'c' });
    await inventory('c', []);
    expect(await location()).toEqual({ location: 'missing' });
  });

  it('prioritizes new evidence while retaining a legacy host as fallback', async () => {
    await dataSync.applyRemote('videoHistory', { videos: [row] });
    writeFileSync(join(PATHS.data, 'peer-hosted-media.json'), JSON.stringify({ version: 1, entries: { 'video:v1.mp4': { peerId: 'a', at: 'old' } } }));
    await inventory('b', ['v1.mp4']);
    expect(await location()).toMatchObject({ hostPeerId: 'b' });
    await inventory('b', []);
    expect(await location()).toMatchObject({ hostPeerId: 'a' });
  });

  it('reconciles collection-only video ownership through the collection category', async () => {
    const collection = { id: 'collection-only', name: 'Clips', items: [{ kind: 'video', ref: 'v1', addedAt: '2026-05-22T00:00:00Z' }], createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T00:00:00Z' };
    await dataSync.applyRemote('mediaCollections', { collections: [collection] }, { peerId: 'a' });
    expect(await location()).toEqual({ location: 'missing' });
    const result = await dataSync.getHostedMediaInventory('mediaCollections');
    expect(result.checked).toContain('v1.mp4');
    await dataSync.applyRemote('mediaCollections', { version: 1, filenames: ['v1.mp4'], checked: ['v1.mp4'] }, { peerId: 'b', inventory: true });
    expect(await location()).toMatchObject({ hostPeerId: 'b' });
  });

  it('ignores malformed, disabled and copy-mode inventories and preserves local bytes', async () => {
    await dataSync.applyRemote('videoHistory', { videos: [row] }, { peerId: 'a' });
    await inventory('b', ['v1.mp4']);
    await inventory('b', ['../bad']);
    expect(await location()).toMatchObject({ hostPeerId: 'b' });
    peers.list[1].enabled = false;
    await inventory('b', []);
    peers.list[1].enabled = true;
    peers.list[1].mediaSyncMode = 'copy';
    await inventory('b', []);
    expect(await location()).toMatchObject({ hostPeerId: 'b' });
    mkdirSync(PATHS.videos, { recursive: true });
    writeFileSync(join(PATHS.videos, 'v1.mp4'), 'local');
    expect(await location()).toEqual({ location: 'local' });
  });

  it('publishes only history files physically present on this peer', async () => {
    writeFileSync(join(PATHS.data, 'video-history.json'), JSON.stringify([row, { filename: 'local-only.mp4' }]));
    expect(await dataSync.getHostedMediaInventory()).toMatchObject({ filenames: [], checked: ['v1.mp4'] });
    mkdirSync(PATHS.videos, { recursive: true });
    writeFileSync(join(PATHS.videos, 'v1.mp4'), 'local');
    expect((await dataSync.getHostedMediaInventory()).filenames).toEqual(['v1.mp4']);
  });

  it('publishes the history filename in standalone and bundled collection manifests and inventory', async () => {
    await syncImportedCollection();
    expect((await dataSync.getHostedMediaInventory('mediaCollections')).checked).toContain('imported-id.mp4');
    await syncImportedHistory();
    expect((await dataSync.getHostedMediaInventory('mediaCollections')).filenames).not.toContain(imported.filename);
    mkdirSync(PATHS.videos, { recursive: true });
    writeFileSync(join(PATHS.videos, imported.filename), 'local');
    for (const manifest of [
      await buildCollectionAssetManifest(importedCollection),
      await buildAssetManifestWithCollection({}, importedCollection),
      await buildAssetManifestForSeries({}, [], importedCollection),
    ]) {
      expect(manifest).toEqual([{ kind: 'video', filename: imported.filename, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    }
    expect((await dataSync.getHostedMediaInventory('mediaCollections')).filenames).toContain(imported.filename);
    expect(await importedLocation()).toEqual({ location: 'local' });
  });

  it.each(['history first', 'inventory first'])('hosts record-owned video with %s', async (order) => {
    await syncImportedCollection();
    if (order === 'history first') {
      await syncImportedHistory();
    } else {
      await importedInventory('mediaCollections');
      expect(await listHostedEntries()).not.toHaveProperty(`video:${imported.filename}`);
      await syncImportedHistory();
    }
    expect(await importedLocation()).toEqual({ location: 'missing' });
    await importedInventory('mediaCollections');
    expect(await importedLocation()).toMatchObject({ location: 'remote', hostPeerId: 'a' });
    expect(await listHostedEntries()).not.toHaveProperty('video:unrelated.webm');
    expect(fetchPeer).not.toHaveBeenCalled();
  });

  it.each(['history first', 'inventory first'])('recovers a missing video copy with %s using the legacy history inventory', async (order) => {
    peers.list[0].mediaSyncMode = 'copy';
    fetchPeer.mockImplementation(async () => new Response('video bytes', { headers: { 'content-length': '11' } }));
    await syncImportedCollection();
    if (order === 'history first') {
      await syncImportedHistory();
    } else {
      await importedInventory('videoHistory');
      expect(fetchPeer).not.toHaveBeenCalled();
      await syncImportedHistory();
    }
    expect(await importedLocation()).toEqual({ location: 'missing' });
    const receipt = await importedInventory('videoHistory');
    expect(receipt).toEqual({ applied: false, count: 0 });
    await vi.waitFor(async () => expect(await importedLocation()).toEqual({ location: 'local' }));
    expect(fetchPeer).toHaveBeenCalledTimes(1);
    expect(fetchPeer.mock.calls[0][0]).toMatch(/\/data\/videos\/imported\.webm$/);
  });
});
afterAll(cleanup);
