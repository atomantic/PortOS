import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const lifecycle = vi.hoisted(() => ({ onDisconnect: null, stopRun: vi.fn(async () => true) }));

vi.mock('../services/systemResources.js', () => ({
  getSystemResourceReport: vi.fn(),
  triageSystemResources: vi.fn(),
}));
vi.mock('../lib/sseDownload.js', () => ({
  onClientDisconnect: vi.fn((_req, _res, callback) => { lifecycle.onDisconnect = callback; }),
}));
vi.mock('../services/runner.js', () => ({
  stopRun: lifecycle.stopRun,
}));

const resources = await import('../services/systemResources.js');
const { default: routes } = await import('./systemResources.js');

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/system-resources', routes);
  app.use(errorMiddleware);
  return app;
};

describe('system resources routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lifecycle.onDisconnect = null;
  });

  it('runs a fresh report only when explicitly requested', async () => {
    resources.getSystemResourceReport.mockResolvedValue({ generatedAt: '2026-08-16T00:00:00.000Z' });
    const response = await request(makeApp()).post('/api/system-resources/report').send({});
    expect(response.status).toBe(200);
    expect(resources.getSystemResourceReport).toHaveBeenCalledWith({ force: true });
  });

  it('rejects report input instead of accepting filesystem hints', async () => {
    const response = await request(makeApp()).post('/api/system-resources/report').send({ path: '/example' });
    expect(response.status).toBe(400);
    expect(resources.getSystemResourceReport).not.toHaveBeenCalled();
  });

  it('normalizes optional picker values before AI triage', async () => {
    resources.triageSystemResources.mockResolvedValue({ triage: { summary: 'Healthy' } });
    const response = await request(makeApp()).post('/api/system-resources/triage').send({
      providerId: 'codex',
      model: '  ',
      effort: '',
    });
    expect(response.status).toBe(200);
    expect(resources.triageSystemResources).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'codex',
      model: undefined,
      effort: undefined,
      onRunCreated: expect.any(Function),
      onRunSettled: expect.any(Function),
    }));
  });

  it('stops active and late-created AI runs after a client disconnect', async () => {
    let hooks;
    resources.triageSystemResources.mockImplementation(async (input) => {
      hooks = input;
      input.onRunCreated('run-active');
      return { triage: { summary: 'Healthy' } };
    });

    const response = await request(makeApp()).post('/api/system-resources/triage').send({ providerId: 'codex' });
    expect(response.status).toBe(200);

    lifecycle.onDisconnect();
    hooks.onRunCreated('run-late');
    await Promise.resolve();

    expect(lifecycle.stopRun).toHaveBeenCalledWith('run-active');
    expect(lifecycle.stopRun).toHaveBeenCalledWith('run-late');
    hooks.onRunSettled('run-active');
    hooks.onRunSettled('run-late');
  });

  it('rejects unsupported effort and unknown fields', async () => {
    const badEffort = await request(makeApp()).post('/api/system-resources/triage').send({
      providerId: 'codex', effort: 'turbo',
    });
    const extra = await request(makeApp()).post('/api/system-resources/triage').send({
      providerId: 'codex', path: '/private/example',
    });
    expect(badEffort.status).toBe(400);
    expect(extra.status).toBe(400);
    expect(resources.triageSystemResources).not.toHaveBeenCalled();
  });
});
