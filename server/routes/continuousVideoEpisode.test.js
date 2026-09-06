import {
  describe, it, expect, vi, beforeEach,
} from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(async () => ({ imageGen: { local: { pythonPath: '/usr/bin/python3' } } })),
}));
vi.mock('../services/videoGen/continuousVideo.js', () => ({
  generateContinuousVideoEpisode: vi.fn(async () => ({ ok: true })),
  composeEpisodeClips: vi.fn(),
  attachEpisodeSseClient: vi.fn(() => false),
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

  describe('GET /:jobId/events', () => {
    it('404s when the job is not found', async () => {
      const r = await request(app).get('/api/continuous-video/missing/events');
      expect(r.status).toBe(404);
    });
  });
});
