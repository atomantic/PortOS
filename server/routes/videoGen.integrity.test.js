import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Integrity / repair routes (issue #1324). Mocks mediaModels + hfCache so the
// thin route glue is exercised in isolation; the real structural/sha256 logic
// is covered in lib/hfCache.test.js. The remaining mock set mirrors
// videoGen.test.js so the route's import graph links under vitest.

vi.mock('../lib/mediaModels.js', () => ({
  repoForModel: vi.fn((m) => m.repo || `org/${m.id}`),
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
  verifyCachedRepoFiles: vi.fn(async (repoId, files, opts) => ({
    repoId, status: 'bad', cached: false, sizeBytes: 0, snapshotPath: '/snap',
    checkedDeep: !!opts?.deep,
    files: files.map((name) => ({ name, path: `/snap/${name}`, ok: false, reason: 'truncated-data', sizeBytes: 10 })),
  })),
  repairCachedRepoFiles: vi.fn(async (repoId, files) => ({ repoId, status: 'bad', deleted: files })),
}));

const sseDownload = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock('../lib/sseDownload.js', async (importOriginal) => ({
  ...(await importOriginal()),
  startHfDownloadStream: sseDownload.start,
}));

vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(async () => ({ imageGen: { local: { pythonPath: '/usr/bin/python3' } } })),
}));

vi.mock('../lib/pythonSetup.js', () => ({
  checkPackages: vi.fn(async () => ({ installed: [], missing: [], missingPip: [] })),
  isAllowedPython: vi.fn(() => true),
}));

