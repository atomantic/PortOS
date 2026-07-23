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

// The outcome STORE (file I/O) is mocked; the pure aggregators the route composes
// (summarizeOutcomeStats + the rejection taxonomy) run for real so the test covers
// the real merge-rate/rejection math, not a restated stub.
vi.mock('../../services/layeredIntelligenceOutcomes.js', () => ({
  listOutcomesResult: vi.fn()
}));

import * as appsService from '../../services/apps.js';
import { listOutcomesResult } from '../../services/layeredIntelligenceOutcomes.js';

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

  describe('GET /api/apps/:id/layered-intelligence/outcomes', () => {
    it('composes stats + rejection tally + recent list from the store', async () => {
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'App' });
      appsService.getAppLayeredIntelligenceConfig.mockResolvedValue({ sources: { outcomes: true } });
      listOutcomesResult.mockResolvedValue({
        read: true,
        outcomes: [
          { slug: 'add-metrics', scope: 'app-improvement', outcome: 'merged', executionOutcome: 'success', executionAt: '2026-07-04T01:00:00.000Z', rejectionReason: null, issueRef: '#10', tracker: 'github', filedAt: '2026-07-04T00:00:00.000Z', outcomeAt: '2026-07-05T00:00:00.000Z' },
          { slug: 'drop-feature', scope: 'app-improvement', outcome: 'rejected', rejectionReason: 'user-rejected', issueRef: '#11', tracker: 'github', filedAt: '2026-07-03T00:00:00.000Z', outcomeAt: '2026-07-04T00:00:00.000Z' },
          { slug: 'vague-idea', scope: 'app-data-gap', outcome: 'abandoned', rejectionReason: 'unknown-reason', issueRef: '#12', tracker: 'github', filedAt: '2026-07-02T00:00:00.000Z', outcomeAt: '2026-07-03T00:00:00.000Z' },
          { slug: 'open-one', scope: 'app-improvement', outcome: null, rejectionReason: null, issueRef: '#13', tracker: 'github', filedAt: '2026-07-01T00:00:00.000Z', outcomeAt: null }
        ]
      });

      const response = await request(app).get('/api/apps/app-001/layered-intelligence/outcomes');

      expect(response.status).toBe(200);
      expect(response.body.read).toBe(true);
      expect(response.body.stats).toMatchObject({ total: 4, merged: 1, rejected: 1, abandoned: 1, pending: 1, resolved: 3 });
      expect(response.body.stats.mergeRate).toBeCloseTo(100 / 3, 5);
      expect(response.body.execution).toMatchObject({
        approved: 1, completed: 1, abandoned: 0, awaitingExecution: 0, attempted: 1, completionRate: 100,
        duration: { count: 1, medianMs: 3_600_000 }
      });
      expect(response.body.execution.byScope['app-improvement']).toMatchObject({ completed: 1, completionRate: 100 });
      // Real diagnoses only in entries; the undiagnosed abandoned row is `unknown`.
      expect(response.body.rejections.entries).toEqual([{ reason: 'user-rejected', count: 1 }]);
      expect(response.body.rejections.unknown).toBe(1);
      expect(response.body.rejections.unclassified).toBe(0);
      expect(response.body.recent).toHaveLength(4);
      expect(response.body.recent[0]).toMatchObject({ slug: 'add-metrics', outcome: 'merged' });
      expect(response.body.tracked).toBe(true);
      expect(listOutcomesResult).toHaveBeenCalledWith({ appId: 'app-001' });
    });

    it('reports tracked:false when the outcomes source is off (records may be stale)', async () => {
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'App' });
      appsService.getAppLayeredIntelligenceConfig.mockResolvedValue({ sources: { outcomes: false } });
      listOutcomesResult.mockResolvedValue({ read: true, outcomes: [] });

      const response = await request(app).get('/api/apps/app-001/layered-intelligence/outcomes');

      expect(response.status).toBe(200);
      expect(response.body.read).toBe(true);
      expect(response.body.tracked).toBe(false);
    });

    it('reports read:false when the store is unreadable (not an empty history)', async () => {
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'App' });
      listOutcomesResult.mockResolvedValue({ read: false, outcomes: [] });

      const response = await request(app).get('/api/apps/app-001/layered-intelligence/outcomes');

      expect(response.status).toBe(200);
      expect(response.body.read).toBe(false);
      expect(response.body.stats).toBeNull();
      expect(response.body.execution).toBeNull();
      expect(response.body.recent).toEqual([]);
    });

    it('returns a zero-total, null merge rate for an app that has filed nothing', async () => {
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'App' });
      listOutcomesResult.mockResolvedValue({ read: true, outcomes: [] });

      const response = await request(app).get('/api/apps/app-001/layered-intelligence/outcomes');

      expect(response.status).toBe(200);
      expect(response.body.read).toBe(true);
      expect(response.body.stats).toMatchObject({ total: 0, resolved: 0, mergeRate: null });
    });

    it('returns 404 for an unknown app', async () => {
      appsService.getAppById.mockResolvedValue(null);
      const response = await request(app).get('/api/apps/app-999/layered-intelligence/outcomes');
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
