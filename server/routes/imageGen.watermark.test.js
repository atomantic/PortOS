import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import sharp from 'sharp';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Sandbox PATHS.images to a tmp dir (same pattern as imageGen.clean.test.js) so
// the remove-watermark endpoint reads/writes real files without touching
// data/images/. Mock installed before the route module imports fileUtils.js.
let sandbox;

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return {
    ...actual,
    get PATHS() {
      return { ...actual.PATHS, images: sandbox };
    },
  };
});

vi.mock('../services/imageGen/index.js', async () => {
  const actual = await vi.importActual('../services/imageGen/index.js');
  return {
    ...actual,
    checkConnection: vi.fn(),
    generateImage: vi.fn(),
    generateAvatar: vi.fn(),
    attachSseClient: vi.fn(() => false),
    cancel: vi.fn(() => false),
  };
});

vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(async () => ({ imageGen: { mode: 'external' } })),
}));

vi.mock('../services/mediaJobQueue/index.js', () => ({
  enqueueJob: vi.fn(),
  attachSseClient: vi.fn(() => false),
  cancelJob: vi.fn(),
  listJobs: vi.fn(() => []),
}));

const { listCollectionsMock, addItemMock } = vi.hoisted(() => ({
  listCollectionsMock: vi.fn(async () => []),
  addItemMock: vi.fn(async () => ({})),
}));
vi.mock('../services/mediaCollections.js', () => ({
  listCollections: listCollectionsMock,
  addItem: addItemMock,
  ERR_DUPLICATE: 'DUPLICATE',
}));

let imageGenRoutes;
let watermarkedPng;

