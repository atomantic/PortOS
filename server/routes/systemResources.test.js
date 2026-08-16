import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/systemResources.js', () => ({
  getSystemResourceReport: vi.fn(),
  triageSystemResources: vi.fn(),
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
  beforeEach(() => vi.clearAllMocks());

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
    expect(resources.triageSystemResources).toHaveBeenCalledWith({
      providerId: 'codex',
      model: undefined,
      effort: undefined,
    });
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
