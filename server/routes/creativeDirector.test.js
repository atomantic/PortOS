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

vi.mock('../services/creativeDirector/agentBridge.js', () => ({
  enqueueCreativeDirectorTask: vi.fn(async () => ({ id: 'task-mock' })),
}));

vi.mock('../services/creativeDirector/orchestrator.js', () => ({
  nextTaskKind: vi.fn(),
}));

import * as cdService from '../services/creativeDirector/local.js';
import * as agentBridge from '../services/creativeDirector/agentBridge.js';
import * as orchestrator from '../services/creativeDirector/orchestrator.js';
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
    it('enqueues the next-kind task when project is in draft', async () => {
      cdService.getProject
        .mockResolvedValueOnce({ id: 'cd-1', name: 'A', status: 'draft' })
        .mockResolvedValueOnce({ id: 'cd-1', name: 'A', status: 'planning' });
      cdService.updateProject.mockResolvedValue({});
      orchestrator.nextTaskKind.mockReturnValue('treatment');
      const r = await request(app).post('/api/creative-director/cd-1/start');
      expect(r.status).toBe(200);
      expect(r.body.kind).toBe('treatment');
      expect(agentBridge.enqueueCreativeDirectorTask).toHaveBeenCalled();
    });

    it('reports nothing-to-do when terminal', async () => {
      cdService.getProject.mockResolvedValue({ id: 'cd-1', name: 'A', status: 'complete' });
      orchestrator.nextTaskKind.mockReturnValue(null);
      const r = await request(app).post('/api/creative-director/cd-1/start');
      expect(r.status).toBe(200);
      expect(r.body.message).toMatch(/Nothing to do/);
      expect(agentBridge.enqueueCreativeDirectorTask).not.toHaveBeenCalled();
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

    it('flips status back and enqueues next task', async () => {
      cdService.getProject
        .mockResolvedValueOnce({ id: 'cd-1', status: 'paused', treatment: { scenes: [{ status: 'pending' }] } })
        .mockResolvedValueOnce({ id: 'cd-1', status: 'rendering', treatment: { scenes: [{ status: 'pending' }] } });
      cdService.updateProject.mockResolvedValue({});
      orchestrator.nextTaskKind.mockReturnValue('scene');
      const r = await request(app).post('/api/creative-director/cd-1/resume');
      expect(r.status).toBe(200);
      expect(r.body.kind).toBe('scene');
    });
  });
});
