import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFile, rm } from 'node:fs/promises';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Mock the services so the route test is deterministic regardless of the test
// host's real arch/memory and never touches a real subprocess.
vi.mock('../services/imageTo3d/targets.js', async (importOriginal) => ({
  ...(await importOriginal()),
  detectHostCapabilities: vi.fn(() => ({
    appleSilicon: true, unifiedMemoryGb: 128, cuda: true, cudaVramGb: 24, linuxHost: true,
  })),
}));

vi.mock('../lib/childProcess.js', async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: vi.fn(() => { throw new Error('Unexpected installer subprocess'); }),
}));

vi.mock('../services/imageTo3d/trellis2Cuda.js', async (importOriginal) => ({
  ...(await importOriginal()),
  isTrellis2CudaInstalled: vi.fn(() => false),
}));

vi.mock('../services/imageTo3d/pixal3dCuda.js', async (importOriginal) => ({
  ...(await importOriginal()),
  isPixal3dCudaInstalled: vi.fn(() => false),
}));

vi.mock('../services/imageTo3d/pixal3dMps.js', async (importOriginal) => ({
  ...(await importOriginal()),
  isPixal3dMpsInstalled: vi.fn(() => false),
}));

vi.mock('../services/imageTo3d/trellis2.js', async (importOriginal) => ({
  ...(await importOriginal()),
  isTrellis2Installed: vi.fn(() => false),
  runTrellis2Generate: vi.fn(),
  probeTrellis2TextureBake: vi.fn(async () => ({
    quality: 'metal', modules: {}, missing: [], degradedQuality: [],
  })),
}));

// Unresolved installers must refuse before resolving the Hugging Face credentials.
vi.mock('../services/hfToken.js', () => ({
  hfChildEnv: vi.fn(async () => ({ HF_TOKEN: 'hf_test', HUGGINGFACE_HUB_TOKEN: 'hf_test' })),
}));

vi.mock('../services/imageTo3d/models.js', () => ({
  listModels: vi.fn(),
  getModel: vi.fn(),
  createModel: vi.fn(),
  startGeneration: vi.fn(),
  deleteModel: vi.fn(),
  getModelAsset: vi.fn(),
  getModelFullMesh: vi.fn(),
  getModelUsdz: vi.fn(),
  saveModelUsdz: vi.fn(),
  USDZ_MAX_BYTES: 64 * 1024 * 1024,
}));

import * as targets from '../services/imageTo3d/targets.js';
import * as trellis2 from '../services/imageTo3d/trellis2.js';
import * as models from '../services/imageTo3d/models.js';
import { spawn } from '../lib/childProcess.js';
import { isTrellis2CudaInstalled } from '../services/imageTo3d/trellis2Cuda.js';
import { isPixal3dCudaInstalled } from '../services/imageTo3d/pixal3dCuda.js';
import { hfChildEnv } from '../services/hfToken.js';
import routes from './imageTo3d.js';

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/image-to-3d', routes);
  app.use(errorMiddleware);
  return app;
};

// Parse `data: {json}\n\n` SSE frames out of a buffered response body.
const sseFrames = (text) => text
  .split('\n')
  .filter((l) => l.startsWith('data: '))
  .map((l) => JSON.parse(l.slice(6)));

