import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import imageGenRoutes from './imageGen.js';

vi.mock('../services/imageGen/index.js', () => ({
  checkConnection: vi.fn(),
  generateImage: vi.fn(),
  generateAvatar: vi.fn(),
  attachSseClient: vi.fn(() => false),
  cancel: vi.fn(() => false),
  IMAGE_GEN_MODES: ['external', 'local', 'codex'],
  local: {
    listImageModels: vi.fn(() => []),
    listLoraFilenames: vi.fn(async () => []),
    listGallery: vi.fn(async () => []),
    deleteImage: vi.fn(async () => ({ ok: true })),
  },
}));

// Default to external mode in tests so /generate goes through the dispatcher.
// Local-mode tests below override the settings mock to flip into queue mode.
vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(async () => ({ imageGen: { mode: 'external' } })),
}));

vi.mock('../services/mediaJobQueue/index.js', () => ({
  enqueueJob: vi.fn(({ kind }) => ({ jobId: `mock-${kind}-job`, position: 1, status: 'queued' })),
  attachSseClient: vi.fn(() => false),
  cancelJob: vi.fn(async () => ({ ok: true, status: 'canceling' })),
  listJobs: vi.fn(() => []),
}));

import * as imageGen from '../services/imageGen/index.js';
import * as mediaJobQueue from '../services/mediaJobQueue/index.js';
import { getSettings } from '../services/settings.js';

