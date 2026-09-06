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
  resumeVideoHold: vi.fn(),
  listVideoHolds: vi.fn(() => []),
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
  resumeVideoHold: (...args) => stubs.resumeVideoHold(...args),
  listVideoHolds: (...args) => stubs.listVideoHolds(...args),
}));
vi.mock('../services/videoGen/prepareParams.js', () => ({
  validateVideoRetryParams: vi.fn(),
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

  it('POST /prompt-from-media 400s when the image source has no filename', async () => {
    const r = await request(makeApp()).post('/api/media-jobs/prompt-from-media').send({
      sourceKind: 'image',
      targets: ['image'],
      providerId: 'openai',
    });
    expect(r.status).toBe(400);
  });

  it('POST /prompt-from-media 400s when a video source has neither videoId nor filename (#4188)', async () => {
    const r = await request(makeApp()).post('/api/media-jobs/prompt-from-media').send({
      sourceKind: 'video',
      targets: ['video'],
      providerId: 'openai',
    });
    expect(r.status).toBe(400);
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

  it('POST /:id/retry hands a federated job back to enqueueJob with its marker intact', async () => {
    // The retry route deliberately does NOT special-case a federated job:
    // enqueueJob re-normalizes anything carrying a marker into the
    // downgrade-safe shape (#4683), so the override the user typed — which
    // never reached the peer anyway, the remote executor renders from
    // `remoteMedia.request` — cannot restore a locally-renderable job.
    const remoteMedia = {
      wireVersion: 1,
      peerId: '00000000-0000-4000-8000-0000000004f1',
      request: { kind: 'image', engine: 'local', modelId: 'dev', prompt: 'a lighthouse at dusk' },
    };
    jobStore.set('j-remote', {
      id: 'j-remote', kind: 'image', owner: null, status: 'failed',
      params: { prompt: '', modelId: null, pythonPath: null, width: 512, remoteMedia },
    });
    const r = await request(makeApp())
      .post('/api/media-jobs/j-remote/retry')
      .send({ params: { prompt: 'something else', modelId: 'sdxl-base' } });
    expect(r.status).toBe(200);
    const { params } = stubs.enqueueJob.mock.calls[0][0];
    expect(params.remoteMedia.request).toEqual(remoteMedia.request);
    expect(params.remoteMedia.peerId).toBe(remoteMedia.peerId);
    expect(params.width).toBe(512);
  });

  it('POST /:id/retry clears the marker run state so a CANCELED federated render can actually re-run', async () => {
    // `cancelRequested` describes the finished attempt. Inherited, it makes the
    // remote executor's preflight abort the retry on its first line — and rides
    // along again on every further retry, so the render could never be re-run.
    // `reconcile` is "recover the provider job for this Idempotency-Key"; the
    // retry gets a fresh queue id, which IS the key, so there is nothing to
    // recover and it must submit instead of skipping preflight.
    jobStore.set('j-canceled', {
      id: 'j-canceled', kind: 'image', owner: null, status: 'canceled',
      params: {
        prompt: '', modelId: null, pythonPath: null,
        remoteMedia: {
          wireVersion: 1,
          peerId: '00000000-0000-4000-8000-0000000004f1',
          cancelRequested: true,
          reconcile: true,
          request: { kind: 'image', engine: 'local', modelId: 'dev', prompt: 'a lighthouse at dusk' },
        },
      },
    });
    const r = await request(makeApp()).post('/api/media-jobs/j-canceled/retry').send({});
    expect(r.status).toBe(200);
    const { params } = stubs.enqueueJob.mock.calls[0][0];
    expect(params.remoteMedia.cancelRequested).toBe(false);
    expect(params.remoteMedia.reconcile).toBe(false);
    // Everything that identifies the render survives.
    expect(params.remoteMedia.peerId).toBe('00000000-0000-4000-8000-0000000004f1');
    expect(params.remoteMedia.request.prompt).toBe('a lighthouse at dusk');
  });

  it('POST /:id/retry survives a corrupt null marker instead of 500ing', async () => {
    // `isRemoteMediaJob` gates on presence, not truthiness — a hand-edited
    // media-jobs.json (or a peer-merged record) can hold `remoteMedia: null`
    // and still be classified as routed. The queue's remote module is where a
    // malformed marker fails closed; the retry route must not crash first.
    jobStore.set('j-null-marker', {
      id: 'j-null-marker', kind: 'image', owner: null, status: 'failed',
      params: { prompt: '', modelId: null, remoteMedia: null },
    });
    const r = await request(makeApp()).post('/api/media-jobs/j-null-marker/retry').send({});
    expect(r.status).toBe(200);
    const { params } = stubs.enqueueJob.mock.calls[0][0];
    expect(params.remoteMedia).toEqual({ cancelRequested: false, reconcile: false });
  });

  it('POST /:id/retry leaves a local job\'s params alone', async () => {
    // Bypass probe for the marker reset above: a training job carrying a stray
    // marker has no federated contract, so it must keep the local path.
    jobStore.set('j-training', {
      id: 'j-training', kind: 'training', owner: null, status: 'failed',
      params: { runId: 'run-1', runtime: 'mflux', remoteMedia: { wireVersion: 1, cancelRequested: true } },
    });
    const r = await request(makeApp()).post('/api/media-jobs/j-training/retry').send({});
    expect(r.status).toBe(200);
    const { params } = stubs.enqueueJob.mock.calls[0][0];
    expect(params.remoteMedia.cancelRequested).toBe(true);
  });

  it('POST /:id/retry accepts the editable video generation controls', async () => {
    jobStore.set('j-video-edit', {
      id: 'j-video-edit', kind: 'video', owner: null, status: 'failed',
      params: { prompt: 'old', modelId: 'video-model', width: 768, height: 512 },
    });
    const r = await request(makeApp())
      .post('/api/media-jobs/j-video-edit/retry')
      .send({ params: {
        prompt: 'new', negativePrompt: 'blur', modelId: 'other-model',
        width: 1024, height: 576, numFrames: 121, fps: 24, steps: 25,
        guidanceScale: 3, seed: 42, imageStrength: 0.5, tiling: 'spatial',
        disableAudio: true, textEncoderId: 'stock', chunks: 2,
        chunkPrompts: ['opening', 'climax'], contextFrames: 12,
      } });
    expect(r.status).toBe(200);
    expect(stubs.enqueueJob).toHaveBeenCalledWith({
      kind: 'video', owner: null,
      params: {
        prompt: 'new', negativePrompt: 'blur', modelId: 'other-model',
        width: 1024, height: 576, numFrames: 121, fps: 24, steps: 25,
        guidanceScale: 3, seed: 42, imageStrength: 0.5, tiling: 'spatial',
        disableAudio: true, textEncoderId: 'stock', chunks: 2,
        chunkPrompts: ['opening', 'climax'], contextFrames: 12,
      },
    });
  });

  // #4875 — resolveVideoSampler ranks a speed profile ABOVE explicit
  // steps/guidanceScale, so without a clear path a retry that edits Steps on a
  // profiled job would run at the profile's schedule and silently ignore it.
  it('POST /:id/retry can drop a speed profile so an edited sampler takes effect', async () => {
    jobStore.set('j-video-profile', {
      id: 'j-video-profile', kind: 'video', owner: null, status: 'failed',
      params: { prompt: 'old', modelId: 'ltx25_mlx_q8', speedProfileId: 'fast', steps: 8 },
    });
    const r = await request(makeApp())
      .post('/api/media-jobs/j-video-profile/retry')
      .send({ params: { speedProfileId: null, steps: 20 } });
    expect(r.status).toBe(200);
    expect(stubs.enqueueJob.mock.calls[0][0].params)
      .toEqual({ prompt: 'old', modelId: 'ltx25_mlx_q8', steps: 20 });
  });

  it('POST /:id/retry can switch a speed profile, and inherits it when untouched', async () => {
    jobStore.set('j-video-keep', {
      id: 'j-video-keep', kind: 'video', owner: null, status: 'failed',
      params: { prompt: 'old', speedProfileId: 'fast' },
    });
    const r = await request(makeApp())
      .post('/api/media-jobs/j-video-keep/retry')
      .send({ params: { prompt: 'new' } });
    expect(r.status).toBe(200);
    expect(stubs.enqueueJob.mock.calls[0][0].params.speedProfileId).toBe('fast');
  });

  // #5449 — the requeue editor now offers the preview-fidelity decode (#5423)
  // as an editable override, so the field has to be in the RETRY allowlist too.
  // Unknown keys are STRIPPED by the schema, so without this a changed decode
  // would be silently dropped rather than rejected.
  it('POST /:id/retry applies a draft-decode override the requeue editor sends', async () => {
    jobStore.set('j-video-decode', {
      id: 'j-video-decode', kind: 'video', owner: null, status: 'failed',
      params: { prompt: 'old', modelId: 'ltx25_mlx_q8' },
    });
    const r = await request(makeApp())
      .post('/api/media-jobs/j-video-decode/retry')
      .send({ params: { draftDecode: 'draft' } });
    expect(r.status).toBe(200);
    expect(stubs.enqueueJob.mock.calls[0][0].params)
      .toEqual({ prompt: 'old', modelId: 'ltx25_mlx_q8', draftDecode: 'draft' });
  });

  it('POST /:id/retry inherits the decode when untouched, and clears it on null or the full sentinel', async () => {
    const seed = () => jobStore.set('j-video-decode-clear', {
      id: 'j-video-decode-clear', kind: 'video', owner: null, status: 'failed',
      params: { prompt: 'old', draftDecode: 'draft' },
    });
    seed();
    const untouched = await request(makeApp())
      .post('/api/media-jobs/j-video-decode-clear/retry')
      .send({ params: { prompt: 'new' } });
    expect(untouched.status).toBe(200);
    expect(stubs.enqueueJob.mock.calls[0][0].params.draftDecode).toBe('draft');

    // Both spellings of "back to Full" drop the key entirely — absence and
    // 'full' are the same request (lib/videoDraftDecoders.js), so persisting the
    // sentinel would leave the requeued job wearing a knob that changed nothing.
    for (const value of [null, 'full']) {
      stubs.enqueueJob.mockClear();
      seed();
      const r = await request(makeApp())
        .post('/api/media-jobs/j-video-decode-clear/retry')
        .send({ params: { draftDecode: value } });
      expect(r.status).toBe(200);
      expect(stubs.enqueueJob.mock.calls[0][0].params).toEqual({ prompt: 'old' });
    }
  });

  it('POST /:id/retry rejects a decode id outside the closed enum', async () => {
    jobStore.set('j-video-decode-bad', {
      id: 'j-video-decode-bad', kind: 'video', owner: null, status: 'failed',
      params: { prompt: 'old' },
    });
    const r = await request(makeApp())
      .post('/api/media-jobs/j-video-decode-bad/retry')
      .send({ params: { draftDecode: 'turbo' } });
    expect(r.status).toBe(400);
  });

  it('POST /:id/retry clears resettable numeric video controls with null', async () => {
    jobStore.set('j-video-clear', {
      id: 'j-video-clear', kind: 'video', owner: null, status: 'failed',
      params: { prompt: 'old', steps: 25, seed: 42, guidanceScale: 3, imageStrength: 0.5 },
    });
    const r = await request(makeApp())
      .post('/api/media-jobs/j-video-clear/retry')
      .send({ params: { steps: null, seed: null, guidanceScale: null, imageStrength: null } });
    expect(r.status).toBe(200);
    expect(stubs.enqueueJob.mock.calls[0][0].params).toEqual({ prompt: 'old' });
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

// The conditioning promise (#4874) rides a retry the same way the strength
// does. RETRY_OVERRIDE_SCHEMA STRIPS unknown keys, so a missing entry there
// would silently re-render an anchored clip under the original job's Inspire
// label instead of failing loudly — which is why this is asserted, not assumed.
describe('POST /:id/retry — i2v reference mode overrides (#4874)', () => {
  const seed = (i2vReferenceMode) => {
    jobStore.set('j-ref-mode', {
      id: 'j-ref-mode', kind: 'video', owner: null, status: 'failed',
      params: {
        prompt: 'a fox', modelId: 'ltx25_mlx_q8', mode: 'image',
        sourceImagePath: '/mock/uploads/frame.png',
        ...(i2vReferenceMode ? { i2vReferenceMode } : {}),
      },
    });
  };

  beforeEach(() => {
    jobStore.clear();
    vi.clearAllMocks();
  });

  it('carries an inspire override into the retried params', async () => {
    seed(null);
    const r = await request(makeApp()).post('/api/media-jobs/j-ref-mode/retry')
      .send({ params: { i2vReferenceMode: 'inspire' } });
    expect(r.status).toBe(200);
    expect(stubs.enqueueJob.mock.calls[0][0].params.i2vReferenceMode).toBe('inspire');
  });

  it('drops the key entirely on a null clear rather than persisting a default', async () => {
    seed('inspire');
    const r = await request(makeApp()).post('/api/media-jobs/j-ref-mode/retry')
      .send({ params: { i2vReferenceMode: null } });
    expect(r.status).toBe(200);
    expect(stubs.enqueueJob.mock.calls[0][0].params).not.toHaveProperty('i2vReferenceMode');
  });

  it('inherits the original promise when the retry overrides nothing', async () => {
    seed('inspire');
    const r = await request(makeApp()).post('/api/media-jobs/j-ref-mode/retry').send({});
    expect(r.status).toBe(200);
    expect(stubs.enqueueJob.mock.calls[0][0].params.i2vReferenceMode).toBe('inspire');
  });

  // A grok job skips validateVideoRetryParams entirely (its `mode` is the
  // cloud-dispatch discriminator, not a semantic mode), so the gate has to be
  // stated on that branch too — otherwise the override merges through unchecked
  // and grok anchors the image regardless.
  it('rejects a loose reference on a grok retry, which skips the local validator', async () => {
    jobStore.set('j-ref-grok', {
      id: 'j-ref-grok', kind: 'video', owner: null, status: 'failed',
      params: { prompt: 'a fox', mode: 'grok', videoMode: 'image' },
    });
    const r = await request(makeApp()).post('/api/media-jobs/j-ref-grok/retry')
      .send({ params: { i2vReferenceMode: 'inspire' } });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('I2V_REFERENCE_MODE_UNSUPPORTED');
    expect(stubs.enqueueJob).not.toHaveBeenCalled();
  });

  it('still retries a grok job that leaves the reference mode alone', async () => {
    jobStore.set('j-ref-grok-ok', {
      id: 'j-ref-grok-ok', kind: 'video', owner: null, status: 'failed',
      params: { prompt: 'a fox', mode: 'grok', videoMode: 'image' },
    });
    const r = await request(makeApp()).post('/api/media-jobs/j-ref-grok-ok/retry').send({});
    expect(r.status).toBe(200);
    expect(stubs.enqueueJob).toHaveBeenCalled();
  });

  it('rejects an unknown reference mode instead of stripping it', async () => {
    seed(null);
    const r = await request(makeApp()).post('/api/media-jobs/j-ref-mode/retry')
      .send({ params: { i2vReferenceMode: 'inspiration' } });
    expect(r.status).toBe(400);
    expect(stubs.enqueueJob).not.toHaveBeenCalled();
  });
});

it('projects local holds on the array list and validates explicit resume', async () => {
  const holdId = '00000000-0000-4000-8000-000000000001';
  jobStore.clear();
  jobStore.set('held-job', { id: 'held-job', kind: 'video', status: 'queued', params: {}, hold: {
    id: holdId, modelId: 'example-mlx', runtime: 'mlx_video', classification: 'runtimeerror',
    cause: 'shader failed', heldAt: '2026-09-05T00:00:00.000Z', heldJobCount: 1, workerOnly: 'private',
  } });
  const app = makeApp();
  const list = await request(app).get('/api/media-jobs');
  expect(Array.isArray(list.body)).toBe(true);
  expect(list.body[0]).toMatchObject({ status: 'queued', hold: { id: holdId, cause: 'shader failed', heldJobCount: 1 } });
  expect(list.body[0].hold.workerOnly).toBeUndefined();
  const detail = await request(app).get('/api/media-jobs/held-job');
  expect(detail.body.hold).toEqual(list.body[0].hold);
  jobStore.clear();
  stubs.listVideoHolds.mockReturnValue([{ ...list.body[0].hold, heldJobCount: 0 }]);
  const holds = await request(app).get('/api/media-jobs/holds');
  expect(holds.body).toEqual([{ ...list.body[0].hold, heldJobCount: 0 }]);
  stubs.resumeVideoHold.mockResolvedValue(true);
  expect((await request(app).post(`/api/media-jobs/holds/${holdId}/resume`).send({})).body).toEqual({ resumed: true });
  expect(stubs.resumeVideoHold).toHaveBeenLastCalledWith(holdId);
  expect((await request(app).post('/api/media-jobs/holds/invalid/resume').send({})).status).toBe(400);
  expect((await request(app).post(`/api/media-jobs/holds/${holdId}/resume`).send({ retry: true })).status).toBe(400);
  stubs.resumeVideoHold.mockResolvedValue(false);
  expect((await request(app).post(`/api/media-jobs/holds/${holdId}/resume`).send({})).status).toBe(404);
});
