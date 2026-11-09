import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const m = vi.hoisted(() => ({
  submit: vi.fn(),
  getProject: vi.fn(),
  refs: vi.fn(),
  jobs: [],
  cancelJob: vi.fn(async () => ({ ok: true, status: 'canceled' })),
}));
vi.mock('../services/videoGen/submitJob.js', () => ({ submitVideoGenJob: m.submit }));
vi.mock('../services/musicVideo/projects.js', () => ({ getProject: m.getProject }));
vi.mock('../services/musicVideo/clipCastReferences.js', () => ({ musicVideoClipReferences: m.refs, musicVideoClipCastReferences: m.refs }));
vi.mock('../services/mediaJobQueue/index.js', () => ({
  enqueueJob: vi.fn(), attachSseClient: vi.fn(() => false), cancelJob: m.cancelJob, listJobs: vi.fn(() => m.jobs),
}));
vi.mock('../lib/mediaModels.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getVideoModels: () => [{ id: 'ltx-ref', runtime: 'ltx25' }, { id: 'omni', runtime: 'fastvideo', fastvideoFamily: 'fasth3omni' }, { id: 'wan', runtime: 'wan22' }],
}));

const { default: videoGenRoutes } = await import('./videoGen.js');

const project = { id: 'mv-1', scenes: [{ sceneId: 's1', referenceImageId: 'start.png', prompt: 'She rides on.', startSec: 0, endSec: 4 }] };
let app;
beforeEach(() => {
  vi.clearAllMocks();
  m.jobs = [];
  m.getProject.mockResolvedValue(project);
  m.refs.mockResolvedValue([{ path: '/refs/lead.png' }]);
  m.submit.mockImplementation(async (body) => ({ jobId: `job-${body.modelId}` }));
  app = express();
  app.use(express.json());
  app.use('/api/video-gen', videoGenRoutes);
  app.use(errorMiddleware);
});

describe('overnight clip batches', () => {
  it('queues each shot and model through the Render route schema, keeping the run window and batch tag', async () => {
    const res = await request(app).post('/api/video-gen/overnight').send({ projectId: 'mv-1', sceneIds: ['s1'], modelIds: ['ltx-ref', 'omni'],
      startAt: '2026-11-09T23:00:00.000Z', stopBy: '2026-11-10T07:00:00.000Z' });
    expect(res.status).toBe(200);
    expect(res.body.queued).toEqual([{ sceneId: 's1', modelId: 'ltx-ref', jobId: 'job-ltx-ref' }, { sceneId: 's1', modelId: 'omni', jobId: 'job-omni' }]);
    const [ltxBody] = m.submit.mock.calls[0];
    expect(ltxBody).toMatchObject({ mode: 'ic-ingredients-25', icReferenceImageFiles: ['lead.png'],
      schedule: { startAt: '2026-11-09T23:00:00.000Z', stopBy: '2026-11-10T07:00:00.000Z' },
      musicVideo: { projectId: 'mv-1', sceneId: 's1', batchId: res.body.batchId } });
  });

  it('refuses a local model that takes no clip references, and a stop before the start', async () => {
    const wan = await request(app).post('/api/video-gen/overnight').send({ projectId: 'mv-1', sceneIds: ['s1'], modelIds: ['wan'] });
    expect(wan.status).toBe(400);
    const backwards = await request(app).post('/api/video-gen/overnight').send({ projectId: 'mv-1', sceneIds: ['s1'], modelIds: ['omni'],
      startAt: '2026-11-10T07:00:00.000Z', stopBy: '2026-11-09T23:00:00.000Z' });
    expect(backwards.status).toBe(400);
    expect(m.submit).not.toHaveBeenCalled();
  });

  it('cancels only the batch jobs still waiting or rendering', async () => {
    const batchId = '00000000-0000-4000-8000-000000000001';
    const tag = { projectId: 'mv-1', sceneId: 's1', batchId };
    m.jobs = [
      { id: 'a', status: 'queued', params: { musicVideo: tag } },
      { id: 'b', status: 'completed', params: { musicVideo: tag } },
      { id: 'c', status: 'queued', params: { musicVideo: { ...tag, batchId: '00000000-0000-4000-8000-000000000002' } } },
    ];
    const res = await request(app).delete(`/api/video-gen/overnight/${batchId}`);
    expect(res.body).toEqual({ canceled: 1 });
    expect(m.cancelJob).toHaveBeenCalledWith('a');
    expect(m.cancelJob).toHaveBeenCalledTimes(1);
  });
});
