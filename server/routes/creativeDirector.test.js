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
}));

import * as cdService from '../services/creativeDirector/local.js';
import * as hook from '../services/creativeDirector/completionHook.js';
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
});
