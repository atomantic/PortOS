import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { brotliDecompressSync, createGzip, gunzipSync, inflateSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { httpCompression } from './httpCompression.js';
import { mountClientDist } from '../services/assetMounts.js';

vi.mock('node:zlib', async importOriginal => {
  const zlib = await importOriginal();
  return { ...zlib, createGzip: vi.fn(zlib.createGzip) };
});

const payload = JSON.stringify({ providers: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `Provider ${i}` })) });
const chunk = 'export const data = ' + payload;
const pipedChunk = chunk.repeat(20);
const multibyte = '€'.repeat(342);
let server;
let port;
const dist = mkdtempSync(join(tmpdir(), 'portos-compression-'));

const get = (path, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path, headers, method }, (res) => {
    const chunks = [];
    res.on('data', (part) => chunks.push(part));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    res.on('error', reject);
  }).on('error', reject);
});

beforeAll(async () => {
  const app = express();
  app.use((_req, res, next) => { res.set('Vary', 'Origin'); next(); });
  app.use(httpCompression);
  app.get('/api/providers', (_req, res) => res.json(JSON.parse(payload)));
  app.get('/small', (_req, res) => res.type('text').send('short'));
  app.get('/end-small', (_req, res) => res.type('text').end('short'));
  app.get('/end-multibyte', (_req, res) => res.type('text').end(multibyte));
  app.get('/piped', (_req, res) => {
    res.writeHead(200, 'OK', { 'Content-Type': 'application/problem+json', Vary: 'Origin, accept-encoding' });
    Readable.from([pipedChunk, pipedChunk]).pipe(res);
  });
  app.get('/abort', (_req, res) => {
    res.type('text');
    res.flushHeaders();
    res.write(pipedChunk);
  });
  app.get('/identity', (_req, res) => res.set('Content-Encoding', 'identity').type('xml').send(chunk));
  app.get('/wasm', (_req, res) => res.type('application/wasm').send(chunk));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'assets', 'app.123abc.js'), chunk);
  mountClientDist(app, dist);
  app.get('/no-transform', (_req, res) => res.set('Cache-Control', 'no-transform').type('js').send(chunk));
  app.get('/encoded', (_req, res) => res.set('Content-Encoding', 'custom').type('js').send(chunk));
  app.get('/range', (req, res) => {
    if (req.headers.range) return res.status(206).set('Content-Range', 'bytes 0-9/100').type('js').send(chunk.slice(0, 10));
    return res.type('js').send(chunk);
  });
  app.get('/events', (_req, res) => res.set('Content-Type', 'text/event-stream').write('data: first\n\n'));
  app.get('/frames', (_req, res) => res.set('Content-Type', 'application/x-ndjson').write('{"frame":1}\n'));
  app.get('/multipart', (_req, res) => res.set('Content-Type', 'multipart/x-mixed-replace; boundary=frame').write('--frame\r\n'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dist, { recursive: true, force: true });
});

