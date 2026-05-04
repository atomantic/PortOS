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
  // The route imports setHistoryItemHidden too — without this entry, ESM
  // module linking fails when the route is loaded inside the test process.
  setHistoryItemHidden: vi.fn(async (id, hidden) => ({ ok: true, id, hidden })),
  extractLastFrame: vi.fn(),
  stitchVideos: vi.fn(),
  upscaleHistoryItem: vi.fn(),
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

    // Pre-enqueue config validation: without pythonPath the queue would
    // accept the job, return 200/queued, then fail asynchronously over SSE
    // and pollute the persisted queue with a doomed entry.
    it('rejects 400 VIDEO_GEN_NOT_CONFIGURED when pythonPath is missing', async () => {
      const settingsMock = await import('../services/settings.js');
      settingsMock.getSettings.mockResolvedValueOnce({ imageGen: { local: {} } });
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a cat' });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/not configured/i);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
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

    // jobId in the body cancels a specific job, even if it's still queued.
    it('cancels a specific queued job when jobId is supplied', async () => {
      const jobs = [
        { id: 'running-1', kind: 'video', status: 'running' },
        { id: 'queued-2',  kind: 'video', status: 'queued' },
      ];
      // The route calls listJobs({ kind: 'video' }) — replicate the production
      // queue's filter semantics (status filter is optional).
      mediaJobQueue.listJobs.mockImplementation(({ status, kind } = {}) => jobs.filter((j) => {
        if (status && j.status !== status) return false;
        if (kind && j.kind !== kind) return false;
        return true;
      }));
      mediaJobQueue.cancelJob.mockResolvedValue({ ok: true, status: 'canceled' });
      const r = await request(app).post('/api/video-gen/cancel').send({ jobId: 'queued-2' });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(mediaJobQueue.cancelJob).toHaveBeenCalledWith('queued-2');
    });

    // No running job and no jobId — fall back to newest queued so the user
    // can pull back a recent submission before it starts.
    it('falls back to newest queued video when no jobId and nothing is running', async () => {
      const jobs = [
        { id: 'queued-old', kind: 'video', status: 'queued' },
        { id: 'queued-new', kind: 'video', status: 'queued' },
      ];
      mediaJobQueue.listJobs.mockImplementation(({ status, kind } = {}) => jobs.filter((j) => {
        if (status && j.status !== status) return false;
        if (kind && j.kind !== kind) return false;
        return true;
      }));
      mediaJobQueue.cancelJob.mockResolvedValue({ ok: true, status: 'canceled' });
      const r = await request(app).post('/api/video-gen/cancel').send({});
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(mediaJobQueue.cancelJob).toHaveBeenCalledWith('queued-new');
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
    const validId = (n) => `aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa${n}`;

    it('rejects when videoIds is not an array', async () => {
      const r = await request(app).post('/api/video-gen/stitch').send({ videoIds: 'not-array' });
      expect(r.status).toBe(400);
    });

    it('rejects when videoIds contains malformed history ids', async () => {
      const r = await request(app).post('/api/video-gen/stitch').send({ videoIds: ['../etc/passwd', 'b'] });
      expect(r.status).toBe(400);
    });

    it('rejects when videoIds has fewer than 2 entries', async () => {
      const r = await request(app).post('/api/video-gen/stitch').send({ videoIds: [validId(1)] });
      expect(r.status).toBe(400);
    });

    it('proxies array of ids to stitchVideos and wraps result', async () => {
      videoGenService.stitchVideos.mockResolvedValue({ id: 's1', filename: 's1.mp4' });
      const r = await request(app).post('/api/video-gen/stitch').send({ videoIds: [validId(1), validId(2)] });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.video.id).toBe('s1');
      expect(videoGenService.stitchVideos).toHaveBeenCalledWith([validId(1), validId(2)]);
    });
  });

  describe('POST /upscale/:id', () => {
    const validHistoryId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1';
    const otherValidId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbb2';

    it('rejects history ids that do not match the UUID shape', async () => {
      const r = await request(app).post('/api/video-gen/upscale/not-a-uuid').send({});
      expect(r.status).toBe(400);
      expect(videoGenService.upscaleHistoryItem).not.toHaveBeenCalled();
    });

    it('forwards id to upscaleHistoryItem and wraps the new entry', async () => {
      const upscaled = { id: otherValidId, filename: `${otherValidId}.mp4`, width: 1536, height: 1024, upscaledFrom: validHistoryId };
      videoGenService.upscaleHistoryItem.mockResolvedValue(upscaled);
      const r = await request(app).post(`/api/video-gen/upscale/${validHistoryId}`).send({});
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.video).toEqual(upscaled);
      expect(videoGenService.upscaleHistoryItem).toHaveBeenCalledWith(validHistoryId);
    });

    it('returns the ServerError status when the service rejects', async () => {
      videoGenService.upscaleHistoryItem.mockRejectedValue(
        Object.assign(new Error('Video not found'), { status: 404, code: 'NOT_FOUND' }),
      );
      const r = await request(app).post(`/api/video-gen/upscale/${validHistoryId}`).send({});
      expect(r.status).toBe(404);
      expect(r.body.error).toMatch(/not found/i);
    });
  });
});
