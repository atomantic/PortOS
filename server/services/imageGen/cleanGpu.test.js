import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

// Point PATHS.imageCleanTmp at a throwaway dir so the seam's temp staging never
// touches the real data tree, and mock the queue + backend so nothing spawns a
// FLUX runner or enqueues a live job on the shared install. `vi.hoisted` gives
// the hoisted vi.mock factory a stable path; the seam's `ensureDir` creates it.
const { TMP } = vi.hoisted(() => ({
  TMP: `/tmp/portos-cleangpu-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
}));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    PATHS: { ...actual.PATHS, imageCleanTmp: TMP },
    // Re-anchor the resolver at the test dir so result-fetch resolves there.
    resolveImageCleanTmp: (name) => {
      if (typeof name !== 'string' || !name || name.includes('/') || name.includes('..')) return null;
      return join(TMP, name);
    },
  };
});

const enqueueJob = vi.fn();
const getJob = vi.fn();
vi.mock('../mediaJobQueue/index.js', () => ({
  enqueueJob: (...a) => enqueueJob(...a),
  getJob: (...a) => getJob(...a),
}));

const resolveRegenBackend = vi.fn();
vi.mock('./regen.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveRegenBackend: (...a) => resolveRegenBackend(...a),
  };
});

import { enqueueGpuClean, readGpuCleanResult, getGpuCleanStatus } from './cleanGpu.js';

const AVAILABLE = { available: true, model: { id: 'flux2-klein-4b' }, pythonPath: null };

beforeEach(() => {
  enqueueJob.mockReset();
  getJob.mockReset();
  resolveRegenBackend.mockReset();
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const makePng = (w = 8, h = 8) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 5, g: 10, b: 15 } } }).png().toBuffer();

describe('enqueueGpuClean', () => {
  it('stages the init bytes to the temp dir and enqueues a non-gallery job', async () => {
    resolveRegenBackend.mockResolvedValue(AVAILABLE);
    enqueueJob.mockReturnValue({ jobId: 'aaaaaaaa-0000-4000-8000-000000000000', position: 1, status: 'queued' });
    const init = await makePng(8, 8);

    const out = await enqueueGpuClean({ initBuffer: init, sourceDims: { width: 8, height: 8 } });

    expect(out.jobId).toBe('aaaaaaaa-0000-4000-8000-000000000000');
    expect(out.modelId).toBe('flux2-klein-4b');
    // A job was enqueued with a NON-GALLERY output target + skipSidecar.
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    const { kind, params } = enqueueJob.mock.calls[0][0];
    expect(kind).toBe('image');
    expect(params.outputTarget.dir).toBe(TMP);
    expect(params.outputTarget.skipSidecar).toBe(true);
    // No regen lineage — a clean render is not a gallery variant of anything.
    expect(params.regenOf).toBeUndefined();
    // The init image is staged on disk and pointed at by the params.
    expect(params.initImagePath.startsWith(TMP)).toBe(true);
    expect(existsSync(params.initImagePath)).toBe(true);
    // A clean-meta sidecar records that no mask was staged.
    const clean = readdirSync(TMP).find((f) => f.endsWith('-clean.json'));
    expect(clean).toBeTruthy();
  });

  it('honors an explicit strength + max-MP override', async () => {
    resolveRegenBackend.mockResolvedValue(AVAILABLE);
    enqueueJob.mockReturnValue({ jobId: 'bbbbbbbb-0000-4000-8000-000000000000', position: 1, status: 'queued' });
    const init = await makePng(2000, 2000);

    const out = await enqueueGpuClean({ initBuffer: init, sourceDims: { width: 2000, height: 2000 }, strength: 0.4, maxMegapixels: 1.0 });

    expect(out.strength).toBe(0.4);
    const { params } = enqueueJob.mock.calls[0][0];
    expect(params.initImageStrength).toBe(0.4);
    // A 1.0-MP budget on a 4-MP source clamps the render below source dims.
    expect(params.width * params.height).toBeLessThanOrEqual(1.05 * 1_000_000);
    // Clamped → upscale-back to source dims is stamped.
    expect(params.upscaleTo).toEqual({ width: 2000, height: 2000 });
  });

  it('stages the mask + original when an ignore-zone rides along', async () => {
    resolveRegenBackend.mockResolvedValue(AVAILABLE);
    enqueueJob.mockReturnValue({ jobId: 'cccccccc-0000-4000-8000-000000000000', position: 1, status: 'queued' });
    const init = await makePng(8, 8);
    const original = await makePng(8, 8);
    const mask = await sharp(Buffer.alloc(8 * 8, 255), { raw: { width: 8, height: 8, channels: 1 } }).png().toBuffer();

    await enqueueGpuClean({ initBuffer: init, sourceDims: { width: 8, height: 8 }, originalBuffer: original, maskBuffer: mask, feather: 4 });

    const files = readdirSync(TMP);
    expect(files.some((f) => f.endsWith('-original.png'))).toBe(true);
    expect(files.some((f) => f.endsWith('-mask.png'))).toBe(true);
  });

  it('throws a 400 when no local FLUX runner is available (hardware gate)', async () => {
    resolveRegenBackend.mockResolvedValue({ available: false, reason: 'No local FLUX runner is installed.' });
    const init = await makePng();
    await expect(enqueueGpuClean({ initBuffer: init })).rejects.toMatchObject({ status: 400, code: 'REGEN_BACKEND_UNAVAILABLE' });
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('rejects an empty init buffer', async () => {
    await expect(enqueueGpuClean({ initBuffer: Buffer.alloc(0) })).rejects.toMatchObject({ status: 400 });
  });
});

describe('readGpuCleanResult', () => {
  it('returns the finished render bytes when present', async () => {
    const jobId = 'dddddddd-0000-4000-8000-000000000000';
    const render = await makePng(12, 12);
    writeFileSync(join(TMP, `${jobId}.png`), render);
    const out = await readGpuCleanResult(jobId);
    expect(out).toBeTruthy();
    expect(out.width).toBe(12);
    expect(out.composited).toBe(false);
  });

  it('returns null when the render is not on disk yet', async () => {
    const out = await readGpuCleanResult('eeeeeeee-0000-4000-8000-000000000000');
    expect(out).toBeNull();
  });

  it('composites the ignore-zone mask back over the render when one was staged', async () => {
    const jobId = 'ffffffff-0000-4000-8000-000000000000';
    // Render = solid black; original = solid white; full-white mask → the whole
    // frame is restored to the original (white) after the composite.
    const render = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
    const original = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
    const mask = await sharp(Buffer.alloc(8 * 8, 255), { raw: { width: 8, height: 8, channels: 1 } }).png().toBuffer();
    writeFileSync(join(TMP, `${jobId}.png`), render);
    writeFileSync(join(TMP, `${jobId}-original.png`), original);
    writeFileSync(join(TMP, `${jobId}-mask.png`), mask);
    writeFileSync(join(TMP, `${jobId}-clean.json`), JSON.stringify({ hasMask: true, feather: 0 }));

    const out = await readGpuCleanResult(jobId);
    expect(out.composited).toBe(true);
    // Center pixel should now be white (the original), not the rendered black.
    const { data } = await sharp(out.data).raw().toBuffer({ resolveWithObject: true });
    const mid = (4 * 8 + 4) * (data.length / (8 * 8));
    expect(data[Math.floor(mid)]).toBeGreaterThan(200);
  });
});

describe('getGpuCleanStatus', () => {
  it('reports unknown for a missing job', () => {
    getJob.mockReturnValue(null);
    expect(getGpuCleanStatus('x')).toEqual({ status: 'unknown' });
  });

  it('surfaces the queue job status + error', () => {
    getJob.mockReturnValue({ status: 'failed', error: 'boom' });
    expect(getGpuCleanStatus('x')).toEqual({ status: 'failed', error: 'boom' });
  });
});
