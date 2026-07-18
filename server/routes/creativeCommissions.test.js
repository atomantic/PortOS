import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// The store service is mocked so the route test asserts exact call args without
// touching the collectionStore. Scheduler re-sync is now event-driven off the
// store (not called by the route), so the route no longer imports the scheduler.
const svc = {
  ERR_NOT_FOUND: 'NOT_FOUND',
  ERR_VALIDATION: 'VALIDATION_ERROR',
  listCommissions: vi.fn(),
  getCommission: vi.fn(),
  createCommission: vi.fn(),
  updateCommission: vi.fn(),
  deleteCommission: vi.fn(),
  submitCommissionFeedback: vi.fn(),
};
vi.mock('../services/creativeCommissions/store.js', () => svc);

// The scheduler is lazy-imported only by the /run handler; mocked so the manual
// fire path is asserted without dragging the eventScheduler/settings graph in.
const runNowMock = vi.fn();
vi.mock('../services/creativeCommissions/scheduler.js', () => ({
  runCommissionNow: (...a) => runNowMock(...a),
}));

const routes = (await import('./creativeCommissions.js')).default;

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/creative-commission', routes);
  app.use(errorMiddleware);
  return app;
};

const validBody = () => ({
  name: 'Nightly Surreal',
  brief: { intent: 'something surreal, dreamlike' },
  schedule: { kind: 'DAILY', atLocalTime: '02:00' },
});

beforeEach(() => vi.clearAllMocks());

describe('GET /api/creative-commission', () => {
  it('returns the full list by default', async () => {
    svc.listCommissions.mockResolvedValue([{ id: 'commission-1' }]);
    const res = await request(buildApp()).get('/api/creative-commission');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'commission-1' }]);
  });
});

describe('POST /api/creative-commission', () => {
  it('validates and creates', async () => {
    svc.createCommission.mockResolvedValue({ id: 'commission-1', name: 'Nightly Surreal' });
    const res = await request(buildApp()).post('/api/creative-commission').send(validBody());
    expect(res.status).toBe(201);
    expect(svc.createCommission).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Nightly Surreal',
      targetAbility: 'video',
      brief: expect.objectContaining({ intent: 'something surreal, dreamlike' }),
      schedule: expect.objectContaining({ kind: 'DAILY', atLocalTime: '02:00' }),
    }));
  });

  it('rejects a body missing the brief with 400 (service not called)', async () => {
    const res = await request(buildApp()).post('/api/creative-commission').send({ name: 'x', schedule: { kind: 'DAILY', atLocalTime: '02:00' } });
    expect(res.status).toBe(400);
    expect(svc.createCommission).not.toHaveBeenCalled();
  });

  it('rejects a DAILY schedule missing atLocalTime with 400', async () => {
    const res = await request(buildApp()).post('/api/creative-commission').send({ ...validBody(), schedule: { kind: 'DAILY' } });
    expect(res.status).toBe(400);
    expect(svc.createCommission).not.toHaveBeenCalled();
  });

  it('accepts a non-video output type with its own generation params (#2769)', async () => {
    svc.createCommission.mockResolvedValue({ id: 'commission-2', name: 'Daily Stills' });
    const res = await request(buildApp()).post('/api/creative-commission')
      .send({ ...validBody(), targetAbility: 'image', generation: { imageCount: 3, aspectRatio: '9:16' } });
    expect(res.status).toBe(201);
    expect(svc.createCommission).toHaveBeenCalledWith(expect.objectContaining({
      targetAbility: 'image',
      generation: expect.objectContaining({ imageCount: 3 }),
    }));
  });

  it('rejects an UNKNOWN target ability with 400 (#2769)', async () => {
    const res = await request(buildApp()).post('/api/creative-commission').send({ ...validBody(), targetAbility: 'hologram' });
    expect(res.status).toBe(400);
    expect(svc.createCommission).not.toHaveBeenCalled();
  });

  it('rejects a generation param that does not belong to the chosen type with 400 (#2769)', async () => {
    // targetDurationSeconds is a video knob, not an image one.
    const res = await request(buildApp()).post('/api/creative-commission')
      .send({ ...validBody(), targetAbility: 'image', generation: { targetDurationSeconds: 10 } });
    expect(res.status).toBe(400);
    expect(svc.createCommission).not.toHaveBeenCalled();
  });

  it('rejects an invalid IANA timezone with 400 (before it can wedge the scheduler)', async () => {
    const res = await request(buildApp()).post('/api/creative-commission')
      .send({ ...validBody(), schedule: { kind: 'DAILY', atLocalTime: '02:00', timezone: 'Not/AZone' } });
    expect(res.status).toBe(400);
    expect(svc.createCommission).not.toHaveBeenCalled();
  });

  it('maps a service VALIDATION_ERROR to 400', async () => {
    svc.createCommission.mockRejectedValue(Object.assign(new Error('bad cron'), { code: 'VALIDATION_ERROR' }));
    const res = await request(buildApp()).post('/api/creative-commission').send(validBody());
    expect(res.status).toBe(400);
  });
});

