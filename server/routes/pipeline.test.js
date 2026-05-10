import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const fileStore = new Map();

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { data: '/mock/data' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn(async (path, data) => { fileStore.set(path, data); }),
  readJSONFile: vi.fn(async (path, fallback) => (fileStore.has(path) ? fileStore.get(path) : fallback)),
}));

let uuidCounter = 0;
vi.mock('crypto', async () => {
  const actual = await vi.importActual('crypto');
  return { ...actual, randomUUID: () => `uuid-${++uuidCounter}` };
});

// Stub the actual text-stage generator: persists ready/output so the route
// returns a realistic { issue, stage, runId }.
vi.mock('../services/pipeline/textStages.js', async () => {
  const issuesSvc = await import('../services/pipeline/issues.js');
  return {
    generateStage: vi.fn(async (issueId, stageId, opts) => {
      const { issue, stage } = await issuesSvc.updateStage(issueId, stageId, {
        status: 'ready',
        output: `mock-output:${stageId}:${opts?.seedInput || ''}`,
        lastRunId: `run-${++uuidCounter}`,
      });
      return { issue, stage, runId: stage.lastRunId };
    }),
  };
});

// Stub the auto-runner so the test doesn't have to wait for real SSE traffic.
vi.mock('../services/pipeline/autoRunner.js', () => ({
  startAutoRunTextStages: vi.fn(async () => ({ runId: 'auto-run-1', alreadyRunning: false })),
  attachClient: vi.fn(() => false),
  cancelAutoRun: vi.fn(() => true),
  isAutoRunActive: vi.fn(() => false),
}));

vi.mock('../services/pipeline/visualStages.js', () => ({
  enqueueVisualImage: vi.fn(async (_issueId, stageId, opts) => ({
    jobId: `job-${++uuidCounter}`,
    mode: 'local',
    prompt: `style, ${opts.description}`,
  })),
}));

const pipelineRouter = (await import('./pipeline.js')).default;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/pipeline', pipelineRouter);
  app.use(errorMiddleware);
  return app;
}

describe('pipeline routes', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    vi.clearAllMocks();
  });

  it('POST /series → 201 with created series', async () => {
    const app = makeApp();
    const r = await request(app).post('/api/pipeline/series').send({
      name: 'Salt Run',
      logline: 'A foundry city goes silent.',
      premise: 'Long premise...',
      styleNotes: 'moebius linework',
    });
    expect(r.status).toBe(201);
    expect(r.body.id).toMatch(/^ser-/);
    expect(r.body.name).toBe('Salt Run');
  });

  it('POST /series rejects empty name with 400', async () => {
    const app = makeApp();
    const r = await request(app).post('/api/pipeline/series').send({ name: '' });
    expect(r.status).toBe(400);
  });

  it('PATCH /series/:id 404s for unknown id', async () => {
    const app = makeApp();
    const r = await request(app).patch('/api/pipeline/series/ser-nope').send({ name: 'x' });
    expect(r.status).toBe(404);
  });

  it('POST /series/:id/issues creates an issue under the series', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const r = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'Pilot' });
    expect(r.status).toBe(201);
    expect(r.body.id).toMatch(/^iss-/);
    expect(r.body.seriesId).toBe(ser.body.id);
    expect(r.body.number).toBe(1);
    expect(r.body.stages.idea.status).toBe('empty');
  });

  it('GET /series/:id/issues 404s for unknown series', async () => {
    const app = makeApp();
    const r = await request(app).get('/api/pipeline/series/ser-nope/issues');
    expect(r.status).toBe(404);
  });

  it('POST /issues/:id/stages/:stageId/generate runs a text stage', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    const r = await request(app).post(`/api/pipeline/issues/${iss.body.id}/stages/idea/generate`).send({ seedInput: 'foundry mystery' });
    expect(r.status).toBe(200);
    expect(r.body.stage.status).toBe('ready');
    expect(r.body.stage.output).toContain('mock-output:idea');
  });

  it('POST /issues/:id/stages/:stageId/generate rejects visual stages', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    const r = await request(app).post(`/api/pipeline/issues/${iss.body.id}/stages/comicPages/generate`).send({});
    expect(r.status).toBe(400);
    expect(r.body.code || r.body.error).toBeTruthy();
  });

  it('POST /issues/:id/stages/comicPages/visual enqueues an image job', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/comicPages/visual`)
      .send({ description: 'Lina enters the foundry, wide shot, dusk' });
    expect(r.status).toBe(200);
    expect(r.body.jobId).toMatch(/^job-/);
    expect(r.body.mode).toBe('local');
  });

  it('POST /issues/:id/stages/episodeVideo/visual returns 501 (deferred)', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/episodeVideo/visual`)
      .send({ description: 'final stitch' });
    expect(r.status).toBe(501);
  });

  it('POST /issues/:id/auto-run-text returns runId + sseUrl', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    const r = await request(app).post(`/api/pipeline/issues/${iss.body.id}/auto-run-text`).send({});
    expect(r.status).toBe(200);
    expect(r.body.runId).toBe('auto-run-1');
    expect(r.body.sseUrl).toContain('/progress');
  });

  it('POST /issues/:id/auto-run-text 404s for unknown issue', async () => {
    const app = makeApp();
    const r = await request(app).post('/api/pipeline/issues/iss-nope/auto-run-text').send({});
    expect(r.status).toBe(404);
  });
});
