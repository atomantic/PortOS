import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Stub the queue so we control which jobs exist for the retry endpoint without
// running the real worker. enqueueJob / cancelJob etc. are returned as vi.fn so
// we can assert the route calls them with the right args.
const jobStore = new Map();
const stubs = {
  enqueueJob: vi.fn(({ kind, params, owner }) => ({ jobId: 'new-job', position: 1, status: 'queued' })),
  cancelJob: vi.fn(async (id) => (jobStore.has(id) ? { ok: true, status: 'canceled' } : { ok: false, code: 'NOT_FOUND' })),
  cancelQueuedJobs: vi.fn(async () => ({ canceled: 0 })),
  runJobNow: vi.fn(() => ({ ok: false, code: 'NOT_FOUND' })),
};
vi.mock('../services/mediaJobQueue/index.js', () => ({
  JOB_KINDS: ['video', 'image'],
  JOB_STATUSES: ['queued', 'running', 'completed', 'failed', 'canceled'],
  listJobs: () => Array.from(jobStore.values()),
  getJob: (id) => jobStore.get(id) || null,
  enqueueJob: (...args) => stubs.enqueueJob(...args),
  cancelJob: (...args) => stubs.cancelJob(...args),
  cancelQueuedJobs: (...args) => stubs.cancelQueuedJobs(...args),
  runJobNow: (...args) => stubs.runJobNow(...args),
}));

const mediaJobsRouter = (await import('./mediaJobs.js')).default;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/media-jobs', mediaJobsRouter);
  app.use(errorMiddleware);
  return app;
}

describe('mediaJobs routes', () => {
  beforeEach(() => {
    jobStore.clear();
    vi.clearAllMocks();
  });

  it('POST /:id/retry 404s for unknown id', async () => {
    const r = await request(makeApp()).post('/api/media-jobs/nope/retry').send({});
    expect(r.status).toBe(404);
  });

  it('POST /:id/retry 409s when the job is still running/queued', async () => {
    jobStore.set('j-live', { id: 'j-live', kind: 'image', owner: null, status: 'running', params: {} });
    const r = await request(makeApp()).post('/api/media-jobs/j-live/retry').send({});
    expect(r.status).toBe(409);
    expect(r.body.code || r.body.error).toMatch(/JOB_NOT_TERMINAL|cancel it/);
    expect(stubs.enqueueJob).not.toHaveBeenCalled();
  });

  it('POST /:id/retry re-enqueues a terminal text-only job (no temp-upload params)', async () => {
    jobStore.set('j-img', {
      id: 'j-img', kind: 'image', owner: 'cd-1', status: 'failed',
      params: { prompt: 'a cat', mode: 'codex' },
    });
    const r = await request(makeApp()).post('/api/media-jobs/j-img/retry').send({});
    expect(r.status).toBe(200);
    expect(r.body.jobId).toBe('new-job');
    expect(r.body.retriedFrom).toBe('j-img');
    expect(stubs.enqueueJob).toHaveBeenCalledWith({
      kind: 'image', owner: 'cd-1', params: { prompt: 'a cat', mode: 'codex' },
    });
  });

  it('POST /:id/retry 409s with JOB_RETRY_TEMP_UPLOAD when the job referenced an uploadedTempPath', async () => {
    jobStore.set('j-up', {
      id: 'j-up', kind: 'video', owner: null, status: 'completed',
      params: { prompt: 'foo', uploadedTempPath: '/data/uploads/staged-1.png' },
    });
    const r = await request(makeApp()).post('/api/media-jobs/j-up/retry').send({});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('JOB_RETRY_TEMP_UPLOAD');
    expect(stubs.enqueueJob).not.toHaveBeenCalled();
  });

  it('POST /:id/retry rejects retries that referenced uploadedTempPaths (array) or audioFilePath', async () => {
    jobStore.set('j-paths', {
      id: 'j-paths', kind: 'video', owner: null, status: 'failed',
      params: { prompt: 'x', uploadedTempPaths: ['/data/uploads/a.png'] },
    });
    jobStore.set('j-audio', {
      id: 'j-audio', kind: 'video', owner: null, status: 'failed',
      params: { prompt: 'x', audioFilePath: '/data/uploads/a.wav' },
    });
    const app = makeApp();
    const r1 = await request(app).post('/api/media-jobs/j-paths/retry').send({});
    const r2 = await request(app).post('/api/media-jobs/j-audio/retry').send({});
    expect(r1.status).toBe(409);
    expect(r1.body.code).toBe('JOB_RETRY_TEMP_UPLOAD');
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe('JOB_RETRY_TEMP_UPLOAD');
    expect(stubs.enqueueJob).not.toHaveBeenCalled();
  });

  it('POST /:id/retry allows retry when uploadedTempPaths is an empty array', async () => {
    jobStore.set('j-empty', {
      id: 'j-empty', kind: 'video', owner: null, status: 'failed',
      params: { prompt: 'x', uploadedTempPaths: [] },
    });
    const r = await request(makeApp()).post('/api/media-jobs/j-empty/retry').send({});
    expect(r.status).toBe(200);
    expect(stubs.enqueueJob).toHaveBeenCalledOnce();
  });
});
