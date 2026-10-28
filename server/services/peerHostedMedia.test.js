/**
 * Host-mode media: the index, the location resolver, and the static-mount
 * fallback that renders a peer-hosted file through an unchanged local URL.
 * Real files under a temp data root; only the peer transport is faked.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { Readable } from 'stream';
import { get } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { closeLoopbackServer, request, startLoopbackServer } from '../lib/testHelper.js';
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
const { peerStreamRequest: realPeerStreamRequest } = await vi.importActual('../lib/peerHttpClient.js');

const { markHosted, unmarkHosted, takeHostedAssets, resolveMediaLocations } = await import('./peerHostedMedia.js');
const { mountAssetRoutes } = await import('./assetMounts.js');
const { saveHistory } = await import('./videoGen/history.js');

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
  rmSync(join(tempRoot, 'video-history.json'), { force: true });
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
    expect(res.headers['content-disposition']).toBe('attachment; filename=clip.mp4');
    expect(streamRequest.mock.calls[0][1].headers.Range).toBe('bytes=0-3');
  });

  it('serves a hosted video poster from the peer (stem lookup)', async () => {
    await markHosted(PEER.instanceId, [{ kind: 'video', filename: 'clip2.mp4' }]);
    streamRequest.mockResolvedValue(upstream('JPEG', 200, { 'content-type': 'image/jpeg' }));
    const res = await request(app).get('/data/video-thumbnails/clip2.jpg');
    expect(res.status).toBe(200);
    expect(streamRequest.mock.calls[0][0]).toBe('https://peer.example.com:5555/data/video-thumbnails/clip2.jpg');
  });

  it('streams hosted image thumbnails and resolves custom video posters through history', async () => {
    const other = { ...PEER, id: 'p2', instanceId: 'peer-instance-2' };
    getPeers.mockImplementation(async () => [PEER, other]);
    await markHosted(PEER.instanceId, [{ kind: 'image', filename: 'remote-image.png' }, { kind: 'video', filename: 'clip.mp4' }]);
    await markHosted(other.instanceId, [{ kind: 'video', filename: 'clip-poster-123.mp4' }]);
    await saveHistory([{ id: 'clip', filename: 'clip.mp4', thumbnail: 'clip-poster-123.jpg' }]);
    streamRequest.mockImplementation(async () => upstream('POSTER'));

    expect((await request(app).get('/data/image-thumbnails/remote-image.webp')).status).toBe(200);
    expect(streamRequest.mock.calls[0][0]).toBe('https://peer.example.com:5555/data/image-thumbnails/remote-image.webp');
    expect((await request(app).get('/data/video-thumbnails/clip-poster-123.jpg')).status).toBe(200);
    expect(streamRequest.mock.calls[1][2].instanceId).toBe(PEER.instanceId);
    expect(streamRequest.mock.calls[1][0]).toBe('https://peer.example.com:5555/data/video-thumbnails/clip-poster-123.jpg');

    // A same-stem video cannot stand in for the poster's recorded owner.
    await saveHistory([{ id: 'other', filename: 'unhosted.mp4', thumbnail: 'clip-poster-123.jpg' }]);
    streamRequest.mockClear();
    expect((await request(app).get('/data/video-thumbnails/clip-poster-123.jpg')).status).toBe(404);
    expect(streamRequest).not.toHaveBeenCalled();
  });

  it('times out stalled posters without losing their host, while a slow original can still stream a range', async () => {
    let posterArrived;
    let imageArrived;
    let videoArrived;
    let bodyTimeoutArmed;
    let videoResponse;
    const posterRequest = new Promise(resolve => { posterArrived = resolve; });
    const imageRequest = new Promise(resolve => { imageArrived = resolve; });
    const videoRequest = new Promise(resolve => { videoArrived = resolve; });
    const bodyTimeout = new Promise(resolve => { bodyTimeoutArmed = resolve; });
    const peerApp = express();
    peerApp.get('/data/video-thumbnails/:name', (req, res) => {
      if (req.params.name === 'stall-body.jpg') res.status(200).type('jpeg').flushHeaders(); // no body
      else posterArrived(); // no headers
    });
    peerApp.get('/data/image-thumbnails/:name', () => imageArrived()); // no headers
    peerApp.get('/data/videos/:name', (req, res) => {
      videoResponse = { req, res };
      videoArrived();
    });
    const peerServer = await startLoopbackServer(peerApp);
    const localServer = await startLoopbackServer(app);
    const peer = { ...PEER, host: undefined, address: '127.0.0.1', port: peerServer.address().port };
    getPeers.mockResolvedValue([peer]);
    streamRequest.mockImplementation(async (...args) => {
      const upstream = await realPeerStreamRequest(...args);
      if (args[0].endsWith('/stall-body.jpg')) {
        // Drive the socket's idle callback with the fake clock; the real stream
        // and HTTP connections still exercise pipeline destruction.
        upstream.stream.setTimeout = (ms, callback) => {
          setTimeout(callback, ms);
          bodyTimeoutArmed();
          return upstream.stream;
        };
      }
      return upstream;
    });
    await markHosted(peer.instanceId, [{ kind: 'video', filename: 'stall.mp4' }, { kind: 'image', filename: 'stall.png' }]);
    await saveHistory([
      { id: 'stall', filename: 'stall.mp4', thumbnail: 'stall-poster.jpg' },
      { id: 'body', filename: 'stall.mp4', thumbnail: 'stall-body.jpg' },
    ]);

    const localGet = (path, headers = {}) => new Promise((resolve, reject) => {
      get({ host: '127.0.0.1', port: localServer.address().port, path, headers }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
        res.on('aborted', () => reject(new Error('response aborted')));
        res.on('error', reject);
      }).on('error', reject);
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let posterSettled = false;
      const poster = localGet('/data/video-thumbnails/stall-poster.jpg').finally(() => { posterSettled = true; });
      await posterRequest;
      await vi.advanceTimersByTimeAsync(2999);
      expect(posterSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await poster).status).toBe(502);
      expect((await resolveMediaLocations([{ kind: 'video', ref: 'stall.mp4' }]))[0].location).toBe('remote');

      const image = localGet('/data/image-thumbnails/stall.webp');
      await imageRequest;
      await vi.advanceTimersByTimeAsync(3000);
      expect((await image).status).toBe(502);
      expect((await resolveMediaLocations([{ kind: 'image', ref: 'stall.png' }]))[0].location).toBe('remote');

      let bodySettled = false;
      const body = localGet('/data/video-thumbnails/stall-body.jpg')
        .then(response => response.status, () => 'disconnected')
        .finally(() => { bodySettled = true; });
      await bodyTimeout;
      await vi.advanceTimersByTimeAsync(2999);
      expect(bodySettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect([502, 'disconnected']).toContain(await body);
      expect((await resolveMediaLocations([{ kind: 'video', ref: 'stall.mp4' }]))[0].location).toBe('remote');
      expect(warn).not.toHaveBeenCalled();

      const video = localGet('/data/videos/stall.mp4', { Range: 'bytes=0-3' });
      await videoRequest;
      await vi.advanceTimersByTimeAsync(5000); // longer than the thumbnail deadline
      expect(videoResponse.req.headers.range).toBe('bytes=0-3');
      videoResponse.res.status(206).set({ 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-3/100' }).end('PART');
      const result = await video;
      expect(result).toMatchObject({ status: 206, body: 'PART' });
      expect(result.headers['content-range']).toBe('bytes 0-3/100');
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
      peerServer.closeAllConnections();
      localServer.closeAllConnections();
      await Promise.all([closeLoopbackServer(peerServer), closeLoopbackServer(localServer)]);
    }
  });

  it('404s a file nobody hosts', async () => {
    const res = await request(app).get('/data/images/unknown.png');
    expect(res.status).toBe(404);
    expect(streamRequest).not.toHaveBeenCalled();
  });

  it('answers 502 when the host peer is unreachable', async () => {
    await markHosted(PEER.instanceId, [{ kind: 'image', filename: 'offline.png' }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      streamRequest.mockRejectedValue(new Error('ECONNREFUSED peer.example.com'));
      const res = await request(app).get('/data/images/offline.png');
      expect(res.status).toBe(502);
      expect(warn).toHaveBeenCalledWith('⚠️ peerHostedMedia: stream /data/images from peer failed (transport error)');
    } finally {
      warn.mockRestore();
    }
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
