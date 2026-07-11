import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import taskTypeRoutes from './taskTypes.js';

// Only the apps service is mocked; SELF_IMPROVEMENT_TASK_TYPES (taskSchedule) and
// parseCronToNextRun (eventScheduler) run for real, as do the sanitizeTaskMetadata
// validators.
vi.mock('../../services/apps.js', () => ({
  getAppById: vi.fn(),
  updateAppTaskTypeOverride: vi.fn(),
  getAppTaskTypeOverrides: vi.fn(),
  getAppWorkTracker: vi.fn(),
  getAppLayeredIntelligenceConfig: vi.fn(),
  toggleAllAppTaskTypes: vi.fn(),
  bulkUpdateAppTaskTypeOverride: vi.fn(),
  PORTOS_APP_ID: 'portos-default'
}));

import * as appsService from '../../services/apps.js';

describe('Apps Task-Type Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/apps', taskTypeRoutes);
    vi.clearAllMocks();
  });

  describe('GET /api/apps/:id/layered-intelligence', () => {
    it('returns the effective config + isPortos flag', async () => {
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'App' });
      appsService.getAppLayeredIntelligenceConfig.mockResolvedValue({
        enabled: false, intervalMs: 86400000, sources: { goals: true }, allowedScopes: ['app-improvement']
      });

      const response = await request(app).get('/api/apps/app-001/layered-intelligence');

      expect(response.status).toBe(200);
      expect(response.body.appId).toBe('app-001');
      expect(response.body.isPortos).toBe(false);
      expect(response.body.config.allowedScopes).toEqual(['app-improvement']);
      expect(appsService.getAppLayeredIntelligenceConfig).toHaveBeenCalledWith('app-001');
    });

    it('flags the PortOS baseline app', async () => {
      appsService.getAppById.mockResolvedValue({ id: 'portos-default', name: 'PortOS' });
      appsService.getAppLayeredIntelligenceConfig.mockResolvedValue({ enabled: false, allowedScopes: ['app-improvement', 'loop-meta'] });

      const response = await request(app).get('/api/apps/portos-default/layered-intelligence');

      expect(response.status).toBe(200);
      expect(response.body.isPortos).toBe(true);
    });

    it('returns 404 for an unknown app', async () => {
      appsService.getAppById.mockResolvedValue(null);
      const response = await request(app).get('/api/apps/app-999/layered-intelligence');
      expect(response.status).toBe(404);
    });
  });

  describe('PUT /api/apps/:id/task-types/:taskType', () => {
    it('should accept valid taskMetadata with allowed boolean keys', async () => {
      appsService.updateAppTaskTypeOverride.mockResolvedValue({
        id: 'app-001',
        name: 'Test App',
        taskTypeOverrides: { 'feature-ideas': { taskMetadata: { useWorktree: true } } }
      });

      const response = await request(app)
        .put('/api/apps/app-001/task-types/feature-ideas')
        .send({ taskMetadata: { useWorktree: true, simplify: false } });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should accept taskMetadata: null to clear metadata', async () => {
      appsService.updateAppTaskTypeOverride.mockResolvedValue({
        id: 'app-001',
        name: 'Test App',
        taskTypeOverrides: {}
      });

      const response = await request(app)
        .put('/api/apps/app-001/task-types/feature-ideas')
        .send({ taskMetadata: null });

      expect(response.status).toBe(200);
    });

    it('should reject taskMetadata that is an array', async () => {
      const response = await request(app)
        .put('/api/apps/app-001/task-types/feature-ideas')
        .send({ taskMetadata: [1, 2, 3] });

      expect(response.status).toBe(400);
    });

    it('should reject taskMetadata with only unknown keys', async () => {
      const response = await request(app)
        .put('/api/apps/app-001/task-types/feature-ideas')
        .send({ taskMetadata: { unknownKey: true } });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('unrecognized');
    });

    it('should reject taskMetadata with non-boolean values for allowed keys', async () => {
      const response = await request(app)
        .put('/api/apps/app-001/task-types/feature-ideas')
        .send({ taskMetadata: { useWorktree: 'yes' } });

      expect(response.status).toBe(400);
    });

    it('should return 400 when no valid fields provided', async () => {
      const response = await request(app)
        .put('/api/apps/app-001/task-types/feature-ideas')
        .send({});

      expect(response.status).toBe(400);
    });

    it('should reject an unknown taskType in the URL', async () => {
      const response = await request(app)
        .put('/api/apps/app-001/task-types/not-a-real-task-type')
        .send({ enabled: true });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_TASK_TYPE');
    });
  });

  describe('PUT /api/apps/bulk-task-type/:taskType', () => {
    it('should reject an unknown taskType in the URL', async () => {
      const response = await request(app)
        .put('/api/apps/bulk-task-type/not-a-real-task-type')
        .send({ enabled: true });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_TASK_TYPE');
    });
  });

  describe('PUT /api/apps/:id/task-types/all', () => {
    it('should toggle all task types for an app', async () => {
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'Test App' });
      appsService.toggleAllAppTaskTypes.mockResolvedValue({ id: 'app-001', name: 'Test App', taskTypeOverrides: { security: { enabled: true } } });

      const response = await request(app)
        .put('/api/apps/app-001/task-types/all')
        .send({ enabled: true });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.appId).toBe('app-001');
      expect(appsService.toggleAllAppTaskTypes).toHaveBeenCalledWith('app-001', true);
    });

    it('should return 400 when enabled is not a boolean', async () => {
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'Test App' });

      const response = await request(app)
        .put('/api/apps/app-001/task-types/all')
        .send({ enabled: 'yes' });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('should return 404 when app not found', async () => {
      appsService.getAppById.mockResolvedValue(null);

      const response = await request(app)
        .put('/api/apps/app-999/task-types/all')
        .send({ enabled: true });

      expect(response.status).toBe(404);
    });
  });
});
