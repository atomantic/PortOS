import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

vi.mock('../services/creativeDirector/local.js', () => ({
  listProjects: vi.fn(async () => [{ id: 'cd-1', name: 'A' }]),
  getProject: vi.fn(),
  createProject: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(async () => ({ ok: true })),
  setTreatment: vi.fn(),
  updateScene: vi.fn(),
}));

vi.mock('../services/creativeDirector/completionHook.js', () => ({
  startCreativeDirectorProject: vi.fn(async () => undefined),
  advanceAfterSceneSettled: vi.fn(async () => undefined),
}));

// Mock the auto-cast service so the route test doesn't pull the real
// catalogDB/embeddings graph; the route's job here is to validate + dispatch.
vi.mock('../services/creativeDirector/autoCast.js', () => ({
  suggestCastForBrief: vi.fn(async () => [{ ingredient: { id: 'c1', type: 'character', name: 'Mara', payload: {} }, rrfScore: 0.5, searchMethod: 'hybrid' }]),
  applyAutoCastToProject: vi.fn(async () => ({ project: { id: 'cd-1', cast: [] }, added: [], suggestions: [] })),
  toSuggestionView: (hit) => ({ ingredientId: hit.ingredient.id, name: hit.ingredient.name, type: hit.ingredient.type, score: hit.rrfScore, searchMethod: hit.searchMethod }),
}));

// Mock first-pass gen (#1818) so the route test doesn't pull the real
// mediaJobQueue/catalogDB graph; the route's job is to gate + dispatch.
vi.mock('../services/creativeDirector/firstPassGen.js', () => ({
  enqueueFirstPassPortraits: vi.fn(async () => ({ mode: 'local', enqueued: [], skipped: [] })),
}));

// Mock first-pass music-bed gen (#1928) so the route test doesn't pull the
// real mediaJobQueue/musicGen graph; the route's job is to gate + dispatch.
vi.mock('../services/creativeDirector/firstPassMusicGen.js', () => ({
  enqueueFirstPassMusicBed: vi.fn(async () => ({ mode: 'musicgen', enqueued: false, reason: 'no-prompt' })),
}));

import * as cdService from '../services/creativeDirector/local.js';
import * as autoCast from '../services/creativeDirector/autoCast.js';
import * as hook from '../services/creativeDirector/completionHook.js';
import * as firstPass from '../services/creativeDirector/firstPassGen.js';
import * as firstPassMusicBed from '../services/creativeDirector/firstPassMusicGen.js';
import creativeDirectorRoutes from './creativeDirector.js';

