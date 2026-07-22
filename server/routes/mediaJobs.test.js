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
  removeArchivedJob: vi.fn((id) => jobStore.delete(id)),
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
  removeArchivedJob: (...args) => stubs.removeArchivedJob(...args),
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

  it('GET /:id exposes progress and statusMsg while sanitizing params', async () => {
    jobStore.set('j-progress', {
      id: 'j-progress',
      kind: 'video',
      owner: null,
      status: 'running',
      queuedAt: '2026-05-30T10:00:00.000Z',
      startedAt: '2026-05-30T10:00:01.000Z',
      position: 1,
      progress: 0.37,
      statusMsg: 'Rendering step 37/100',
      params: {
        prompt: 'visible prompt',
        pythonPath: '/private/python',
        uploadedTempPath: '/private/upload.png',
      },
    });

    const r = await request(makeApp()).get('/api/media-jobs/j-progress');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      id: 'j-progress',
      status: 'running',
      progress: 0.37,
      statusMsg: 'Rendering step 37/100',
      params: { prompt: 'visible prompt' },
    });
    expect(r.body.params.pythonPath).toBeUndefined();
    expect(r.body.params.uploadedTempPath).toBeUndefined();
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
    // The original failed row is dropped from the archive so the UI doesn't
    // keep a clickable Retry button next to a job whose work was already
    // inherited by the freshly-enqueued one.
    expect(stubs.removeArchivedJob).toHaveBeenCalledWith('j-img');
  });

  it('POST /:id/retry merges body.params overrides onto the original params', async () => {
    jobStore.set('j-edit', {
      id: 'j-edit', kind: 'image', owner: null, status: 'failed',
      params: {
        prompt: 'old prompt', negativePrompt: 'old neg',
        mode: 'codex', model: 'gpt-image-1', width: 512, height: 512, steps: 30,
        // a non-whitelisted internal field — must ride through unchanged
        codexPath: '/usr/local/bin/codex',
      },
    });
    const r = await request(makeApp())
      .post('/api/media-jobs/j-edit/retry')
      .send({ params: { prompt: 'new prompt', width: 1024, model: 'gpt-image-1' } });
    expect(r.status).toBe(200);
    // overridden fields take the new value; non-overridden fields inherit;
    // non-whitelisted internal fields are preserved untouched.
    expect(stubs.enqueueJob).toHaveBeenCalledWith({
      kind: 'image', owner: null,
      params: {
        prompt: 'new prompt', negativePrompt: 'old neg',
        mode: 'codex', model: 'gpt-image-1', width: 1024, height: 512, steps: 30,
        codexPath: '/usr/local/bin/codex',
      },
    });
  });

  it('POST /:id/retry treats empty model/modelId override as "keep original" rather than clobbering with ""', async () => {
    jobStore.set('j-clear', {
      id: 'j-clear', kind: 'image', owner: null, status: 'failed',
      params: { prompt: 'cat', modelId: 'sdxl-base', steps: 30 },
    });
    const r = await request(makeApp())
      .post('/api/media-jobs/j-clear/retry')
      .send({ params: { modelId: '   ', steps: 40 } });
    expect(r.status).toBe(200);
    const call = stubs.enqueueJob.mock.calls[0][0];
    // modelId stays at the original — empty/whitespace override drops out.
    expect(call.params.modelId).toBe('sdxl-base');
    expect(call.params.steps).toBe(40);
  });

  it('GET /:id surfaces the Codex reasoning effort a job used (allowlisted)', async () => {
    jobStore.set('j-eff', {
      id: 'j-eff', kind: 'image', owner: null, status: 'failed',
      params: { prompt: 'cat', mode: 'codex', model: 'gpt-5.6-luna', effort: 'high' },
    });
    const r = await request(makeApp()).get('/api/media-jobs/j-eff');
    expect(r.status).toBe(200);
    expect(r.body.params.effort).toBe('high');
  });

  it('POST /:id/retry preserves an explicit Codex effort on a plain retry', async () => {
    jobStore.set('j-eff-keep', {
      id: 'j-eff-keep', kind: 'image', owner: null, status: 'failed',
      params: { prompt: 'cat', mode: 'codex', model: 'gpt-5.6-luna', effort: 'high' },
    });
    const r = await request(makeApp()).post('/api/media-jobs/j-eff-keep/retry').send({});
    expect(r.status).toBe(200);
    expect(stubs.enqueueJob.mock.calls[0][0].params.effort).toBe('high');
  });

  it('POST /:id/retry pins a new Codex effort when overridden', async () => {
    jobStore.set('j-eff-pin', {
      id: 'j-eff-pin', kind: 'image', owner: null, status: 'failed',
      params: { prompt: 'cat', mode: 'codex', effort: 'low' },
    });
    const r = await request(makeApp())
      .post('/api/media-jobs/j-eff-pin/retry')
      .send({ params: { effort: 'medium' } });
    expect(r.status).toBe(200);
    expect(stubs.enqueueJob.mock.calls[0][0].params.effort).toBe('medium');
  });

  it('POST /:id/retry resets Codex effort to the default when the clear sentinel is sent', async () => {
    jobStore.set('j-eff-clear', {
      id: 'j-eff-clear', kind: 'image', owner: null, status: 'failed',
      params: { prompt: 'cat', mode: 'codex', model: 'gpt-5.6-luna', effort: 'high' },
    });
    const r = await request(makeApp())
      .post('/api/media-jobs/j-eff-clear/retry')
      .send({ params: { effort: 'default' } });
    expect(r.status).toBe(200);
    const call = stubs.enqueueJob.mock.calls[0][0];
    // The key is DROPPED (not set to the sentinel or to undefined) so codex.js's
    // CODEX_IMAGEGEN_DEFAULT_EFFORT fallback takes over.
    expect('effort' in call.params).toBe(false);
    // other params are untouched by the clear
    expect(call.params.model).toBe('gpt-5.6-luna');
  });

  it('POST /:id/retry rejects an invalid Codex effort override', async () => {
    jobStore.set('j-eff-bad', {
      id: 'j-eff-bad', kind: 'image', owner: null, status: 'failed',
      params: { prompt: 'cat', mode: 'codex' },
    });
    const r = await request(makeApp())
      .post('/api/media-jobs/j-eff-bad/retry')
      .send({ params: { effort: 'turbo' } });
    expect(r.status).toBe(400);
    expect(stubs.enqueueJob).not.toHaveBeenCalled();
  });

  it('POST /:id/retry rejects override fields outside the whitelist', async () => {
    jobStore.set('j-bad', {
      id: 'j-bad', kind: 'image', owner: null, status: 'failed',
      params: { prompt: 'x', mode: 'codex' },
    });
    // pythonPath is not in the override schema; zod strips unknown keys, so
    // the enqueue should still happen but pythonPath must NOT have leaked
    // through.
    const r = await request(makeApp())
      .post('/api/media-jobs/j-bad/retry')
      .send({ params: { prompt: 'x', pythonPath: '/tmp/evil' } });
    expect(r.status).toBe(200);
    const call = stubs.enqueueJob.mock.calls[0][0];
    expect(call.params.pythonPath).toBeUndefined();
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

  it('POST /:id/run-now starts a queued Codex job past the parallel limit', async () => {
    stubs.runJobNow.mockReturnValueOnce({ ok: true, status: 'running' });
    const r = await request(makeApp()).post('/api/media-jobs/j-codex/run-now').send({});
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('running');
    expect(stubs.runJobNow).toHaveBeenCalledWith('j-codex');
  });

  it('POST /:id/run-now 400s for non-Codex (GPU) jobs', async () => {
    stubs.runJobNow.mockReturnValueOnce({
      ok: false, code: 'NOT_CODEX',
      error: 'Only Codex image jobs can be run-now; GPU jobs serialize on the MLX runtime',
    });
    const r = await request(makeApp()).post('/api/media-jobs/j-gpu/run-now').send({});
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('NOT_CODEX');
  });

  it('POST /:id/run-now 404s for unknown / not-queued ids', async () => {
    // Default stub returns NOT_FOUND
    const r = await request(makeApp()).post('/api/media-jobs/nope/run-now').send({});
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('NOT_FOUND');
  });

  it('DELETE /:id removes a terminal job from the archive', async () => {
    jobStore.set('j-old', { id: 'j-old', kind: 'image', owner: null, status: 'failed', params: {} });
    const r = await request(makeApp()).delete('/api/media-jobs/j-old');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(stubs.removeArchivedJob).toHaveBeenCalledWith('j-old');
  });

  it('DELETE /:id 409s for queued/running jobs', async () => {
    jobStore.set('j-live', { id: 'j-live', kind: 'image', owner: null, status: 'running', params: {} });
    const r = await request(makeApp()).delete('/api/media-jobs/j-live');
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('JOB_NOT_TERMINAL');
    expect(stubs.removeArchivedJob).not.toHaveBeenCalled();
  });

  it('DELETE /:id 404s for unknown ids', async () => {
    const r = await request(makeApp()).delete('/api/media-jobs/nope');
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('NOT_FOUND');
  });
});
