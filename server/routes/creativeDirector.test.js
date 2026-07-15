import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

vi.mock('../services/creativeDirector/local.js', () => ({
  listProjects: vi.fn(async () => [{ id: 'cd-1', name: 'A' }]),
  getProject: vi.fn(),
  createProject: vi.fn(),
  updateProject: vi.fn(async (id, patch) => ({ id, ...patch })),
  deleteProject: vi.fn(async () => ({ ok: true })),
  setTreatment: vi.fn(),
  setPlan: vi.fn(),
  updatePlanStep: vi.fn(async () => ({})),
  updateScene: vi.fn(),
}));

vi.mock('../services/creativeDirector/completionHook.js', () => ({
  startCreativeDirectorProject: vi.fn(async () => undefined),
  advanceAfterSceneSettled: vi.fn(async () => undefined),
}));

// CDO Phase 4 (#2186) — the new studio routes dynamic-import these; mock so the
// route test stays off the heavy tool graph + cos state modules.
vi.mock('../services/creativeDirector/planAdvance.js', () => ({
  advanceAfterPlanStepSettled: vi.fn(async () => undefined),
}));
vi.mock('../services/creative/toolRegistry.js', () => ({
  getAllCreativeToolMetadata: vi.fn(() => [{ id: 'universe_create', costClass: 'free', longRunning: false, destructive: false }]),
}));
vi.mock('../lib/domainAutonomy.js', () => ({ getCreativeAutonomyMode: vi.fn(() => 'dry-run') }));
vi.mock('../services/domainUsage.js', () => ({ getDomainBudgetStatus: vi.fn(async () => ({ withinBudget: false, exceeded: 'actions' })) }));
vi.mock('../services/cosState.js', () => ({ loadState: vi.fn(async () => ({ config: {} })) }));

// Mock the auto-cast service so the route test doesn't pull the real
// catalogDB/embeddings graph; the route's job here is to validate + dispatch.
vi.mock('../services/creativeDirector/autoCast.js', () => ({
  suggestCastForBrief: vi.fn(async () => [{ ingredient: { id: 'c1', type: 'character', name: 'Mara', payload: {} }, rrfScore: 0.5, searchMethod: 'hybrid' }]),
  applyAutoCastToProject: vi.fn(async () => ({ project: { id: 'cd-1', cast: [] }, added: [], suggestions: [] })),
  toSuggestionView: (hit) => ({ ingredientId: hit.ingredient.id, name: hit.ingredient.name, type: hit.ingredient.type, score: hit.rrfScore, searchMethod: hit.searchMethod }),
}));

