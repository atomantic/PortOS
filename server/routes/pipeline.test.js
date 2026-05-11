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

// The episode-video handoff creates a CD project; stub it so the route test
// doesn't have to spin up the whole CD machinery.
vi.mock('../services/pipeline/episodeVideo.js', () => ({
  ERR_NO_STORYBOARDS: 'PIPELINE_EPISODE_NO_STORYBOARDS',
  startEpisodeVideoForIssue: vi.fn(async (issueId, opts) => ({
    cdProjectId: `cd-mock-${issueId.slice(0, 6)}`,
    scenes: 2,
    reused: opts?.force ? false : false,
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

  it('POST /issues/:id/stages/episodeVideo/visual hands off to Creative Director', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/episodeVideo/visual`)
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.cdProjectId).toMatch(/^cd-mock-/);
    expect(r.body.scenes).toBe(2);
  });

  it('POST /issues/:id/stages/episodeVideo/visual surfaces missing-storyboards as 400', async () => {
    const ev = await import('../services/pipeline/episodeVideo.js');
    ev.startEpisodeVideoForIssue.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Storyboards stage has no scenes with descriptions.'), { code: 'PIPELINE_EPISODE_NO_STORYBOARDS' });
    });
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/episodeVideo/visual`)
      .send({});
    expect(r.status).toBe(400);
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

  it('POST /series/:id/extract-bible 400s when no issueId and no corpus is supplied', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const r = await request(app).post(`/api/pipeline/series/${ser.body.id}/extract-bible`).send({});
    expect(r.status).toBe(400);
  });

  it('POST /series/:id/extract-bible 400s when the issue has no prose stage output', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    const r = await request(app)
      .post(`/api/pipeline/series/${ser.body.id}/extract-bible`)
      .send({ issueId: iss.body.id });
    expect(r.status).toBe(400);
    expect(r.body.error || r.body.message).toMatch(/no prose/i);
  });

  it('POST /series/:id/extract-bible 400s when the issue belongs to a different series', async () => {
    const app = makeApp();
    const ser1 = await request(app).post('/api/pipeline/series').send({ name: 'S1' });
    const ser2 = await request(app).post('/api/pipeline/series').send({ name: 'S2' });
    const iss = await request(app).post(`/api/pipeline/series/${ser1.body.id}/issues`).send({ title: 'I' });
    const r = await request(app)
      .post(`/api/pipeline/series/${ser2.body.id}/extract-bible`)
      .send({ issueId: iss.body.id });
    expect(r.status).toBe(400);
  });

  it('POST /series/:id/extract-bible runs the requested kinds and merges into the series', async () => {
    // Stub the bible extractor to skip the LLM call entirely.
    const extractor = await import('../lib/bibleExtractor.js');
    const spy = vi.spyOn(extractor, 'extractBible').mockImplementation(async ({ kind }) => ({
      extracted: kind === 'character'
        ? [{ name: 'Aria', physicalDescription: 'tall' }]
        : kind === 'setting'
        ? [{ slugline: 'INT. FOUNDRY — NIGHT', description: 'molten light' }]
        : [{ name: 'The Locket', significance: "mother's" }],
      runId: `run-${kind}`, providerId: 'mock', model: 'mock-model',
    }));

    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    // Seed prose
    await request(app).patch(`/api/pipeline/issues/${iss.body.id}`).send({
      stages: { prose: { status: 'ready', output: 'Once upon a time...' } },
    });

    const r = await request(app)
      .post(`/api/pipeline/series/${ser.body.id}/extract-bible`)
      .send({ issueId: iss.body.id, kinds: ['character', 'setting'] });

    expect(r.status).toBe(200);
    expect(r.body.series.characters[0].name).toBe('Aria');
    expect(r.body.series.settings[0].slugline).toBe('INT. FOUNDRY — NIGHT');
    // Objects bible was not requested → still empty
    expect(r.body.series.objects).toEqual([]);
    expect(r.body.results.characters.runId).toBe('run-character');
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('POST /series/:id/extract-bible with parallel:true fans all kinds out concurrently', async () => {
    // Track interleaving by recording per-call start + finish times. In
    // parallel mode all starts come before any finish; sequential mode has
    // finish[N] before start[N+1].
    const extractor = await import('../lib/bibleExtractor.js');
    const events = [];
    const spy = vi.spyOn(extractor, 'extractBible').mockImplementation(async ({ kind }) => {
      events.push({ kind, event: 'start' });
      await new Promise((r) => setTimeout(r, 30));
      events.push({ kind, event: 'finish' });
      return { extracted: [], runId: `run-${kind}`, providerId: 'mock', model: 'mock-model' };
    });

    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const r = await request(app)
      .post(`/api/pipeline/series/${ser.body.id}/extract-bible`)
      .send({ corpus: 'x', parallel: true });

    expect(r.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(3);
    // Parallel guarantee: every start fired before the first finish.
    const firstFinishIdx = events.findIndex((e) => e.event === 'finish');
    const startsBeforeFirstFinish = events.slice(0, firstFinishIdx).filter((e) => e.event === 'start').length;
    expect(startsBeforeFirstFinish).toBe(3);
    spy.mockRestore();
  });

  it('POST /series/:id/extract-bible defaults to sequential (CLI-provider safe)', async () => {
    const extractor = await import('../lib/bibleExtractor.js');
    const events = [];
    const spy = vi.spyOn(extractor, 'extractBible').mockImplementation(async ({ kind }) => {
      events.push({ kind, event: 'start' });
      await new Promise((r) => setTimeout(r, 10));
      events.push({ kind, event: 'finish' });
      return { extracted: [], runId: `run-${kind}`, providerId: 'mock', model: 'mock-model' };
    });

    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const r = await request(app)
      .post(`/api/pipeline/series/${ser.body.id}/extract-bible`)
      .send({ corpus: 'x' });

    expect(r.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(3);
    // Sequential: each kind finishes before the next one starts. The events
    // array must alternate start, finish, start, finish, start, finish.
    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toEqual(['start', 'finish', 'start', 'finish', 'start', 'finish']);
    spy.mockRestore();
  });

  it('POST /series/:id/extract-bible dedups duplicate kinds (no extra LLM calls)', async () => {
    const extractor = await import('../lib/bibleExtractor.js');
    const calls = [];
    const spy = vi.spyOn(extractor, 'extractBible').mockImplementation(async ({ kind }) => {
      calls.push(kind);
      return { extracted: [], runId: `run-${kind}`, providerId: 'mock', model: 'mock-model' };
    });

    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const r = await request(app)
      .post(`/api/pipeline/series/${ser.body.id}/extract-bible`)
      .send({ corpus: 'x', kinds: ['character', 'character', 'setting'] });

    expect(r.status).toBe(200);
    // Duplicates collapsed before the LLM dispatch — 2 calls for 2 unique kinds.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(calls.sort()).toEqual(['character', 'setting']);
    spy.mockRestore();
  });

  // ---- storyboards/extract-scenes ----

  it('POST /issues/:id/stages/storyboards/extract-scenes 400s when the source stage is empty', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/storyboards/extract-scenes`)
      .send({ from: 'tvScript' });
    expect(r.status).toBe(400);
    expect(r.body.error || r.body.message).toMatch(/empty/i);
  });

  it('POST /issues/:id/stages/storyboards/extract-scenes 409s when scenes already exist (no force)', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    await request(app).patch(`/api/pipeline/issues/${iss.body.id}`).send({
      stages: {
        tvScript: { status: 'ready', output: '## TEASER\n\n**INT. ROOM — NIGHT**\n\nAction.' },
        storyboards: { scenes: [{ slugline: 'EXT. CITY', description: 'pre-existing' }] },
      },
    });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/storyboards/extract-scenes`)
      .send({ from: 'tvScript' });
    expect(r.status).toBe(409);
    expect(r.body.error || r.body.message).toMatch(/force/i);
  });

  it('POST /issues/:id/stages/storyboards/extract-scenes runs the extractor and persists scenes (visualPrompt → description)', async () => {
    const extractor = await import('../lib/sceneExtractor.js');
    const spy = vi.spyOn(extractor, 'extractScenes').mockResolvedValue({
      extracted: {
        title: 'The Pilot', logline: 'A heist gone wrong.',
        scenes: [
          { id: 'scene-01', heading: 'Scene 1 — Vault', slugline: 'INT. VAULT — NIGHT', summary: 'They break in.', characters: ['ALICE'], action: 'A drill bites.', dialogue: [{ character: 'ALICE', line: 'Quiet.' }], visualPrompt: 'a high-tech vault, two figures in tactical gear, dim red emergency light', sourceSegmentIds: [] },
          { id: 'scene-02', heading: 'Scene 2 — Escape', slugline: 'EXT. ROOFTOP — DAWN', summary: '...', characters: [], action: '', dialogue: [], visualPrompt: 'a rooftop at first light, helicopter approaching', sourceSegmentIds: [] },
        ],
      },
      runId: 'run-scenes-1', providerId: 'mock', model: 'mock-model',
    });

    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({
      name: 'S', characters: [{ name: 'Alice', physicalDescription: 'tall, freckles' }],
    });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    await request(app).patch(`/api/pipeline/issues/${iss.body.id}`).send({
      stages: { tvScript: { status: 'ready', output: '## TEASER\n\n**INT. VAULT — NIGHT**\n\nThey break in.' } },
    });

    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/storyboards/extract-scenes`)
      .send({ from: 'tvScript' });

    expect(r.status).toBe(200);
    expect(r.body.sceneCount).toBe(2);
    expect(r.body.runId).toBe('run-scenes-1');
    expect(r.body.sourceKind).toBe('tvScript');
    // visualPrompt → description aliasing for UI compat
    expect(r.body.stage.scenes[0].description).toBe('a high-tech vault, two figures in tactical gear, dim red emergency light');
    expect(r.body.stage.scenes[0].slugline).toBe('INT. VAULT — NIGHT');
    expect(r.body.stage.scenes[0].imageJobId).toBeNull();
    // Rich fields ride along
    expect(r.body.stage.scenes[0].heading).toBe('Scene 1 — Vault');
    expect(r.body.stage.scenes[0].dialogue[0]).toEqual({ character: 'ALICE', line: 'Quiet.' });
    expect(r.body.stage.lastRunId).toBe('run-scenes-1');
    expect(r.body.stage.status).toBe('ready');

    // Series characters were forwarded to the extractor for bible deference
    const firstCall = spy.mock.calls[0][0];
    expect(firstCall.characters[0].name).toBe('Alice');
    expect(firstCall.sourceKind).toBe('tvScript');
    expect(firstCall.series).toEqual({ name: 'S', styleNotes: '' });
    spy.mockRestore();
  });

  it('POST /issues/:id/stages/storyboards/extract-scenes with from=prose routes to the prose stage output', async () => {
    const extractor = await import('../lib/sceneExtractor.js');
    const spy = vi.spyOn(extractor, 'extractScenes').mockResolvedValue({
      extracted: { title: null, logline: null, scenes: [{ visualPrompt: 'a paragraph beat' }] },
      runId: 'run-scenes-2', providerId: 'mock', model: 'mock-model',
    });

    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    await request(app).patch(`/api/pipeline/issues/${iss.body.id}`).send({
      stages: { prose: { status: 'ready', output: 'Once upon a time, a paragraph happened.' } },
    });

    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/storyboards/extract-scenes`)
      .send({ from: 'prose' });

    expect(r.status).toBe(200);
    expect(r.body.sourceKind).toBe('prose');
    expect(r.body.sceneCount).toBe(1);
    const callArgs = spy.mock.calls[0][0];
    expect(callArgs.source).toBe('Once upon a time, a paragraph happened.');
    expect(callArgs.sourceKind).toBe('prose');
    spy.mockRestore();
  });

  it('POST /issues/:id/stages/storyboards/extract-scenes with force=true overwrites existing scenes', async () => {
    const extractor = await import('../lib/sceneExtractor.js');
    const spy = vi.spyOn(extractor, 'extractScenes').mockResolvedValue({
      extracted: { title: null, logline: null, scenes: [{ visualPrompt: 'fresh scene' }] },
      runId: 'run-scenes-3', providerId: 'mock', model: 'mock-model',
    });

    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    await request(app).patch(`/api/pipeline/issues/${iss.body.id}`).send({
      stages: {
        tvScript: { status: 'ready', output: '## TEASER\n\n**INT. ROOM — NIGHT**' },
        storyboards: { scenes: [{ slugline: 'OLD', description: 'will be replaced' }] },
      },
    });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/storyboards/extract-scenes`)
      .send({ from: 'tvScript', force: true });

    expect(r.status).toBe(200);
    expect(r.body.sceneCount).toBe(1);
    expect(r.body.stage.scenes[0].description).toBe('fresh scene');
    spy.mockRestore();
  });
});
