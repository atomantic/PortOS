import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import sharp from 'sharp';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import imageCleanRoutes from './imageClean.js';

const buildApp = () => {
  const app = express();
  app.use(express.json({ limit: '55mb' }));
  app.use('/api/image-clean', imageCleanRoutes);
  app.use(errorMiddleware);
  return app;
};

let pngFixture;
let jpegFixture;
let webpFixture;
let pngWithC2PA;

beforeAll(async () => {
  // 1×1 fixtures sized just large enough to round-trip through sharp.
  const baseInput = {
    create: { width: 4, height: 4, channels: 3, background: { r: 200, g: 100, b: 50 } },
  };
  pngFixture = await sharp(baseInput).png().toBuffer();
  jpegFixture = await sharp(baseInput).jpeg().toBuffer();
  webpFixture = await sharp(baseInput).webp().toBuffer();

  // Synthesize a PNG with a `caBX` chunk inserted AFTER the IHDR chunk so the
  // file remains a structurally valid PNG that sharp can still decode, but
  // pngHasC2PA's walker has something to find.
  // PNG layout: 8-byte signature, then IHDR (length=13 ⇒ 4+4+13+4 = 25 bytes).
  const ihdrEnd = 8 + 25;
  const cabxType = Buffer.from('caBX', 'ascii');
  const cabxData = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const cabxLen = Buffer.alloc(4);
  cabxLen.writeUInt32BE(cabxData.length, 0);
  const cabxCrc = Buffer.alloc(4); // CRC value not validated by walker or sharp's strict mode here
  const cabxChunk = Buffer.concat([cabxLen, cabxType, cabxData, cabxCrc]);
  pngWithC2PA = Buffer.concat([
    pngFixture.slice(0, ihdrEnd),
    cabxChunk,
    pngFixture.slice(ihdrEnd),
  ]);
});

describe('POST /api/image-clean', () => {
  it('cleans a PNG and returns base64 + metadata', async () => {
    const res = await request(buildApp())
      .post('/api/image-clean')
      .send({ data: pngFixture.toString('base64'), level: 'light' });

    expect(res.status).toBe(200);
    expect(res.body.format).toBe('png');
    expect(res.body.mimeType).toBe('image/png');
    expect(res.body.level).toBe('light');
    expect(res.body.width).toBe(4);
    expect(res.body.height).toBe(4);
    expect(res.body.c2paStripped).toBe(false);
    expect(typeof res.body.data).toBe('string');
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it('cleans a JPEG and emits a JPEG response', async () => {
    const res = await request(buildApp())
      .post('/api/image-clean')
      .send({ data: jpegFixture.toString('base64') });

    expect(res.status).toBe(200);
    expect(res.body.format).toBe('jpeg');
    expect(res.body.mimeType).toBe('image/jpeg');
    expect(res.body.level).toBe('light'); // default
  });

  it('cleans a WebP', async () => {
    const res = await request(buildApp())
      .post('/api/image-clean')
      .send({ data: webpFixture.toString('base64'), level: 'aggressive' });

    expect(res.status).toBe(200);
    expect(res.body.format).toBe('webp');
    expect(res.body.mimeType).toBe('image/webp');
    expect(res.body.level).toBe('aggressive');
  });

  it('flags c2paStripped=true when PNG contains a caBX chunk', async () => {
    const res = await request(buildApp())
      .post('/api/image-clean')
      .send({ data: pngWithC2PA.toString('base64') });

    expect(res.status).toBe(200);
    expect(res.body.c2paStripped).toBe(true);
  });

  it('rejects unsupported formats with UNSUPPORTED_FORMAT', async () => {
    const garbage = Buffer.from('not an image at all').toString('base64');
    const res = await request(buildApp())
      .post('/api/image-clean')
      .send({ data: garbage });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNSUPPORTED_FORMAT');
  });

  it('rejects empty payloads with VALIDATION_ERROR', async () => {
    const res = await request(buildApp())
      .post('/api/image-clean')
      .send({ data: '' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects oversized base64 payloads with FILE_TOO_LARGE before decoding', async () => {
    // Sized to exceed the pre-decode cap (~53.3MB) but stay under the 55mb
    // body parser ceiling so the route handler runs (not express's 413).
    const tooBig = 'A'.repeat(54 * 1024 * 1024);
    const res = await request(buildApp())
      .post('/api/image-clean')
      .send({ data: tooBig });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('FILE_TOO_LARGE');
  });

  it('rejects invalid level enum with VALIDATION_ERROR', async () => {
    const res = await request(buildApp())
      .post('/api/image-clean')
      .send({ data: pngFixture.toString('base64'), level: 'nuclear' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});
