import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Integrity / repair routes (issue #1324). Mocks mediaModels + hfCache so the
// thin route glue is exercised in isolation; the real structural/sha256 logic
// is covered in lib/hfCache.test.js. The remaining mock set mirrors
// videoGen.test.js so the route's import graph links under vitest.

vi.mock('../lib/mediaModels.js', () => ({
  repoForModel: vi.fn((m) => `org/${m.id}`),
  getTextEncoderRepo: vi.fn(() => 'org/text-encoder'),
  isHfRepoId: vi.fn(() => true),
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

vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(async () => ({ imageGen: { local: { pythonPath: '/usr/bin/python3' } } })),
}));

vi.mock('../lib/pythonSetup.js', () => ({
  checkPackages: vi.fn(async () => ({ installed: [], missing: [], missingPip: [] })),
  isAllowedPython: vi.fn(() => true),
}));

vi.mock('../services/videoGen/local.js', () => ({
  listVideoModels: vi.fn(() => [{ id: 'ltx2_unified', name: 'LTX-2 Unified', runtime: 'ltx2' }]),
  defaultVideoModelId: vi.fn(() => 'ltx2_unified'),
  loadHistory: vi.fn(async () => []),
  deleteHistoryItem: vi.fn(),
  setHistoryItemHidden: vi.fn(),
  extractLastFrame: vi.fn(),
  stitchVideos: vi.fn(),
  upscaleHistoryItem: vi.fn(),
  DEFAULT_NUM_FRAMES: 121,
  resolveFflfLtx2PixelBudget: vi.fn(() => 1000),
  BYOV_VIDEO_RUNTIMES: new Set(['ltx2']),
  BYOV_RUNTIME_INFO: { ltx2: { id: 'ltx2', label: 'LTX-2 MLX', venvPython: '/tmp/x.py', installEnvVar: 'X', repoUrl: 'x', repoDir: '/tmp' } },
  isByovRuntimeInstalled: vi.fn(() => false),
  isByovRuntimeReady: vi.fn(async () => false),
  invalidateByovReadyCache: vi.fn(),
}));

vi.mock('../services/mediaJobQueue/index.js', () => ({
  enqueueJob: vi.fn(() => ({ jobId: 'mock', position: 1, status: 'queued' })),
  attachSseClient: vi.fn(() => false),
  cancelJob: vi.fn(async () => ({ ok: true })),
  listJobs: vi.fn(() => []),
}));

vi.mock('../lib/multipart.js', () => ({
  uploadFields: () => (_req, _res, next) => next(),
}));

vi.mock('../lib/fileUtils.js', () => ({
  tryReadFile: vi.fn().mockResolvedValue(null),
  PATHS: { root: '/mock', data: '/mock/data', images: '/mock/images', videos: '/mock/videos', uploads: '/mock/uploads' },
  ensureDir: vi.fn(async () => {}),
  resolveGalleryImage: vi.fn((name) => `/mock/images/${name}`),
}));

vi.mock('fs', () => ({ existsSync: vi.fn(() => true) }));
vi.mock('fs/promises', () => ({ unlink: vi.fn(async () => {}), copyFile: vi.fn(async () => {}) }));

import videoGenRoutes from './videoGen.js';
import { verifyModelCache, repairModelCache } from '../lib/hfCache.js';
import { isHfRepoId } from '../lib/mediaModels.js';

describe('Video Gen integrity routes', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/video-gen', videoGenRoutes);
    app.use(errorMiddleware);
    vi.clearAllMocks();
  });

  it('GET /models/status surfaces integrity for cached models + text encoder', async () => {
    const res = await request(app).get('/api/video-gen/models/status');
    expect(res.status).toBe(200);
    expect(res.body.models[0].integrity.status).toBe('bad');
    expect(res.body.textEncoder.integrity.status).toBe('bad');
  });

  it('POST /models/verify deep-scans every model + the encoder', async () => {
    const res = await request(app).post('/api/video-gen/models/verify').send({ deep: true });
    expect(res.status).toBe(200);
    expect(res.body.deep).toBe(true);
    expect(res.body.models.length).toBeGreaterThanOrEqual(2); // model + encoder
    expect(verifyModelCache).toHaveBeenCalledWith('org/ltx2_unified', { deep: true });
  });

  it('POST /models/:id/repair deletes flagged files and reports them', async () => {
    const res = await request(app).post('/api/video-gen/models/ltx2_unified/repair').send({});
    expect(res.status).toBe(200);
    expect(res.body.deleted).toEqual([{ repo: 'org/ltx2_unified', name: 'model.safetensors' }]);
    expect(repairModelCache).toHaveBeenCalledWith('org/ltx2_unified', { deep: false });
  });

  it('POST /models/:id/repair 404s for an unknown model', async () => {
    const res = await request(app).post('/api/video-gen/models/nope/repair').send({});
    expect(res.status).toBe(404);
  });

  it('POST /text-encoder/repair deletes the encoder repo flagged files', async () => {
    const res = await request(app).post('/api/video-gen/text-encoder/repair').send({});
    expect(res.status).toBe(200);
    expect(res.body.repos).toEqual(['org/text-encoder']);
    expect(res.body.deleted).toEqual([{ repo: 'org/text-encoder', name: 'model.safetensors' }]);
    expect(repairModelCache).toHaveBeenCalledWith('org/text-encoder', { deep: false });
  });

  it('POST /text-encoder/repair passes deep through', async () => {
    const res = await request(app).post('/api/video-gen/text-encoder/repair').send({ deep: true });
    expect(res.status).toBe(200);
    expect(res.body.deep).toBe(true);
    expect(repairModelCache).toHaveBeenCalledWith('org/text-encoder', { deep: true });
  });

  it('POST /text-encoder/repair 400s for a local-path (non-HF) encoder', async () => {
    isHfRepoId.mockReturnValueOnce(false);
    const res = await request(app).post('/api/video-gen/text-encoder/repair').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_DOWNLOADABLE');
  });
});
