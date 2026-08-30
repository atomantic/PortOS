import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const mocks = vi.hoisted(() => ({
  augment: vi.fn(),
  ensurePresence: vi.fn(),
  getStatus: vi.fn(),
  project: vi.fn(),
  say: vi.fn(),
  updateConfig: vi.fn(),
}));

vi.mock('../services/eidoverseWorld.js', () => ({
  augmentEidoverseWorld: mocks.augment,
  ensureEidoverseWorldPresence: mocks.ensurePresence,
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

  it('validates and persists a configuration patch', async () => {
    const res = await request(makeApp()).put('/api/eidoverse/world/config').send({ humanName: 'Example User' });
    expect(res.status).toBe(200);
    expect(mocks.updateConfig).toHaveBeenCalledWith({ humanName: 'Example User' });
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