describe('image-to-3d routes', () => {
  it('GET /targets returns host capabilities and annotated targets', async () => {
    const res = await request(makeApp()).get('/api/image-to-3d/targets');
    expect(res.status).toBe(200);
    expect(res.body.capabilities).toMatchObject({ appleSilicon: true, unifiedMemoryGb: 128 });
    expect(Array.isArray(res.body.targets)).toBe(true);
    expect(res.body.targets[0]).toMatchObject({
      id: 'trellis2',
      available: true,
      installed: false,
      gatedRepos: [
        {
          label: 'facebook/dinov3-vitl16-pretrain-lvd1689m',
          url: 'https://huggingface.co/facebook/dinov3-vitl16-pretrain-lvd1689m',
        },
        { label: 'briaai/RMBG-2.0', url: 'https://huggingface.co/briaai/RMBG-2.0' },
      ],
    });
  });

  // #2952: an installed TRELLIS.2 whose Metal bake is missing still renders, but
  // the surface comes out scrambled — the client needs that distinction to avoid
  // showing a flat "Ready".
  it('GET /targets annotates an installed trellis2 with its texture-bake quality', async () => {
    trellis2.isTrellis2Installed.mockReturnValueOnce(true);
    trellis2.probeTrellis2TextureBake.mockResolvedValueOnce({
      quality: 'fallback', missing: ['mtldiffrast'], degradedQuality: [], modules: {}, help: 'fix it',
    });
    const res = await request(makeApp()).get('/api/image-to-3d/targets');
    expect(res.body.targets[0].textureBake).toMatchObject({ quality: 'fallback', help: 'fix it' });
  });

  // FINDING: the render-option projection had no route coverage at all, and the client
  // does `setRecord(next)` with the POST bodies — so a create/re-render response that
  // omitted the field blanked the disabled Quality control until the next poll.
  describe('supportsRenderOptions projection', () => {
    const record = (target) => ({ id: 'image3d-1', target, status: 'ready', runs: [] });

    it('projects the field onto GET, create, and re-render responses', async () => {
      const app = makeApp();
      models.getModel.mockResolvedValue(record('pixal3dCuda'));
      models.createModel.mockResolvedValue(record('pixal3dCuda'));
      models.startGeneration.mockResolvedValue(record('pixal3dCuda'));
      // Read from the registry rather than restated, so adding a knob to a
      // descriptor does not need an edit here to stay honest.
      const expected = targets.renderOptionSupportFor('pixal3dCuda');

      const get = await request(app).get('/api/image-to-3d/models/image3d-1');
      expect(get.body.supportsRenderOptions).toEqual(expected);

      const created = await request(app).post('/api/image-to-3d/models')
        .send({ filename: 'example.png', name: 'x' });
      expect(created.body.supportsRenderOptions).toEqual(expected);

      const regen = await request(app).post('/api/image-to-3d/models/image3d-1/generate').send({});
      expect(regen.body.supportsRenderOptions).toEqual(expected);
    });

    it('tells the client the detail control is unusable on a VRAM-derived lane', () => {
      // Pixal3D picks 1024/1536 from the card's VRAM, so a rendered-but-ignored
      // Detail control would be a lie about what the render will do.
      expect(targets.renderOptionSupportFor('pixal3dCuda').detail).toBe(false);
      expect(targets.renderOptionSupportFor('trellis2Cuda').detail).toBe(false);
      // The MPS lane is the one that honors it.
      expect(targets.renderOptionSupportFor('trellis2')).toBeNull();
    });

    it('omits the field for a target that honors every knob', async () => {
      // Absent must mean "all supported" so existing targets need no descriptor entry.
      models.getModel.mockResolvedValue(record('trellis2'));
      const res = await request(makeApp()).get('/api/image-to-3d/models/image3d-1');
      expect(res.body.supportsRenderOptions).toBeUndefined();
    });
  });

  // The `degraded` projection is what the CLIENT actually renders (badge, help panel,
  // Repair button); `textureBake` above is retained only for API back-compat and has no
  // in-repo reader. These cases pin the live contract, which was previously untested.
  it('GET /targets projects a degraded bake into the normalized `degraded` shape', async () => {
    trellis2.isTrellis2Installed.mockReturnValueOnce(true);
    trellis2.probeTrellis2TextureBake.mockResolvedValueOnce({
      quality: 'fallback', missing: ['mtldiffrast'], degradedQuality: [], modules: {}, help: 'fix it',
    });
    const res = await request(makeApp()).get('/api/image-to-3d/targets');
    expect(res.body.targets[0].degraded).toEqual({
      label: 'degraded textures',
      help: 'fix it',
      repairable: true,
      // #4636: `help` names the remedy, `detail` names what is actually missing —
      // without it a Repair that keeps failing only ever reprints the same sentence.
      detail: 'Missing: mtldiffrast',
    });
  });

  it('GET /targets omits `degraded` when the bake probe could not determine anything', async () => {
    // The sentinel that matters: 'unknown' must NOT read as degraded, or a probe that
    // simply failed makes a healthy install look broken.
    trellis2.isTrellis2Installed.mockReturnValueOnce(true);
    trellis2.probeTrellis2TextureBake.mockResolvedValueOnce({
      quality: 'unknown', missing: [], degradedQuality: [], modules: {},
    });
    const res = await request(makeApp()).get('/api/image-to-3d/targets');
    expect(res.body.targets[0].degraded).toBeUndefined();
  });

  it('GET /targets omits `degraded` for a healthy bake', async () => {
    trellis2.isTrellis2Installed.mockReturnValueOnce(true);
    const res = await request(makeApp()).get('/api/image-to-3d/targets');
    expect(res.body.targets[0].degraded).toBeUndefined();
  });

  it('GET /targets skips the bake probe entirely when trellis2 is not installed', async () => {
    trellis2.probeTrellis2TextureBake.mockClear();
    trellis2.isTrellis2Installed.mockReturnValueOnce(false);
    const res = await request(makeApp()).get('/api/image-to-3d/targets');
    expect(res.body.targets[0].textureBake).toBeUndefined();
    expect(trellis2.probeTrellis2TextureBake).not.toHaveBeenCalled();
  });
});

