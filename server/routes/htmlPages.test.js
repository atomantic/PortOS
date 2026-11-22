import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware, ServerError } from '../lib/errorHandler.js';

const mocks = vi.hoisted(() => ({
  listRuns: vi.fn(),
  listSelectableModels: vi.fn(),
  readRun: vi.fn(),
  removeRun: vi.fn(),
  startRuns: vi.fn(),
}));
vi.mock('../services/htmlPages/index.js', () => mocks);

import htmlPagesRoutes from './htmlPages.js';

const app = express();
app.use(express.json());
app.use('/api/html-pages', htmlPagesRoutes);
app.use(errorMiddleware);

const model = { backend: 'ollama', modelId: 'example-coder:7b' };

beforeEach(() => vi.clearAllMocks());

describe('POST /api/html-pages/runs', () => {
  it('queues the validated models with the page count and answers 202 with the queued runs', async () => {
    mocks.startRuns.mockResolvedValue([{ id: 'run-1', status: 'queued' }]);
    const res = await request(app).post('/api/html-pages/runs').send({ models: [model], pageCount: '3' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual([{ id: 'run-1', status: 'queued' }]);
    expect(mocks.startRuns).toHaveBeenCalledWith({ models: [model], pageCount: 3 });
  });

  it.each([
    ['no models', { models: [] }],
    ['a repeated model', { models: [model, model] }],
    ['an unknown runtime', { models: [{ backend: 'cloud', modelId: 'x' }] }],
    ['more pages than the brief has', { models: [model], pageCount: 99 }],
    ['zero pages', { models: [model], pageCount: 0 }],
    ['too many models at once', { models: Array.from({ length: 9 }, (_, i) => ({ backend: 'ollama', modelId: `m${i}` })) }],
  ])('refuses %s before reaching any model', async (_label, body) => {
    const res = await request(app).post('/api/html-pages/runs').send(body);
    expect(res.status).toBe(400);
    expect(mocks.startRuns).not.toHaveBeenCalled();
  });

  it('maps a model that is not installed to the 409 the service raises', async () => {
    mocks.startRuns.mockRejectedValue(new ServerError('missing:1b is not installed', { status: 409, code: 'HTML_PAGES_MODEL_UNAVAILABLE' }));
    const res = await request(app).post('/api/html-pages/runs').send({ models: [model] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('HTML_PAGES_MODEL_UNAVAILABLE');
  });
});

describe('reads and deletes', () => {
  it('serves the model picker ahead of the run id route', async () => {
    mocks.listSelectableModels.mockResolvedValue({ models: [] });
    const res = await request(app).get('/api/html-pages/models');
    expect(res.status).toBe(200);
    expect(mocks.readRun).not.toHaveBeenCalled();
  });

  it('lists runs, reads one by id, and maps a missing run to 404', async () => {
    mocks.listRuns.mockResolvedValue([{ id: 'run-1' }]);
    expect((await request(app).get('/api/html-pages/runs')).body).toEqual([{ id: 'run-1' }]);
    mocks.readRun.mockRejectedValue(new ServerError('HTML pages run not found', { status: 404, code: 'NOT_FOUND' }));
    expect((await request(app).get('/api/html-pages/runs/nope')).status).toBe(404);
  });

  it('deletes a run through the service so a generating one is stopped', async () => {
    mocks.removeRun.mockResolvedValue({ id: 'run-1', deleted: true });
    const res = await request(app).delete('/api/html-pages/runs/run-1');
    expect(res.status).toBe(200);
    expect(mocks.removeRun).toHaveBeenCalledWith('run-1');
  });
});
