import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import scheduleRoutes from './cosScheduleRoutes.js';

vi.mock('../services/taskSchedule.js', () => ({
  getScheduleStatus: vi.fn(),
  getUpcomingTasks: vi.fn(),
  getTaskInterval: vi.fn(),
  shouldRunTask: vi.fn(),
  updateTaskInterval: vi.fn(),
  getDueTasks: vi.fn(),
  triggerOnDemandTask: vi.fn(),
  getOnDemandRequests: vi.fn(),
  clearOnDemandRequest: vi.fn(),
  resetExecutionHistory: vi.fn(),
  getTemplateTasks: vi.fn(),
  addTemplateTask: vi.fn(),
  deleteTemplateTask: vi.fn(),
  INTERVAL_TYPES: ['rotation', 'daily', 'weekly', 'once', 'on-demand', 'custom', 'cron']
}));

vi.mock('../lib/validation.js', () => ({
  sanitizeTaskMetadata: vi.fn((meta) => meta)
}));

import * as taskSchedule from '../services/taskSchedule.js';

describe('CoS Schedule Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/cos', scheduleRoutes);
    vi.clearAllMocks();
  });

  describe('GET /api/cos/schedule', () => {
    it('should return schedule status', async () => {
      taskSchedule.getScheduleStatus.mockResolvedValue({ tasks: [], enabled: true });

      const response = await request(app).get('/api/cos/schedule');

      expect(response.status).toBe(200);
    });
  });

  describe('GET /api/cos/upcoming', () => {
    it('should return upcoming tasks with default limit', async () => {
      taskSchedule.getUpcomingTasks.mockResolvedValue([{ taskType: 'review', dueIn: 300 }]);

      const response = await request(app).get('/api/cos/upcoming');

      expect(response.status).toBe(200);
      expect(taskSchedule.getUpcomingTasks).toHaveBeenCalledWith(10);
    });

    it('should respect custom limit', async () => {
      taskSchedule.getUpcomingTasks.mockResolvedValue([]);

      const response = await request(app).get('/api/cos/upcoming?limit=3');

      expect(response.status).toBe(200);
      expect(taskSchedule.getUpcomingTasks).toHaveBeenCalledWith(3);
    });
  });

  describe('GET /api/cos/schedule/task/:taskType', () => {
    it('should return interval and shouldRun for task type', async () => {
      taskSchedule.getTaskInterval.mockResolvedValue({ type: 'daily', intervalMs: 86400000 });
      taskSchedule.shouldRunTask.mockResolvedValue(true);

      const response = await request(app).get('/api/cos/schedule/task/review');

      expect(response.status).toBe(200);
      expect(response.body.taskType).toBe('review');
      expect(response.body.shouldRun).toBe(true);
    });
  });

  describe('PUT /api/cos/schedule/task/:taskType', () => {
    it('should update interval for task type', async () => {
      taskSchedule.updateTaskInterval.mockResolvedValue({ type: 'daily' });

      const response = await request(app)
        .put('/api/cos/schedule/task/review')
        .send({ type: 'daily', enabled: true });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should return 400 for invalid enabled type', async () => {
      const response = await request(app)
        .put('/api/cos/schedule/task/review')
        .send({ enabled: 'not-bool' });

      expect(response.status).toBe(400);
    });

    it('should return 400 for negative intervalMs', async () => {
      const response = await request(app)
        .put('/api/cos/schedule/task/review')
        .send({ intervalMs: -1 });

      expect(response.status).toBe(400);
    });

    it('should filter self-references from runAfter', async () => {
      taskSchedule.updateTaskInterval.mockResolvedValue({ type: 'rotation' });

      const response = await request(app)
        .put('/api/cos/schedule/task/review')
        .send({ runAfter: ['review', 'deploy'] });

      expect(response.status).toBe(200);
      expect(taskSchedule.updateTaskInterval).toHaveBeenCalledWith('review', expect.objectContaining({
        runAfter: ['deploy']
      }));
    });

    it('should set runAfter to null when only self-reference remains', async () => {
      taskSchedule.updateTaskInterval.mockResolvedValue({ type: 'rotation' });

      const response = await request(app)
        .put('/api/cos/schedule/task/review')
        .send({ runAfter: ['review'] });

      expect(response.status).toBe(200);
      expect(taskSchedule.updateTaskInterval).toHaveBeenCalledWith('review', expect.objectContaining({
        runAfter: null
      }));
    });
  });

  describe('GET /api/cos/schedule/due', () => {
    it('should return due tasks', async () => {
      taskSchedule.getDueTasks.mockResolvedValue([{ taskType: 'review' }]);

      const response = await request(app).get('/api/cos/schedule/due');

      expect(response.status).toBe(200);
      expect(response.body.tasks).toHaveLength(1);
    });
  });

  describe('GET /api/cos/schedule/due/:appId', () => {
    it('should return due tasks for specific app', async () => {
      taskSchedule.getDueTasks.mockResolvedValue([]);

      const response = await request(app).get('/api/cos/schedule/due/my-app');

      expect(response.status).toBe(200);
      expect(response.body.appId).toBe('my-app');
      expect(taskSchedule.getDueTasks).toHaveBeenCalledWith('my-app');
    });
  });

  describe('POST /api/cos/schedule/trigger', () => {
    it('should trigger an on-demand task', async () => {
      taskSchedule.triggerOnDemandTask.mockResolvedValue({ id: 'req-1' });

      const response = await request(app)
        .post('/api/cos/schedule/trigger')
        .send({ taskType: 'review', appId: 'my-app' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should return 400 if taskType is missing', async () => {
      const response = await request(app)
        .post('/api/cos/schedule/trigger')
        .send({});

      expect(response.status).toBe(400);
    });

    it('should return 409 when triggerOnDemandTask returns an error', async () => {
      taskSchedule.triggerOnDemandTask.mockResolvedValue({ error: 'Improvement is disabled — enable it in CoS → Config to run on-demand tasks' });

      const response = await request(app)
        .post('/api/cos/schedule/trigger')
        .send({ taskType: 'feature-ideas', appId: 'critical-mass' });

      expect(response.status).toBe(409);
      expect(response.body.error || response.body.message || '').toMatch(/disabled/i);
    });
  });

  describe('GET /api/cos/schedule/on-demand', () => {
    it('should return pending on-demand requests', async () => {
      taskSchedule.getOnDemandRequests.mockResolvedValue([{ id: 'req-1' }]);

      const response = await request(app).get('/api/cos/schedule/on-demand');

      expect(response.status).toBe(200);
      expect(response.body.requests).toHaveLength(1);
    });
  });

  describe('DELETE /api/cos/schedule/on-demand/:requestId', () => {
    it('should clear on-demand request', async () => {
      taskSchedule.clearOnDemandRequest.mockResolvedValue({ id: 'req-1' });

      const response = await request(app).delete('/api/cos/schedule/on-demand/req-1');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should return 404 if request not found', async () => {
      taskSchedule.clearOnDemandRequest.mockResolvedValue(null);

      const response = await request(app).delete('/api/cos/schedule/on-demand/req-999');

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/cos/schedule/reset', () => {
    it('should reset execution history', async () => {
      taskSchedule.resetExecutionHistory.mockResolvedValue({ success: true });

      const response = await request(app)
        .post('/api/cos/schedule/reset')
        .send({ taskType: 'review' });

      expect(response.status).toBe(200);
    });

    it('should return 400 if taskType is missing', async () => {
      const response = await request(app)
        .post('/api/cos/schedule/reset')
        .send({});

      expect(response.status).toBe(400);
    });

    it('should return 404 on reset error', async () => {
      taskSchedule.resetExecutionHistory.mockResolvedValue({ error: 'Task type not found' });

      const response = await request(app)
        .post('/api/cos/schedule/reset')
        .send({ taskType: 'unknown' });

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/cos/schedule/templates', () => {
    it('should return template tasks', async () => {
      taskSchedule.getTemplateTasks.mockResolvedValue([{ id: 'tmpl-1' }]);

      const response = await request(app).get('/api/cos/schedule/templates');

      expect(response.status).toBe(200);
      expect(response.body.templates).toHaveLength(1);
    });
  });

  describe('POST /api/cos/schedule/templates', () => {
    it('should add a template task', async () => {
      taskSchedule.addTemplateTask.mockResolvedValue({ id: 'tmpl-1', name: 'Review' });

      const response = await request(app)
        .post('/api/cos/schedule/templates')
        .send({ name: 'Review', description: 'Code review task' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should return 400 if name is missing', async () => {
      const response = await request(app)
        .post('/api/cos/schedule/templates')
        .send({ description: 'No name' });

      expect(response.status).toBe(400);
    });

    it('should return 400 if description is missing', async () => {
      const response = await request(app)
        .post('/api/cos/schedule/templates')
        .send({ name: 'No description' });

      expect(response.status).toBe(400);
    });
  });

  describe('DELETE /api/cos/schedule/templates/:templateId', () => {
    it('should delete a template task', async () => {
      taskSchedule.deleteTemplateTask.mockResolvedValue({ success: true });

      const response = await request(app).delete('/api/cos/schedule/templates/tmpl-1');

      expect(response.status).toBe(200);
    });

    it('should return 404 on delete error', async () => {
      taskSchedule.deleteTemplateTask.mockResolvedValue({ error: 'Template not found' });

      const response = await request(app).delete('/api/cos/schedule/templates/tmpl-999');

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/cos/schedule/interval-types', () => {
    it('should return available interval types', async () => {
      const response = await request(app).get('/api/cos/schedule/interval-types');

      expect(response.status).toBe(200);
      expect(response.body.types).toContain('daily');
      expect(response.body.descriptions).toHaveProperty('daily');
    });
  });

});
