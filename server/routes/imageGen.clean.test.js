import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import sharp from 'sharp';
import { mkdtemp, rm, writeFile, readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Sandbox PATHS.images to a tmp dir so the clean endpoint can read/write real
// files without touching data/images/. The mock has to be installed BEFORE the
// route module imports fileUtils.js, hence the dynamic import below.
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

// Partial mock: keep the real `local` namespace (for assertGalleryFilename /
// readImageSidecar / etc.) and just stub out the dispatcher entry points so
// /generate doesn't try to spin up an actual provider during tests.
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
tryReadFile: vi.fn().mockResolvedValue(null),
  getSettings: vi.fn(async () => ({ imageGen: { mode: 'external' } })),
}));

vi.mock('../services/mediaJobQueue/index.js', () => ({
  enqueueJob: vi.fn(),
  attachSseClient: vi.fn(() => false),
  cancelJob: vi.fn(),
  listJobs: vi.fn(() => []),
}));

let imageGenRoutes;
let pngFixture;

beforeAll(async () => {
  // Tmp dir created before route import so the mocked PATHS.images resolves
  // to a real path when the route reads from it.
  sandbox = await mkdtemp(join(tmpdir(), 'portos-imageclean-'));
  ({ default: imageGenRoutes } = await import('./imageGen.js'));
  // Noisy 16×16 RGB so light vs aggressive denoise produce visibly different
  // outputs. A solid-color fixture would round-trip identically through both.
  const raw = Buffer.alloc(16 * 16 * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 73 + 11) % 256;
  pngFixture = await sharp(raw, { raw: { width: 16, height: 16, channels: 3 } })
    .png()
    .toBuffer();
});

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('POST /api/image-gen/:filename/clean', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/image-gen', imageGenRoutes);
    app.use(errorMiddleware);
  });

  it('cleans an existing PNG and writes _clean-light.png back to the gallery', async () => {
    await writeFile(join(sandbox, 'render-1.png'), pngFixture);
    await writeFile(join(sandbox, 'render-1.metadata.json'), JSON.stringify({
      prompt: 'a red square', seed: 42, modelId: 'flux-v1',
    }));

    const res = await request(app).post('/api/image-gen/render-1.png/clean').send({ level: 'light' });
    expect(res.status).toBe(200);
    expect(res.body.filename).toBe('render-1_clean-light.png');
    expect(res.body.cleanedFrom).toBe('render-1.png');
    expect(res.body.cleanLevel).toBe('light');
    // Source sidecar carried forward so the cleaned copy retains lineage.
    expect(res.body.prompt).toBe('a red square');
    expect(res.body.seed).toBe(42);
    expect(res.body.modelId).toBe('flux-v1');

    expect(existsSync(join(sandbox, 'render-1_clean-light.png'))).toBe(true);
    expect(existsSync(join(sandbox, 'render-1_clean-light.metadata.json'))).toBe(true);
  });

  it('aggressive level produces a different output than light (different denoise)', async () => {
    await writeFile(join(sandbox, 'render-2.png'), pngFixture);

    const lightRes = await request(app).post('/api/image-gen/render-2.png/clean').send({ level: 'light' });
    const aggRes = await request(app).post('/api/image-gen/render-2.png/clean').send({ level: 'aggressive' });
    expect(lightRes.status).toBe(200);
    expect(aggRes.status).toBe(200);
    expect(lightRes.body.filename).toBe('render-2_clean-light.png');
    expect(aggRes.body.filename).toBe('render-2_clean-aggressive.png');

    const lightBuf = await readFile(join(sandbox, lightRes.body.filename));
    const aggBuf = await readFile(join(sandbox, aggRes.body.filename));
    expect(lightBuf.equals(aggBuf)).toBe(false);
  });

  it('idempotent: running the same level twice overwrites instead of accumulating', async () => {
    await writeFile(join(sandbox, 'render-3.png'), pngFixture);
    const first = await request(app).post('/api/image-gen/render-3.png/clean').send({ level: 'light' });
    const second = await request(app).post('/api/image-gen/render-3.png/clean').send({ level: 'light' });
    expect(first.body.filename).toBe(second.body.filename);
    expect(first.body.filename).toBe('render-3_clean-light.png');
  });

  it('defaults to light when level omitted', async () => {
    await writeFile(join(sandbox, 'render-4.png'), pngFixture);
    const res = await request(app).post('/api/image-gen/render-4.png/clean').send({});
    expect(res.status).toBe(200);
    expect(res.body.cleanLevel).toBe('light');
  });

  it('rejects unknown level', async () => {
    await writeFile(join(sandbox, 'render-5.png'), pngFixture);
    const res = await request(app).post('/api/image-gen/render-5.png/clean').send({ level: 'extreme' });
    expect(res.status).toBe(400);
  });

  it('rejects non-PNG filenames (gallery is PNG-only)', async () => {
    const res = await request(app).post('/api/image-gen/render.jpg/clean').send({ level: 'light' });
    expect(res.status).toBe(400);
  });

  it('rejects path-traversal in filename', async () => {
    const res = await request(app).post('/api/image-gen/' + encodeURIComponent('../etc/passwd.png') + '/clean').send({ level: 'light' });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the source image does not exist', async () => {
    const res = await request(app).post('/api/image-gen/does-not-exist.png/clean').send({ level: 'light' });
    expect(res.status).toBe(404);
  });

  it('writes a sidecar that records the cleaning lineage', async () => {
    await writeFile(join(sandbox, 'render-6.png'), pngFixture);
    await request(app).post('/api/image-gen/render-6.png/clean').send({ level: 'aggressive' });
    const sidecar = JSON.parse(await readFile(join(sandbox, 'render-6_clean-aggressive.metadata.json'), 'utf-8'));
    expect(sidecar.cleanedFrom).toBe('render-6.png');
    expect(sidecar.cleanLevel).toBe('aggressive');
    expect(typeof sidecar.createdAt).toBe('string');
  });

  it('strips hidden=true from the cleaned copy so it surfaces in the gallery', async () => {
    await writeFile(join(sandbox, 'render-hidden.png'), pngFixture);
    await writeFile(join(sandbox, 'render-hidden.metadata.json'), JSON.stringify({
      prompt: 'a hidden render', hidden: true,
    }));
    const res = await request(app).post('/api/image-gen/render-hidden.png/clean').send({ level: 'light' });
    expect(res.status).toBe(200);
    expect(res.body.hidden).toBeUndefined();
    expect(res.body.prompt).toBe('a hidden render');

    const sidecar = JSON.parse(await readFile(join(sandbox, 'render-hidden_clean-light.metadata.json'), 'utf-8'));
    expect(sidecar.hidden).toBeUndefined();
  });

  it('accepts legitimate filenames containing `..` substring (not exact `..`)', async () => {
    await writeFile(join(sandbox, 'my..render.png'), pngFixture);
    const res = await request(app).post(`/api/image-gen/${encodeURIComponent('my..render.png')}/clean`).send({ level: 'light' });
    expect(res.status).toBe(200);
    expect(res.body.filename).toBe('my..render_clean-light.png');
  });

  it('output file size is reflected in sizeBytes / sizeAfter', async () => {
    await writeFile(join(sandbox, 'render-7.png'), pngFixture);
    const res = await request(app).post('/api/image-gen/render-7.png/clean').send({ level: 'light' });
    const s = await stat(join(sandbox, res.body.filename));
    expect(res.body.sizeBytes).toBe(s.size);
    expect(res.body.sizeAfter).toBe(s.size);
  });
});
