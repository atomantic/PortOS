import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request, startLoopbackServer, closeLoopbackServer } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Integrity / repair routes (issue #1324). Mocks mediaModels + hfCache so the
// thin route glue is exercised in isolation; the real structural/sha256 logic
// is covered in lib/hfCache.test.js. The remaining mock set mirrors
// imageGen.test.js so the route's import graph links under vitest.

vi.mock('../lib/mediaModels.js', () => ({
  getImageModels: vi.fn(() => [{ id: 'flux2', name: 'FLUX.2' }]),
  isFlux2: vi.fn(() => true),
  isEditOnly: vi.fn(() => false),
  repoForModel: vi.fn((m) => `org/${m.id}`),
  requiredReposForModel: vi.fn((m) => [`org/${m.id}`]),
}));

// Keep the real pure helpers (summarizeVerify/aggregateVerifies); only stub the
// IO-bound inspect/verify/repair so we don't touch a real HF cache.
vi.mock('../lib/hfCache.js', async (importOriginal) => ({
  ...(await importOriginal()),
  inspectModelCache: vi.fn(async () => ({ cached: true, sizeBytes: 100, snapshotPath: '/snap' })),
  verifyModelCache: vi.fn(async (repoId, opts) => ({
    repoId, status: 'bad', cached: false, sizeBytes: 0, snapshotPath: '/snap',
    checkedDeep: !!opts?.deep,
    files: [{ name: 'model.safetensors', path: '/snap/model.safetensors', ok: false, reason: 'truncated-data', sizeBytes: 10 }],
  })),
  repairModelCache: vi.fn(async (repoId) => ({ repoId, status: 'bad', deleted: ['model.safetensors'] })),
}));

vi.mock('../services/imageGen/index.js', () => ({
  checkConnection: vi.fn(),
  generateImage: vi.fn(),
  generateAvatar: vi.fn(),
  attachSseClient: vi.fn(() => false),
  cancel: vi.fn(() => false),
  IMAGE_GEN_MODE: { EXTERNAL: 'external', LOCAL: 'local', CODEX: 'codex' },
  IMAGE_GEN_MODES: ['external', 'local', 'codex'],
  resolveImageCleaners: () => ({ cleanC2PA: true, denoise: false }),
  local: { listImageModels: vi.fn(() => []) },
}));

vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(async () => ({ imageGen: { mode: 'external' } })),
  updateSettingsWith: vi.fn(async () => {}),
  settingsEvents: { on: () => {}, emit: () => {} },
}));

vi.mock('../services/mediaJobQueue/index.js', () => ({
  enqueueJob: vi.fn(() => ({ jobId: 'mock', position: 1, status: 'queued' })),
  attachSseClient: vi.fn(() => false),
  cancelJob: vi.fn(async () => ({ ok: true })),
  listJobs: vi.fn(() => []),
}));

vi.mock('../lib/pythonSetup.js', async (importOriginal) => ({
  ...(await importOriginal()),
  isFlux2VenvHealthy: vi.fn(async () => true),
  isFlux2InstallSatisfied: vi.fn(async () => true),
  resolveFlux2Python: vi.fn(() => null),
}));

vi.mock('../services/hfDownloadStream.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, startHfDownloadStream: vi.fn(actual.startHfDownloadStream) };
});
vi.mock('../services/hfDownload.js', () => ({ downloadHfRepo: vi.fn() }));
vi.mock('../services/modelManifest.js', () => ({ recordModelInstall: vi.fn(async () => null) }));
import { startHfDownloadStream } from '../services/hfDownloadStream.js';
import { downloadHfRepo } from '../services/hfDownload.js';
import imageGenRoutes from './imageGen.js';
import { verifyModelCache, repairModelCache } from '../lib/hfCache.js';