// Build a 128×128 PNG with a flat background and a bright white box stamped
// into the bottom-right corner — stands in for the Gemini ✦ sparkle.
async function makeWatermarkedPng(w = 128, h = 128, box = 20) {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const inBox = x >= w - box && y >= h - box;
      raw[i] = inBox ? 255 : 40;
      raw[i + 1] = inBox ? 255 : 60;
      raw[i + 2] = inBox ? 255 : 90;
    }
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'portos-watermark-'));
  ({ default: imageGenRoutes } = await import('./imageGen.js'));
  watermarkedPng = await makeWatermarkedPng();
});

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('POST /api/image-gen/:filename/remove-watermark', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/image-gen', imageGenRoutes);
    app.use(errorMiddleware);
    listCollectionsMock.mockReset();
    listCollectionsMock.mockResolvedValue([]);
    addItemMock.mockReset();
    addItemMock.mockResolvedValue({});
  });

  it('writes a _nowatermark.png variant + sidecar and carries the source lineage', async () => {
    await writeFile(join(sandbox, 'wm-1.png'), watermarkedPng);
    await writeFile(join(sandbox, 'wm-1.metadata.json'), JSON.stringify({
      prompt: 'a sunset', seed: 7, modelId: 'gemini',
    }));

    const res = await request(app).post('/api/image-gen/wm-1.png/remove-watermark').send({});
    expect(res.status).toBe(200);
    expect(res.body.filename).toBe('wm-1_nowatermark.png');
    expect(res.body.cleanedFrom).toBe('wm-1.png');
    expect(res.body.watermarkRemoved).toBe(true);
    expect(res.body.watermarkRegion).toMatchObject({ x: expect.any(Number), w: expect.any(Number) });
    // Source sidecar carried forward.
    expect(res.body.prompt).toBe('a sunset');
    expect(res.body.modelId).toBe('gemini');

    expect(existsSync(join(sandbox, 'wm-1_nowatermark.png'))).toBe(true);
    expect(existsSync(join(sandbox, 'wm-1_nowatermark.metadata.json'))).toBe(true);
  });

  it('strips regen lineage from a de-watermarked REGEN source so it labels as watermark-removed, not regenerated', async () => {
    // Source is itself a SynthID-defeat regen (issue #912). Removing the ✦ from
    // it must NOT inherit `regenerated:true` + stale fidelity numbers — both the
    // lightbox lineage and variant grouping check `regenerated` BEFORE
    // `watermarkRemoved`, so it would otherwise mislabel as "Regenerated …".
    await writeFile(join(sandbox, 'regen-1.png'), watermarkedPng);
    await writeFile(join(sandbox, 'regen-1.metadata.json'), JSON.stringify({
      prompt: 'a sunset', seed: 7, modelId: 'gemini',
      cleanedFrom: 'orig.png',
      regenerated: true, regenStrength: 0.4, regenSteps: 28,
      regenModelId: 'flux', regenPixelDeltaPct: 12, regenPsnr: 31, regenMethod: 'flux',
    }));

    const res = await request(app).post('/api/image-gen/regen-1.png/remove-watermark').send({});
    expect(res.status).toBe(200);
    expect(res.body.watermarkRemoved).toBe(true);
    // Regen lineage fields gone → describeCleanedLineage falls to the
    // watermarkRemoved branch, not the regenerated branch.
    expect(res.body.regenerated).toBeUndefined();
    expect(res.body.regenStrength).toBeUndefined();
    expect(res.body.regenSteps).toBeUndefined();
    expect(res.body.regenModelId).toBeUndefined();
    expect(res.body.regenPixelDeltaPct).toBeUndefined();
    expect(res.body.regenPsnr).toBeUndefined();
    expect(res.body.regenMethod).toBeUndefined();
    // Non-regen lineage still carried + group anchored at the root original.
    expect(res.body.prompt).toBe('a sunset');
    expect(res.body.cleanedFrom).toBe('orig.png');
  });

  it('actually erases the bright corner mark', async () => {
    await writeFile(join(sandbox, 'wm-erase.png'), watermarkedPng);
    const res = await request(app).post('/api/image-gen/wm-erase.png/remove-watermark').send({});
    expect(res.status).toBe(200);
    const out = await readFile(join(sandbox, res.body.filename));
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    // A pixel that was inside the white box should now be near the background.
    const px = info.width - 4; const py = info.height - 4;
    const i = (py * info.width + px) * info.channels;
    expect(data[i]).toBeLessThan(160);
  });

  it('anchors the region to the bottom-right corner of the image', async () => {
    await writeFile(join(sandbox, 'wm-region.png'), watermarkedPng);
    const res = await request(app).post('/api/image-gen/wm-region.png/remove-watermark').send({});
    const r = res.body.watermarkRegion;
    expect(r.x + r.w).toBe(res.body.width);
    expect(r.y + r.h).toBe(res.body.height);
  });

  it('honors an explicit region override', async () => {
    await writeFile(join(sandbox, 'wm-override.png'), watermarkedPng);
    const res = await request(app)
      .post('/api/image-gen/wm-override.png/remove-watermark')
      .send({ region: { x: 60, y: 60, w: 40, h: 40 } });
    expect(res.status).toBe(200);
    expect(res.body.watermarkRegion).toEqual({ x: 60, y: 60, w: 40, h: 40 });
  });

  it('rejects non-PNG filenames (gallery is PNG-only)', async () => {
    const res = await request(app).post('/api/image-gen/photo.jpg/remove-watermark').send({});
    expect(res.status).toBe(400);
  });

  it('rejects path-traversal in filename', async () => {
    const res = await request(app)
      .post('/api/image-gen/' + encodeURIComponent('../etc/passwd.png') + '/remove-watermark')
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 404 when the source image does not exist', async () => {
    const res = await request(app).post('/api/image-gen/missing.png/remove-watermark').send({});
    expect(res.status).toBe(404);
  });

  it('files the variant into every collection that contained the source', async () => {
    await writeFile(join(sandbox, 'wm-coll.png'), watermarkedPng);
    listCollectionsMock.mockResolvedValue([
      { id: 'col-a', items: [{ kind: 'image', ref: 'wm-coll.png' }] },
      { id: 'col-unrelated', items: [{ kind: 'image', ref: 'other.png' }] },
    ]);
    const res = await request(app).post('/api/image-gen/wm-coll.png/remove-watermark').send({});
    expect(res.status).toBe(200);
    expect(addItemMock).toHaveBeenCalledTimes(1);
    expect(addItemMock).toHaveBeenCalledWith('col-a', { kind: 'image', ref: 'wm-coll_nowatermark.png' });
  });
});
