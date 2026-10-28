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
vi.mock('../lib/peerHttpClient.js', () => ({ peerStreamRequest: streamPeer }));

const dataSync = await import('./dataSync.js');
const { markHosted, resolveMediaLocations, hostedAssetFallback } = await import('./peerHostedMedia.js');
const { PATHS } = await import('../lib/fileUtils.js');
const row = { id: 'v1', filename: 'v1.mp4', createdAt: '2026-05-22T00:00:00Z' };
const location = async () => (await resolveMediaLocations([{ kind: 'video', ref: 'v1.mp4' }]))[0];
const inventory = (peerId, filenames, portosMeta) => dataSync.applyRemote('videoHistory', { version: 1, filenames, checked: ['v1.mp4'] }, { peerId, inventory: true, portosMeta });

describe('video history peer ownership', () => {
  beforeEach(() => {
    rmSync(join(PATHS.data, 'peer-hosted-media.json'), { force: true });
    rmSync(join(PATHS.data, 'video-history.json'), { force: true });
    rmSync(join(PATHS.videos, 'v1.mp4'), { force: true });
    peers.list = ['a', 'b', 'c'].map(instanceId => ({ instanceId, mediaSyncMode: 'host' }));
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
    await dataSync.applyRemote('videoHistory', { videos: [row] }, { peerId: 'a' });
    expect((await dataSync.getVideoHistoryInventory()).filenames).toEqual([]);
    mkdirSync(PATHS.videos, { recursive: true });
    writeFileSync(join(PATHS.videos, 'v1.mp4'), 'local');
    expect((await dataSync.getVideoHistoryInventory()).filenames).toEqual(['v1.mp4']);
  });
});
afterAll(cleanup);
