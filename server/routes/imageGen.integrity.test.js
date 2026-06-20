import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
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
  resolveFlux2Python: vi.fn(() => null),
}));

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