describe('Image Gen integrity routes', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/image-gen', imageGenRoutes);
    app.use(errorMiddleware);
    vi.clearAllMocks();
  });

  it('GET download is a read-only cache entry even with force=1', async () => {
    const collection = await request(app).get('/api/image-gen/models/status');
    const response = await request(app).get('/api/image-gen/models/flux2/download?force=1');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body).toEqual(collection.body[0]);
    expect(startHfDownloadStream).not.toHaveBeenCalled();
    expect(downloadHfRepo).not.toHaveBeenCalled();
  });

  it('POST streams progress and completion, and returns JSON errors before opening SSE', async () => {
    downloadHfRepo.mockImplementation(({ onEvent }) => {
      onEvent({ type: 'stage', stage: 'download' });
      onEvent({ type: 'progress', downloaded: 10, total: 10 });
      return { promise: Promise.resolve({ ok: true, sizeBytes: 10 }), kill: vi.fn() };
    });
    const response = await request(app).post('/api/image-gen/models/flux2/download?force=1').send({});
    expect(response.headers['content-type']).toMatch(/text\/event-stream/);
    const frames = response.text.trim().split('\n\n').map(line => JSON.parse(line.slice(6)));
    expect(frames.map(frame => frame.type)).toEqual(['stage', 'progress', 'complete']);
    for (const [path, status] of [['flux2/download?force=yes', 400], ['flux2/download?force=1&force=0', 400], ['unknown/download', 404]]) {
      const failure = await request(app).post(`/api/image-gen/models/${path}`);
      expect(failure.status).toBe(status);
      expect(failure.headers['content-type']).toMatch(/application\/json/);
      expect(failure.body).toMatchObject({ error: expect.any(String), code: expect.any(String), timestamp: expect.any(Number) });
    }
    expect(downloadHfRepo).toHaveBeenCalledTimes(1);
  });

  it('POST download errors keep their SSE frame and a disconnect kills the active child', async () => {
    downloadHfRepo.mockImplementationOnce(() => ({
      promise: Promise.resolve({ ok: false, errorKind: 'gated_repo', errorMessage: 'Accept the license' }), kill: vi.fn(),
    }));
    const failed = await request(app).post('/api/image-gen/models/flux2/download?force=1');
    expect(failed.text).toContain('"type":"error"');
    expect(failed.text).toContain('gated_repo');
    let finish;
    const kill = vi.fn(() => finish({ ok: false, errorKind: 'cancelled' }));
    downloadHfRepo.mockImplementationOnce(({ onEvent }) => {
      onEvent({ type: 'stage', stage: 'download' });
      return { promise: new Promise(resolve => { finish = resolve; }), kill };
    });
    const server = await startLoopbackServer(app);
    const controller = new AbortController();
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/image-gen/models/flux2/download?force=1`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: controller.signal,
      });
      expect(response.status).toBe(200);
      expect(kill).not.toHaveBeenCalled();
      controller.abort();
      await vi.waitFor(() => expect(kill).toHaveBeenCalledOnce());
    } finally {
      controller.abort();
      finish?.({ ok: false, errorKind: 'cancelled' });
      await closeLoopbackServer(server);
    }
  });

  it('GET /models/status surfaces an integrity block for cached models', async () => {
    const res = await request(app).get('/api/image-gen/models/status');
    expect(res.status).toBe(200);
    const entry = res.body.find((m) => m.id === 'flux2');
    expect(entry.cached).toBe(true);
    expect(entry.integrity.status).toBe('bad');
    expect(entry.integrity.badFiles[0].name).toBe('model.safetensors');
  });

  it('POST /models/verify runs a deep scan and returns per-model status', async () => {
    const res = await request(app).post('/api/image-gen/models/verify').send({ deep: true });
    expect(res.status).toBe(200);
    expect(res.body.deep).toBe(true);
    expect(res.body.models[0].status).toBe('bad');
    // deep:true must reach verifyModelCache
    expect(verifyModelCache).toHaveBeenCalledWith('org/flux2', { deep: true });
  });

  it('POST /models/:id/repair deletes flagged files and reports them', async () => {
    const res = await request(app).post('/api/image-gen/models/flux2/repair').send({});
    expect(res.status).toBe(200);
    expect(res.body.deleted).toEqual([{ repo: 'org/flux2', name: 'model.safetensors' }]);
    expect(repairModelCache).toHaveBeenCalledWith('org/flux2', { deep: false });
  });

  it('POST /models/:id/repair 404s for an unknown model', async () => {
    const res = await request(app).post('/api/image-gen/models/nope/repair').send({});
    expect(res.status).toBe(404);
  });
});
