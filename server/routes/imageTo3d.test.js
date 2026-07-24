import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFile, rm } from 'node:fs/promises';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Mock the services so the route test is deterministic regardless of the test
// host's real arch/memory and never touches a real subprocess.
vi.mock('../services/imageTo3d/targets.js', () => ({
  detectHostCapabilities: vi.fn(() => ({ appleSilicon: true, unifiedMemoryGb: 128, cuda: false })),
  listTargets: vi.fn((caps) => [
    {
      id: 'trellis2',
      label: 'TRELLIS.2',
      executionLane: 'local-mps',
      outputKind: 'glb-mesh',
      available: caps.appleSilicon && caps.unifiedMemoryGb >= 24,
      unavailableReason: null,
    },
  ]),
  isTargetAvailable: vi.fn(() => true),
  unavailableReason: vi.fn(() => 'requires-apple-silicon'),
  IMAGE_TO_3D_TARGET_IDS: ['trellis2'],
}));

vi.mock('../services/imageTo3d/trellis2.js', () => ({
  isTrellis2Installed: vi.fn(() => false),
  trellis2Root: vi.fn(() => '/tmp/trellis2'),
  installTrellis2: vi.fn(({ onEvent }) => {
    onEvent({ type: 'stage', stage: 'clone', message: 'git clone …' });
    onEvent({ type: 'complete', message: 'TRELLIS.2 installed.' });
    return { promise: Promise.resolve({ ok: true }), kill: vi.fn() };
  }),
}));

vi.mock('../services/imageTo3d/models.js', () => ({
  listModels: vi.fn(),
  getModel: vi.fn(),
  createModel: vi.fn(),
  startGeneration: vi.fn(),
  deleteModel: vi.fn(),
  getModelAsset: vi.fn(),
}));

import * as targets from '../services/imageTo3d/targets.js';
import * as trellis2 from '../services/imageTo3d/trellis2.js';
import * as models from '../services/imageTo3d/models.js';
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
    expect(res.body.targets[0]).toMatchObject({ id: 'trellis2', available: true, installed: false });
  });
});

describe('GET /trellis2/install (SSE)', () => {
  it('streams stage → complete on the happy path', async () => {
    trellis2.isTrellis2Installed.mockReturnValueOnce(false);
    targets.isTargetAvailable.mockReturnValueOnce(true);
    const res = await request(makeApp()).get('/api/image-to-3d/trellis2/install');
    const frames = sseFrames(res.text);
    expect(frames).toContainEqual({ type: 'stage', stage: 'clone', message: 'git clone …' });
    expect(frames.at(-1)).toMatchObject({ type: 'complete' });
    expect(trellis2.installTrellis2).toHaveBeenCalled();
  });

  it('short-circuits with complete when already installed (no install spawned)', async () => {
    trellis2.installTrellis2.mockClear();
    trellis2.isTrellis2Installed.mockReturnValueOnce(true);
    const res = await request(makeApp()).get('/api/image-to-3d/trellis2/install');
    const frames = sseFrames(res.text);
    expect(frames.at(-1)).toMatchObject({ type: 'complete', message: expect.stringMatching(/already/i) });
    expect(trellis2.installTrellis2).not.toHaveBeenCalled();
  });

  it('appends a resume hint when the install fails with a transient network error', async () => {
    trellis2.isTrellis2Installed.mockReturnValueOnce(false);
    targets.isTargetAvailable.mockReturnValueOnce(true);
    trellis2.installTrellis2.mockImplementationOnce(() => ({
      promise: Promise.reject(Object.assign(
        new Error("TRELLIS.2 install step 'setup' exited 128"),
        { code: 'TRELLIS2_INSTALL_FAILED', stage: 'setup', transient: true },
      )),
      kill: vi.fn(),
    }));
    const res = await request(makeApp()).get('/api/image-to-3d/trellis2/install');
    const frames = sseFrames(res.text);
    expect(frames.at(-1)).toMatchObject({
      type: 'error',
      stage: 'setup',
      message: expect.stringMatching(/exited 128.*network hiccup — click Install again to resume/is),
    });
  });

  it('does NOT append the resume hint for a non-transient failure', async () => {
    trellis2.isTrellis2Installed.mockReturnValueOnce(false);
    targets.isTargetAvailable.mockReturnValueOnce(true);
    trellis2.installTrellis2.mockImplementationOnce(() => ({
      promise: Promise.reject(Object.assign(
        new Error('TRELLIS.2 install step \'setup\' exited 1'),
        { code: 'TRELLIS2_INSTALL_FAILED', stage: 'setup', transient: false },
      )),
      kill: vi.fn(),
    }));
    const res = await request(makeApp()).get('/api/image-to-3d/trellis2/install');
    const frames = sseFrames(res.text);
    expect(frames.at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/exited 1$/) });
    expect(frames.at(-1).message).not.toMatch(/network hiccup/i);
  });

  it('refuses on unsupported hardware', async () => {
    trellis2.installTrellis2.mockClear();
    trellis2.isTrellis2Installed.mockReturnValueOnce(false);
    targets.isTargetAvailable.mockReturnValueOnce(false);
    targets.unavailableReason.mockReturnValueOnce('requires-apple-silicon');
    const res = await request(makeApp()).get('/api/image-to-3d/trellis2/install');
    const frames = sseFrames(res.text);
    expect(frames.at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/requires-apple-silicon/) });
    expect(trellis2.installTrellis2).not.toHaveBeenCalled();
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
    expect(models.startGeneration).toHaveBeenCalledWith('image3d-1');
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
});