describe('GET /api/creative-commission/:id', () => {
  it('maps a service NOT_FOUND to 404', async () => {
    svc.getCommission.mockRejectedValue(Object.assign(new Error('nope'), { code: 'NOT_FOUND' }));
    const res = await request(buildApp()).get('/api/creative-commission/missing');
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/creative-commission/:id', () => {
  it('updates the commission', async () => {
    svc.updateCommission.mockResolvedValue({ id: 'commission-1', enabled: false });
    const res = await request(buildApp()).patch('/api/creative-commission/commission-1').send({ enabled: false });
    expect(res.status).toBe(200);
    expect(svc.updateCommission).toHaveBeenCalledWith('commission-1', { enabled: false });
  });

  it('rejects an empty patch with 400', async () => {
    const res = await request(buildApp()).patch('/api/creative-commission/commission-1').send({});
    expect(res.status).toBe(400);
    expect(svc.updateCommission).not.toHaveBeenCalled();
  });
});

describe('POST /api/creative-commission/:id/run', () => {
  it('fires the manual run and returns the outcome plus the refreshed record (202)', async () => {
    runNowMock.mockResolvedValue({ status: 'started', projectId: 'cd-xyz', run: { id: 'run-1' } });
    svc.getCommission.mockResolvedValue({ id: 'commission-1', runs: [{ id: 'run-1' }] });
    const res = await request(buildApp()).post('/api/creative-commission/commission-1/run');
    expect(res.status).toBe(202);
    expect(runNowMock).toHaveBeenCalledWith('commission-1');
    expect(res.body).toMatchObject({
      status: 'started',
      projectId: 'cd-xyz',
      commission: { id: 'commission-1' },
    });
  });

  it('returns a skipped outcome verbatim (the gate result IS the test result)', async () => {
    runNowMock.mockResolvedValue({ status: 'skipped', reason: 'autonomy-off', run: { id: 'run-1' } });
    svc.getCommission.mockResolvedValue({ id: 'commission-1' });
    const res = await request(buildApp()).post('/api/creative-commission/commission-1/run');
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'skipped', reason: 'autonomy-off' });
  });

  it('maps a service NOT_FOUND to 404', async () => {
    runNowMock.mockRejectedValue(Object.assign(new Error('gone'), { code: 'NOT_FOUND' }));
    const res = await request(buildApp()).post('/api/creative-commission/missing/run');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/creative-commission/:id/feedback', () => {
  it('validates and forwards the reaction to the service', async () => {
    svc.submitCommissionFeedback.mockResolvedValue({ id: 'commission-1', feedback: [{ runId: 'run-A', rating: 'up' }] });
    const res = await request(buildApp())
      .post('/api/creative-commission/commission-1/feedback')
      .send({ runId: 'run-A', rating: 'up', note: 'more Magritte' });
    expect(res.status).toBe(201);
    expect(svc.submitCommissionFeedback).toHaveBeenCalledWith('commission-1', expect.objectContaining({
      runId: 'run-A', rating: 'up', note: 'more Magritte',
    }));
  });

  it('rejects a body missing runId with 400 (service not called)', async () => {
    const res = await request(buildApp())
      .post('/api/creative-commission/commission-1/feedback')
      .send({ rating: 'up' });
    expect(res.status).toBe(400);
    expect(svc.submitCommissionFeedback).not.toHaveBeenCalled();
  });

  it('rejects a zero numeric rating with 400 (meaningless)', async () => {
    const res = await request(buildApp())
      .post('/api/creative-commission/commission-1/feedback')
      .send({ runId: 'run-A', rating: 0 });
    expect(res.status).toBe(400);
    expect(svc.submitCommissionFeedback).not.toHaveBeenCalled();
  });

  it('maps a service NOT_FOUND to 404', async () => {
    svc.submitCommissionFeedback.mockRejectedValue(Object.assign(new Error('gone'), { code: 'NOT_FOUND' }));
    const res = await request(buildApp())
      .post('/api/creative-commission/missing/feedback')
      .send({ runId: 'run-A', rating: 'down' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/creative-commission/:id', () => {
  it('deletes the commission', async () => {
    svc.deleteCommission.mockResolvedValue({ id: 'commission-1', deleted: true });
    const res = await request(buildApp()).delete('/api/creative-commission/commission-1');
    expect(res.status).toBe(200);
    expect(svc.deleteCommission).toHaveBeenCalledWith('commission-1');
  });
});