describe('Image Gen Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/image-gen', imageGenRoutes);
    vi.clearAllMocks();
  });

  describe('GET /api/image-gen/status', () => {
    it('should return connection status', async () => {
      imageGen.checkConnection.mockResolvedValue({ connected: true, model: 'flux-v1' });

      const response = await request(app).get('/api/image-gen/status');

      expect(response.status).toBe(200);
      expect(response.body.connected).toBe(true);
      expect(response.body.model).toBe('flux-v1');
    });

    it('should return disconnected status', async () => {
      imageGen.checkConnection.mockResolvedValue({ connected: false, reason: 'No SD API URL configured' });

      const response = await request(app).get('/api/image-gen/status');

      expect(response.status).toBe(200);
      expect(response.body.connected).toBe(false);
    });

    it('forwards a valid ?mode= query into checkConnection', async () => {
      imageGen.checkConnection.mockResolvedValue({ connected: true, mode: 'codex' });
      const response = await request(app).get('/api/image-gen/status?mode=codex');
      expect(response.status).toBe(200);
      expect(imageGen.checkConnection).toHaveBeenCalledWith({ mode: 'codex' });
    });

    it('ignores an invalid ?mode= query and uses the saved default', async () => {
      imageGen.checkConnection.mockResolvedValue({ connected: true, mode: 'external' });
      const response = await request(app).get('/api/image-gen/status?mode=bogus');
      expect(response.status).toBe(200);
      expect(imageGen.checkConnection).toHaveBeenCalledWith({ mode: undefined });
    });

    // Express turns ?mode=a&mode=b into an array — without the
    // typeof === 'string' guard, that array would either match
    // IMAGE_GEN_MODES.includes() falsely or propagate as a non-string
    // mode to the dispatcher.
    it('ignores a duplicated-key ?mode= array', async () => {
      imageGen.checkConnection.mockResolvedValue({ connected: true, mode: 'external' });
      const response = await request(app).get('/api/image-gen/status?mode=local&mode=codex');
      expect(response.status).toBe(200);
      expect(imageGen.checkConnection).toHaveBeenCalledWith({ mode: undefined });
    });
  });

  describe('POST /api/image-gen/generate', () => {
    it('should generate an image', async () => {
      imageGen.generateImage.mockResolvedValue({
        generationId: 'gen-001',
        filename: 'test.png',
        path: '/data/images/test.png'
      });

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'a fantasy landscape' });

      expect(response.status).toBe(200);
      expect(response.body.path).toBe('/data/images/test.png');
      expect(imageGen.generateImage).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'a fantasy landscape' }));
    });

    it('should return 400 if prompt is missing', async () => {
      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({});

      expect(response.status).toBe(400);
      expect(imageGen.generateImage).not.toHaveBeenCalled();
    });

    it('should validate width and height bounds', async () => {
      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'test', width: 50000 });

      expect(response.status).toBe(400);
    });

    it('should pass optional parameters', async () => {
      imageGen.generateImage.mockResolvedValue({ generationId: 'gen-002', filename: 'test2.png', path: '/data/images/test2.png' });

      await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'test', width: 512, height: 768, steps: 30, cfgScale: 7, seed: 42 });

      expect(imageGen.generateImage).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: 'test', width: 512, height: 768, steps: 30, cfgScale: 7, seed: 42 })
      );
    });

    // Local mode goes through the mediaJobQueue rather than calling
    // generateImage synchronously; the route returns immediately with
    // { jobId, status: 'queued', position } so the UI can attach SSE.
    it('local mode enqueues through mediaJobQueue and returns queued status', async () => {
      getSettings.mockResolvedValueOnce({ imageGen: { mode: 'local', local: { pythonPath: '/usr/bin/python3' } } });
      mediaJobQueue.enqueueJob.mockReturnValueOnce({ jobId: 'queued-job-001', position: 1, status: 'queued' });

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'a fox in a forest' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('queued');
      expect(response.body.position).toBe(1);
      expect(response.body.mode).toBe('local');
      expect(response.body.jobId).toBe('queued-job-001');
      expect(response.body.generationId).toBe('queued-job-001');
      expect(response.body.path).toBe('/data/images/queued-job-001.png');
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'image',
        params: expect.objectContaining({ prompt: 'a fox in a forest', pythonPath: '/usr/bin/python3' }),
      }));
      // Synchronous generateImage MUST NOT be called in local mode — the
      // queue takes ownership of the job lifecycle.
      expect(imageGen.generateImage).not.toHaveBeenCalled();
    });

    it('local mode maps cfgScale to guidance before enqueueing', async () => {
      getSettings.mockResolvedValueOnce({ imageGen: { mode: 'local', local: { pythonPath: '/usr/bin/python3' } } });
      mediaJobQueue.enqueueJob.mockReturnValueOnce({ jobId: 'queued-job-cfg', position: 1, status: 'queued' });

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'a fox in a forest', cfgScale: 6.5 });

      expect(response.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'image',
        params: expect.objectContaining({ cfgScale: 6.5, guidance: 6.5 }),
      }));
    });

    // The per-request `mode` override flips into queue mode even when the
    // saved default is external — protects against future regressions where
    // someone hard-codes settings.imageGen.mode as the only mode source.
    it('per-request mode=local override enqueues even when settings default is external', async () => {
      // Local mode now validates pythonPath up-front (mflux model needs it),
      // so the test must supply a configured local section. The override
      // contract — explicit `mode: 'local'` flips into queue mode regardless
      // of the saved default — is still what's being asserted here.
      getSettings.mockResolvedValueOnce({ imageGen: { mode: 'external', local: { pythonPath: '/usr/bin/python3' } } });
      mediaJobQueue.enqueueJob.mockReturnValueOnce({ jobId: 'queued-job-002', position: 2, status: 'queued' });

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'a wizard tower', mode: 'local' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('queued');
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({ kind: 'image' }));
      expect(imageGen.generateImage).not.toHaveBeenCalled();
    });

    // Local mode without a configured pythonPath now rejects up-front (400)
    // rather than enqueueing a job that can never run. The queue is meant to
    // serialize concurrent renders, not to absorb hard configuration errors.
    it('local mode with missing pythonPath returns 400 IMAGE_GEN_NOT_CONFIGURED', async () => {
      getSettings.mockResolvedValueOnce({ imageGen: { mode: 'local' } }); // no `local.pythonPath`

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'a fox in a forest' });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/not configured/i);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    // z-image and ernie use the FLUX.2 venv — they must NOT require pythonPath.
    it('local mode with z-image model and missing pythonPath still enqueues (exempted)', async () => {
      getSettings.mockResolvedValueOnce({ imageGen: { mode: 'local' } }); // no pythonPath
      mediaJobQueue.enqueueJob.mockReturnValueOnce({ jobId: 'mock-image-job', position: 1, status: 'queued' });

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'a fox in a forest', modelId: 'z-image-turbo-bf16' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('queued');
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalled();
    });

    it('local mode with ernie model and missing pythonPath still enqueues (exempted)', async () => {
      getSettings.mockResolvedValueOnce({ imageGen: { mode: 'local' } }); // no pythonPath
      mediaJobQueue.enqueueJob.mockReturnValueOnce({ jobId: 'mock-image-job', position: 1, status: 'queued' });

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'a wizard tower', modelId: 'ernie-image' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('queued');
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalled();
    });

    // Codex mode now goes through the mediaJobQueue (codex lane), so a
    // burst of writers-room storyboard renders queues against itself
    // instead of failing the second-and-onwards calls with 409
    // IMAGE_GEN_BUSY.
    it('codex mode enqueues through mediaJobQueue and returns queued status', async () => {
      getSettings.mockResolvedValueOnce({
        imageGen: { mode: 'codex', codex: { enabled: true, codexPath: '/usr/local/bin/codex', model: 'gpt-5.4' } },
      });
      mediaJobQueue.enqueueJob.mockReturnValueOnce({ jobId: 'queued-codex-001', position: 1, status: 'queued' });

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'a tavern at dusk' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('queued');
      expect(response.body.mode).toBe('codex');
      expect(response.body.model).toBe('gpt-5.4');
      expect(response.body.jobId).toBe('queued-codex-001');
      expect(response.body.path).toBe('/data/images/queued-codex-001.png');
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'image',
        params: expect.objectContaining({
          mode: 'codex',
          codexPath: '/usr/local/bin/codex',
          model: 'gpt-5.4',
          prompt: 'a tavern at dusk',
        }),
      }));
      // Synchronous generateImage MUST NOT be called in codex mode either —
      // the queue takes ownership.
      expect(imageGen.generateImage).not.toHaveBeenCalled();
    });

    // Per-request codex override: even when the saved default is external,
    // an explicit `mode: 'codex'` on the payload (e.g. the writers-room
    // storyboard chip strip) flips into queue mode so renders serialize.
    it('per-request mode=codex override enqueues even when settings default is external', async () => {
      getSettings.mockResolvedValueOnce({
        imageGen: { mode: 'external', codex: { enabled: true, model: 'gpt-5.4' } },
      });
      mediaJobQueue.enqueueJob.mockReturnValueOnce({ jobId: 'queued-codex-002', position: 2, status: 'queued' });

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'a wizard tower', mode: 'codex' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('queued');
      expect(response.body.mode).toBe('codex');
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'image',
        params: expect.objectContaining({ mode: 'codex' }),
      }));
      expect(imageGen.generateImage).not.toHaveBeenCalled();
    });

    // Codex with the toggle off rejects up-front rather than enqueueing.
    it('codex mode with disabled toggle returns 400 CODEX_IMAGEGEN_DISABLED', async () => {
      getSettings.mockResolvedValueOnce({
        imageGen: { mode: 'codex', codex: { enabled: false } },
      });

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'a fox' });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/disabled/i);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/image-gen/avatar', () => {
    it('should generate an avatar', async () => {
      imageGen.generateAvatar.mockResolvedValue({
        generationId: 'gen-003',
        filename: 'avatar.png',
        path: '/data/images/avatar.png'
      });

      const response = await request(app)
        .post('/api/image-gen/avatar')
        .send({ name: 'Gandalf', characterClass: 'Wizard' });

      expect(response.status).toBe(200);
      expect(response.body.path).toBe('/data/images/avatar.png');
    });

    it('should accept empty body for default avatar', async () => {
      imageGen.generateAvatar.mockResolvedValue({
        generationId: 'gen-004',
        filename: 'default.png',
        path: '/data/images/default.png'
      });

      const response = await request(app)
        .post('/api/image-gen/avatar')
        .send({});

      expect(response.status).toBe(200);
    });
  });

  // GET /:jobId/events and POST /cancel both go through the dispatcher's
  // attachSseClient/cancel — these tests lock in that contract so a future
  // refactor can't accidentally re-couple them to the local provider.
  describe('SSE attach + cancel via dispatcher', () => {
    it('GET /:jobId/events returns 404 when no provider owns the job', async () => {
      imageGen.attachSseClient.mockReturnValueOnce(false);
      const response = await request(app).get('/api/image-gen/missing-job/events');
      expect(response.status).toBe(404);
      expect(imageGen.attachSseClient).toHaveBeenCalledWith('missing-job', expect.anything());
    });

    it('POST /cancel returns ok=false when no provider had a job', async () => {
      imageGen.cancel.mockReturnValueOnce(false);
      const response = await request(app).post('/api/image-gen/cancel');
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(false);
      expect(imageGen.cancel).toHaveBeenCalled();
    });

    it('POST /cancel returns ok=true when a provider cancelled', async () => {
      imageGen.cancel.mockReturnValueOnce(true);
      const response = await request(app).post('/api/image-gen/cancel');
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
    });

    it('POST /cancel { all: true } cancels every queued/running image job', async () => {
      mediaJobQueue.listJobs.mockReturnValueOnce([
        { id: 'a', status: 'running' },
        { id: 'b', status: 'queued' },
        { id: 'c', status: 'queued' },
      ]);
      const response = await request(app).post('/api/image-gen/cancel').send({ all: true });
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.attempted).toBe(3);
      expect(mediaJobQueue.cancelJob).toHaveBeenCalledTimes(3);
      // Queued jobs cancelled before the running one — slot doesn't refill mid-loop.
      expect(mediaJobQueue.cancelJob.mock.calls.map((c) => c[0])).toEqual(['b', 'c', 'a']);
      // Belt-and-braces: legacy single-process cancel also poked.
      expect(imageGen.cancel).toHaveBeenCalled();
    });

    it('POST /cancel (no jobId) picks the most-recently-submitted job by queuedAt — NOT the listJobs() ordering', async () => {
      // listJobs() returns jobs in queue-internal order: gpuRunning first,
      // then codexRunning, then queue. Without explicit queuedAt sorting, a
      // bare `/cancel` (the user's "stop the last thing I submitted" gesture)
      // would target the gpuRunning job — even when the user just queued a
      // newer Codex job that should be the cancel target. The route must
      // tie-break by queuedAt DESC so the newest submit always wins.
      mediaJobQueue.listJobs.mockReturnValueOnce([
        // listJobs ordering: gpu-running first (oldest submit, started long ago).
        { id: 'gpu-running', status: 'running', queuedAt: '2026-05-05T08:00:00Z' },
        // Codex job queued AFTER the GPU job started — this is the "most
        // recent submit" and should be the cancel target.
        { id: 'codex-newest', status: 'queued', queuedAt: '2026-05-05T08:30:00Z' },
        // Older queued job, should NOT be picked.
        { id: 'queued-older', status: 'queued', queuedAt: '2026-05-05T08:15:00Z' },
      ]);
      const response = await request(app).post('/api/image-gen/cancel').send({});
      expect(response.status).toBe(200);
      // The newest-submit (codex-newest at 08:30) wins — not 'gpu-running'
      // (which appeared first in listJobs) and not 'queued-older'.
      expect(mediaJobQueue.cancelJob).toHaveBeenCalledTimes(1);
      expect(mediaJobQueue.cancelJob.mock.calls[0][0]).toBe('codex-newest');
    });

    it('POST /cancel (explicit jobId) cancels exactly that job and skips queuedAt selection', async () => {
      // When a jobId is provided, the route must cancel THAT job — even if a
      // newer queued job exists. This locks in that explicit selection wins
      // over the queuedAt fallback (writers-room "cancel this scene").
      mediaJobQueue.listJobs.mockReturnValueOnce([
        { id: 'newest', status: 'queued', queuedAt: '2026-05-05T08:30:00Z' },
        { id: 'middle', status: 'queued', queuedAt: '2026-05-05T08:20:00Z' },
        { id: 'oldest', status: 'running', queuedAt: '2026-05-05T08:00:00Z' },
      ]);
      const response = await request(app).post('/api/image-gen/cancel').send({ jobId: 'middle' });
      expect(response.status).toBe(200);
      expect(mediaJobQueue.cancelJob).toHaveBeenCalledTimes(1);
      expect(mediaJobQueue.cancelJob.mock.calls[0][0]).toBe('middle');
    });
  });
});
