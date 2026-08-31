import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const mocks = vi.hoisted(() => ({
  augment: vi.fn(),
  ensurePresence: vi.fn(),
  getProjectionStatus: vi.fn(),
  getStatus: vi.fn(),
  project: vi.fn(),
  say: vi.fn(),
  updateConfig: vi.fn(),
}));

vi.mock('../services/eidoverseWorld.js', () => ({
  augmentEidoverseWorld: mocks.augment,
  ensureEidoverseWorldPresence: mocks.ensurePresence,
  getEidoverseWorldProjectionStatus: mocks.getProjectionStatus,
  getEidoverseWorldStatus: mocks.getStatus,
  projectEidoverseWorld: mocks.project,
  sayInEidoverseWorld: mocks.say,
  updateEidoverseWorldConfig: mocks.updateConfig,
}));

const { default: eidoverseWorldRoutes } = await import('./eidoverseWorldRoutes.js');

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/eidoverse/world', eidoverseWorldRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('Eidoverse world routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStatus.mockResolvedValue({ world: 'portos', identity: { name: 'example-user' } });
    mocks.getProjectionStatus.mockResolvedValue({
      design: { reconciliation: { status: 'applying', checkpoint: 'applying-live' } },
      projection: { lastRunAt: '2026-01-01T00:00:00.000Z' },
    });
    mocks.updateConfig.mockResolvedValue({ world: 'portos', human: { name: 'example-user' } });
    mocks.ensurePresence.mockResolvedValue({ connected: true, role: 'owner' });
    mocks.project.mockResolvedValue({ success: true, summary: { operationCount: 0 } });
    mocks.augment.mockResolvedValue({ success: true, applied: 1 });
    mocks.say.mockResolvedValue({ success: true });
  });

  it('returns private world status from the service boundary', async () => {
    const res = await request(makeApp()).get('/api/eidoverse/world/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ world: 'portos', identity: { name: 'example-user' } });
    expect(mocks.getStatus).toHaveBeenCalledOnce();
  });

  it('returns lightweight persisted projection progress', async () => {
    const res = await request(makeApp()).get('/api/eidoverse/world/projection/status');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      design: { reconciliation: { checkpoint: 'applying-live' } },
    });
    expect(mocks.getProjectionStatus).toHaveBeenCalledOnce();
    expect(mocks.getStatus).not.toHaveBeenCalled();
  });

  it('validates and persists a configuration patch', async () => {
    const res = await request(makeApp()).put('/api/eidoverse/world/config').send({ humanName: 'Example User' });
    expect(res.status).toBe(200);
    expect(mocks.updateConfig).toHaveBeenCalledWith({ humanName: 'Example User' });
  });

  it('validates scoped reset and asset-refresh actions', async () => {
    const district = await request(makeApp()).put('/api/eidoverse/world/config').send({
      reset: { scope: 'district', districtId: 'apps' },
    });
    const assets = await request(makeApp()).put('/api/eidoverse/world/config').send({ refreshAssets: true });
    const invalid = await request(makeApp()).put('/api/eidoverse/world/config').send({ reset: { scope: 'district' } });
    const custom = await request(makeApp()).put('/api/eidoverse/world/config').send({
      reset: { scope: 'district', districtId: 'example-unknown-district' },
    });
    const malformed = await request(makeApp()).put('/api/eidoverse/world/config').send({
      reset: { scope: 'district', districtId: 'Example Unknown District' },
    });

    expect(district.status).toBe(200);
    expect(assets.status).toBe(200);
    expect(mocks.updateConfig).toHaveBeenCalledWith({ reset: { scope: 'district', districtId: 'apps' } });
    expect(mocks.updateConfig).toHaveBeenCalledWith({ reset: { scope: 'district', districtId: 'example-unknown-district' } });
    expect(mocks.updateConfig).toHaveBeenCalledWith({ refreshAssets: true });
    expect(invalid.status).toBe(400);
    expect(custom.status).toBe(200);
    expect(malformed.status).toBe(400);
  });

  it('accepts explicit install-local asset overrides without making them portable defaults', async () => {
    const payload = {
      assetOverrides: {
        app: 'store/example-local-asset',
        operations: 'eidoverse/assets/models/example-legacy-operations.glb',
      },
    };
    const response = await request(makeApp()).put('/api/eidoverse/world/config').send(payload);

    expect(response.status).toBe(200);
    expect(mocks.updateConfig).toHaveBeenCalledWith(payload);
  });

  it('rejects verbs outside the bounded augmentation contract', async () => {
    const res = await request(makeApp()).post('/api/eidoverse/world/augment').send({
      operations: [{ verb: 'behavior', args: {} }],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(mocks.augment).not.toHaveBeenCalled();
  });

  it('passes valid augmentation and chat requests to the service', async () => {
    const operations = [{ verb: 'spawn', args: { id: 'example-prop', lib: 'eidoverse/assets/models/example.glb' } }];
    const augmentResponse = await request(makeApp()).post('/api/eidoverse/world/augment').send({ operations });
    const sayResponse = await request(makeApp()).post('/api/eidoverse/world/say').send({ text: 'Example message' });

    expect(augmentResponse.status).toBe(200);
    expect(mocks.augment).toHaveBeenCalledWith(operations);
    expect(sayResponse.status).toBe(200);
    expect(mocks.say).toHaveBeenCalledWith('Example message');
  });
});
