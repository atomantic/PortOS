import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { CLOUD_VIDEO_GEN_MODES } from '../lib/generationModes.js';

// Retry admission for hosted video jobs (#10741), through the real router and
// the REAL local retry validator. The local model catalog is deliberately empty:
// a hosted retry must not consult it (or local hardware) to be admitted.
const jobStore = new Map();
const enqueueJob = vi.fn(() => ({ jobId: 'new-job', position: 1, status: 'queued' }));
vi.mock('../services/mediaJobQueue/index.js', () => ({
  JOB_KINDS: ['video', 'image'],
  JOB_STATUSES: ['queued', 'running', 'completed', 'failed', 'canceled'],
  MEDIA_QUEUE_SHUTTING_DOWN: 'MEDIA_QUEUE_SHUTTING_DOWN',
  listJobs: () => Array.from(jobStore.values()),
  listQueueJobs: () => [],
  getJob: (id) => jobStore.get(id) || null,
  enqueueJob: (...args) => enqueueJob(...args),
  cancelJob: vi.fn(),
  cancelQueuedJobs: vi.fn(),
  runJobNow: vi.fn(),
  removeArchivedJob: (id) => jobStore.delete(id),
  resumeVideoHold: vi.fn(),
  listVideoHolds: () => [],
}));
vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock('../services/musicVideo/projects.js', () => ({ getProject: vi.fn() }));
vi.mock('../services/tracks/index.js', () => ({ getTrack: vi.fn() }));
vi.mock('../services/videoGen/local.js', () => ({
  listVideoModels: vi.fn(() => []),
  defaultVideoModelId: vi.fn(() => null),
  loadHistory: vi.fn(async () => []),
  BYOV_VIDEO_RUNTIMES: new Set(),
  DEFAULT_NUM_FRAMES: 121,
}));

const { listVideoModels } = await import('../services/videoGen/local.js');
const { HOSTED_VIDEO_SUBMISSIONS, hostedVideoRetryValidator } = await import('../services/videoGen/hostedSubmission.js');
const mediaJobsRouter = (await import('./mediaJobs.js')).default;

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/media-jobs', mediaJobsRouter);
  app.use(errorMiddleware);
  return app;
};

// Persisted params exactly as each backend's buildParams writes them.
const HOSTED_JOB_PARAMS = {
  grok: { prompt: 'a fox', mode: 'grok', videoMode: 'text', grokPath: '/bin/grok', aspectRatio: '16:9', width: 1280, height: 720, duration: 6 },
  fal: { prompt: 'a fox', mode: 'fal', videoMode: 'text', modelId: 'fal-ai/provider-model', aspectRatio: '16:9', width: 1280, height: 720, duration: 5 },
  reactor: { prompt: 'a fox', mode: 'reactor', videoMode: 'text', seconds: 4, seed: 7, aspect: '16:9' },
};
const seedJob = (id, params) => jobStore.set(id, { id, kind: 'video', owner: null, status: 'failed', params });
const retry = (id, body = {}) => request(makeApp()).post(`/api/media-jobs/${id}/retry`).send(body);

describe('hosted video retry admission', () => {
  beforeEach(() => {
    jobStore.clear();
    vi.clearAllMocks();
  });

  it('declares a retry validator and a fixture for every hosted backend', () => {
    // A backend added to the submission policy without a retry contract would
    // fall through to the local validator and be rejected by the local catalog.
    expect(Object.keys(HOSTED_VIDEO_SUBMISSIONS).sort()).toEqual([...CLOUD_VIDEO_GEN_MODES].sort());
    expect(Object.keys(HOSTED_JOB_PARAMS).sort()).toEqual(Object.keys(HOSTED_VIDEO_SUBMISSIONS).sort());
    for (const mode of Object.keys(HOSTED_VIDEO_SUBMISSIONS)) {
      expect(hostedVideoRetryValidator(mode)).toBeTypeOf('function');
    }
  });

  it.each(Object.keys(HOSTED_JOB_PARAMS))('re-enqueues an untouched %s job without consulting local models', async (mode) => {
    seedJob('j-hosted', HOSTED_JOB_PARAMS[mode]);
    const r = await retry('j-hosted');
    expect(r.status).toBe(200);
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(enqueueJob.mock.calls[0][0].params).toEqual(HOSTED_JOB_PARAMS[mode]);
    expect(listVideoModels).not.toHaveBeenCalled();
  });

  it.each(Object.keys(HOSTED_JOB_PARAMS))('refuses a loose reference mode on a %s retry', async (mode) => {
    seedJob('j-hosted', { ...HOSTED_JOB_PARAMS[mode], videoMode: 'image' });
    const r = await retry('j-hosted', { params: { i2vReferenceMode: 'inspire' } });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('I2V_REFERENCE_MODE_UNSUPPORTED');
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('lets a prompt edit through but never replaces the backend discriminator or paths', async () => {
    seedJob('j-fal', HOSTED_JOB_PARAMS.fal);
    const r = await retry('j-fal', { params: { prompt: 'a wolf', mode: 'local', pythonPath: '/evil', sourceImagePath: '/etc/passwd' } });
    expect(r.status).toBe(200);
    expect(enqueueJob.mock.calls[0][0].params).toEqual({ ...HOSTED_JOB_PARAMS.fal, prompt: 'a wolf' });
  });

  it('still validates a local job against the local catalog', async () => {
    seedJob('j-local', { prompt: 'a fox', mode: 'text', modelId: 'not-a-local-model' });
    const r = await retry('j-local');
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('VIDEO_GEN_UNKNOWN_MODEL');
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('does not resolve an inherited property name as a hosted backend', async () => {
    expect(hostedVideoRetryValidator('constructor')).toBeNull();
    expect(hostedVideoRetryValidator('__proto__')).toBeNull();
    seedJob('j-proto', { prompt: 'a fox', mode: 'constructor', modelId: 'not-a-local-model' });
    const r = await retry('j-proto');
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('VIDEO_GEN_UNKNOWN_MODEL');
  });
});
