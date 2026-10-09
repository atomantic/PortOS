/**
 * Host-mode media: the index, the location resolver, and the static-mount
 * fallback that renders a peer-hosted file through an unchanged local URL.
 * Real files under a temp data root; only the peer transport is faked.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { Readable } from 'stream';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { request } from '../lib/testHelper.js';
import { createTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const tempRoot = createTempDataRoot('portos-peer-hosted-media-');
vi.mock('../lib/fileUtils.js', async (importOriginal) => (
  makePathsProxy(await importOriginal(), { dataRoot: tempRoot })
));
afterAll(() => rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const PEER = { id: 'p1', instanceId: 'peer-instance-1', name: 'Studio Mac', host: 'peer.example.com', port: 5555 };
const getPeers = vi.fn(async () => [PEER]);
vi.mock('./instances.js', () => ({ getPeers: (...args) => getPeers(...args) }));

const streamRequest = vi.fn();
vi.mock('../lib/peerHttpClient.js', () => ({ peerStreamRequest: (...args) => streamRequest(...args) }));

const { markHosted, unmarkHosted, takeHostedAssets, resolveMediaLocations } = await import('./peerHostedMedia.js');
const { mountAssetRoutes } = await import('./assetMounts.js');

let app;
beforeAll(() => {
  mkdirSync(join(tempRoot, 'images'), { recursive: true });
  mkdirSync(join(tempRoot, 'videos'), { recursive: true });
  writeFileSync(join(tempRoot, 'images', 'local.png'), 'LOCALBYTES');
  app = express();
  mountAssetRoutes(app);
});

beforeEach(async () => {
  streamRequest.mockReset();
  getPeers.mockImplementation(async () => [PEER]);
  rmSync(join(tempRoot, 'peer-hosted-media.json'), { force: true });
});

const upstream = (body, status = 200, headers = {}) => ({
  status,
  headers: { 'content-type': 'image/png', 'content-length': String(body.length), ...headers },
  stream: Readable.from([Buffer.from(body)]),
});

describe('resolveMediaLocations', () => {
  it('reports local, peer-hosted (with the host name) and missing files', async () => {
    await markHosted(PEER.instanceId, [{ kind: 'image', filename: 'remote.png' }, { kind: 'video', filename: 'v1.mp4' }]);
    const result = await resolveMediaLocations([
      { kind: 'image', ref: 'local.png' },
      { kind: 'image', ref: 'remote.png' },
      { kind: 'video', ref: 'v1' }, // bare video id → v1.mp4
      { kind: 'image', ref: 'nobody-has-this.png' },
    ]);
    expect(result).toEqual([
      { location: 'local' },
      { location: 'remote', hostPeerId: PEER.instanceId, hostPeerName: 'Studio Mac' },
      { location: 'remote', hostPeerId: PEER.instanceId, hostPeerName: 'Studio Mac' },
      { location: 'missing' },
    ]);
  });

  it('never marks a file that already exists locally as hosted', async () => {
    expect(await markHosted(PEER.instanceId, [{ kind: 'image', filename: 'local.png' }])).toBe(0);
  });

  it('drops the entry only once the bytes are actually local', async () => {
    await markHosted(PEER.instanceId, [{ kind: 'image', filename: 'arriving.png' }]);
    expect(await unmarkHosted('image', 'arriving.png')).toBe(false); // pull failed: keep host entry
    writeFileSync(join(tempRoot, 'images', 'arriving.png'), 'BYTES');
    expect(await unmarkHosted('image', 'arriving.png')).toBe(true);
  });
});

describe('takeHostedAssets', () => {
  it('hosts absent collection-owned files and leaves everything else to the copy path', async () => {
    const missing = [
      { kind: 'image', filename: 'coll-only.png' },
      { kind: 'image', filename: 'universe-art.png' }, // not collection-owned → still copied
      { kind: 'image', filename: 'local.png' },        // exists locally with a different hash → still copied
    ];
    const keys = new Set(['image:coll-only.png', 'image:local.png']);
    const remaining = await takeHostedAssets(PEER.instanceId, missing, keys);
    expect(remaining.map((a) => a.filename)).toEqual(['universe-art.png', 'local.png']);
    expect((await resolveMediaLocations([{ kind: 'image', ref: 'coll-only.png' }]))[0].location).toBe('remote');
  });
});

describe('static-mount fallback', () => {
  it('streams a peer-hosted image through the unchanged local URL', async () => {
    await markHosted(PEER.instanceId, [{ kind: 'image', filename: 'remote.png' }]);
    streamRequest.mockResolvedValue(upstream('REMOTEBYTES'));
    const res = await request(app).get('/data/images/remote.png');
    expect(res.status).toBe(200);
    expect(res.headers['x-portos-media-location']).toBe('remote');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(streamRequest.mock.calls[0][0]).toBe('https://peer.example.com:5555/data/images/remote.png');
  });

  it('prefers the local copy over a recorded host', async () => {
    await markHosted(PEER.instanceId, [{ kind: 'image', filename: 'shadowed.png' }]);
    writeFileSync(join(tempRoot, 'images', 'shadowed.png'), 'LOCALWINS');
    const res = await request(app).get('/data/images/shadowed.png');
    expect(res.status).toBe(200);
    expect(res.text).toBe('LOCALWINS');
    expect(streamRequest).not.toHaveBeenCalled();
  });

  it('forwards Range and retains attachment semantics when downloading a hosted video', async () => {
    await markHosted(PEER.instanceId, [{ kind: 'video', filename: 'clip.mp4' }]);
    streamRequest.mockResolvedValue(upstream('PART', 206, { 'content-type': 'video/mp4', 'content-range': 'bytes 0-3/100' }));
    const res = await request(app).get('/data/videos/clip.mp4?download=1').set('Range', 'bytes=0-3');
    expect(res.status).toBe(206);
    expect(res.headers['content-disposition']).toBe('attachment; filename="clip.mp4"');
    expect(streamRequest.mock.calls[0][1].headers.Range).toBe('bytes=0-3');
  });

  it('serves a hosted video poster from the peer (stem lookup)', async () => {
    await markHosted(PEER.instanceId, [{ kind: 'video', filename: 'clip2.mp4' }]);
    streamRequest.mockResolvedValue(upstream('JPEG', 200, { 'content-type': 'image/jpeg' }));
    const res = await request(app).get('/data/video-thumbnails/clip2.jpg');
    expect(res.status).toBe(200);
    expect(streamRequest.mock.calls[0][0]).toBe('https://peer.example.com:5555/data/video-thumbnails/clip2.jpg');
  });

  it('404s a file nobody hosts', async () => {
    const res = await request(app).get('/data/images/unknown.png');
    expect(res.status).toBe(404);
    expect(streamRequest).not.toHaveBeenCalled();
  });

  it('answers 502 when the host peer is unreachable', async () => {
    await markHosted(PEER.instanceId, [{ kind: 'image', filename: 'offline.png' }]);
    streamRequest.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await request(app).get('/data/images/offline.png');
    expect(res.status).toBe(502);
  });

  it('never streams from a disabled peer', async () => {
    await markHosted(PEER.instanceId, [{ kind: 'image', filename: 'paused.png' }]);
    getPeers.mockImplementation(async () => [{ ...PEER, enabled: false }]);
    const res = await request(app).get('/data/images/paused.png');
    expect(res.status).toBe(404);
    expect(streamRequest).not.toHaveBeenCalled();
  });

  it('forgets a hosted entry once the peer answers 404, so it stops reading as remote', async () => {
    await markHosted(PEER.instanceId, [{ kind: 'image', filename: 'gone.png' }]);
    streamRequest.mockResolvedValue(upstream('nope', 404));
    expect((await request(app).get('/data/images/gone.png')).status).toBe(404);
    expect((await resolveMediaLocations([{ kind: 'image', ref: 'gone.png' }]))[0].location).toBe('missing');
  });
});
