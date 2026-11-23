import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware, ServerError } from '../lib/errorHandler.js';

const mocks = vi.hoisted(() => ({
  listRuns: vi.fn(),
  listSelectableModels: vi.fn(),
  pageFile: vi.fn(),
  readRun: vi.fn(),
  removeRun: vi.fn(),
  resumeRun: vi.fn(),
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
  it('queues the validated models with the briefs exactly as typed and answers 202 with the queued runs', async () => {
    mocks.startRuns.mockResolvedValue([{ id: 'run-1', status: 'queued' }]);
    const res = await request(app).post('/api/html-pages/runs').send({ models: [model], pages: ['  A lighthouse at dusk \n', 'A tide-pool'] });
    expect(res.status).toBe(202);
    expect(res.body).toEqual([{ id: 'run-1', status: 'queued' }]);
    expect(mocks.startRuns).toHaveBeenCalledWith({ models: [model], routes: [], pages: ['  A lighthouse at dusk \n', 'A tide-pool'] });
  });

  it('accepts provider routes on their own, with a blank model meaning the provider default', async () => {
    mocks.startRuns.mockResolvedValue([{ id: 'run-1', status: 'queued' }]);
    const res = await request(app).post('/api/html-pages/runs').send({ routes: [{ providerId: 'example-cli', model: '', effort: 'high' }], pages: ['A'] });
    expect(res.status).toBe(202);
    expect(mocks.startRuns).toHaveBeenCalledWith({ models: [], routes: [{ providerId: 'example-cli', model: null, effort: 'high' }], pages: ['A'] });
  });

  it.each([
    ['no models', { models: [], pages: ['A'] }],
    ['a repeated model', { models: [model, model], pages: ['A'] }],
    ['an unknown runtime', { models: [{ backend: 'cloud', modelId: 'x' }], pages: ['A'] }],
    ['no pages', { models: [model] }],
    ['an empty page list', { models: [model], pages: [] }],
    ['more pages than the cap', { models: [model], pages: Array.from({ length: 6 }, (_, i) => `page ${i}`) }],
    ['a blank brief', { models: [model], pages: ['   '] }],
    ['a brief over the length limit, which is refused rather than cut', { models: [model], pages: ['x'.repeat(2001)] }],
    ['too many models at once', { models: Array.from({ length: 9 }, (_, i) => ({ backend: 'ollama', modelId: `m${i}` })), pages: ['A'] }],
    ['too many models and routes together', { models: Array.from({ length: 5 }, (_, i) => ({ backend: 'ollama', modelId: `m${i}` })), routes: Array.from({ length: 4 }, (_, i) => ({ providerId: `p${i}` })), pages: ['A'] }],
    ['a repeated route', { routes: [{ providerId: 'p' }, { providerId: 'p' }], pages: ['A'] }],
    ['an unknown effort', { routes: [{ providerId: 'p', effort: 'turbo' }], pages: ['A'] }],
  ])('refuses %s before reaching any model', async (_label, body) => {
    const res = await request(app).post('/api/html-pages/runs').send(body);
    expect(res.status).toBe(400);
    expect(mocks.startRuns).not.toHaveBeenCalled();
  });

  it('maps a model that is not installed to the 409 the service raises', async () => {
    mocks.startRuns.mockRejectedValue(new ServerError('missing:1b is not installed', { status: 409, code: 'HTML_PAGES_MODEL_UNAVAILABLE' }));
    const res = await request(app).post('/api/html-pages/runs').send({ models: [model], pages: ['A'] });
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

describe('POST /api/html-pages/runs/:id/resume', () => {
  it('re-queues the run and answers 202 with its summary', async () => {
    mocks.resumeRun.mockResolvedValue({ id: 'run-1', status: 'queued' });
    const res = await request(app).post('/api/html-pages/runs/run-1/resume');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ id: 'run-1', status: 'queued' });
    expect(mocks.resumeRun).toHaveBeenCalledWith('run-1');
  });

  it('passes through the 409 for a run that cannot be resumed', async () => {
    mocks.resumeRun.mockRejectedValue(new ServerError('Only a failed run can be resumed', { status: 409, code: 'HTML_PAGES_RUN_NOT_RESUMABLE' }));
    const res = await request(app).post('/api/html-pages/runs/run-1/resume');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('HTML_PAGES_RUN_NOT_RESUMABLE');
  });
});

describe('page files', () => {
  const RUN = 'htmlpages-0f8a1c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
  const dirPromise = mkdtemp(join(tmpdir(), 'portos-html-pages-route-'));
  afterAll(async () => rm(await dirPromise, { recursive: true, force: true }));

  it('downloads a page as an attachment named after the page', async () => {
    const path = join(await dirPromise, '1-night-almanac.html');
    await writeFile(path, '<html>page</html>');
    mocks.pageFile.mockResolvedValue({ path, fileName: '1-night-almanac.html' });
    const res = await request(app).get(`/api/html-pages/runs/${RUN}/pages/0/file`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="?1-night-almanac\.html"?$/);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toBe('<html>page</html>');
    expect(mocks.pageFile).toHaveBeenCalledWith(RUN, 0);
  });

  it('answers the page file path', async () => {
    mocks.pageFile.mockResolvedValue({ path: '/example/data/html-pages/x/2-a.html', fileName: '2-a.html' });
    const res = await request(app).get(`/api/html-pages/runs/${RUN}/pages/1/path`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ path: '/example/data/html-pages/x/2-a.html', fileName: '2-a.html' });
  });

  it.each([
    ['a run id PortOS never minted', '/api/html-pages/runs/..%2F..%2Fetc/pages/0/file'],
    ['a page past the cap', `/api/html-pages/runs/${RUN}/pages/5/path`],
    ['a negative page', `/api/html-pages/runs/${RUN}/pages/-1/path`],
  ])('refuses %s before reaching the disk', async (_label, url) => {
    const res = await request(app).get(url);
    expect(res.status).toBe(400);
    expect(mocks.pageFile).not.toHaveBeenCalled();
  });

  it('passes through the 404 for a page with no HTML', async () => {
    mocks.pageFile.mockRejectedValue(new ServerError('That page has no HTML', { status: 404, code: 'HTML_PAGES_PAGE_NOT_FOUND' }));
    const res = await request(app).get(`/api/html-pages/runs/${RUN}/pages/0/file`);
    expect(res.status).toBe(404);
  });
});