describe('creativeDirector routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/creative-director', creativeDirectorRoutes);
    vi.clearAllMocks();
  });

  describe('GET /', () => {
    it('returns all projects', async () => {
      const r = await request(app).get('/api/creative-director');
      expect(r.status).toBe(200);
      expect(r.body).toEqual([{ id: 'cd-1', name: 'A' }]);
    });
  });

  describe('GET /:id', () => {
    it('returns 404 when project missing', async () => {
      cdService.getProject.mockResolvedValue(null);
      const r = await request(app).get('/api/creative-director/cd-missing');
      expect(r.status).toBe(404);
    });

    it('returns the project when found', async () => {
      cdService.getProject.mockResolvedValue({ id: 'cd-1', name: 'A' });
      const r = await request(app).get('/api/creative-director/cd-1');
      expect(r.status).toBe(200);
      expect(r.body.id).toBe('cd-1');
    });

    it('with ?slim=1 drops runs[] + full treatment, keeps poll-essential fields', async () => {
      cdService.getProject.mockResolvedValue({
        id: 'cd-1', name: 'A', status: 'rendering', updatedAt: '2026-05-10T10:00:00Z',
        finalVideoId: null, failureReason: null,
        styleSpec: 'big blob of style notes that polling consumers do not need',
        runs: Array.from({ length: 50 }, (_, i) => ({ id: `run-${i}`, prompt: 'big payload' })),
        treatment: {
          logline: 'big logline text',
          synopsis: 'big synopsis text',
          scenes: [
            { sceneId: 's1', order: 0, status: 'accepted', intent: 'long intent text', visualPrompt: 'long prompt' },
            { sceneId: 's2', order: 1, status: 'rendering', intent: 'longer text', visualPrompt: 'longer prompt' },
          ],
        },
      });
      const r = await request(app).get('/api/creative-director/cd-1?slim=1');
      expect(r.status).toBe(200);
      expect(r.body).toEqual({
        id: 'cd-1',
        status: 'rendering',
        updatedAt: '2026-05-10T10:00:00Z',
        finalVideoId: null,
        failureReason: null,
        treatment: {
          scenes: [
            { sceneId: 's1', order: 0, status: 'accepted' },
            { sceneId: 's2', order: 1, status: 'rendering' },
          ],
        },
      });
      expect(r.body.runs).toBeUndefined();
      expect(r.body.styleSpec).toBeUndefined();
      expect(r.body.treatment.logline).toBeUndefined();
      expect(r.body.treatment.scenes[0].intent).toBeUndefined();
    });

    it('slim mode tolerates a project with no treatment (empty scenes array)', async () => {
      cdService.getProject.mockResolvedValue({
        id: 'cd-2', status: 'draft', updatedAt: 'now',
      });
      const r = await request(app).get('/api/creative-director/cd-2?slim=1');
      expect(r.status).toBe(200);
      expect(r.body.treatment).toEqual({ scenes: [] });
      expect(r.body.finalVideoId).toBeNull();
      expect(r.body.failureReason).toBeNull();
    });
  });

  describe('POST /', () => {
    it('rejects body missing required fields', async () => {
      const r = await request(app).post('/api/creative-director').send({ name: 'x' });
      expect(r.status).toBe(400);
    });

    it('creates a project on a complete payload', async () => {
      cdService.createProject.mockResolvedValue({ id: 'cd-new', name: 'New' });
      const r = await request(app).post('/api/creative-director').send({
        name: 'New',
        aspectRatio: '16:9',
        quality: 'standard',
        modelId: 'ltx2_unified',
        targetDurationSeconds: 60,
      });
      expect(r.status).toBe(201);
      expect(r.body.id).toBe('cd-new');
    });

    it('rejects an invalid aspect ratio', async () => {
      const r = await request(app).post('/api/creative-director').send({
        name: 'New',
        aspectRatio: '4:3',
        quality: 'standard',
        modelId: 'ltx2_unified',
        targetDurationSeconds: 60,
      });
      expect(r.status).toBe(400);
    });
  });

  describe('PATCH /:id/treatment', () => {
    it('writes the treatment when shape is valid', async () => {
      cdService.setTreatment.mockResolvedValue({ id: 'cd-1', treatment: { scenes: [] } });
      const r = await request(app).patch('/api/creative-director/cd-1/treatment').send({
        logline: 'A cat finds a hat.',
        synopsis: 'Then puts it on.',
        scenes: [{
          sceneId: 'scene-1',
          order: 0,
          intent: 'Cat enters frame',
          prompt: 'A cat walks into view',
          durationSeconds: 4,
        }],
      });
      expect(r.status).toBe(200);
      expect(cdService.setTreatment).toHaveBeenCalled();
    });
  });

  describe('POST /:id/start', () => {
    it('flips draft → planning and triggers the orchestrator', async () => {
      cdService.getProject.mockResolvedValueOnce({ id: 'cd-1', name: 'A', status: 'draft' });
      cdService.updateProject.mockResolvedValue({});
      const r = await request(app).post('/api/creative-director/cd-1/start');
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(cdService.updateProject).toHaveBeenCalledWith('cd-1', { status: 'planning' });
      expect(hook.startCreativeDirectorProject).toHaveBeenCalledWith('cd-1');
    });

    it('resets failed scenes back to pending and re-fires orchestrator', async () => {
      cdService.getProject.mockResolvedValueOnce({
        id: 'cd-1',
        status: 'failed',
        treatment: { scenes: [
          { sceneId: 'scene-1', status: 'failed', retryCount: 3 },
          { sceneId: 'scene-2', status: 'accepted', retryCount: 0 },
        ] },
      });
      cdService.updateProject.mockResolvedValue({});
      cdService.updateScene.mockResolvedValue({});
      const r = await request(app).post('/api/creative-director/cd-1/start');
      expect(r.status).toBe(200);
      expect(cdService.updateScene).toHaveBeenCalledWith('cd-1', 'scene-1', { status: 'pending', retryCount: 0 });
      expect(cdService.updateScene).not.toHaveBeenCalledWith('cd-1', 'scene-2', expect.anything());
      expect(hook.startCreativeDirectorProject).toHaveBeenCalledWith('cd-1');
    });
  });

  describe('POST /:id/pause', () => {
    it('marks paused', async () => {
      cdService.updateProject.mockResolvedValue({ id: 'cd-1', status: 'paused' });
      const r = await request(app).post('/api/creative-director/cd-1/pause');
      expect(r.status).toBe(200);
      expect(cdService.updateProject).toHaveBeenCalledWith('cd-1', { status: 'paused' });
    });
  });

  describe('POST /:id/resume', () => {
    it('rejects when not paused', async () => {
      cdService.getProject.mockResolvedValue({ id: 'cd-1', status: 'rendering' });
      const r = await request(app).post('/api/creative-director/cd-1/resume');
      expect(r.status).toBe(400);
    });

    it('flips paused → rendering and triggers the orchestrator', async () => {
      cdService.getProject.mockResolvedValueOnce({
        id: 'cd-1',
        status: 'paused',
        treatment: { scenes: [{ status: 'pending' }] },
      });
      cdService.updateProject.mockResolvedValue({});
      const r = await request(app).post('/api/creative-director/cd-1/resume');
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(cdService.updateProject).toHaveBeenCalledWith('cd-1', { status: 'rendering' });
      expect(hook.startCreativeDirectorProject).toHaveBeenCalledWith('cd-1');
    });
  });

  describe('PATCH /:id/scene/:sceneId', () => {
    it('returns the updated scene and does not nudge orchestrator for non-terminal status', async () => {
      cdService.updateScene.mockResolvedValue({ sceneId: 'scene-1', status: 'rendering' });
      const r = await request(app)
        .patch('/api/creative-director/cd-1/scene/scene-1')
        .send({ status: 'rendering' });
      expect(r.status).toBe(200);
      expect(cdService.updateScene).toHaveBeenCalledWith('cd-1', 'scene-1', { status: 'rendering' });
      expect(hook.advanceAfterSceneSettled).not.toHaveBeenCalled();
    });

    it('nudges the orchestrator when a scene is accepted', async () => {
      cdService.updateScene.mockResolvedValue({ sceneId: 'scene-1', status: 'accepted' });
      const r = await request(app)
        .patch('/api/creative-director/cd-1/scene/scene-1')
        .send({ status: 'accepted' });
      expect(r.status).toBe(200);
      expect(hook.advanceAfterSceneSettled).toHaveBeenCalledWith('cd-1');
    });

    it('nudges the orchestrator when a scene is failed', async () => {
      cdService.updateScene.mockResolvedValue({ sceneId: 'scene-1', status: 'failed' });
      const r = await request(app)
        .patch('/api/creative-director/cd-1/scene/scene-1')
        .send({ status: 'failed' });
      expect(r.status).toBe(200);
      expect(hook.advanceAfterSceneSettled).toHaveBeenCalledWith('cd-1');
    });
  });

  describe('POST /auto-cast/suggest (#1810)', () => {
    it('400s when brief is missing', async () => {
      const r = await request(app).post('/api/creative-director/auto-cast/suggest').send({});
      expect(r.status).toBe(400);
      expect(autoCast.suggestCastForBrief).not.toHaveBeenCalled();
    });

    it('returns slimmed suggestions for a brief (no full ingredient leak)', async () => {
      const r = await request(app).post('/api/creative-director/auto-cast/suggest').send({ brief: 'rain noir' });
      expect(r.status).toBe(200);
      expect(autoCast.suggestCastForBrief).toHaveBeenCalledWith({ brief: 'rain noir', types: undefined, limit: undefined });
      expect(r.body.suggestions).toEqual([
        { ingredientId: 'c1', name: 'Mara', type: 'character', score: 0.5, searchMethod: 'hybrid' },
      ]);
      expect(r.body.suggestions[0]).not.toHaveProperty('payload');
    });

    it('is not shadowed by the /:id param route', async () => {
      // /auto-cast/suggest must hit the literal handler, not POST /:id/auto-cast
      const r = await request(app).post('/api/creative-director/auto-cast/suggest').send({ brief: 'x' });
      expect(r.status).toBe(200);
      expect(autoCast.applyAutoCastToProject).not.toHaveBeenCalled();
    });
  });

  describe('POST /:id/auto-cast (#1810)', () => {
    it('applies auto-cast to the project and returns the result', async () => {
      autoCast.applyAutoCastToProject.mockResolvedValue({
        project: { id: 'cd-1', cast: [{ ingredientId: 'p1' }] }, added: [{ ingredientId: 'p1' }], suggestions: [],
      });
      const r = await request(app).post('/api/creative-director/cd-1/auto-cast').send({ limit: 5 });
      expect(r.status).toBe(200);
      expect(autoCast.applyAutoCastToProject).toHaveBeenCalledWith('cd-1', { brief: undefined, types: undefined, limit: 5 });
      expect(r.body.added).toEqual([{ ingredientId: 'p1' }]);
    });

    it('400s on an over-cap limit', async () => {
      const r = await request(app).post('/api/creative-director/cd-1/auto-cast').send({ limit: 999 });
      expect(r.status).toBe(400);
      expect(autoCast.applyAutoCastToProject).not.toHaveBeenCalled();
    });
  });

  describe('POST /:id/auto-cast — auto-compose (#1817)', () => {
    it('kicks off the treatment agent and reports composing when compose:true and the cast is seeded', async () => {
      autoCast.applyAutoCastToProject.mockResolvedValue({
        project: { id: 'cd-1', cast: [{ ingredientId: 'p1' }] }, added: [{ ingredientId: 'p1' }], suggestions: [],
      });
      const r = await request(app).post('/api/creative-director/cd-1/auto-cast').send({ compose: true });
      expect(r.status).toBe(200);
      expect(r.body.composing).toBe(true);
      expect(hook.startCreativeDirectorProject).toHaveBeenCalledWith('cd-1');
    });

    it('does not compose when compose is omitted', async () => {
      autoCast.applyAutoCastToProject.mockResolvedValue({
        project: { id: 'cd-1', cast: [{ ingredientId: 'p1' }] }, added: [{ ingredientId: 'p1' }], suggestions: [],
      });
      const r = await request(app).post('/api/creative-director/cd-1/auto-cast').send({});
      expect(r.status).toBe(200);
      expect(r.body.composing).toBe(false);
      expect(hook.startCreativeDirectorProject).not.toHaveBeenCalled();
    });

    it('does not compose when the project ends up with an empty cast', async () => {
      autoCast.applyAutoCastToProject.mockResolvedValue({ project: { id: 'cd-1', cast: [] }, added: [], suggestions: [] });
      const r = await request(app).post('/api/creative-director/cd-1/auto-cast').send({ compose: true });
      expect(r.status).toBe(200);
      expect(r.body.composing).toBe(false);
      expect(hook.startCreativeDirectorProject).not.toHaveBeenCalled();
    });

    it('never clobbers an existing treatment even with compose:true', async () => {
      autoCast.applyAutoCastToProject.mockResolvedValue({
        project: { id: 'cd-1', cast: [{ ingredientId: 'p1' }], treatment: { scenes: [{ sceneId: 's1' }] } },
        added: [], suggestions: [],
      });
      const r = await request(app).post('/api/creative-director/cd-1/auto-cast').send({ compose: true });
      expect(r.status).toBe(200);
      expect(r.body.composing).toBe(false);
      expect(hook.startCreativeDirectorProject).not.toHaveBeenCalled();
    });

    it('400s on a non-boolean compose', async () => {
      const r = await request(app).post('/api/creative-director/cd-1/auto-cast').send({ compose: 'yes' });
      expect(r.status).toBe(400);
      expect(autoCast.applyAutoCastToProject).not.toHaveBeenCalled();
    });

    it.each(['paused', 'failed'])('does not compose a %s project (orchestrator would no-op)', async (status) => {
      autoCast.applyAutoCastToProject.mockResolvedValue({
        project: { id: 'cd-1', status, cast: [{ ingredientId: 'p1' }] }, added: [], suggestions: [],
      });
      const r = await request(app).post('/api/creative-director/cd-1/auto-cast').send({ compose: true });
      expect(r.status).toBe(200);
      expect(r.body.composing).toBe(false);
      expect(hook.startCreativeDirectorProject).not.toHaveBeenCalled();
    });
  });

  describe('POST /:id/auto-cast — first-pass gen (#1818)', () => {
    it('enqueues first-pass portraits for the added members and returns the summary', async () => {
      autoCast.applyAutoCastToProject.mockResolvedValue({
        project: { id: 'cd-1', cast: [{ ingredientId: 'p1' }] }, added: [{ ingredientId: 'p1' }], suggestions: [],
      });
      firstPass.enqueueFirstPassPortraits.mockResolvedValue({
        mode: 'local', enqueued: [{ ingredientId: 'p1', jobId: 'job-1' }], skipped: [],
      });
      const r = await request(app).post('/api/creative-director/cd-1/auto-cast').send({ generateFirstPass: true });
      expect(r.status).toBe(200);
      expect(firstPass.enqueueFirstPassPortraits).toHaveBeenCalledWith([{ ingredientId: 'p1' }]);
      expect(r.body.firstPass).toEqual({ mode: 'local', enqueued: [{ ingredientId: 'p1', jobId: 'job-1' }], skipped: [] });
    });

    it('does not enqueue when generateFirstPass is omitted', async () => {
      autoCast.applyAutoCastToProject.mockResolvedValue({
        project: { id: 'cd-1', cast: [{ ingredientId: 'p1' }] }, added: [{ ingredientId: 'p1' }], suggestions: [],
      });
      const r = await request(app).post('/api/creative-director/cd-1/auto-cast').send({});
      expect(r.status).toBe(200);
      expect(firstPass.enqueueFirstPassPortraits).not.toHaveBeenCalled();
      expect(r.body.firstPass).toBeUndefined();
    });

    it('does not enqueue when nothing was added', async () => {
      autoCast.applyAutoCastToProject.mockResolvedValue({ project: { id: 'cd-1', cast: [{ ingredientId: 'p1' }] }, added: [], suggestions: [] });
      const r = await request(app).post('/api/creative-director/cd-1/auto-cast').send({ generateFirstPass: true });
      expect(r.status).toBe(200);
      expect(firstPass.enqueueFirstPassPortraits).not.toHaveBeenCalled();
      expect(r.body.firstPass).toBeUndefined();
    });

    it('composes and generates first-pass portraits together', async () => {
      autoCast.applyAutoCastToProject.mockResolvedValue({
        project: { id: 'cd-1', cast: [{ ingredientId: 'p1' }] }, added: [{ ingredientId: 'p1' }], suggestions: [],
      });
      firstPass.enqueueFirstPassPortraits.mockResolvedValue({ mode: 'local', enqueued: [{ ingredientId: 'p1', jobId: 'j' }], skipped: [] });
      const r = await request(app).post('/api/creative-director/cd-1/auto-cast').send({ compose: true, generateFirstPass: true });
      expect(r.status).toBe(200);
      expect(r.body.composing).toBe(true);
      expect(hook.startCreativeDirectorProject).toHaveBeenCalledWith('cd-1');
      expect(firstPass.enqueueFirstPassPortraits).toHaveBeenCalledWith([{ ingredientId: 'p1' }]);
    });

    it('400s on a non-boolean generateFirstPass', async () => {
      const r = await request(app).post('/api/creative-director/cd-1/auto-cast').send({ generateFirstPass: 'yes' });
      expect(r.status).toBe(400);
      expect(autoCast.applyAutoCastToProject).not.toHaveBeenCalled();
    });
  });

  describe('POST /:id/auto-cast — first-pass music bed (#1928)', () => {
    it('enqueues a first-pass music bed and returns the summary', async () => {
      autoCast.applyAutoCastToProject.mockResolvedValue({
        project: { id: 'cd-1', name: 'A', cast: [{ ingredientId: 'p1' }] }, added: [{ ingredientId: 'p1' }], suggestions: [],
      });
      firstPassMusicBed.enqueueFirstPassMusicBed.mockResolvedValue({ mode: 'musicgen', enqueued: true, jobId: 'job-1' });
      const r = await request(app).post('/api/creative-director/cd-1/auto-cast').send({ generateFirstPassMusicBed: true });
      expect(r.status).toBe(200);
      expect(firstPassMusicBed.enqueueFirstPassMusicBed).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'cd-1', name: 'A' }),
      );
      expect(r.body.firstPassMusicBed).toEqual({ mode: 'musicgen', enqueued: true, jobId: 'job-1' });
    });

    it('does not enqueue when generateFirstPassMusicBed is omitted', async () => {
      autoCast.applyAutoCastToProject.mockResolvedValue({
        project: { id: 'cd-1', cast: [{ ingredientId: 'p1' }] }, added: [{ ingredientId: 'p1' }], suggestions: [],
      });
      const r = await request(app).post('/api/creative-director/cd-1/auto-cast').send({});
      expect(r.status).toBe(200);
      expect(firstPassMusicBed.enqueueFirstPassMusicBed).not.toHaveBeenCalled();
      expect(r.body.firstPassMusicBed).toBeUndefined();
    });

    it('does not require added members — unlike portraits, it can run on a re-cast with no new members', async () => {
      autoCast.applyAutoCastToProject.mockResolvedValue({
        project: { id: 'cd-1', cast: [{ ingredientId: 'p1' }] }, added: [], suggestions: [],
      });
      firstPassMusicBed.enqueueFirstPassMusicBed.mockResolvedValue({ mode: 'musicgen', enqueued: true, jobId: 'job-1' });
      const r = await request(app).post('/api/creative-director/cd-1/auto-cast').send({ generateFirstPassMusicBed: true });
      expect(r.status).toBe(200);
      expect(firstPassMusicBed.enqueueFirstPassMusicBed).toHaveBeenCalled();
      expect(r.body.firstPassMusicBed).toEqual({ mode: 'musicgen', enqueued: true, jobId: 'job-1' });
    });

    it('composes, generates first-pass portraits, and the music bed together', async () => {
      autoCast.applyAutoCastToProject.mockResolvedValue({
        project: { id: 'cd-1', cast: [{ ingredientId: 'p1' }] }, added: [{ ingredientId: 'p1' }], suggestions: [],
      });
      firstPass.enqueueFirstPassPortraits.mockResolvedValue({ mode: 'local', enqueued: [{ ingredientId: 'p1', jobId: 'j' }], skipped: [] });
      firstPassMusicBed.enqueueFirstPassMusicBed.mockResolvedValue({ mode: 'musicgen', enqueued: true, jobId: 'job-2' });
      const r = await request(app).post('/api/creative-director/cd-1/auto-cast')
        .send({ compose: true, generateFirstPass: true, generateFirstPassMusicBed: true });
      expect(r.status).toBe(200);
      expect(r.body.composing).toBe(true);
      expect(r.body.firstPass).toEqual({ mode: 'local', enqueued: [{ ingredientId: 'p1', jobId: 'j' }], skipped: [] });
      expect(r.body.firstPassMusicBed).toEqual({ mode: 'musicgen', enqueued: true, jobId: 'job-2' });
    });

    it('400s on a non-boolean generateFirstPassMusicBed', async () => {
      const r = await request(app).post('/api/creative-director/cd-1/auto-cast').send({ generateFirstPassMusicBed: 'yes' });
      expect(r.status).toBe(400);
      expect(autoCast.applyAutoCastToProject).not.toHaveBeenCalled();
    });
  });
});
