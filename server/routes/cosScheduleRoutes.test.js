import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import scheduleRoutes from './cosScheduleRoutes.js';

const recordUserAction = vi.hoisted(() => vi.fn(async () => ({ id: 'evt' })));
vi.mock('../services/userActions.js', () => ({ recordUserAction }));
const maintenance = vi.hoisted(() => ({ listMaintenanceRuns: vi.fn(), startMaintenanceRun: vi.fn(), stopMaintenanceRun: vi.fn(), resumeMaintenanceRun: vi.fn() }));
vi.mock('../services/maintenanceRun.js', () => maintenance);

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
  INTERVAL_TYPES: { ON_DEMAND: 'on-demand', CRON: 'cron' }
}));

vi.mock('../lib/validation.js', () => ({
  sanitizeTaskMetadata: vi.fn((meta) => meta),
  taskDataInputsSchema: {
    safeParse: (ids) => {
      const allowed = new Set(['product-requirements', 'project-goals', 'open-issues', 'open-pull-requests', 'closed-unmerged-pull-requests']);
      return Array.isArray(ids) && ids.every((id) => allowed.has(id))
        ? { success: true, data: [...new Set(ids)] }
        : { success: false };
    }
  },
  validateRequest: vi.fn((schema, data) => {
    const result = schema.safeParse(data);
    if (!result.success) {
      const { ServerError } = require('../lib/errorHandler.js');
      throw new ServerError('Validation failed', { status: 400, code: 'VALIDATION_ERROR' });
    }
    return result.data;
  }),
  parsePagination: vi.fn((query, { defaultLimit = 50, maxLimit = 200 } = {}) => {
    const rawLimit = parseInt(query?.limit, 10);
    const rawOffset = parseInt(query?.offset, 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, maxLimit) : defaultLimit;
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    return { limit, offset };
  }),
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

  describe('manual maintenance runs', () => {
    it('accepts fix mode and rejects unknown modes', async () => {
      maintenance.startMaintenanceRun.mockResolvedValue({ run: { id: 'maint-1' } });
      const body = { appId: 'app-1', providerId: 'codex', model: 'gpt-5', mode: 'fix', claimBetweenAudits: false, claimHandler: { providerId: 'claude', model: 'sonnet', effort: 'low' } };
      expect((await request(app).post('/api/cos/schedule/maintenance-runs').send(body)).status).toBe(201);
      expect(maintenance.startMaintenanceRun).toHaveBeenCalledWith(body);
      expect((await request(app).post('/api/cos/schedule/maintenance-runs').send({ ...body, claimHandler: { providerId: 'claude' } })).status).toBe(400);
      expect((await request(app).post('/api/cos/schedule/maintenance-runs').send({ ...body, mode: 'unknown' })).status).toBe(400);
      expect((await request(app).post('/api/cos/schedule/maintenance-runs').send({ ...body, claimBetweenAudits: 'false' })).status).toBe(400);
    });
    it('starts a run from a validated body and reports the first dispatch', async () => {
      maintenance.startMaintenanceRun.mockResolvedValue({ run: { id: 'maint-1', status: 'running' }, result: { dispatched: true, taskType: 'better-structural-drift' } });
      const response = await request(app).post('/api/cos/schedule/maintenance-runs').send({ appId: 'app-1', providerId: 'codex', model: 'gpt-5', effort: null });
      expect(response.status).toBe(201);
      expect(response.body.result.taskType).toBe('better-structural-drift');
      expect(maintenance.startMaintenanceRun).toHaveBeenCalledWith({ appId: 'app-1', providerId: 'codex', model: 'gpt-5', effort: null });
      // The model is not optional: a run must name what it spends.
      expect((await request(app).post('/api/cos/schedule/maintenance-runs').send({ appId: 'app-1', providerId: 'codex' })).status).toBe(400);
      expect(maintenance.startMaintenanceRun).toHaveBeenCalledTimes(1);
    });

    it('lists, stops and resumes runs, and 404s an unknown id', async () => {
      maintenance.listMaintenanceRuns.mockResolvedValue([{ id: 'maint-1' }]);
      expect((await request(app).get('/api/cos/schedule/maintenance-runs')).body).toEqual({ runs: [{ id: 'maint-1' }] });
      maintenance.stopMaintenanceRun.mockResolvedValue({ id: 'maint-1', status: 'stopped' });
      expect((await request(app).post('/api/cos/schedule/maintenance-runs/maint-1/stop')).body.run.status).toBe('stopped');
      maintenance.resumeMaintenanceRun.mockResolvedValue(null);
      expect((await request(app).post('/api/cos/schedule/maintenance-runs/maint-1/resume')).status).toBe(404);
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
      taskSchedule.getTaskInterval.mockResolvedValue({ type: 'cron', cronExpression: '0 7 * * *' });
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
      expect(recordUserAction).toHaveBeenCalledWith(expect.objectContaining({
        type: 'cos.schedule.update',
        target: 'review',
        payload: expect.objectContaining({
          keysChanged: ['runAfter'],
          changes: { runAfter: { changed: true } },
        }),
      }));
    });

    it('records a long prompt as { changed: true }, never the body', async () => {
      taskSchedule.updateTaskInterval.mockResolvedValue({ type: 'daily' });
      const prompt = 'x'.repeat(200);
      const response = await request(app)
        .put('/api/cos/schedule/task/review')
        .send({ prompt });
      expect(response.status).toBe(200);
      expect(recordUserAction).toHaveBeenCalledWith(expect.objectContaining({
        type: 'cos.schedule.update',
        payload: expect.objectContaining({
          keysChanged: ['prompt'],
          changes: { prompt: { changed: true } },
        }),
      }));
      expect(JSON.stringify(recordUserAction.mock.calls.at(-1)[0])).not.toContain(prompt);
    });

    it('keeps an emptied suggestedAfter as [], so the shipped default is not re-seeded', async () => {
      taskSchedule.updateTaskInterval.mockResolvedValue({ type: 'on-demand' });

      const response = await request(app)
        .put('/api/cos/schedule/task/review')
        .send({ suggestedAfter: [] });

      expect(response.status).toBe(200);
      expect(taskSchedule.updateTaskInterval).toHaveBeenCalledWith('review', expect.objectContaining({
        suggestedAfter: []
      }));
    });

    it('normalizes suggestedAfter — self-reference and duplicates dropped, never nulled', async () => {
      taskSchedule.updateTaskInterval.mockResolvedValue({ type: 'on-demand' });

      const response = await request(app)
        .put('/api/cos/schedule/task/review')
        .send({ suggestedAfter: ['review', 'deploy', 'deploy'] });

      expect(response.status).toBe(200);
      expect(taskSchedule.updateTaskInterval).toHaveBeenCalledWith('review', expect.objectContaining({
        suggestedAfter: ['deploy']
      }));
    });

    it('rejects a suggestedAfter that is not a list of task type strings', async () => {
      const response = await request(app)
        .put('/api/cos/schedule/task/review')
        .send({ suggestedAfter: [{ taskType: 'deploy' }] });

      expect(response.status).toBe(400);
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

    it('validates and forwards registered data input ids', async () => {
      taskSchedule.updateTaskInterval.mockResolvedValue({ type: 'weekly' });
      const response = await request(app)
        .put('/api/cos/schedule/task/plan-feature')
        .send({ dataInputs: ['project-goals', 'open-issues', 'project-goals'] });

      expect(response.status).toBe(200);
      expect(taskSchedule.updateTaskInterval).toHaveBeenCalledWith('plan-feature', expect.objectContaining({
        dataInputs: ['project-goals', 'open-issues']
      }));
    });

    it('rejects unknown data input ids', async () => {
      const response = await request(app)
        .put('/api/cos/schedule/task/plan-feature')
        .send({ dataInputs: ['not-registered'] });

      expect(response.status).toBe(400);
      expect(taskSchedule.updateTaskInterval).not.toHaveBeenCalled();
    });

    // promptSource carries the stored prompt's provenance (#5432). An explicit
    // prompt write stamps it server-side, so the allowlist entry exists for the
    // writes that carry provenance WITHOUT a prompt — restoring a saved config,
    // or releasing a pin back to the auto-upgrade path without clearing the body.
    // The enum is validated here so neither can persist an unrecognized value.
    it('forwards a valid promptSource', async () => {
      taskSchedule.updateTaskInterval.mockResolvedValue({ type: 'weekly' });

      const response = await request(app)
        .put('/api/cos/schedule/task/documentation')
        .send({ promptSource: 'user' });

      expect(response.status).toBe(200);
      expect(taskSchedule.updateTaskInterval).toHaveBeenCalledWith('documentation', expect.objectContaining({
        promptSource: 'user'
      }));
    });

    it('normalizes an empty promptSource to null', async () => {
      taskSchedule.updateTaskInterval.mockResolvedValue({ type: 'weekly' });

      const response = await request(app)
        .put('/api/cos/schedule/task/documentation')
        .send({ promptSource: '' });

      expect(response.status).toBe(200);
      expect(taskSchedule.updateTaskInterval).toHaveBeenCalledWith('documentation', expect.objectContaining({
        promptSource: null
      }));
    });

    it('rejects an unknown promptSource', async () => {
      const response = await request(app)
        .put('/api/cos/schedule/task/documentation')
        .send({ promptSource: 'made-up' });

      expect(response.status).toBe(400);
      expect(taskSchedule.updateTaskInterval).not.toHaveBeenCalled();
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
    it('returns exactly the two cadence variants, with perpetual described apart', async () => {
      const response = await request(app).get('/api/cos/schedule/interval-types');

      expect(response.status).toBe(200);
      expect(response.body.types).toEqual({ ON_DEMAND: 'on-demand', CRON: 'cron' });
      expect(Object.keys(response.body.descriptions).sort()).toEqual(['cron', 'on-demand']);
      // `perpetual` is an orthogonal flag, so it must NOT appear as a type.
      expect(typeof response.body.perpetual).toBe('string');
    });
  });

  describe('PUT /api/cos/schedule/task/:taskType — cadence validation', () => {
    it('accepts the perpetual flag on either cadence and rejects a non-boolean', async () => {
      const ok = await request(app)
        .put('/api/cos/schedule/task/security')
        .send({ type: 'cron', cronExpression: '0 9 * * *', perpetual: true });
      expect(ok.status).toBe(200);
      expect(taskSchedule.updateTaskInterval).toHaveBeenCalledWith('security', expect.objectContaining({
        type: 'cron', cronExpression: '0 9 * * *', perpetual: true
      }));

      const bad = await request(app).put('/api/cos/schedule/task/security').send({ perpetual: 'yes' });
      expect(bad.status).toBe(400);
    });

    it('rewrites a legacy cadence name from an older client instead of rejecting it', async () => {
      taskSchedule.updateTaskInterval.mockClear();
      const weekly = await request(app).put('/api/cos/schedule/task/security').send({ type: 'weekly' });
      expect(weekly.status).toBe(200);
      expect(taskSchedule.updateTaskInterval).toHaveBeenCalledWith('security', expect.objectContaining({
        type: 'cron', cronExpression: '0 7 * * 1'
      }));

      taskSchedule.updateTaskInterval.mockClear();
      const perpetual = await request(app).put('/api/cos/schedule/task/security').send({ type: 'perpetual' });
      expect(perpetual.status).toBe(200);
      expect(taskSchedule.updateTaskInterval).toHaveBeenCalledWith('security', expect.objectContaining({
        type: 'on-demand', perpetual: true
      }));
    });

    it('accepts manual perpetual starts and rejects malformed start flags', async () => {
      const settings = { type: 'on-demand', perpetual: true, autoStart: false };
      const response = await request(app).put('/api/cos/schedule/task/security').send(settings);
      expect(response.status).toBe(200);
      expect(taskSchedule.updateTaskInterval).toHaveBeenCalledWith('security', settings);
      const invalid = await request(app).put('/api/cos/schedule/task/security').send({ autoStart: 'false' });
      expect(invalid.status).toBe(400);
    });

    it('rejects an unrecognized cadence name rather than silently making it manual-only', async () => {
      const response = await request(app).put('/api/cos/schedule/task/security').send({ type: 'hourly-ish' });
      expect(response.status).toBe(400);
    });

    it('rejects a cronExpression that is not 5 fields', async () => {
      const response = await request(app)
        .put('/api/cos/schedule/task/security')
        .send({ type: 'cron', cronExpression: '0 9 * *' });
      expect(response.status).toBe(400);
    });

    // #6634: a 5-token expression with an out-of-range field used to be saved
    // and enabled, then silently dropped by the scheduler — an 'enabled'
    // schedule that never fires. The store must not be written at all.
    it('rejects an out-of-range cronExpression before persisting it', async () => {
      for (const cronExpression of ['99 9 * * *', '0 25 * * *']) {
        taskSchedule.updateTaskInterval.mockClear();
        const response = await request(app)
          .put('/api/cos/schedule/task/security')
          .send({ type: 'cron', cronExpression });
        expect(response.status, cronExpression).toBe(400);
        expect(taskSchedule.updateTaskInterval).not.toHaveBeenCalled();
      }
    });

    it('rejects an out-of-range recheckCron before persisting it, and still clears on empty', async () => {
      taskSchedule.updateTaskInterval.mockClear();
      const bad = await request(app)
        .put('/api/cos/schedule/task/security')
        .send({ recheckCron: '99 9 * * *' });
      expect(bad.status).toBe(400);
      expect(taskSchedule.updateTaskInterval).not.toHaveBeenCalled();

      taskSchedule.updateTaskInterval.mockClear();
      const cleared = await request(app)
        .put('/api/cos/schedule/task/security')
        .send({ recheckCron: '  ' });
      expect(cleared.status).toBe(200);
      expect(taskSchedule.updateTaskInterval).toHaveBeenCalledWith('security', { recheckCron: null });

      taskSchedule.updateTaskInterval.mockClear();
      const ok = await request(app)
        .put('/api/cos/schedule/task/security')
        .send({ recheckCron: ' 0 */6 * * * ' });
      expect(ok.status).toBe(200);
      expect(taskSchedule.updateTaskInterval).toHaveBeenCalledWith('security', { recheckCron: '0 */6 * * *' });
    });

    // Syntax validity is not 'has an occurrence in the search window' — the
    // scheduler's bounded walk finds no leap day within two years of this
    // reference, but the expression is still savable.
    it('accepts a leap-day cron that has no occurrence in the search window', async () => {
      taskSchedule.updateTaskInterval.mockClear();
      const response = await request(app)
        .put('/api/cos/schedule/task/security')
        .send({ type: 'cron', cronExpression: '0 0 29 2 *' });
      expect(response.status).toBe(200);
      expect(taskSchedule.updateTaskInterval).toHaveBeenCalledWith('security', expect.objectContaining({
        type: 'cron', cronExpression: '0 0 29 2 *'
      }));
    });
  });

  it('normalizes labels, supports clearing, and rejects invalid labels before writing', async () => {
    taskSchedule.updateTaskInterval.mockResolvedValue({ labels: ['backend'] });
    const response = await request(app).put('/api/cos/schedule/task/security').send({ labels: [' Backend ', 'backend'] });
    expect(response.status).toBe(200);
    expect(taskSchedule.updateTaskInterval).toHaveBeenLastCalledWith('security', { labels: ['backend'] });
    expect((await request(app).put('/api/cos/schedule/task/security').send({ labels: [] })).status).toBe(200);
    taskSchedule.updateTaskInterval.mockClear();
    for (const labels of [null, 'backend', [''], ['x'.repeat(41)], Array(21).fill('x')]) {
      expect((await request(app).put('/api/cos/schedule/task/security').send({ labels })).status).toBe(400);
    }
    expect(taskSchedule.updateTaskInterval).not.toHaveBeenCalled();
  });

});
