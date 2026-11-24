import {
  describe, it, expect, vi, beforeEach,
} from 'vitest';
import express from 'express';
import { request, startLoopbackServer, closeLoopbackServer } from '../lib/testHelper.js';
import { errorMiddleware, ServerError } from '../lib/errorHandler.js';

vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(async () => ({ imageGen: { local: { pythonPath: '/usr/bin/python3' } } })),
}));
vi.mock('../services/videoGen/continuousVideo.js', () => ({
  generateContinuousVideoEpisode: vi.fn(async () => ({ ok: true })),
  composeEpisodeClips: vi.fn(),
  attachEpisodeSseClient: vi.fn(() => false),
  resolveEpisodeContinuity: vi.fn(async () => null),
  listActiveContinuousVideoEpisodes: vi.fn(() => []),
  cancelContinuousVideoEpisode: vi.fn(async () => ({ ok: false, code: 'NOT_FOUND', error: 'Episode job not found' })),
  CONTINUOUS_VIDEO_BACKENDS: ['local', 'reactor', 'fal'],
}));
vi.mock('../lib/videoPromptLinter.js', () => ({ lintClips: vi.fn() }));

import * as continuousVideo from '../services/videoGen/continuousVideo.js';
import { lintClips } from '../lib/videoPromptLinter.js';
import continuousVideoEpisodeRoutes from './continuousVideoEpisode.js';

const scenes = [{ sceneId: 's1', location: 'loc1', lines: [{ type: 'action', text: 'A quiet street.' }] }];
const bible = { locations: { loc1: { descriptor: 'A quiet, rain-slicked street.' } } };

