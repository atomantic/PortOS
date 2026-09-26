import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { httpCompression } from './httpCompression.js';
import { mountClientDist } from '../services/assetMounts.js';

const payload = JSON.stringify({ providers: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `Provider ${i}` })) });
const chunk = 'export const data = ' + payload;
let server;
let port;
const dist = mkdtempSync(join(tmpdir(), 'portos-compression-'));

const get = (path, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
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
    expect(brotliDecompressSync(api.body).toString()).toBe(payload);

    const asset = await get('/assets/app.123abc.js', { 'Accept-Encoding': 'gzip' });
    expect(asset.headers['content-encoding']).toBe('gzip');
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(gunzipSync(asset.body).toString()).toBe(chunk);

    const identity = await get('/api/providers');
    expect(identity.headers['content-encoding']).toBeUndefined();
    expect(identity.body.toString()).toBe(payload);
  });

  it('preserves no-transform, existing encodings, and range bytes', async () => {
    for (const path of ['/no-transform', '/encoded']) {
      const response = await get(path, { 'Accept-Encoding': 'br, gzip' });
      expect(response.body.toString()).toBe(chunk);
    }
    const range = await get('/range', { 'Accept-Encoding': 'br, gzip', Range: 'bytes=0-9' });
    expect(range.status).toBe(206);
    expect(range.headers['content-encoding']).toBeUndefined();
    expect(range.body.toString()).toBe(chunk.slice(0, 10));
  });

  it.each([['/events', 'data: first\n\n'], ['/frames', '{"frame":1}\n']])('delivers the first %s frame before stream completion', async (path, frame) => {
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
