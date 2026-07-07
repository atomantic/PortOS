import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import express from 'express';
import sharp from 'sharp';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import imageCleanRoutes from './imageClean.js';

// Mirror server/index.js: the global express.json() runs first but is a no-op
// for image/* content-types, so the route's own express.raw() owns the body.
const buildApp = () => {
  const app = express();
  app.use(express.json({ limit: '55mb' }));
  app.use('/api/image-clean', imageCleanRoutes);
  app.use(errorMiddleware);
  return app;
};

// Read the JSON report the route stows in the X-Clean-Report response header.
const reportOf = (res) => JSON.parse(res.headers['x-clean-report']);

let pngFixture;
let jpegFixture;
let webpFixture;
let pngWithC2PA;
let pngWithText;
let largePng;

beforeAll(async () => {
  // 4×4 fixtures sized just large enough to round-trip through sharp.
  const baseInput = {
    create: { width: 4, height: 4, channels: 3, background: { r: 200, g: 100, b: 50 } },
  };
  pngFixture = await sharp(baseInput).png().toBuffer();
  jpegFixture = await sharp(baseInput).jpeg().toBuffer();
  webpFixture = await sharp(baseInput).webp().toBuffer();

  // Build extra chunks structurally so the metadata-strip pass has something to
  // remove regardless of sharp's metadata-writing behavior across versions.
  const ihdrEnd = 8 + 25; // signature + IHDR (4+4+13+4)
  const buildChunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4) /* CRC unchecked */]);
  };
  const cabxChunk = buildChunk('caBX', Buffer.from([0x01, 0x02, 0x03, 0x04]));
  pngWithC2PA = Buffer.concat([pngFixture.slice(0, ihdrEnd), cabxChunk, pngFixture.slice(ihdrEnd)]);

  const textChunk = buildChunk('tEXt', Buffer.from('Comment\0secret author note', 'latin1'));
  pngWithText = Buffer.concat([pngFixture.slice(0, ihdrEnd), textChunk, pngFixture.slice(ihdrEnd)]);

  // A multi-MB valid PNG to prove raw-byte transport handles payloads far above
  // the old 40MB *base64* envelope without a 413/FILE_TOO_LARGE. Truly random
  // bytes so PNG can't compress it down to a trivial size.
  const w = 1200;
  const h = 1200;
  const raw = randomBytes(w * h * 3);
  largePng = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
});

const postImage = (query, buffer, contentType = 'image/png') =>
  request(buildApp())
    .post(`/api/image-clean${query}`)
    .set('Content-Type', contentType)
    .send(buffer);

