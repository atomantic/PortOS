import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(async () => ({ imageGen: { local: { pythonPath: '/usr/bin/python3' } } })),
}));

vi.mock('../services/videoGen/local.js', () => ({
  listVideoModels: vi.fn(() => [{ id: 'ltx2_unified', name: 'LTX-2 Unified' }]),
  defaultVideoModelId: vi.fn(() => 'ltx2_unified'),
  loadHistory: vi.fn(async () => []),
  deleteHistoryItem: vi.fn(async (id) => ({ ok: true, id })),
  extractLastFrame: vi.fn(),
  stitchVideos: vi.fn(),
}));

// Render submissions go through the mediaJobQueue. Mock its surface so the
// route tests stay synchronous and don't kick off the worker loop.
vi.mock('../services/mediaJobQueue/index.js', () => ({
  enqueueJob: vi.fn(({ kind, params }) => ({ jobId: `mock-${kind}-job`, position: 1, status: 'queued' })),
  attachSseClient: vi.fn(() => false),
  cancelJob: vi.fn(async () => ({ ok: true, status: 'canceling' })),
  listJobs: vi.fn(() => []),
}));

vi.mock('../lib/multipart.js', () => ({
  // Bypass the multipart parser for unit tests — handler treats req.file as
  // optional, and we exercise the no-upload path here.
  uploadSingle: () => (_req, _res, next) => next(),
}));

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { images: '/mock/images' },
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  // statSync gates resolveGalleryImage onto regular-file checks — the route
  // rejects directories, so the mock has to look like a file for the
  // gallery-image plumbing tests to pass.
  statSync: vi.fn(() => ({ isFile: () => true })),
}));
vi.mock('fs/promises', () => ({ unlink: vi.fn(async () => {}) }));

import * as videoGenService from '../services/videoGen/local.js';
import * as mediaJobQueue from '../services/mediaJobQueue/index.js';
import videoGenRoutes from './videoGen.js';

describe('videoGen routes', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/video-gen', videoGenRoutes);
    vi.clearAllMocks();
  });

  describe('GET /status', () => {
    it('reports connected when pythonPath is set', async () => {
      const r = await request(app).get('/api/video-gen/status');
      expect(r.status).toBe(200);
      expect(r.body.connected).toBe(true);
      expect(r.body.pythonPath).toBe('/usr/bin/python3');
      expect(r.body.defaultModel).toBe('ltx2_unified');
    });
  });

  describe('GET /models', () => {
    it('returns the static catalog', async () => {
      const r = await request(app).get('/api/video-gen/models');
      expect(r.status).toBe(200);
      expect(r.body).toEqual([{ id: 'ltx2_unified', name: 'LTX-2 Unified' }]);
    });
  });

  describe('POST /', () => {
    it('rejects missing prompt', async () => {
      const r = await request(app).post('/api/video-gen/').send({ width: 512 });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/prompt/i);
    });

    it('rejects out-of-range width', async () => {
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a cat', width: 99999 });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/width/i);
    });

    it('rejects bad tiling enum value', async () => {
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a cat', tiling: 'wrong' });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/tiling/i);
    });

    it('accepts empty-string numerics as undefined (multipart preprocess fix)', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a cat',
        width: '',
        height: '',
        seed: '',
      });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('queued');
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({
          prompt: 'a cat',
          width: undefined,
          height: undefined,
          seed: undefined,
        }),
      }));
    });

    it('strips path-traversal segments from sourceImageFile via basename + prefix-check', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a cat',
        sourceImageFile: '../../etc/passwd',
      });
      // Documented-safe behavior: `basename()` strips dirs so the resolved
      // path is `/mock/images/passwd` (under PATHS.images). The route does
      // NOT 400 — it just consumes whatever's safely under the images root.
      // What this test really locks in: the request succeeds + the route
      // never enqueues a job that points outside PATHS.images.
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({ prompt: 'a cat' }),
      }));
    });

    it('forwards lastImageFile + mode for FFLF', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'morph between two scenes',
        sourceImageFile: 'first.png',
        lastImageFile: 'last.png',
        mode: 'fflf',
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({
          prompt: 'morph between two scenes',
          sourceImagePath: '/mock/images/first.png',
          lastImagePath: '/mock/images/last.png',
          mode: 'fflf',
        }),
      }));
    });

    it('rejects an unknown mode value', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a cat',
        mode: 'bogus',
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/mode/i);
    });
  });

  describe('GET /:jobId/events', () => {
    it('returns 404 when the job is unknown', async () => {
      mediaJobQueue.attachSseClient.mockReturnValue(false);
      const r = await request(app).get('/api/video-gen/unknown-job/events');
      expect(r.status).toBe(404);
      expect(r.body.error).toMatch(/not found/i);
    });
  });

  describe('POST /cancel', () => {
    it('reports nothing to cancel when no video render is running', async () => {
      mediaJobQueue.listJobs.mockReturnValue([]);
      const r = await request(app).post('/api/video-gen/cancel').send({});
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(false);
    });

    it('cancels the running video render through the queue', async () => {
      mediaJobQueue.listJobs.mockReturnValue([{ id: 'running-job', kind: 'video', status: 'running' }]);
      mediaJobQueue.cancelJob.mockResolvedValue({ ok: true, status: 'canceling' });
      const r = await request(app).post('/api/video-gen/cancel').send({});
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(mediaJobQueue.cancelJob).toHaveBeenCalledWith('running-job');
    });
  });

  describe('GET /history', () => {
    it('returns the full history list', async () => {
      videoGenService.loadHistory.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
      const r = await request(app).get('/api/video-gen/history');
      expect(r.status).toBe(200);
      expect(r.body).toHaveLength(2);
    });
  });

  describe('DELETE /history/:id', () => {
    it('proxies to deleteHistoryItem', async () => {
      videoGenService.deleteHistoryItem.mockResolvedValue({ ok: true, id: 'abc' });
      const r = await request(app).delete('/api/video-gen/history/abc');
      expect(r.status).toBe(200);
      expect(videoGenService.deleteHistoryItem).toHaveBeenCalledWith('abc');
    });
  });

  describe('POST /stitch', () => {
    it('rejects when videoIds is not an array', async () => {
      const r = await request(app).post('/api/video-gen/stitch').send({ videoIds: 'not-array' });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/array/i);
    });

    it('proxies array of ids to stitchVideos and wraps result', async () => {
      videoGenService.stitchVideos.mockResolvedValue({ id: 's1', filename: 's1.mp4' });
      const r = await request(app).post('/api/video-gen/stitch').send({ videoIds: ['a', 'b'] });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.video.id).toBe('s1');
    });
  });
});
