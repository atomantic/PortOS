import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import scheduleRoutes from './cosScheduleRoutes.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const recordUserAction = vi.hoisted(() => vi.fn(async () => ({ id: 'evt' })));
vi.mock('../services/userActions.js', () => ({ recordUserAction }));
const maintenance = vi.hoisted(() => ({ updateMaintenanceStep: vi.fn(), listMaintenanceRuns: vi.fn(), startMaintenanceRun: vi.fn(), stopMaintenanceRun: vi.fn(), resumeMaintenanceRun: vi.fn() }));
vi.mock('../services/maintenanceRun.js', () => maintenance);
const recovery = vi.hoisted(() => ({ prepareInventoriedCheckoutRetirement: vi.fn(), retireInventoriedCheckout: vi.fn() }));
vi.mock('../services/heldCheckoutRecovery.js', () => recovery);
const legacyRecovery = vi.hoisted(() => ({ reviewLegacyReleaseRecovery: vi.fn(), acceptLegacyReleaseRecovery: vi.fn(), resetReleaseSynchronization: vi.fn() }));
vi.mock('../services/releaseSynchronization.js', () => legacyRecovery);
const refreshInventory = vi.hoisted(() => vi.fn());
vi.mock('../services/branchReconcileRefresh.js', () => ({ refreshBranchReconcileInventory: refreshInventory }));

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