describe('image-to-3D install profile preflight', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['trellis2Cuda', isTrellis2CudaInstalled, /TRELLIS.2 CUDA.*PyTorch CUDA wheels/],
    ['pixal3dCuda', isPixal3dCudaInstalled, /Pixal3D CUDA.*MoGe, NATTEN/],
  ])('reports the unresolved %s profile for fresh Install and Repair', async (id, installed, missing) => {
    const app = makeApp();
    const path = `/api/image-to-3d/targets/${id}/install`;
    const status = await request(app).get(path);
    expect(status.status).toBe(200);
    expect(status.body.target).toMatchObject({
      id, available: true, installed: false, installBlockedReason: expect.stringMatching(missing),
    });
    const error = { type: 'error', stage: 'preflight', message: status.body.target.installBlockedReason };
    const fresh = await request(app).post(path);
    expect(sseFrames(fresh.text)).toEqual([error]);
    installed.mockReturnValueOnce(true);
    const repair = await request(app).post(`${path}?repair=1`);
    expect(sseFrames(repair.text)).toEqual([error]);
    expect(hfChildEnv).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    ['/api/image-to-3d/trellis2/install', false],
    ['/api/image-to-3d/targets/trellis2/install?repair=1', true],
  ])('runs the locked TRELLIS.2 installer through %s', async (path, repair) => {
    if (repair) trellis2.isTrellis2Installed.mockReturnValueOnce(true);
    spawn.mockImplementationOnce(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      process.nextTick(() => {
        child.stdout.emit('data', 'Native imports verified');
        child.emit('close', 0);
      });
      return child;
    });
    const app = makeApp();
    const res = await request(app).post(path);
    const frames = sseFrames(res.text);
    expect(frames).toContainEqual({ type: 'log', stage: 'bootstrap', message: 'Native imports verified' });
    expect(frames.at(-1)).toMatchObject({ type: 'complete' });
    expect(spawn).toHaveBeenCalledWith('bash', [
      expect.stringMatching(/setup-trellis2-mps\.sh$/), expect.stringMatching(/trellis2$/),
    ], expect.any(Object));
    expect(spawn.mock.calls[0][2].env).not.toHaveProperty('HF_TOKEN');
    expect(spawn.mock.calls[0][2].env).not.toHaveProperty('HUGGINGFACE_HUB_TOKEN');
  });

  it('keeps the already-installed response and its degraded runtime warning', async () => {
    trellis2.isTrellis2Installed.mockReturnValueOnce(true);
    trellis2.probeTrellis2TextureBake.mockResolvedValueOnce({
      quality: 'fallback', missing: ['mtldiffrast'], degradedQuality: [], modules: {}, help: 'Degraded textures.',
    });
    const res = await request(makeApp()).post('/api/image-to-3d/trellis2/install');
    const frames = sseFrames(res.text);
    expect(frames).toContainEqual({
      type: 'log', stage: 'verify', message: '⚠️ Degraded textures. Missing: mtldiffrast.',
    });
    expect(frames.at(-1)).toMatchObject({ type: 'complete', message: expect.stringMatching(/already/i) });
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('image-to-3d model records', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /models lists records', async () => {
    models.listModels.mockResolvedValue([{ id: 'image3d-1', status: 'ready' }]);
    const res = await request(makeApp()).get('/api/image-to-3d/models');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'image3d-1', status: 'ready' }]);
  });

  it('POST /models creates a record (202) from a validated gallery image', async () => {
    models.createModel.mockResolvedValue({ id: 'image3d-1', status: 'generating' });
    const res = await request(makeApp())
      .post('/api/image-to-3d/models')
      .send({ name: 'Beacon', filename: 'shot.png' });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ id: 'image3d-1', status: 'generating' });
    expect(models.createModel).toHaveBeenCalledWith(expect.objectContaining({ name: 'Beacon', filename: 'shot.png' }));
  });

  it('POST /models 400s on a non-image filename', async () => {
    const res = await request(makeApp())
      .post('/api/image-to-3d/models')
      .send({ name: 'Beacon', filename: 'not-an-image.txt' });
    expect(res.status).toBe(400);
    expect(models.createModel).not.toHaveBeenCalled();
  });

  it('POST /models 400s on a path-traversal filename', async () => {
    const res = await request(makeApp())
      .post('/api/image-to-3d/models')
      .send({ name: 'Beacon', filename: '../secrets.png' });
    expect(res.status).toBe(400);
    expect(models.createModel).not.toHaveBeenCalled();
  });

  it('GET /models/:id 404s when absent', async () => {
    models.getModel.mockResolvedValue(null);
    const res = await request(makeApp()).get('/api/image-to-3d/models/nope');
    expect(res.status).toBe(404);
  });

  it('POST /models/:id/generate re-renders (202)', async () => {
    models.startGeneration.mockResolvedValue({ id: 'image3d-1', status: 'generating' });
    const res = await request(makeApp()).post('/api/image-to-3d/models/image3d-1/generate');
    expect(res.status).toBe(202);
    // A bodiless re-render forwards empty options — stored renderOptions apply.
    expect(models.startGeneration).toHaveBeenCalledWith('image3d-1', { options: {} });
  });

  it('POST /models/:id/generate forwards per-run options and rejects invalid ones', async () => {
    models.startGeneration.mockResolvedValue({ id: 'image3d-1', status: 'generating' });
    const res = await request(makeApp())
      .post('/api/image-to-3d/models/image3d-1/generate')
      .send({ steps: 24, seed: 7, keyBackground: false });
    expect(res.status).toBe(202);
    expect(models.startGeneration).toHaveBeenCalledWith(
      'image3d-1',
      { options: { steps: 24, seed: 7, keyBackground: false } },
    );

    const bad = await request(makeApp())
      .post('/api/image-to-3d/models/image3d-1/generate')
      .send({ steps: 999 });
    expect(bad.status).toBe(400);
  });

  it('POST /models/:id/generate takes a subject scale in (0, 1] and 400s outside it', async () => {
    models.startGeneration.mockResolvedValue({ id: 'image3d-1', status: 'generating' });
    const ok = await request(makeApp())
      .post('/api/image-to-3d/models/image3d-1/generate')
      .send({ subjectScale: 0.65 });
    expect(ok.status).toBe(202);
    expect(models.startGeneration).toHaveBeenCalledWith('image3d-1', { options: { subjectScale: 0.65 } });

    // 0 scales the subject out of existence; above 1 crops it — which is the exact
    // failure the knob exists to prevent, so it must not be reachable by accident.
    for (const subjectScale of [0, -0.5, 1.5]) {
      const bad = await request(makeApp())
        .post('/api/image-to-3d/models/image3d-1/generate')
        .send({ subjectScale });
      expect(bad.status, `subjectScale ${subjectScale}`).toBe(400);
    }
  });

  it('DELETE /models/:id soft-deletes', async () => {
    models.deleteModel.mockResolvedValue({ ok: true });
    const res = await request(makeApp()).delete('/api/image-to-3d/models/image3d-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('GET /models/:id/asset streams the GLB with a download filename', async () => {
    const tmp = join(tmpdir(), `it-asset-${process.pid}.glb`);
    await writeFile(tmp, 'GLB-BYTES');
    models.getModelAsset.mockResolvedValue({ path: tmp, filename: 'beacon.glb' });
    const res = await request(makeApp()).get('/api/image-to-3d/models/image3d-1/asset');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/model\/gltf-binary/);
    expect(res.headers['content-disposition']).toMatch(/beacon\.glb/);
    expect(res.text).toBe('GLB-BYTES');
    await rm(tmp, { force: true });
  });

  it('GET /models/:id/asset 409s when the mesh is not ready', async () => {
    const { ServerError } = await import('../lib/errorHandler.js');
    models.getModelAsset.mockRejectedValue(new ServerError('not ready', { status: 409, code: 'MODEL_NOT_READY' }));
    const res = await request(makeApp()).get('/api/image-to-3d/models/image3d-1/asset');
    expect(res.status).toBe(409);
  });

  it('GET /models/:id/full-mesh streams the pre-decimation OBJ', async () => {
    const tmp = join(tmpdir(), `it-full-${process.pid}.obj`);
    await writeFile(tmp, 'v 0 0 0\nf 1 1 1\n');
    models.getModelFullMesh.mockResolvedValue({ path: tmp, filename: 'beacon-full.obj' });
    const res = await request(makeApp()).get('/api/image-to-3d/models/image3d-1/full-mesh');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/model\/obj/);
    expect(res.headers['content-disposition']).toMatch(/beacon-full\.obj/);
    await rm(tmp, { force: true });
  });

  it('GET /models/:id/full-mesh 404s when the sidecar was never written', async () => {
    // A missing OBJ is NOT a broken record — older renders simply have none, so it
    // must not read as the model being unavailable.
    const { ServerError } = await import('../lib/errorHandler.js');
    models.getModelFullMesh.mockRejectedValue(
      new ServerError('no full mesh', { status: 404, code: 'FULL_MESH_MISSING' }),
    );
    const res = await request(makeApp()).get('/api/image-to-3d/models/image3d-1/full-mesh');
    expect(res.status).toBe(404);
    expect(res.body?.error?.code || res.body?.code).toBe('FULL_MESH_MISSING');
  });

  // ── AR Quick Look (USDZ) ────────────────────────────────────────────────
  // The bytes are produced in the browser, so the route's whole job is to accept a
  // raw body past the app-wide JSON parser, persist it, and re-serve it with the
  // exact content type + disposition AR Quick Look requires.

  // A minimal stored-zip header — USDZ is an uncompressed zip, and the service
  // gates on that magic rather than trusting the request's content type.
  const ZIP_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);

  it('POST /models/:id/usdz accepts a raw USDZ body past the JSON parser', async () => {
    models.saveModelUsdz.mockResolvedValue({
      id: 'image3d-1', status: 'ready', usdzPath: '/data/image-to-3d/image3d-1/model.usdz',
    });
    const res = await request(makeApp())
      .post('/api/image-to-3d/models/image3d-1/usdz')
      .set('Content-Type', 'model/vnd.usdz+zip')
      .send(ZIP_BYTES);
    expect(res.status).toBe(201);
    expect(res.body.usdzPath).toBe('/data/image-to-3d/image3d-1/model.usdz');
    const [id, body] = models.saveModelUsdz.mock.calls.at(-1);
    expect(id).toBe('image3d-1');
    expect(Buffer.from(body).equals(ZIP_BYTES)).toBe(true);
  });

  it('POST /models/:id/usdz surfaces the service refusal for a non-USDZ payload', async () => {
    const { ServerError } = await import('../lib/errorHandler.js');
    models.saveModelUsdz.mockRejectedValue(
      new ServerError('Payload is not a USDZ archive', { status: 400, code: 'USDZ_INVALID' }),
    );
    const res = await request(makeApp())
      .post('/api/image-to-3d/models/image3d-1/usdz')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('not a zip'));
    expect(res.status).toBe(400);
    expect(res.body?.error?.code || res.body?.code).toBe('USDZ_INVALID');
  });

  it('GET /models/:id/usdz serves inline with the AR Quick Look content type', async () => {
    // `inline`, not `attachment`: Safari will not engage AR Quick Look on an
    // attachment response, so this header pair IS the feature.
    const tmp = join(tmpdir(), `it-usdz-${process.pid}.usdz`);
    await writeFile(tmp, ZIP_BYTES);
    models.getModelUsdz.mockResolvedValue({ path: tmp, filename: 'beacon.usdz' });
    const res = await request(makeApp()).get('/api/image-to-3d/models/image3d-1/usdz');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/model\/vnd\.usdz\+zip/);
    expect(res.headers['content-disposition']).toMatch(/^inline; filename="beacon\.usdz"$/);
    await rm(tmp, { force: true });
  });

  it('GET /models/:id/usdz 404s when the model was never exported for AR', async () => {
    const { ServerError } = await import('../lib/errorHandler.js');
    models.getModelUsdz.mockRejectedValue(
      new ServerError('not exported', { status: 404, code: 'USDZ_MISSING' }),
    );
    const res = await request(makeApp()).get('/api/image-to-3d/models/image3d-1/usdz');
    expect(res.status).toBe(404);
    expect(res.body?.error?.code || res.body?.code).toBe('USDZ_MISSING');
  });

  it('routes /full-mesh to its own handler with the record id', async () => {
    // Deliberately NOT claiming this proves route ordering: Express's `:id` matches a
    // single path segment, so `/models/x/full-mesh` can never match `/models/:id`
    // regardless of registration order. What it does pin is that the id is parsed
    // from the right segment and reaches the handler.
    models.getModelFullMesh.mockRejectedValue(new Error('boom'));
    await request(makeApp()).get('/api/image-to-3d/models/image3d-1/full-mesh');
    expect(models.getModelFullMesh).toHaveBeenCalledWith('image3d-1');
  });
});