describe('POST /api/image-clean (raw transport)', () => {
  it('cleans a PNG and returns the bytes + report header', async () => {
    const res = await postImage('', pngFixture);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    const report = reportOf(res);
    expect(report.format).toBe('png');
    expect(report.width).toBe(4);
    expect(report.height).toBe(4);
    expect(report.c2paStripped).toBe(false);
    expect(report.steps.some((s) => s.step === 'metadata')).toBe(true);
  });

  it('cleans a JPEG and emits a JPEG response', async () => {
    const res = await postImage('', jpegFixture, 'image/jpeg');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(reportOf(res).format).toBe('jpeg');
  });

  it('cleans a WebP', async () => {
    const res = await postImage('', webpFixture, 'image/webp');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(reportOf(res).format).toBe('webp');
  });

  it('flags c2paStripped=true when PNG contains a caBX chunk', async () => {
    const res = await postImage('', pngWithC2PA);
    expect(res.status).toBe(200);
    expect(reportOf(res).c2paStripped).toBe(true);
  });

  it('metadata step (default) losslessly strips text chunks', async () => {
    const res = await postImage('', pngWithText);
    expect(res.status).toBe(200);
    const report = reportOf(res);
    const meta = report.steps.find((s) => s.step === 'metadata');
    expect(meta.status).toBe('applied');
    expect(meta.detail).toContain('tEXt');
    // Lossless strip only removes the chunk → output is smaller than input.
    expect(report.sizeAfter).toBeLessThan(report.sizeBefore);
  });

  it('runs the denoise step when ?denoise=1', async () => {
    const res = await postImage('?denoise=1', pngFixture);
    expect(res.status).toBe(200);
    const report = reportOf(res);
    expect(report.steps.some((s) => s.step === 'denoise' && s.status === 'applied')).toBe(true);
  });

  it('runs the CPU light diffusion pass when ?diffusion=light and reports a fidelity delta', async () => {
    // Use the multi-MB fixture — applyLightRegen resize-squeezes then upscales,
    // which needs real pixel content (a 4×4 solid fixture floor16-collapses to
    // its own dims and can no-op the squeeze).
    const res = await postImage('?diffusion=light', largePng);
    expect(res.status).toBe(200);
    // The light pass always re-encodes to PNG regardless of source format.
    expect(res.headers['content-type']).toBe('image/png');
    const report = reportOf(res);
    const diff = report.steps.find((s) => s.step === 'diffusion');
    expect(diff).toBeTruthy();
    expect(diff.status).toBe('applied');
    expect(diff.mode).toBe('light');
    expect(diff.lossless).toBe(false);
    // Fidelity metric attached so the report never claims "removed".
    expect(typeof diff.pixelDeltaPct).toBe('number');
    expect(typeof diff.psnr).toBe('number');
    expect(report.format).toBe('png');
  });

  it('runs metadata + denoise + diffusion in pipeline order when all are selected', async () => {
    const res = await postImage('?metadata=1&denoise=1&diffusion=light', largePng);
    expect(res.status).toBe(200);
    const report = reportOf(res);
    expect(report.steps.map((s) => s.step)).toEqual(['metadata', 'denoise', 'diffusion']);
  });

  it('rejects GPU diffusion with 501 NOT_IMPLEMENTED (deferred to a follow-up)', async () => {
    const res = await postImage('?diffusion=gpu', pngFixture);
    expect(res.status).toBe(501);
    expect(res.body.code).toBe('NOT_IMPLEMENTED');
  });

  it('treats an unknown diffusion value as off (no diffusion step)', async () => {
    const res = await postImage('?diffusion=banana', pngFixture);
    expect(res.status).toBe(200);
    expect(reportOf(res).steps.some((s) => s.step === 'diffusion')).toBe(false);
  });

  it('runs no steps and passes bytes through when ?metadata=0&denoise=0', async () => {
    const res = await postImage('?metadata=0&denoise=0', pngWithC2PA);
    expect(res.status).toBe(200);
    const report = reportOf(res);
    expect(report.steps).toEqual([]);
    // Untouched passthrough — the caBX chunk is left in place, but the report
    // still tells the truth: present-but-kept, not "none found".
    expect(report.sizeAfter).toBe(report.sizeBefore);
    expect(report.c2paStripped).toBe(false);
    expect(report.c2paPresent).toBe(true);
  });

  it('accepts a multi-MB raw payload without a 413/FILE_TOO_LARGE (40MB cap removed)', async () => {
    expect(largePng.length).toBeGreaterThan(1_000_000);
    const res = await postImage('', largePng);
    expect(res.status).toBe(200);
    expect(reportOf(res).format).toBe('png');
  });

  it('bails on PNG-signature buffers with garbage chunk data instead of looping', async () => {
    const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fake = Buffer.concat([pngSig, Buffer.alloc(1024)]);
    const start = Date.now();
    const res = await postImage('', fake);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_IMAGE');
  });

  it('caps the chunk walk so a PNG-sig buffer of zero-length ASCII chunks bails fast', async () => {
    const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const oneChunk = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from('ABCD', 'ascii'),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
    ]);
    const fake = Buffer.concat([pngSig, Buffer.concat(Array(20000).fill(oneChunk))]);
    const start = Date.now();
    const res = await postImage('', fake);
    expect(Date.now() - start).toBeLessThan(1500);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_IMAGE');
  });

  it('rejects unsupported formats with UNSUPPORTED_FORMAT', async () => {
    const res = await postImage('', Buffer.from('not an image at all'), 'application/octet-stream');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNSUPPORTED_FORMAT');
  });

  it('rejects an empty body with VALIDATION_ERROR', async () => {
    const res = await postImage('', Buffer.alloc(0));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('auto-orients images via EXIF Orientation tag', async () => {
    // 4×8 JPEG re-emitted with EXIF Orientation=6 (rotate 90° CW). The metadata
    // re-encode path bakes in the rotation → output is 8×4 (dims swapped).
    const raw = await sharp({
      create: { width: 4, height: 8, channels: 3, background: { r: 100, g: 150, b: 200 } },
    }).jpeg().toBuffer();
    const oriented = await sharp(raw).withMetadata({ orientation: 6 }).jpeg().toBuffer();

    const res = await postImage('', oriented, 'image/jpeg');
    expect(res.status).toBe(200);
    const report = reportOf(res);
    expect(report.width).toBe(8);
    expect(report.height).toBe(4);
  });
});