vi.mock('../lib/validation.js', async (importOriginal) => ({
  ...(await importOriginal()),
  sanitizeTaskMetadata: vi.fn((meta) => meta),
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

  it('requires an exact reviewed legacy recovery digest and returns a bounded refusal', async () => {
    app.use(errorMiddleware);
    const identity = 'a'.repeat(64), digest = 'b'.repeat(64);
    legacyRecovery.reviewLegacyReleaseRecovery.mockResolvedValue({ digest, mode: 'present' });
    legacyRecovery.acceptLegacyReleaseRecovery.mockResolvedValue({ digest, acceptedAt: '2026-01-01T00:00:00Z' });
    const base = '/api/cos/schedule/release-synchronization/legacy';
    expect((await request(app).post(`${base}/review`).send({ identity })).body).toEqual({ digest, mode: 'present' });
    expect((await request(app).post(`${base}/accept`).send({ identity, digest })).body).toEqual({ identity, digest, acceptedAt: '2026-01-01T00:00:00Z' });
    expect((await request(app).post(`${base}/accept`).send({ identity, digest: 'bad' })).status).toBe(400);
    legacyRecovery.reviewLegacyReleaseRecovery.mockRejectedValue(Object.assign(new Error('private detail'), { code: 'legacy-review-lifecycle-unverified' }));
    const refused = await request(app).post(`${base}/review`).send({ identity });
    expect(refused.status).toBe(409);
    expect(refused.body.context.reason).toBe('legacy-review-lifecycle-unverified');
    expect(JSON.stringify(refused.body)).not.toContain('private detail');
  });

  it('records an operator checkpoint reset with a reason', async () => {
    app.use(errorMiddleware);
    const identity = 'a'.repeat(64), reason = 'Start from main';
    legacyRecovery.resetReleaseSynchronization.mockResolvedValue({ identity, reason });
    const path = '/api/cos/schedule/release-synchronization/operator-reset';
    expect((await request(app).post(path).send({ identity, reason })).body).toEqual({ identity, reason });
    expect(legacyRecovery.resetReleaseSynchronization).toHaveBeenCalledWith(identity, reason, 'local-operator', []);
    expect((await request(app).post(path).send({ identity, reason: '' })).status).toBe(400);
    expect((await request(app).post(path).send({ identity, reason, actor: 'operator-session' })).status).toBe(400);
  });

  it('refreshes only a validated managed app target', async () => {
    const result = { appId: 'app-1', outcome: { status: 'drained', remaining: [] } };
    refreshInventory.mockResolvedValue(result);
    const response = await request(app).post('/api/cos/schedule/branch-reconcile/refresh').send({ appId: 'app-1' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(result);
    expect(refreshInventory).toHaveBeenCalledWith('app-1');
    refreshInventory.mockClear();
    for (const body of [{}, { appId: null }, { appId: 4 }, { appId: 'app-1', cleanup: true }]) {
      expect((await request(app).post('/api/cos/schedule/branch-reconcile/refresh').send(body)).status).toBe(400);
    }
    expect(refreshInventory).not.toHaveBeenCalled();
  });

  it('keeps replacement-source mode out of the released inventory tuple and binds it on confirmation', async () => {
    const tuple = { path: '/synthetic/checkout', head: 'a'.repeat(40), branch: 'original', locked: false, lockReason: null };
    const prUrl = 'https://github.com/example/repo/pull/42';
    recovery.prepareInventoriedCheckoutRetirement.mockResolvedValue({ ok: true, review: { digest: 'b'.repeat(64) } });
    expect((await request(app).post('/api/cos/schedule/branch-reconcile/checkouts/review')
      .send({ appId: 'app-1', ...tuple, prUrl, kind: 'source-supersession' })).status).toBe(200);
    expect(recovery.prepareInventoriedCheckoutRetirement).toHaveBeenCalledWith({ appId: 'app-1', release: tuple, prUrl, kind: 'source-supersession' });
    const review = { prUrl, digest: 'b'.repeat(64), acceptSuperseded: true, kind: 'source-supersession' };
    recovery.retireInventoriedCheckout.mockResolvedValue({ ok: true });
    expect((await request(app).post('/api/cos/schedule/branch-reconcile/checkouts/retire').send({ appId: 'app-1', ...tuple, review })).status).toBe(200);
    expect(recovery.retireInventoriedCheckout).toHaveBeenCalledWith({ appId: 'app-1', release: tuple, review });
    expect((await request(app).post('/api/cos/schedule/branch-reconcile/checkouts/review').send({ appId: 'app-1', ...tuple, prUrl, kind: 'force' })).status).toBe(400);
  });

  it.each([false, true])('validates retirement review evidence with optional observation identity: %s', async withObservation => {
    const tuple = { path: '/synthetic/checkout', head: 'a'.repeat(40), branch: 'claim/42', locked: false, lockReason: null };
    if (withObservation) Object.assign(tuple, { checkoutIdentity: 'c'.repeat(64), observedAt: '2026-10-23T00:00:00Z' });
    const prUrl = 'https://github.com/example/repo/pull/42';
    recovery.prepareInventoriedCheckoutRetirement.mockResolvedValue({ ok: true, review: { digest: 'b'.repeat(64) } });
    const prepared = await request(app).post('/api/cos/schedule/branch-reconcile/checkouts/review').send({ appId: 'app-1', ...tuple, prUrl });
    expect(prepared.status).toBe(200);
    expect(recovery.prepareInventoriedCheckoutRetirement).toHaveBeenCalledWith({ appId: 'app-1', release: tuple, prUrl });
    const review = { prUrl, digest: 'b'.repeat(64), acceptSuperseded: true };
    recovery.retireInventoriedCheckout.mockResolvedValue({ ok: false, reason: 'retirement-review-changed' });
    const kept = await request(app).post('/api/cos/schedule/branch-reconcile/checkouts/retire').send({ appId: 'app-1', ...tuple, review });
    expect(kept.status).toBe(409);
    expect(recovery.retireInventoriedCheckout).toHaveBeenCalledWith({ appId: 'app-1', release: tuple, review });
    recovery.retireInventoriedCheckout.mockClear();
    expect((await request(app).post('/api/cos/schedule/branch-reconcile/checkouts/retire').send({ appId: 'app-1', ...tuple, review: { ...review, digest: 'wrong' } })).status).toBe(400);
    expect(recovery.retireInventoriedCheckout).not.toHaveBeenCalled();
  });

  it.each([
    ['review', 'CHECKOUT_REVIEW_REFUSED'], ['retire', 'CHECKOUT_RETIREMENT_REFUSED'],
  ])('returns numeric archive capacity evidence on refused %s without claiming a review or receipt', async (operation, code) => {
    const tuple = { path: '/synthetic/checkout', head: 'a'.repeat(40), branch: 'claim/42', locked: false, lockReason: null };
    const archiveLimit = { scope: 'content', kind: 'total', limitBytes: 250 * 1024 * 1024, observedBytes: 264 * 1024 * 1024 };
    recovery.prepareInventoriedCheckoutRetirement.mockResolvedValue({ ok: false, reason: 'retirement-archive-limit-exceeded', archiveLimit });
    recovery.retireInventoriedCheckout.mockResolvedValue({ ok: false, reason: 'retirement-archive-limit-exceeded', archiveLimit });
    const prUrl = 'https://github.com/example/repo/pull/42';
    const evidence = operation === 'review' ? { prUrl } : { review: { prUrl, digest: 'b'.repeat(64), acceptSuperseded: false } };
    const response = await request(app).post(`/api/cos/schedule/branch-reconcile/checkouts/${operation}`)
      .send({ appId: 'app-1', ...tuple, ...evidence });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code, context: { reason: 'retirement-archive-limit-exceeded', archiveLimit } });
    expect(response.body).not.toHaveProperty('review');
    expect(response.body).not.toHaveProperty('archiveDir');
    expect(JSON.stringify(response.body)).not.toContain(tuple.path);
    if (operation === 'review') expect(recovery.retireInventoriedCheckout).not.toHaveBeenCalled();
  });

  it.each(['review', 'retire'])('returns measured archive capacity and recovery guidance from checkout %s', async operation => {
    const tuple = { path: '/synthetic/checkout', head: 'a'.repeat(40), branch: 'feature/bounded', locked: false, lockReason: null };
    const prUrl = 'https://github.com/example/repo/pull/42';
    const result = { ok: false, reason: 'retirement-archive-work-limit-exceeded',
      archiveLimit: { scope: 'verification', kind: 'time', limitMs: 600000, observedMs: 600001 },
      nextAction: 'Keep the checkout and ref; free resources and retry with fresh evidence.' };
    const method = operation === 'review' ? recovery.prepareInventoriedCheckoutRetirement : recovery.retireInventoriedCheckout;
    method.mockResolvedValue(result);
    app.use(errorMiddleware);
    const body = operation === 'review' ? { appId: 'app-1', ...tuple, prUrl }
      : { appId: 'app-1', ...tuple, review: { prUrl, digest: 'b'.repeat(64), acceptSuperseded: false } };
    const response = await request(app).post(`/api/cos/schedule/branch-reconcile/checkouts/${operation}`).send(body);
    expect(response.status).toBe(409);
    expect(response.body.context).toEqual({ reason: result.reason, archiveLimit: result.archiveLimit, nextAction: result.nextAction });
  });

  describe('GET /api/cos/schedule', () => {
    it('surfaces unavailable schedule inputs as errors and recovers on the next read', async () => {
      taskSchedule.getScheduleStatus
        .mockRejectedValueOnce(new Error('app registry unavailable'))
        .mockRejectedValueOnce(new Error('app cadence unavailable'))
        .mockResolvedValueOnce({ tasks: {}, onDemandRequests: [] });

      expect((await request(app).get('/api/cos/schedule')).status).toBe(500);
      expect((await request(app).get('/api/cos/schedule')).status).toBe(500);
      const recovered = await request(app).get('/api/cos/schedule');
      expect(recovered.status).toBe(200);
      expect(recovered.body).toEqual({ tasks: {}, onDemandRequests: [] });
    });

    it('should return schedule status', async () => {
      taskSchedule.getScheduleStatus.mockResolvedValue({ tasks: [], enabled: true });

      const response = await request(app).get('/api/cos/schedule');

      expect(response.status).toBe(200);
    });
  });

  describe('manual maintenance runs', () => {
    it('validates stage settings and returns the saved run or not-found', async () => {
      const url = '/api/cos/schedule/maintenance-runs/maint-1/steps/step-2';
      const settings = { providerId: 'codex', model: 'example-model', effort: null };
      maintenance.updateMaintenanceStep.mockResolvedValue({ id: 'maint-1' });
      expect((await request(app).patch(url).send(settings)).body.run.id).toBe('maint-1');
      expect(maintenance.updateMaintenanceStep).toHaveBeenCalledWith('maint-1', 'step-2', settings);
      expect((await request(app).patch(url).send({ ...settings, effort: 'invalid' })).status).toBe(400);
      expect((await request(app).patch(url).send({ ...settings, completed: {} })).status).toBe(400);
      maintenance.updateMaintenanceStep.mockResolvedValue(null);
      expect((await request(app).patch(url).send(settings)).status).toBe(404);
    });
    it('accepts an explicit draft disposition and rejects unknown policies', async () => {
      maintenance.startMaintenanceRun.mockResolvedValue({ run: { id: 'draft-run' } });
      const body = { appId: 'app-1', providerId: 'codex', model: 'gpt-6-astra', effort: 'medium', mode: 'fix', prCompletion: 'draft', taskTypes: ['security'] };
      expect((await request(app).post('/api/cos/schedule/maintenance-runs').send(body)).status).toBe(201);
      expect(maintenance.startMaintenanceRun).toHaveBeenCalledWith(body);
      expect((await request(app).post('/api/cos/schedule/maintenance-runs').send({ ...body, prCompletion: 'unknown' })).status).toBe(400);
    });

    it('accepts fix mode and rejects unknown modes', async () => {
      maintenance.startMaintenanceRun.mockResolvedValue({ run: { id: 'maint-1' } });
      const body = { appId: 'app-1', providerId: 'codex', model: 'gpt-5', mode: 'fix', claimBetweenAudits: false, claimHandler: { providerId: 'claude', model: 'sonnet', effort: 'low' } };
      expect((await request(app).post('/api/cos/schedule/maintenance-runs').send(body)).status).toBe(201);
      expect(maintenance.startMaintenanceRun).toHaveBeenCalledWith(body);
      expect((await request(app).post('/api/cos/schedule/maintenance-runs').send({ ...body, claimHandler: { providerId: 'claude' } })).status).toBe(400);
      expect((await request(app).post('/api/cos/schedule/maintenance-runs').send({ ...body, mode: 'unknown' })).status).toBe(400);
      for (const taskTypes of [[], ['claim-issue'], ['unknown']]) {
        expect((await request(app).post('/api/cos/schedule/maintenance-runs').send({ ...body, taskTypes })).status).toBe(400);
      }
      expect((await request(app).post('/api/cos/schedule/maintenance-runs').send({ ...body, taskTypes: ['security'] })).status).toBe(201);
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

    // #7527: getUpcomingTasks now rejects (rather than silently returning a
    // partial []) when an app inventory/override/readiness read fails. The
    // route must not answer 200 with incomplete deadlines.
    it('does not return 200 when the upcoming-tasks calculation is unavailable', async () => {
      taskSchedule.getUpcomingTasks.mockRejectedValue(new Error('app inventory read failed'));

      const response = await request(app).get('/api/cos/upcoming');

      expect(response.status).toBe(503);
      expect(response.body.code).toBe('UPCOMING_TASKS_UNAVAILABLE');
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
    it('rejects malformed execution fields before writing any schedule settings', async () => {
      for (const field of ['prompt', 'providerId', 'model']) {
        for (const value of [{ text: 'Example prompt' }, ['example'], true, 42]) {
          const response = await request(app).put('/api/cos/schedule/task/documentation').send({ [field]: value });
          expect(response.status).toBe(400);
          expect(response.body.code).toBe('VALIDATION_ERROR');
        }
      }
      expect(taskSchedule.updateTaskInterval).not.toHaveBeenCalled();
    });

    it('preserves valid execution fields, picker clears, and omitted values', async () => {
      taskSchedule.updateTaskInterval.mockResolvedValue({});
      for (const fields of [
        { prompt: '  Example custom prompt  ', providerId: 'example-provider', model: 'example-model' },
        { prompt: null, providerId: null, model: null },
        { prompt: '', providerId: '', model: '' },
        { enabled: true },
      ]) {
        expect((await request(app).put('/api/cos/schedule/task/documentation').send(fields)).status).toBe(200);
        expect(taskSchedule.updateTaskInterval).toHaveBeenLastCalledWith('documentation', fields);
      }
    });

    it('should update interval for task type', async () => {
      taskSchedule.updateTaskInterval.mockResolvedValue({ type: 'daily' });

      const response = await request(app)
        .put('/api/cos/schedule/task/review')
        .send({ type: 'daily', enabled: true });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('returns the post-write readiness status for an updated schedule', async () => {
      const status = {
        shouldRun: false,
        reason: 'cron-cooldown',
        cronExpression: '0 3 * * 0,1,3,4,5,6',
        nextRunAt: '2026-09-23T10:00:00.000Z',
      };
      taskSchedule.updateTaskInterval.mockResolvedValue({
        type: 'cron',
        cronExpression: status.cronExpression,
      });
      taskSchedule.shouldRunTask.mockResolvedValue(status);

      const response = await request(app)
        .put('/api/cos/schedule/task/do-release')
        .send({ type: 'cron', cronExpression: status.cronExpression });

      expect(response.status).toBe(200);
      expect(response.body.status).toEqual(status);
      expect(taskSchedule.shouldRunTask).toHaveBeenCalledWith('do-release');
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
      expect(taskSchedule.triggerOnDemandTask).toHaveBeenCalledWith('review', 'my-app', {
        provider: undefined,
        model: undefined,
        effort: undefined,
        executionOptions: undefined,
        targetModels: null,
        targetPullRequest: undefined,
      });
    });

    it('forwards provider, model, effort, executionOptions, and targetModels to triggerOnDemandTask', async () => {
      taskSchedule.triggerOnDemandTask.mockResolvedValue({ id: 'req-2' });

      const response = await request(app)
        .post('/api/cos/schedule/trigger')
        .send({
          taskType: 'model-comparison-refresh',
          appId: null,
          provider: 'anthropic',
          model: 'claude-3-7-sonnet',
          effort: 'high',
          executionOptions: { serviceTier: 'fast' },
          targetModels: ['gpt-6-luna', 'claude-opus-5-5'],
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(taskSchedule.triggerOnDemandTask).toHaveBeenCalledWith('model-comparison-refresh', null, {
        provider: 'anthropic',
        model: 'claude-3-7-sonnet',
        effort: 'high',
        executionOptions: { serviceTier: 'fast' },
        targetModels: ['gpt-6-luna', 'claude-opus-5-5'],
        targetPullRequest: undefined,
      });
    });

    it('rejects missing or malformed taskType before triggering an on-demand task', async () => {
      for (const body of [{}, { taskType: '' }, { taskType: 42 }]) {
        const response = await request(app)
          .post('/api/cos/schedule/trigger')
          .send(body);

        expect(response.status).toBe(400);
      }
      expect(taskSchedule.triggerOnDemandTask).not.toHaveBeenCalled();
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

    it('rejects missing or malformed taskType before resetting execution history', async () => {
      for (const body of [{}, { taskType: '' }, { taskType: 42 }]) {
        const response = await request(app)
          .post('/api/cos/schedule/reset')
          .send(body);

        expect(response.status).toBe(400);
      }
      expect(taskSchedule.resetExecutionHistory).not.toHaveBeenCalled();
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