// Mock first-pass gen (#1818, extended by #1867) so the route test doesn't
// pull the real mediaJobQueue/catalogDB graph; the route's job is to gate +
// dispatch.
vi.mock('../services/creativeDirector/firstPassGen.js', () => ({
  enqueueFirstPassPortraits: vi.fn(async () => ({ mode: 'local', enqueued: [], skipped: [] })),
  enqueueFirstPassSceneFrames: vi.fn(async () => ({ mode: 'local', enqueued: [], skipped: [] })),
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

    it('returns a bounded envelope when pagination is requested', async () => {
      cdService.listProjects.mockResolvedValueOnce(
        Array.from({ length: 5 }, (_, i) => ({ id: `cd-${i}`, name: `P${i}` }))
      );
      const r = await request(app).get('/api/creative-director?limit=2&offset=1');
      expect(r.status).toBe(200);
      expect(r.body.items).toHaveLength(2);
      expect(r.body.items[0].id).toBe('cd-1');
      expect(r.body.total).toBe(5);
      expect(r.body.limit).toBe(2);
      expect(r.body.offset).toBe(1);
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
    const treatmentBody = {
      logline: 'A cat finds a hat.',
      synopsis: 'Then puts it on.',
      scenes: [{
        sceneId: 'scene-1',
        order: 0,
        intent: 'Cat enters frame',
        prompt: 'A cat walks into view',
        durationSeconds: 4,
      }],
    };

    it('writes the treatment when shape is valid', async () => {
      cdService.setTreatment.mockResolvedValue({ id: 'cd-1', treatment: { scenes: [] } });
      const r = await request(app).patch('/api/creative-director/cd-1/treatment').send(treatmentBody);
      expect(r.status).toBe(200);
      expect(cdService.setTreatment).toHaveBeenCalled();
    });
    // First-pass scene-frame seeding now fires from `setTreatment` itself
    // (the domain write, #1938) rather than this route, so its behavior is
    // asserted in services/creativeDirector/local.test.js.
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

    // The opt-in flag is now threaded into applyAutoCastToProject's options
    // (#1938) so the cast merge + flag persist in a single write, rather than
    // the route issuing a second updateProject. The route's job here is to
    // forward the flag; the actual persist is asserted in autoCast.test.js.
    it('forwards generateFirstPass to auto-cast when composing with the flag set (#1867)', async () => {
      autoCast.applyAutoCastToProject.mockResolvedValue({
        project: { id: 'cd-1', cast: [{ ingredientId: 'p1' }] }, added: [{ ingredientId: 'p1' }], suggestions: [],
      });
      const r = await request(app).post('/api/creative-director/cd-1/auto-cast').send({ compose: true, generateFirstPass: true });
      expect(r.status).toBe(200);
      expect(autoCast.applyAutoCastToProject).toHaveBeenCalledWith('cd-1', expect.objectContaining({ generateFirstPass: true }));
      expect(cdService.updateProject).not.toHaveBeenCalledWith('cd-1', { generateFirstPass: true });
    });

    it('forwards generateFirstPass even when not composing this request (#1867) — the toggles are independent, and the project may only be started later via /:id/start', async () => {
      autoCast.applyAutoCastToProject.mockResolvedValue({
        project: { id: 'cd-1', cast: [{ ingredientId: 'p1' }] }, added: [{ ingredientId: 'p1' }], suggestions: [],
      });
      const r = await request(app).post('/api/creative-director/cd-1/auto-cast').send({ generateFirstPass: true });
      expect(r.status).toBe(200);
      expect(autoCast.applyAutoCastToProject).toHaveBeenCalledWith('cd-1', expect.objectContaining({ generateFirstPass: true }));
      expect(hook.startCreativeDirectorProject).not.toHaveBeenCalled();
    });

    it('does not forward a truthy generateFirstPass when the flag is omitted', async () => {
      autoCast.applyAutoCastToProject.mockResolvedValue({
        project: { id: 'cd-1', cast: [{ ingredientId: 'p1' }] }, added: [{ ingredientId: 'p1' }], suggestions: [],
      });
      const r = await request(app).post('/api/creative-director/cd-1/auto-cast').send({ compose: true });
      expect(r.status).toBe(200);
      expect(autoCast.applyAutoCastToProject).toHaveBeenCalledWith('cd-1', expect.objectContaining({ generateFirstPass: undefined }));
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

  // CDO Phase 4 (#2186) — studio UI routes.
  describe('GET /tools', () => {
    it('returns the tool catalog + mode + budget', async () => {
      const r = await request(app).get('/api/creative-director/tools');
      expect(r.status).toBe(200);
      expect(r.body.tools).toEqual([{ id: 'universe_create', costClass: 'free', longRunning: false, destructive: false }]);
      expect(r.body.mode).toBe('dry-run');
      expect(r.body.budget).toEqual({ withinBudget: false, exceeded: 'actions' });
    });
  });

  describe('POST /:id/directive', () => {
    it('sets a directive, clears the plan, flips to planning, and nudges the advance loop', async () => {
      const planAdvance = await import('../services/creativeDirector/planAdvance.js');
      cdService.getProject.mockResolvedValue({ id: 'cd-1', status: 'draft' });
      const r = await request(app).post('/api/creative-director/cd-1/directive')
        .send({ goal: 'Make a noir series', deliverables: ['story'], constraints: { budgetCap: 10 } });
      expect(r.status).toBe(200);
      expect(cdService.updateProject).toHaveBeenCalledWith('cd-1', expect.objectContaining({
        plan: null, status: 'planning', directive: expect.objectContaining({ goal: 'Make a noir series' }),
      }));
      expect(planAdvance.advanceAfterPlanStepSettled).toHaveBeenCalledWith('cd-1');
    });

    it('leaves a paused project parked (no advance)', async () => {
      const planAdvance = await import('../services/creativeDirector/planAdvance.js');
      cdService.getProject.mockResolvedValue({ id: 'cd-1', status: 'paused' });
      const r = await request(app).post('/api/creative-director/cd-1/directive').send({ goal: 'x' });
      expect(r.status).toBe(200);
      expect(planAdvance.advanceAfterPlanStepSettled).not.toHaveBeenCalled();
    });

    it('400s on a missing goal', async () => {
      cdService.getProject.mockResolvedValue({ id: 'cd-1', status: 'draft' });
      const r = await request(app).post('/api/creative-director/cd-1/directive').send({ deliverables: ['x'] });
      expect(r.status).toBe(400);
    });

    it('404s on an unknown project', async () => {
      cdService.getProject.mockResolvedValue(null);
      const r = await request(app).post('/api/creative-director/nope/directive').send({ goal: 'x' });
      expect(r.status).toBe(404);
    });
  });

  describe('POST /:id/replan', () => {
    it('clears the plan and re-runs the planner', async () => {
      const planAdvance = await import('../services/creativeDirector/planAdvance.js');
      cdService.getProject.mockResolvedValue({ id: 'cd-1', status: 'rendering', directive: { goal: 'x' } });
      const r = await request(app).post('/api/creative-director/cd-1/replan');
      expect(r.status).toBe(200);
      expect(cdService.updateProject).toHaveBeenCalledWith('cd-1', { plan: null, status: 'planning', failureReason: null });
      expect(planAdvance.advanceAfterPlanStepSettled).toHaveBeenCalledWith('cd-1');
    });

    it('400s when the project has no directive', async () => {
      cdService.getProject.mockResolvedValue({ id: 'cd-1', status: 'draft', directive: null });
      const r = await request(app).post('/api/creative-director/cd-1/replan');
      expect(r.status).toBe(400);
    });
  });

  describe('POST /:id/plan/step/:stepId', () => {
    const projectWithStep = (status = 'rendering') => ({
      id: 'cd-1', status, directive: { goal: 'x' },
      plan: { steps: [{ stepId: 'draft', toolName: 'story_generateStep', status: 'blocked' }] },
    });

    it('skips a step, then nudges the advance loop', async () => {
      const planAdvance = await import('../services/creativeDirector/planAdvance.js');
      cdService.getProject.mockResolvedValue(projectWithStep());
      const r = await request(app).post('/api/creative-director/cd-1/plan/step/draft').send({ action: 'skip' });
      expect(r.status).toBe(200);
      expect(cdService.updatePlanStep).toHaveBeenCalledWith('cd-1', 'draft', expect.objectContaining({ status: 'skipped' }));
      expect(planAdvance.advanceAfterPlanStepSettled).toHaveBeenCalledWith('cd-1');
    });

    it('retries a step, resetting it to pending', async () => {
      cdService.getProject.mockResolvedValue(projectWithStep());
      const r = await request(app).post('/api/creative-director/cd-1/plan/step/draft').send({ action: 'retry' });
      expect(r.status).toBe(200);
      expect(cdService.updatePlanStep).toHaveBeenCalledWith('cd-1', 'draft', { status: 'pending', retryCount: 0, result: null });
    });

    it('clears a plan-level pause (paused → rendering) before advancing', async () => {
      cdService.getProject.mockResolvedValue(projectWithStep('paused'));
      const r = await request(app).post('/api/creative-director/cd-1/plan/step/draft').send({ action: 'retry' });
      expect(r.status).toBe(200);
      expect(cdService.updateProject).toHaveBeenCalledWith('cd-1', { status: 'rendering', failureReason: null });
    });

    it('404s on an unknown step', async () => {
      cdService.getProject.mockResolvedValue(projectWithStep());
      const r = await request(app).post('/api/creative-director/cd-1/plan/step/ghost').send({ action: 'skip' });
      expect(r.status).toBe(404);
    });

    it('400s on an invalid action', async () => {
      cdService.getProject.mockResolvedValue(projectWithStep());
      const r = await request(app).post('/api/creative-director/cd-1/plan/step/draft').send({ action: 'nuke' });
      expect(r.status).toBe(400);
    });
  });
});
