import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { Readable } from 'stream';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-collection-hosted-' });
vi.mock('../lib/fileUtils.js', async () => makeProxy(await vi.importActual('../lib/fileUtils.js')));
const peers = vi.hoisted(() => ({ list: [] }));
vi.mock('./instances.js', async () => ({
  ...(await vi.importActual('./instances.js')),
  getPeers: async () => peers.list,
}));
const streamPeer = vi.hoisted(() => vi.fn());
vi.mock('../lib/peerHttpClient.js', () => ({ peerStreamRequest: streamPeer }));

const dataSync = await import('./dataSync.js');
const { markHosted, resolveMediaLocations, hostedAssetFallback, __resetPeerCooldown } = await import('./peerHostedMedia.js');
const { PATHS } = await import('../lib/fileUtils.js');
const collection = {
  id: 'shared-art', name: 'Shared art', items: [{ kind: 'image', ref: 'art.png', addedAt: '2026-05-22T00:00:00Z' }],
  createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T00:00:00Z',
};
const location = async () => (await resolveMediaLocations(collection.items))[0];
const inventory = (peerId, filenames, extra = {}) => dataSync.applyRemote('mediaCollections', {
  version: 1, filenames, checked: ['art.png'], ...extra,
}, { peerId, inventory: true, inventoryKind: 'image' });
const upstream = (body, status = 200) => ({ status, headers: { 'content-type': 'image/png' }, stream: Readable.from([Buffer.from(body)]) });
const app = express();
app.use('/data/images', express.static(PATHS.images), hostedAssetFallback('/data/images'));
app.use('/data/image-thumbnails', hostedAssetFallback('/data/image-thumbnails'));

describe('collection image ownership', () => {
  beforeEach(() => {
    rmSync(join(PATHS.data, 'peer-hosted-media.json'), { force: true });
    rmSync(join(PATHS.images, 'art.png'), { force: true });
    peers.list = ['relay', 'owner', 'alternate'].map(instanceId => ({ instanceId, host: `${instanceId}.example.com`, mediaSyncMode: 'host' }));
    streamPeer.mockReset();
    __resetPeerCooldown();
  });

  it('does not turn relayed metadata into a host and streams the actual owner through the receiver', async () => {
    await dataSync.applyRemote('mediaCollections', { collections: [collection] }, { peerId: 'relay' });
    expect(await location()).toEqual({ location: 'missing' });
    await inventory('relay', []);
    await inventory('owner', ['art.png']);
    streamPeer.mockImplementation(async (_url, _options, peer) => upstream(peer.instanceId === 'owner' ? 'OWNER' : '', peer.instanceId === 'owner' ? 200 : 404));
    const response = await request(app).get('/data/images/art.png');
    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe('OWNER');
    expect(streamPeer.mock.calls.map(call => call[2].instanceId)).toEqual(['owner']);
    expect((await request(app).get('/data/image-thumbnails/art.webp')).status).toBe(200);
    expect(streamPeer.mock.calls.at(-1)[0]).toContain('/data/image-thumbnails/art.webp');
  });

  it('repairs old incorrect entries and reconciles deletion without changing collection metadata', async () => {
    await dataSync.applyRemote('mediaCollections', { collections: [collection] });
    const before = await dataSync.getChecksum('mediaCollections');
    writeFileSync(join(PATHS.data, 'peer-hosted-media.json'), JSON.stringify({ version: 1, entries: { 'image:art.png': { peerId: 'relay', at: 'old' } } }));
    await inventory('owner', ['art.png']);
    expect(await location()).toMatchObject({ hostPeerId: 'owner' });
    await inventory('relay', []);
    await inventory('alternate', ['art.png']);
    await inventory('owner', []);
    expect(await location()).toMatchObject({ hostPeerId: 'alternate' });
    await inventory('alternate', []);
    expect(await location()).toEqual({ location: 'missing' });
    expect(await dataSync.getChecksum('mediaCollections')).toEqual(before);
  });

  it('retains offline hosts, tries alternates, and removes only confirmed missing originals', async () => {
    await inventory('owner', ['art.png']);
    await inventory('alternate', ['art.png']);
    streamPeer.mockImplementation(async (_url, _options, peer) => {
      if (peer.instanceId === 'owner') throw new Error('offline');
      return upstream('ALTERNATE');
    });
    expect((await request(app).get('/data/images/art.png')).body.toString()).toBe('ALTERNATE');
    expect(await location()).toMatchObject({ hostPeerId: 'owner' });
    __resetPeerCooldown();
    streamPeer.mockImplementation(async (_url, _options, peer) => upstream('ALTERNATE', peer.instanceId === 'owner' ? 404 : 200));
    expect((await request(app).get('/data/image-thumbnails/art.webp')).status).toBe(200);
    expect(await location()).toMatchObject({ hostPeerId: 'owner' });
    expect((await request(app).get('/data/images/art.png')).status).toBe(200);
    expect(await location()).toMatchObject({ hostPeerId: 'alternate' });
  });

  it('publishes only local files and leaves inventories inconclusive when malformed, disabled or copy mode', async () => {
    await dataSync.applyRemote('mediaCollections', { collections: [collection] });
    await markHosted('owner', [{ kind: 'image', filename: 'art.png' }]);
    expect(await dataSync.getHostedMediaInventory('mediaCollections', 'image')).toMatchObject({ filenames: [], checked: ['art.png'] });
    await inventory('owner', [], { version: 2 });
    await inventory('owner', ['../invalid']);
    peers.list[1].enabled = false;
    await inventory('owner', []);
    peers.list[1].enabled = true;
    peers.list[1].mediaSyncMode = 'copy';
    await inventory('owner', []);
    expect(await location()).toMatchObject({ hostPeerId: 'owner' });
    mkdirSync(PATHS.images, { recursive: true });
    writeFileSync(join(PATHS.images, 'art.png'), 'LOCAL');
    expect(await dataSync.getHostedMediaInventory('mediaCollections', 'image')).toMatchObject({ filenames: ['art.png'], checked: ['art.png'] });
    expect((await request(app).get('/data/images/art.png')).body.toString()).toBe('LOCAL');
    expect(streamPeer).not.toHaveBeenCalled();
    rmSync(join(PATHS.images, 'art.png'));
    expect((await dataSync.getHostedMediaInventory('mediaCollections', 'image')).filenames).toEqual([]);
  });
});
afterAll(cleanup);