describe('continuousVideoEpisode routes', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/continuous-video', continuousVideoEpisodeRoutes);
    app.use(errorMiddleware);
    vi.clearAllMocks();
    continuousVideo.composeEpisodeClips.mockReturnValue([{ prompt: 'A quiet street.', cutType: 'fresh' }]);
    continuousVideo.resolveEpisodeContinuity.mockResolvedValue(null);
    continuousVideo.listActiveContinuousVideoEpisodes.mockReturnValue([]);
    continuousVideo.cancelContinuousVideoEpisode.mockResolvedValue({ ok: false, code: 'NOT_FOUND', error: 'Episode job not found' });
    lintClips.mockReturnValue({ pass: true, results: [] });
  });

  describe('POST /', () => {
    it('rejects a request missing scenes/bible', async () => {
      const r = await request(app).post('/api/continuous-video').send({});
      expect(r.status).toBe(400);
      expect(continuousVideo.generateContinuousVideoEpisode).not.toHaveBeenCalled();
    });

    it('rejects a lint failure before starting generation', async () => {
      lintClips.mockReturnValue({ pass: false, results: [{ index: 0, pass: false, reasons: ['banned term'] }] });
      const r = await request(app).post('/api/continuous-video').send({ scenes, bible });
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('VIDEO_PROMPT_LINT_FAILED');
      expect(continuousVideo.generateContinuousVideoEpisode).not.toHaveBeenCalled();
    });

    it('starts an episode and returns a running job descriptor', async () => {
      const r = await request(app).post('/api/continuous-video').send({ scenes, bible, backend: 'local' });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('running');
      expect(typeof r.body.jobId).toBe('string');
      expect(continuousVideo.generateContinuousVideoEpisode).toHaveBeenCalledTimes(1);
      const call = continuousVideo.generateContinuousVideoEpisode.mock.calls[0][0];
      expect(call.jobId).toBe(r.body.jobId);
      expect(call.backend).toBe('local');
      // pythonPath/settings are server-resolved, never accepted from the client.
      expect(call.renderOptions.pythonPath).toBe('/usr/bin/python3');
      expect(call.renderOptions.settings).toBeTruthy();
    });

    it('strips a client-supplied pythonPath/settings override from renderOptions', async () => {
      const r = await request(app).post('/api/continuous-video').send({
        scenes, bible, renderOptions: { pythonPath: '/evil/python', settings: { hacked: true }, modelId: 'ltx2' },
      });
      expect(r.status).toBe(200);
      const call = continuousVideo.generateContinuousVideoEpisode.mock.calls[0][0];
      expect(call.renderOptions.pythonPath).toBe('/usr/bin/python3');
      expect(call.renderOptions.settings).not.toEqual({ hacked: true });
      expect(call.renderOptions.modelId).toBe('ltx2');
    });

    it('refuses unavailable temporal admission before returning a running descriptor', async () => {
      continuousVideo.resolveEpisodeContinuity.mockRejectedValueOnce(new ServerError('Hardware evidence unavailable', { status: 400, code: 'VIDEO_TEMPORAL_UNAVAILABLE' }));
      const r = await request(app).post('/api/continuous-video').send({
        scenes, bible, renderOptions: { continuityStrategy: 'window', contextFrames: 17 },
      });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('VIDEO_TEMPORAL_UNAVAILABLE');
      expect(continuousVideo.resolveEpisodeContinuity).toHaveBeenCalledWith({
        backend: undefined, renderOptions: { continuityStrategy: 'window', contextFrames: 17 },
      });
      expect(continuousVideo.generateContinuousVideoEpisode).not.toHaveBeenCalled();
    });
  });

  describe('POST /lint', () => {
    it('composes and lints without starting generation', async () => {
      lintClips.mockReturnValue({ pass: false, results: [{ index: 0, pass: false, reasons: ['banned term'] }] });
      const r = await request(app).post('/api/continuous-video/lint').send({ scenes, bible });
      expect(r.status).toBe(200);
      expect(r.body.lint.pass).toBe(false);
      expect(r.body.clips).toEqual([{ prompt: 'A quiet street.', cutType: 'fresh' }]);
      expect(continuousVideo.generateContinuousVideoEpisode).not.toHaveBeenCalled();
    });

    it('rejects a request missing scenes/bible', async () => {
      const r = await request(app).post('/api/continuous-video/lint').send({});
      expect(r.status).toBe(400);
      expect(continuousVideo.composeEpisodeClips).not.toHaveBeenCalled();
    });

    it('does not accept backend/renderOptions — only compose+lint fields', async () => {
      const r = await request(app).post('/api/continuous-video/lint').send({
        scenes, bible, backend: 'reactor', renderOptions: { modelId: 'ltx2' },
      });
      expect(r.status).toBe(200);
      // composeEpisodeClips is only ever called with the compose-relevant fields.
      const call = continuousVideo.composeEpisodeClips.mock.calls[0][0];
      expect(call).not.toHaveProperty('backend');
      expect(call).not.toHaveProperty('renderOptions');
    });
  });

  describe('GET /active', () => {
    it('returns empty activeEpisodes and null activeEpisode when none are running', async () => {
      const r = await request(app).get('/api/continuous-video/active');
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ activeEpisodes: [], activeEpisode: null });
    });

    it('returns running episodes with the most recent as activeEpisode', async () => {
      const ep1 = { jobId: 'ep-1', generationId: 'ep-1', backend: 'local', status: 'running', totalClips: 2, progress: 0.5, message: 'Clip 2/2' };
      const ep2 = { jobId: 'ep-2', generationId: 'ep-2', backend: 'fal', status: 'running', totalClips: 3, progress: 0, message: 'Clip 1/3' };
      continuousVideo.listActiveContinuousVideoEpisodes.mockReturnValue([ep1, ep2]);
      const r = await request(app).get('/api/continuous-video/active');
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ activeEpisodes: [ep1, ep2], activeEpisode: ep2 });
    });
  });

  describe('POST /:jobId/cancel', () => {
    it('cancels an active episode and returns 200', async () => {
      continuousVideo.cancelContinuousVideoEpisode.mockResolvedValueOnce({ ok: true, jobId: 'ep-1', status: 'canceling' });
      const r = await request(app).post('/api/continuous-video/ep-1/cancel');
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true, jobId: 'ep-1', status: 'canceling' });
      expect(continuousVideo.cancelContinuousVideoEpisode).toHaveBeenCalledExactlyOnceWith('ep-1');
    });

    it('returns 404 when the episode id does not exist', async () => {
      const r = await request(app).post('/api/continuous-video/missing/cancel');
      expect(r.status).toBe(404);
      expect(r.body.code).toBe('NOT_FOUND');
    });

    it('returns 409 when the episode already settled', async () => {
      continuousVideo.cancelContinuousVideoEpisode.mockResolvedValueOnce({
        ok: false, code: 'ALREADY_TERMINAL', status: 'complete', error: 'Episode is already complete',
      });
      const r = await request(app).post('/api/continuous-video/ep-done/cancel');
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('ALREADY_TERMINAL');
    });
  });

  describe('GET /:jobId/events', () => {
    it('404s when the job is not found', async () => {
      const r = await request(app).get('/api/continuous-video/missing/events');
      expect(r.status).toBe(404);
    });

    it('attaches SSE immediately after POST while cold module import is still pending and streams setup rejection', async () => {
      vi.resetModules();
      vi.doUnmock('../services/videoGen/continuousVideo.js');
      vi.doUnmock('../lib/videoPromptLinter.js');
      vi.doMock('../services/mediaJobQueue/index.js', async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
          get enqueueJob() { throw new Error('cold import crashed'); },
          cancelJob: vi.fn(),
        };
      });

      const { default: realRouter } = await import('./continuousVideoEpisode.js');
      const liveApp = express();
      liveApp.use(express.json());
      liveApp.use('/api/continuous-video', realRouter);
      liveApp.use(errorMiddleware);

      const server = await startLoopbackServer(liveApp);
      const { port } = server.address();
      const baseUrl = `http://127.0.0.1:${port}`;
      try {
        const postRes = await fetch(`${baseUrl}/api/continuous-video`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scenes, bible, backend: 'local' }),
        });
        expect(postRes.status).toBe(200);
        const { jobId } = await postRes.json();

        // Attach immediately while dynamic queue module import is still blocked.
        const sseRes = await fetch(`${baseUrl}/api/continuous-video/${jobId}/events`);
        expect(sseRes.status).toBe(200);
        expect(sseRes.headers.get('content-type')).toContain('text/event-stream');

        const reader = sseRes.body.getReader();
        const { value } = await reader.read();
        const text = new TextDecoder().decode(value);
        expect(text).toContain('"type":"error"');
        expect(text).toContain('cold import crashed');
        await reader.cancel();
      } finally {
        server.closeAllConnections?.();
        await closeLoopbackServer(server);
        vi.resetModules();
      }
    });

    it('discovers a running episode via GET /active and cancels it via POST /:jobId/cancel with a canceled SSE frame', async () => {
      vi.resetModules();
      vi.doUnmock('../services/videoGen/continuousVideo.js');
      vi.doUnmock('../lib/videoPromptLinter.js');
      let capturedInnerId = null;
      const falCancelMock = vi.fn(() => true);
      vi.doMock('../services/videoGen/fal.js', () => ({
        generateVideo: vi.fn(async ({ jobId }) => {
          capturedInnerId = jobId;
          return { jobId };
        }),
        cancel: falCancelMock,
      }));

      const { default: realRouter } = await import('./continuousVideoEpisode.js');
      const liveApp = express();
      liveApp.use(express.json());
      liveApp.use('/api/continuous-video', realRouter);
      liveApp.use(errorMiddleware);

      const server = await startLoopbackServer(liveApp);
      const { port } = server.address();
      const baseUrl = `http://127.0.0.1:${port}`;
      try {
        const postRes = await fetch(`${baseUrl}/api/continuous-video`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scenes, bible, backend: 'fal' }),
        });
        expect(postRes.status).toBe(200);
        const { jobId } = await postRes.json();

        await vi.waitFor(() => expect(capturedInnerId).toBeTruthy());

        const activeRes = await fetch(`${baseUrl}/api/continuous-video/active`);
        expect(activeRes.status).toBe(200);
        const activeBody = await activeRes.json();
        expect(activeBody.activeEpisode).toMatchObject({ jobId, backend: 'fal', status: 'running' });

        const sseRes = await fetch(`${baseUrl}/api/continuous-video/${jobId}/events`);
        expect(sseRes.status).toBe(200);
        const reader = sseRes.body.getReader();

        const cancelRes = await fetch(`${baseUrl}/api/continuous-video/${jobId}/cancel`, { method: 'POST' });
        expect(cancelRes.status).toBe(200);
        expect(falCancelMock).toHaveBeenCalledExactlyOnceWith(capturedInnerId);

        let received = '';
        while (!received.includes('"type":"canceled"')) {
          const { done, value } = await reader.read();
          if (done) break;
          received += new TextDecoder().decode(value);
        }
        expect(received).toContain('"type":"canceled"');
        await reader.cancel();

        const afterActiveRes = await fetch(`${baseUrl}/api/continuous-video/active`);
        expect(await afterActiveRes.json()).toEqual({ activeEpisodes: [], activeEpisode: null });
      } finally {
        server.closeAllConnections?.();
        await closeLoopbackServer(server);
        vi.resetModules();
      }
    });
  });
});