vi.mock('../services/videoGen/local.js', () => ({
  listVideoModels: vi.fn(() => [
    { id: 'ltx2_unified', name: 'LTX-2 Unified', runtime: 'ltx2' },
    {
      id: 'wan_lightning', name: 'Wan Lightning', runtime: 'wan22',
      repo: 'org/wan-base', revision: '1111111111111111111111111111111111111111',
      requiredWeights: [{
        repo: 'org/wan-lightning', revision: '2222222222222222222222222222222222222222',
        files: ['profile/high.safetensors', 'profile/low.safetensors'],
        targetRoles: ['high_noise_transformer', 'low_noise_transformer'],
      }],
    },
  ]),
  defaultVideoModelId: vi.fn(() => 'ltx2_unified'),
  loadHistory: vi.fn(async () => []),
  deleteHistoryItem: vi.fn(),
  setHistoryItemHidden: vi.fn(),
  extractLastFrame: vi.fn(),
  stitchVideos: vi.fn(),
  upscaleHistoryItem: vi.fn(),
  DEFAULT_NUM_FRAMES: 121,
  resolveFflfLtx2PixelBudget: vi.fn(() => 1000),
  BYOV_VIDEO_RUNTIMES: new Set(['ltx2', 'wan22']),
  BYOV_RUNTIME_INFO: {
    ltx2: { id: 'ltx2', label: 'LTX-2 MLX', venvPython: '/tmp/x.py', installEnvVar: 'X', repoUrl: 'x', repoDir: '/tmp' },
    wan22: { id: 'wan22', label: 'Wan MLX', venvPython: '/tmp/wan.py', installEnvVar: 'WAN', repoUrl: 'x', repoDir: '/tmp' },
  },
  isByovRuntimeInstalled: vi.fn(() => false),
  isByovRuntimeReady: vi.fn(async () => false),
  isByovRuntimeCurrent: vi.fn(async () => false),
  invalidateByovReadyCache: vi.fn(),
  invalidateRuntimeFingerprintCache: vi.fn(),
  resolveRuntimeFingerprint: vi.fn(async () => null),
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
import {
  verifyModelCache, repairModelCache, verifyCachedRepoFiles, repairCachedRepoFiles,
} from '../lib/hfCache.js';
import { isHfRepoId } from '../lib/mediaModels.js';
import { downloadableVideoTextEncoders } from '../lib/videoTextEncoders.js';

describe('Video Gen integrity routes', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/video-gen', videoGenRoutes);
    app.use(errorMiddleware);
    vi.clearAllMocks();
    sseDownload.start.mockImplementation(async ({ res }) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"type":"complete"}\n\n');
    });
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

  it('threads immutable base and exact Lightning revisions through status', async () => {
    const res = await request(app).get('/api/video-gen/models/status');
    const lightning = res.body.models.find((model) => model.id === 'wan_lightning');
    expect(lightning.requiredRepos).toEqual(['org/wan-base', 'org/wan-lightning']);
    expect(verifyModelCache).toHaveBeenCalledWith(
      'org/wan-base',
      { deep: false, revision: '1111111111111111111111111111111111111111' },
    );
    expect(verifyCachedRepoFiles).toHaveBeenCalledWith(
      'org/wan-lightning',
      ['profile/high.safetensors', 'profile/low.safetensors'],
      { deep: false, revision: '2222222222222222222222222222222222222222' },
    );
  });

  it('repairs only the exact pinned Lightning dependency files', async () => {
    const res = await request(app).post('/api/video-gen/models/wan_lightning/repair').send({ deep: true });
    expect(res.status).toBe(200);
    expect(repairCachedRepoFiles).toHaveBeenCalledWith(
      'org/wan-lightning',
      ['profile/high.safetensors', 'profile/low.safetensors'],
      { deep: true, revision: '2222222222222222222222222222222222222222' },
    );
  });

  it('downloads the pinned base snapshot plus both exact Lightning files', async () => {
    const res = await request(app).get('/api/video-gen/models/wan_lightning/download');
    expect(res.status).toBe(200);
    expect(sseDownload.start).toHaveBeenCalledWith(expect.objectContaining({
      repos: [
        { repo: 'org/wan-base', revision: '1111111111111111111111111111111111111111', only: [] },
        {
          repo: 'org/wan-lightning', revision: '2222222222222222222222222222222222222222',
          only: ['profile/high.safetensors', 'profile/low.safetensors'],
        },
      ],
    }));
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

  // Substitutable prompt conditioners (#4081) — their own lane, keyed by the
  // registry id rather than a model id (they aren't listVideoModels() entries).
  // Every operation is scoped to the entry's pinned FILE LIST: the upstream
  // repos also publish INT8 ConvRot / NVFP4 quantizations, 50-63 generation
  // tails and (for a full checkpoint) the language layers past the conditioning
  // depth this MLX loader never builds, so a repo-wide pull would cost ~130 GB
  // for ~48 GB of usable weights — and a repo-wide verify would flag the rest as
  // corrupt.
  describe('substitutable text encoders', () => {
    const encoder = () => downloadableVideoTextEncoders()[0];

    // Every entry gets its own row, not just the first: a substitute missing
    // from this lane has no Download badge and no repair path in the UI.
    it('GET /models/status reports every registered substitute', async () => {
      const res = await request(app).get('/api/video-gen/models/status');
      expect(res.status).toBe(200);
      expect(res.body.textEncoderOptions.map((o) => o.id))
        .toEqual(downloadableVideoTextEncoders().map((e) => e.id));
    });

    it('GET /models/status reports each substitute with the badge shape', async () => {
      const res = await request(app).get('/api/video-gen/models/status');
      expect(res.status).toBe(200);
      const entry = res.body.textEncoderOptions.find((o) => o.id === encoder().id);
      expect(entry).toMatchObject({
        id: encoder().id,
        repo: encoder().repo,
        cached: false,
        label: expect.any(String),
      });
      // The mocked verify reports 'bad', but an uncached file gets the Download
      // badge rather than a Repair banner — same rule as repoCacheStatus.
      expect(entry.integrity).toBeNull();
      // Through the shared target verifier, so the badge is checked exactly the
      // way the integrity scan and the repair route check it.
      expect(verifyCachedRepoFiles).toHaveBeenCalledWith(
        encoder().repo, encoder().files, { deep: false, revision: encoder().revision },
      );
    });

    it('GET /text-encoders/:id/download pulls only the pinned file at its pinned revision', async () => {
      const res = await request(app).get(`/api/video-gen/text-encoders/${encoder().id}/download`);
      expect(res.status).toBe(200);
      expect(sseDownload.start).toHaveBeenCalledWith(expect.objectContaining({
        repos: [{ repo: encoder().repo, revision: encoder().revision, only: encoder().files }],
        force: false,
      }));
    });

    it('GET /text-encoders/:id/download threads force=1 for a repair re-fetch', async () => {
      const res = await request(app).get(`/api/video-gen/text-encoders/${encoder().id}/download?force=1`);
      expect(res.status).toBe(200);
      expect(sseDownload.start).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
    });

    it('POST /text-encoders/:id/repair deletes only the pinned file', async () => {
      const res = await request(app).post(`/api/video-gen/text-encoders/${encoder().id}/repair`).send({ deep: true });
      expect(res.status).toBe(200);
      expect(res.body.deep).toBe(true);
      expect(res.body.deleted).toEqual(encoder().files.map((name) => ({ repo: encoder().repo, name })));
      expect(repairCachedRepoFiles).toHaveBeenCalledWith(
        encoder().repo, encoder().files, { deep: true, revision: encoder().revision },
      );
    });

    it.each(['download', 'repair'])('404s an unknown encoder id on /%s', async (action) => {
      const res = action === 'download'
        ? await request(app).get('/api/video-gen/text-encoders/nope/download')
        : await request(app).post('/api/video-gen/text-encoders/nope/repair').send({});
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('VIDEO_TEXT_ENCODER_UNKNOWN');
    });

    // The built-in option ships inside the model's own weights and has no repo,
    // so it must never reach this lane — otherwise the UI could offer a Download
    // button for something that isn't separately downloadable.
    it('404s the built-in stock option', async () => {
      const res = await request(app).get('/api/video-gen/text-encoders/stock/download');
      expect(res.status).toBe(404);
    });

    it('POST /models/verify covers every substitute in an unscoped scan', async () => {
      await request(app).post('/api/video-gen/models/verify').send({});
      expect(verifyCachedRepoFiles).toHaveBeenCalledWith(
        encoder().repo, encoder().files, { deep: false, revision: encoder().revision },
      );
    });
  });
});
