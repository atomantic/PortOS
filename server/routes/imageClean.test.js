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
  // 4×4 fixtures sized just large enough to round-trip through sharp.
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

  it('bails on PNG-signature buffers with garbage chunk data instead of looping', async () => {
    // PNG magic bytes followed by zero-filled garbage. Without an early bailout,
    // pngHasC2PA would walk in 12-byte steps through ~40MiB of zeros (~3.3M
    // iterations) before sharp's decode failure surfaces. This test asserts the
    // request resolves quickly with INVALID_IMAGE rather than timing out.
    const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const garbage = Buffer.alloc(1024); // zeros — chunk type bytes will be 0x00
    const fake = Buffer.concat([pngSig, garbage]);
    const start = Date.now();
    const res = await request(buildApp())
      .post('/api/image-clean')
      .send({ data: fake.toString('base64') });
    const elapsed = Date.now() - start;

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_IMAGE');
    expect(elapsed).toBeLessThan(1000);
  });

  it('caps the chunk walk so a PNG-sig buffer of zero-length ASCII-typed chunks bails fast', async () => {
    // Adversarial input: valid PNG signature + many tiny chunks with valid
    // ASCII chunk types (so isPngChunkType passes) but length=0. Without a
    // chunk-count cap, the walker would iterate ~3.5M times for a 40MiB
    // payload. With MAX_PNG_CHUNKS=10000, it bails after 10000 iterations.
    const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const oneChunk = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x00]), // length=0
      Buffer.from('ABCD', 'ascii'),           // valid chunk type bytes
      Buffer.from([0x00, 0x00, 0x00, 0x00]), // CRC (unchecked)
    ]);
    // 20000 chunks > MAX_PNG_CHUNKS=10000 — proves the cap fires.
    const fake = Buffer.concat([pngSig, Buffer.concat(Array(20000).fill(oneChunk))]);
    const start = Date.now();
    const res = await request(buildApp())
      .post('/api/image-clean')
      .send({ data: fake.toString('base64') });
    const elapsed = Date.now() - start;

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_IMAGE');
    expect(elapsed).toBeLessThan(1500);
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
    // Sized (in MiB) to exceed the pre-decode base64 cap (~53.3 MiB, derived
    // from MAX_INPUT_BYTES = 40 MiB) but stay under the 55 MiB body parser
    // ceiling so the route handler runs (not express's 413).
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

  it('auto-orients images via EXIF Orientation tag', async () => {
    // Build a 4×8 JPEG, then re-emit with EXIF Orientation=6 (rotate 90° CW)
    // embedded via withMetadata. After the route's auto-orient, the output
    // should be 8×4 — i.e., width/height swapped.
    const raw = await sharp({
      create: { width: 4, height: 8, channels: 3, background: { r: 100, g: 150, b: 200 } },
    }).jpeg().toBuffer();
    const oriented = await sharp(raw)
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    const res = await request(buildApp())
      .post('/api/image-clean')
      .send({ data: oriented.toString('base64') });

    expect(res.status).toBe(200);
    expect(res.body.width).toBe(8);
    expect(res.body.height).toBe(4);
  });
});
