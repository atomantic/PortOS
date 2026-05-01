import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

vi.mock('../services/videoTimeline/local.js', () => ({
  listProjects: vi.fn(),
  getProject: vi.fn(),
  createProject: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  renderProject: vi.fn(),
  attachSseClient: vi.fn(() => false),
  cancelRender: vi.fn(() => true),
}));

import * as svc from '../services/videoTimeline/local.js';
import videoTimelineRoutes from './videoTimeline.js';

describe('videoTimeline routes', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/video-timeline', videoTimelineRoutes);
    vi.clearAllMocks();
  });

  describe('GET /projects', () => {
    it('returns the project list', async () => {
      svc.listProjects.mockResolvedValue([{ id: 'a', name: 'A' }]);
      const r = await request(app).get('/api/video-timeline/projects');
      expect(r.status).toBe(200);
      expect(r.body).toHaveLength(1);
    });
  });

  describe('POST /projects', () => {
    it('rejects empty name', async () => {
      const r = await request(app).post('/api/video-timeline/projects').send({ name: '' });
      expect(r.status).toBe(400);
    });

    it('creates a project and returns it', async () => {
      svc.createProject.mockResolvedValue({ id: 'p1', name: 'My Edit', clips: [] });
      const r = await request(app).post('/api/video-timeline/projects').send({ name: 'My Edit' });
      expect(r.status).toBe(201);
      expect(r.body.id).toBe('p1');
      expect(svc.createProject).toHaveBeenCalledWith('My Edit');
    });
  });

  describe('GET /projects/:id', () => {
    it('returns 404 when project missing', async () => {
      svc.getProject.mockResolvedValue(null);
      const r = await request(app).get('/api/video-timeline/projects/nope');
      expect(r.status).toBe(404);
    });

    it('returns the project when found', async () => {
      svc.getProject.mockResolvedValue({ id: 'p1', name: 'A', clips: [] });
      const r = await request(app).get('/api/video-timeline/projects/p1');
      expect(r.status).toBe(200);
      expect(r.body.name).toBe('A');
    });
  });

  describe('PATCH /projects/:id', () => {
    it('rejects clip with negative inSec', async () => {
      const r = await request(app).patch('/api/video-timeline/projects/p1').send({
        clips: [{ clipId: '11111111-1111-4111-8111-111111111111', inSec: -1, outSec: 2 }],
      });
      expect(r.status).toBe(400);
    });

    it('rejects empty patch body', async () => {
      const r = await request(app).patch('/api/video-timeline/projects/p1').send({});
      expect(r.status).toBe(400);
    });

    it('forwards expectedUpdatedAt to the service', async () => {
      svc.updateProject.mockResolvedValue({ id: 'p1', name: 'X', clips: [] });
      const r = await request(app).patch('/api/video-timeline/projects/p1').send({
        name: 'X',
        expectedUpdatedAt: '2026-01-01T00:00:00Z',
      });
      expect(r.status).toBe(200);
      expect(svc.updateProject).toHaveBeenCalledWith('p1', { name: 'X' }, '2026-01-01T00:00:00Z');
    });

    it('forwards a multi-clip update', async () => {
      svc.updateProject.mockResolvedValue({ id: 'p1', clips: [] });
      const clips = [
        { clipId: '11111111-1111-4111-8111-111111111111', inSec: 0, outSec: 4 },
        { clipId: '22222222-2222-4222-8222-222222222222', inSec: 1.5, outSec: 3.5 },
      ];
      const r = await request(app).patch('/api/video-timeline/projects/p1').send({ clips });
      expect(r.status).toBe(200);
      expect(svc.updateProject).toHaveBeenCalledWith('p1', { clips }, undefined);
    });

    it('rejects non-uuid clipId', async () => {
      const r = await request(app).patch('/api/video-timeline/projects/p1').send({
        clips: [{ clipId: 'not-a-uuid', inSec: 0, outSec: 1 }],
      });
      expect(r.status).toBe(400);
    });

    it('rejects outSec <= inSec', async () => {
      const r = await request(app).patch('/api/video-timeline/projects/p1').send({
        clips: [{ clipId: '11111111-1111-4111-8111-111111111111', inSec: 2, outSec: 2 }],
      });
      expect(r.status).toBe(400);
    });
  });

  describe('DELETE /projects/:id', () => {
    it('proxies to the service', async () => {
      svc.deleteProject.mockResolvedValue({ ok: true });
      const r = await request(app).delete('/api/video-timeline/projects/p1');
      expect(r.status).toBe(200);
      expect(svc.deleteProject).toHaveBeenCalledWith('p1');
    });
  });

  describe('POST /projects/:id/render', () => {
    it('proxies to the service and returns the jobId', async () => {
      svc.renderProject.mockResolvedValue({ jobId: 'job-123' });
      const r = await request(app).post('/api/video-timeline/projects/p1/render').send({});
      expect(r.status).toBe(200);
      expect(r.body.jobId).toBe('job-123');
    });
  });

  describe('GET /:jobId/events', () => {
    it('returns 404 when job is unknown', async () => {
      svc.attachSseClient.mockReturnValue(false);
      const r = await request(app).get('/api/video-timeline/unknown/events');
      expect(r.status).toBe(404);
    });
  });

  describe('POST /:jobId/cancel', () => {
    it('returns the cancel result', async () => {
      svc.cancelRender.mockReturnValue(true);
      const r = await request(app).post('/api/video-timeline/job-1/cancel').send({});
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
    });
  });
});
