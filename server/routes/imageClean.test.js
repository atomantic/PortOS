import { describe, it, expect, beforeAll, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import express from 'express';
import sharp from 'sharp';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Mock the GPU-clean orchestration so the route's ?diffusion=gpu path never
// touches the REAL mediaJobQueue / FLUX runner (which would enqueue a live job
// against the shared install — and would OOM/spawn Python on a machine that has
// a runner installed). The route contract (stage → enqueue → 202 with jobId,
// result-fetch, save-to-gallery) is what's under test here; the seam's own
// behavior (temp staging, param assembly) is covered in cleanGpu.test.js.
vi.mock('../services/imageGen/cleanGpu.js', () => ({
  enqueueGpuClean: vi.fn(),
  readGpuCleanResult: vi.fn(),
  getGpuCleanStatus: vi.fn(),
  saveGpuCleanToGallery: vi.fn(),
}));

import { enqueueGpuClean, readGpuCleanResult, getGpuCleanStatus, saveGpuCleanToGallery } from '../services/imageGen/cleanGpu.js';
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

beforeEach(() => {
  vi.mocked(enqueueGpuClean).mockReset();
  vi.mocked(readGpuCleanResult).mockReset();
  vi.mocked(getGpuCleanStatus).mockReset();
  vi.mocked(saveGpuCleanToGallery).mockReset();
});

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

  it('enqueues a GPU FLUX clean job and returns 202 + jobId (issue #2264)', async () => {
    vi.mocked(enqueueGpuClean).mockResolvedValue({
      jobId: '11111111-1111-4111-8111-111111111111',
      position: 1,
      status: 'queued',
      modelId: 'flux2-klein-4b',
      strength: 0.25,
      width: 16,
      height: 16,
      scaled: true,
    });
    const res = await postImage('?diffusion=gpu', pngFixture);
    expect(res.status).toBe(202);
    expect(res.body.mode).toBe('gpu');
    expect(res.body.jobId).toBe('11111111-1111-4111-8111-111111111111');
    expect(res.body.modelId).toBe('flux2-klein-4b');
    // The sync-clean report rides along so the client can show what already ran.
    expect(Array.isArray(res.body.steps)).toBe(true);
    // The already-sync-cleaned bytes were handed to the seam, not the raw upload.
    expect(vi.mocked(enqueueGpuClean)).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(enqueueGpuClean).mock.calls[0][0];
    expect(Buffer.isBuffer(arg.initBuffer)).toBe(true);
  });

  it('surfaces the no-FLUX-runner gate as a 400 on the GPU path', async () => {
    vi.mocked(enqueueGpuClean).mockRejectedValue(
      Object.assign(new Error('No local FLUX runner is installed.'), { status: 400, code: 'REGEN_BACKEND_UNAVAILABLE' }),
    );
    const res = await postImage('?diffusion=gpu', pngFixture);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REGEN_BACKEND_UNAVAILABLE');
  });

  it('passes a validated strength + max-MP override through to the GPU seam', async () => {
    vi.mocked(enqueueGpuClean).mockResolvedValue({
      jobId: '22222222-2222-4222-8222-222222222222', position: 1, status: 'queued',
      modelId: 'flux2-klein-4b', strength: 0.4, width: 16, height: 16, scaled: false,
    });
    const res = await postImage('?diffusion=gpu&strength=0.4&maxMp=1.5', pngFixture);
    expect(res.status).toBe(202);
    const arg = vi.mocked(enqueueGpuClean).mock.calls[0][0];
    expect(arg.strength).toBe(0.4);
    expect(arg.maxMegapixels).toBe(1.5);
  });

  it('rejects an out-of-range strength on the GPU path with VALIDATION_ERROR', async () => {
    const res = await postImage('?diffusion=gpu&strength=5', pngFixture);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    // The seam was never reached — validation short-circuits.
    expect(vi.mocked(enqueueGpuClean)).not.toHaveBeenCalled();
  });

  it('stages the oriented original + mask for the GPU composite when a mask rides along', async () => {
    vi.mocked(enqueueGpuClean).mockResolvedValue({
      jobId: '33333333-3333-4333-8333-333333333333', position: 1, status: 'queued',
      modelId: 'flux2-klein-4b', strength: 0.25, width: 4, height: 4, scaled: false,
    });
    const maskRaw = Buffer.alloc(4 * 4, 255);
    const maskPng = await sharp(maskRaw, { raw: { width: 4, height: 4, channels: 1 } }).png().toBuffer();
    const lenPrefix = Buffer.alloc(4);
    lenPrefix.writeUInt32BE(maskPng.length, 0);
    const envelope = Buffer.concat([lenPrefix, maskPng, pngFixture]);
    const res = await postImage('?diffusion=gpu&mask=1&feather=2', envelope);
    expect(res.status).toBe(202);
    const arg = vi.mocked(enqueueGpuClean).mock.calls[0][0];
    expect(Buffer.isBuffer(arg.originalBuffer)).toBe(true);
    expect(Buffer.isBuffer(arg.maskBuffer)).toBe(true);
    expect(arg.feather).toBe(2);
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

  it('composites an ignore-zone mask over the diffused result when ?diffusion=light&mask=1', async () => {
    // Build a left-half-white mask sized to the large fixture, then frame the
    // body as <uint32 maskLen><mask><image>. The response should carry an
    // ignore-zone step and stay a PNG.
    const meta = await sharp(largePng).metadata();
    const mw = meta.width;
    const mh = meta.height;
    const maskRaw = Buffer.alloc(mw * mh, 0);
    for (let y = 0; y < mh; y += 1) {
      for (let x = 0; x < mw; x += 1) if (x < mw / 2) maskRaw[y * mw + x] = 255;
    }
    const maskPng = await sharp(maskRaw, { raw: { width: mw, height: mh, channels: 1 } }).png().toBuffer();
    const lenPrefix = Buffer.alloc(4);
    lenPrefix.writeUInt32BE(maskPng.length, 0);
    const envelope = Buffer.concat([lenPrefix, maskPng, largePng]);

    const res = await postImage('?diffusion=light&mask=1&feather=2', envelope);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    const report = reportOf(res);
    const zone = report.steps.find((s) => s.step === 'ignore-zone');
    expect(zone).toBeTruthy();
    expect(zone.status).toBe('applied');
    expect(report.steps.map((s) => s.step)).toContain('diffusion');
  });

  it('ignores the mask envelope when no diffusion step runs', async () => {
    // mask=1 but diffusion=off → the mask is decoded off the body but never
    // composited (nothing to preserve against). The image half of the envelope
    // must still clean cleanly.
    const maskRaw = Buffer.alloc(4 * 4, 255);
    const maskPng = await sharp(maskRaw, { raw: { width: 4, height: 4, channels: 1 } }).png().toBuffer();
    const lenPrefix = Buffer.alloc(4);
    lenPrefix.writeUInt32BE(maskPng.length, 0);
    const envelope = Buffer.concat([lenPrefix, maskPng, pngFixture]);

    const res = await postImage('?mask=1', envelope);
    expect(res.status).toBe(200);
    const report = reportOf(res);
    expect(report.steps.some((s) => s.step === 'ignore-zone')).toBe(false);
    expect(report.format).toBe('png');
    expect(report.width).toBe(4);
  });

  it('aligns the mask with the diffused base on an EXIF-oriented source with metadata OFF', async () => {
    // Orientation=6 (rotate 90° CW) JPEG: visual space is 40×20, stored is 20×40.
    // With metadata=0 the clean step returns un-rotated bytes, so the route must
    // bake orientation into the diffusion input to match the (oriented) mask.
    const raw = await sharp({
      create: { width: 20, height: 40, channels: 3, background: { r: 120, g: 90, b: 60 } },
    }).jpeg().toBuffer();
    const oriented = await sharp(raw).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    // Mask painted in VISUAL space (40 wide × 20 tall), left half white.
    const vw = 40;
    const vh = 20;
    const maskRaw = Buffer.alloc(vw * vh, 0);
    for (let y = 0; y < vh; y += 1) for (let x = 0; x < vw; x += 1) if (x < vw / 2) maskRaw[y * vw + x] = 255;
    const maskPng = await sharp(maskRaw, { raw: { width: vw, height: vh, channels: 1 } }).png().toBuffer();
    const lenPrefix = Buffer.alloc(4);
    lenPrefix.writeUInt32BE(maskPng.length, 0);
    const envelope = Buffer.concat([lenPrefix, maskPng, oriented]);

    const res = await postImage('?metadata=0&denoise=0&diffusion=light&mask=1&feather=0', envelope, 'image/jpeg');
    expect(res.status).toBe(200);
    const report = reportOf(res);
    // Output is delivered in the oriented (visual) dims — 40×20 — so the mask,
    // base, and original all agree. A misaligned (un-baked) path would report
    // 20×40 here.
    expect(report.width).toBe(vw);
    expect(report.height).toBe(vh);
    expect(report.steps.some((s) => s.step === 'ignore-zone' && s.status === 'applied')).toBe(true);
  });

  it('degrades to no-mask when the envelope length prefix is malformed', async () => {
    // A length that overruns the buffer → splitMaskEnvelope treats the whole
    // body as the image, so a plain PNG (no real envelope) still cleans.
    const badPrefix = Buffer.alloc(4);
    badPrefix.writeUInt32BE(0xffffffff, 0);
    const envelope = Buffer.concat([badPrefix, pngFixture]);
    const res = await postImage('?mask=1', envelope);
    // The body now starts with a bogus prefix, so it's not a valid PNG → the
    // sniffer rejects it as unsupported (proves we didn't 500 on the bad frame).
    expect([200, 400]).toContain(res.status);
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

describe('GPU clean result-fetch + save-to-gallery (issue #2264)', () => {
  const JOB = '44444444-4444-4444-8444-444444444444';
  const getResult = (jobId) => request(buildApp()).get(`/api/image-clean/result/${jobId}`);
  const postSave = (jobId) => request(buildApp()).post(`/api/image-clean/result/${jobId}/save`);

  it('returns the finished render bytes as image/png with a report header', async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
    vi.mocked(getGpuCleanStatus).mockReturnValue({ status: 'completed', error: null });
    vi.mocked(readGpuCleanResult).mockResolvedValue({ data: png, width: 8, height: 8, composited: false });
    const res = await getResult(JOB);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    const report = JSON.parse(res.headers['x-clean-report']);
    expect(report.mode).toBe('gpu');
    expect(report.width).toBe(8);
  });

  it('409s (keep polling) while the job is still running', async () => {
    vi.mocked(getGpuCleanStatus).mockReturnValue({ status: 'running', error: null });
    vi.mocked(readGpuCleanResult).mockResolvedValue(null);
    const res = await getResult(JOB);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RESULT_NOT_READY');
  });

  it('404s once the render is gone (past temp GC / unknown id)', async () => {
    vi.mocked(getGpuCleanStatus).mockReturnValue({ status: 'unknown', error: null });
    vi.mocked(readGpuCleanResult).mockResolvedValue(null);
    const res = await getResult(JOB);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('409s with the failure reason when the job failed', async () => {
    vi.mocked(getGpuCleanStatus).mockReturnValue({ status: 'failed', error: 'runner OOM' });
    const res = await getResult(JOB);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('JOB_FAILED');
  });

  it('rejects a non-UUID job id with VALIDATION_ERROR', async () => {
    const res = await getResult('not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(vi.mocked(readGpuCleanResult)).not.toHaveBeenCalled();
  });

  it('saves a finished result to the gallery on the explicit save action (201)', async () => {
    vi.mocked(saveGpuCleanToGallery).mockResolvedValue({ filename: 'upload-abcd1234.png', path: '/data/images/upload-abcd1234.png' });
    const res = await postSave(JOB);
    expect(res.status).toBe(201);
    expect(res.body.filename).toBe('upload-abcd1234.png');
    expect(vi.mocked(saveGpuCleanToGallery)).toHaveBeenCalledWith(JOB);
  });
});