describe('HTTP compression', () => {
  it('negotiates Brotli for JSON and gzip for immutable JavaScript without losing Vary or cache policy', async () => {
    const api = await get('/api/providers', { 'Accept-Encoding': 'br, gzip' });
    expect(api.headers['content-encoding']).toBe('br');
    expect(api.headers.vary).toMatch(/Origin/i);
    expect(api.headers.vary).toMatch(/Accept-Encoding/i);
    expect(api.headers['content-length']).toBeUndefined();
    expect(brotliDecompressSync(api.body).toString()).toBe(payload);

    const asset = await get('/assets/app.123abc.js', { 'Accept-Encoding': 'gzip' });
    expect(asset.headers['content-encoding']).toBe('gzip');
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(gunzipSync(asset.body).toString()).toBe(chunk);

    const identity = await get('/api/providers');
    expect(identity.headers['content-encoding']).toBeUndefined();
    expect(identity.body.toString()).toBe(payload);
  });

  it.each([
    ['gzip;q=1, br;q=0', 'gzip'],
    ['br;q=0.5, deflate;q=0.8', 'deflate'],
    ['br;q=0, gzip;q=0, *;q=0.7', 'deflate'],
    ['gzip;q=0.5, identity;q=1', undefined],
    ['br;q=0, gzip;q=0, *;q=0', undefined],
  ])('negotiates %s according to quality and specificity', async (acceptEncoding, encoding) => {
    const response = await get('/api/providers', { 'Accept-Encoding': acceptEncoding });
    expect(response.headers['content-encoding']).toBe(encoding);
    const decode = { gzip: gunzipSync, deflate: inflateSync }[encoding];
    const body = decode ? decode(response.body) : response.body;
    expect(body.toString()).toBe(payload);
  });

  it('leaves small bodies intact and counts the final chunk in bytes', async () => {
    const headers = { 'Accept-Encoding': 'gzip' };
    for (const path of ['/small', '/end-small']) {
      const response = await get(path, headers);
      expect(response.headers['content-encoding']).toBeUndefined();
      expect(response.headers['content-length']).toBe('5');
      expect(response.body.toString()).toBe('short');
    }
    const response = await get('/end-multibyte', headers);
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(response.body).toString()).toBe(multibyte);
  });

  it('keeps the representation length on HEAD', async () => {
    const response = await get('/api/providers', { 'Accept-Encoding': 'br, gzip' }, 'HEAD');
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.headers['content-length']).toBe(String(Buffer.byteLength(payload)));
    expect(response.body).toHaveLength(0);
  });

  it('compresses piped writes after explicit headers and preserves an existing Vary entry', async () => {
    const response = await get('/piped', { 'Accept-Encoding': 'gzip' });
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(response.headers.vary).toBe('Origin, accept-encoding');
    expect(gunzipSync(response.body).toString()).toBe(pipedChunk.repeat(2));
  });

  it('can replace explicit identity and leaves binary media types intact', async () => {
    const headers = { 'Accept-Encoding': 'gzip' };
    const identity = await get('/identity', headers);
    expect(identity.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(identity.body).toString()).toBe(chunk);
    const wasm = await get('/wasm', headers);
    expect(wasm.headers['content-encoding']).toBeUndefined();
    expect(wasm.body.toString()).toBe(chunk);
  });

  it('destroys the active compressor when the client aborts', async () => {
    const response = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/abort', headers: { 'Accept-Encoding': 'gzip' } }, res => {
        res.once('error', reject);
        res.once('data', () => {
          res.pause();
          resolve(res);
        });
      }).once('error', reject);
    });
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(response.complete).toBe(false);
    const compressor = vi.mocked(createGzip).mock.results.at(-1).value;
    expect(compressor.destroyed).toBe(false);
    const closed = once(compressor, 'close');
    response.destroy();
    await closed;
    expect(compressor.destroyed).toBe(true);
  });

  it('preserves no-transform, existing encodings, and range bytes', async () => {
    for (const path of ['/no-transform', '/encoded']) {
      const response = await get(path, { 'Accept-Encoding': 'br, gzip' });
      expect(response.headers['content-encoding']).toBe(path === '/encoded' ? 'custom' : undefined);
      expect(response.body.toString()).toBe(chunk);
    }
    const range = await get('/range', { 'Accept-Encoding': 'br, gzip', Range: 'bytes=0-9' });
    expect(range.status).toBe(206);
    expect(range.headers['content-encoding']).toBeUndefined();
    expect(range.body.toString()).toBe(chunk.slice(0, 10));
  });

  it.each([
    ['/events', 'data: first\n\n'],
    ['/frames', '{"frame":1}\n'],
    ['/multipart', '--frame\r\n'],
  ])('delivers the first %s frame before stream completion', async (path, frame) => {
    const response = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path, headers: { 'Accept-Encoding': 'br, gzip' } }, (res) => {
        res.once('data', (data) => {
          resolve({ headers: res.headers, data: data.toString(), ended: res.complete });
          res.destroy();
        });
        res.once('error', reject);
      }).once('error', reject);
    });
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.data).toBe(frame);
    expect(response.ended).toBe(false);
  });
});
