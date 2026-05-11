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

// Stub the arc-planner LLM calls so route tests don't hit a provider.
let arcGenerateSpy;
let seasonEpisodesSpy;
let arcVerifySpy;
vi.mock('../services/pipeline/arcPlanner.js', async () => {
  const actual = await vi.importActual('../services/pipeline/arcPlanner.js');
  return {
    ...actual,
    generateArcOverview: vi.fn((...args) => arcGenerateSpy(...args)),
    generateSeasonEpisodes: vi.fn((...args) => seasonEpisodesSpy(...args)),
    verifyArc: vi.fn((...args) => arcVerifySpy(...args)),
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
  enqueueVisualComicPage: vi.fn(async (_issueId, opts) => ({
    jobId: `page-job-${++uuidCounter}`,
    mode: 'local',
    // Match the real service contract: pageNumber is 1-based (pageIndex + 1).
    prompt: `comic-page prompt for page ${opts.pageIndex + 1}`,
    pageIndex: opts.pageIndex,
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

  // ---- comicPages/extract-pages ----

  it('POST /issues/:id/stages/comicPages/extract-pages 400s when comicScript is empty', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/comicPages/extract-pages`)
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.code || r.body.error).toMatch(/PIPELINE_NO_SOURCE_FOR_PAGE_EXTRACT|empty/i);
  });

  it('POST /issues/:id/stages/comicPages/extract-pages 409s when comicPages already has pages (no force)', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    await request(app).patch(`/api/pipeline/issues/${iss.body.id}`).send({
      stages: {
        comicScript: { status: 'ready', output: '## Page 1\n\n### Panel 1\n\n**Description:** x\n' },
        comicPages: { pages: [{ panels: [{ description: 'pre-existing', caption: '', dialogue: [], sfx: '' }] }] },
      },
    });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/comicPages/extract-pages`)
      .send({});
    expect(r.status).toBe(409);
    expect(r.body.code || r.body.error).toMatch(/PIPELINE_COMIC_PAGES_NOT_EMPTY|force/i);
  });

  it('POST /issues/:id/stages/comicPages/extract-pages parses comicScript output and persists pages', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    const script = [
      '## Page 1',
      '',
      '### Panel 1',
      '',
      '**Description:** A wide-shot of the foundry.',
      '**Caption:** The city woke late.',
      '**Dialogue:** ALICE: It\'s quiet.',
      '**SFX:** (none)',
      '',
      '### Panel 2',
      '',
      '**Description:** Close on a hand.',
      '**Caption:** (none)',
      '**Dialogue:** (none)',
      '**SFX:** TINK',
      '',
      '## Page 2',
      '',
      '### Panel 1',
      '',
      '**Description:** A door swings open.',
      '**Caption:** (none)',
      '**Dialogue:** (none)',
      '**SFX:** (none)',
    ].join('\n');
    await request(app).patch(`/api/pipeline/issues/${iss.body.id}`).send({
      stages: { comicScript: { status: 'ready', output: script } },
    });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/comicPages/extract-pages`)
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.pageCount).toBe(2);
    expect(r.body.panelCount).toBe(3);
    expect(r.body.stage.status).toBe('ready');
    expect(r.body.stage.pages).toHaveLength(2);
    expect(r.body.stage.pages[0].panels).toHaveLength(2);
    // (none) sentinels normalized to '' / [] per the parser docstring
    expect(r.body.stage.pages[0].panels[0].sfx).toBe('');
    expect(r.body.stage.pages[0].panels[1].caption).toBe('');
    expect(r.body.stage.pages[0].panels[1].dialogue).toEqual([]);
    expect(r.body.stage.pages[0].panels[0].dialogue[0]).toEqual({ character: 'ALICE', line: 'It\'s quiet.' });
  });

  it('POST /issues/:id/stages/comicPages/extract-pages with force=true replaces existing pages', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    await request(app).patch(`/api/pipeline/issues/${iss.body.id}`).send({
      stages: {
        comicScript: { status: 'ready', output: '## Page 1\n\n### Panel 1\n\n**Description:** Fresh.\n**Caption:** (none)\n**Dialogue:** (none)\n**SFX:** (none)\n' },
        comicPages: { pages: [{ panels: [{ description: 'stale' }] }] },
      },
    });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/comicPages/extract-pages`)
      .send({ force: true });
    expect(r.status).toBe(200);
    expect(r.body.pageCount).toBe(1);
    expect(r.body.stage.pages[0].panels[0].description).toBe('Fresh.');
  });

  // ---- comicPages/pages/:pageIndex/render ----

  it('POST /issues/:id/stages/comicPages/pages/:pageIndex/render 400s for a non-integer pageIndex', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/comicPages/pages/abc/render`)
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.code || r.body.error).toMatch(/PIPELINE_COMIC_PAGE_BAD_INDEX|integer/i);
  });

  it('POST /issues/:id/stages/comicPages/pages/:pageIndex/render persists imageJobId + prompt onto the target page', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    await request(app).patch(`/api/pipeline/issues/${iss.body.id}`).send({
      stages: {
        comicPages: {
          pages: [
            { panels: [{ description: 'p1', caption: '', dialogue: [], sfx: '' }] },
            { panels: [{ description: 'p2', caption: '', dialogue: [], sfx: '' }] },
          ],
        },
      },
    });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/comicPages/pages/1/render`)
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.jobId).toMatch(/^page-job-/);
    // pageNumber is pageIndex + 1, so /pages/1/render renders the *2nd* page.
    expect(r.body.prompt).toMatch(/page 2/);
    expect(r.body.stage.pages[1].imageJobId).toBe(r.body.jobId);
    expect(r.body.stage.pages[1].prompt).toBe(r.body.prompt);
    // Other page untouched
    expect(r.body.stage.pages[0].imageJobId).toBeUndefined();
    expect(r.body.stage.status).toBe('edited');
  });

  it('POST /issues/:id/stages/comicPages/pages/:pageIndex/render 404s when pageIndex is out of range', async () => {
    // The service throws on out-of-range pageIndex; the route validates the
    // page exists up front and returns 404 instead of letting the service
    // bubble a generic Error.
    const visualStages = await import('../services/pipeline/visualStages.js');
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    await request(app).patch(`/api/pipeline/issues/${iss.body.id}`).send({
      stages: { comicPages: { pages: [] } },
    });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/comicPages/pages/99/render`)
      .send({});
    expect(r.status).toBe(404);
    expect(r.body.code || r.body.error).toMatch(/PIPELINE_COMIC_PAGE_NOT_FOUND|out of range/i);
    // Enqueue is never reached when the page doesn't exist.
    expect(visualStages.enqueueVisualComicPage).not.toHaveBeenCalled();
  });

  // -----------------------
  // Season routes (Phase 2 of Story Arc Planning)
  // -----------------------

  it('GET /series/:id/seasons returns [] for a fresh series', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const r = await request(app).get(`/api/pipeline/series/${ser.body.id}/seasons`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });

  it('GET /series/:id/seasons 404s for unknown series', async () => {
    const app = makeApp();
    const r = await request(app).get('/api/pipeline/series/ser-nope/seasons');
    expect(r.status).toBe(404);
  });

  it('POST /series/:id/seasons creates a season and auto-numbers it', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const r1 = await request(app).post(`/api/pipeline/series/${ser.body.id}/seasons`).send({ title: 'Pilot' });
    expect(r1.status).toBe(201);
    expect(r1.body.id).toMatch(/^sea-/);
    expect(r1.body.number).toBe(1);
    const r2 = await request(app).post(`/api/pipeline/series/${ser.body.id}/seasons`).send({ title: 'Aftermath' });
    expect(r2.body.number).toBe(2);
  });

  it('POST /series/:id/seasons rejects entry with neither title nor number', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const r = await request(app).post(`/api/pipeline/series/${ser.body.id}/seasons`).send({});
    expect(r.status).toBe(400);
  });

  it('PATCH /series/:id/seasons/:seasonId updates fields', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const sea = await request(app).post(`/api/pipeline/series/${ser.body.id}/seasons`).send({ title: 'Pilot' });
    const r = await request(app)
      .patch(`/api/pipeline/series/${ser.body.id}/seasons/${sea.body.id}`)
      .send({ logline: 'L1', status: 'verified' });
    expect(r.status).toBe(200);
    expect(r.body.logline).toBe('L1');
    expect(r.body.status).toBe('verified');
    expect(r.body.title).toBe('Pilot');
  });

  it('PATCH /series/:id/seasons/:seasonId 404s for unknown season', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const r = await request(app)
      .patch(`/api/pipeline/series/${ser.body.id}/seasons/sea-nope`)
      .send({ title: 'x' });
    expect(r.status).toBe(404);
  });

  it('DELETE /series/:id/seasons/:seasonId un-groups child issues by default', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const sea = await request(app).post(`/api/pipeline/series/${ser.body.id}/seasons`).send({ title: 'Pilot' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'Ep 1' });
    await request(app).patch(`/api/pipeline/issues/${iss.body.id}`).send({ seasonId: sea.body.id, arcPosition: 1 });

    const r = await request(app).delete(`/api/pipeline/series/${ser.body.id}/seasons/${sea.body.id}`).send({});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: sea.body.id, reassignedIssueCount: 1, reassignedTo: null });

    const reloaded = await request(app).get(`/api/pipeline/issues/${iss.body.id}`);
    expect(reloaded.body.seasonId).toBe(null);
  });

  it('DELETE /series/:id/seasons/:seasonId reassigns child issues to reassignTo sibling', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const a = await request(app).post(`/api/pipeline/series/${ser.body.id}/seasons`).send({ title: 'Pilot' });
    const b = await request(app).post(`/api/pipeline/series/${ser.body.id}/seasons`).send({ title: 'Hiatus' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'Ep 1' });
    await request(app).patch(`/api/pipeline/issues/${iss.body.id}`).send({ seasonId: a.body.id });

    const r = await request(app).delete(`/api/pipeline/series/${ser.body.id}/seasons/${a.body.id}`)
      .send({ reassignTo: b.body.id });
    expect(r.status).toBe(200);
    expect(r.body.reassignedTo).toBe(b.body.id);

    const reloaded = await request(app).get(`/api/pipeline/issues/${iss.body.id}`);
    expect(reloaded.body.seasonId).toBe(b.body.id);
  });

  it('DELETE /series/:id/seasons/:seasonId 400s when reassignTo points at non-existent sibling', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const sea = await request(app).post(`/api/pipeline/series/${ser.body.id}/seasons`).send({ title: 'Pilot' });
    const r = await request(app).delete(`/api/pipeline/series/${ser.body.id}/seasons/${sea.body.id}`)
      .send({ reassignTo: 'sea-ghost' });
    expect(r.status).toBe(400);
  });

  it('PATCH /issues/:id accepts seasonId + arcPosition', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const sea = await request(app).post(`/api/pipeline/series/${ser.body.id}/seasons`).send({ title: 'Pilot' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'Ep 1' });
    const r = await request(app).patch(`/api/pipeline/issues/${iss.body.id}`)
      .send({ seasonId: sea.body.id, arcPosition: 3 });
    expect(r.status).toBe(200);
    expect(r.body.seasonId).toBe(sea.body.id);
    expect(r.body.arcPosition).toBe(3);
  });

  it('PATCH /series/:id accepts arc payload', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const r = await request(app).patch(`/api/pipeline/series/${ser.body.id}`).send({
      arc: { logline: 'Big-picture pitch', themes: ['legacy', 'betrayal'], status: 'draft' },
    });
    expect(r.status).toBe(200);
    expect(r.body.arc).toMatchObject({
      logline: 'Big-picture pitch',
      themes: ['legacy', 'betrayal'],
      status: 'draft',
    });
  });

  // -----------------------
  // Arc planning routes (Phase 3 of Story Arc Planning)
  // -----------------------

  it('POST /series/:id/arc/generate returns preview without committing by default', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'Salt Run' });
    arcGenerateSpy = vi.fn(async () => ({
      arc: { logline: 'Whole-arc pitch', summary: 'sum', themes: ['legacy'], protagonistArc: 'P', status: 'draft' },
      seasons: [{ id: 'sea-1', number: 1, title: 'Pilot' }],
      runId: 'run-1',
      providerId: 'claude',
      model: 'opus-4',
    }));
    const r = await request(app).post(`/api/pipeline/series/${ser.body.id}/arc/generate`).send({});
    expect(r.status).toBe(200);
    expect(r.body.arc.logline).toBe('Whole-arc pitch');
    expect(r.body.seasons).toHaveLength(1);
    expect(r.body.committed).toBe(false);
    expect(r.body.series).toBe(null);

    // Confirm the series wasn't actually mutated.
    const reloaded = await request(app).get(`/api/pipeline/series/${ser.body.id}`);
    expect(reloaded.body.arc).toBe(null);
    expect(reloaded.body.seasons).toEqual([]);
  });

  it('POST /series/:id/arc/generate with commit:true persists arc + seasons', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'Salt Run' });
    arcGenerateSpy = vi.fn(async () => ({
      arc: { logline: 'Pitch', summary: 'sum', themes: [], protagonistArc: '', status: 'draft' },
      seasons: [
        { id: 'sea-1', number: 1, title: 'Pilot', createdAt: '2026-05-10T00:00:00.000Z', updatedAt: '2026-05-10T00:00:00.000Z' },
      ],
      runId: 'run-1', providerId: 'claude', model: 'opus-4',
    }));
    const r = await request(app).post(`/api/pipeline/series/${ser.body.id}/arc/generate`).send({ commit: true });
    expect(r.status).toBe(200);
    expect(r.body.committed).toBe(true);
    expect(r.body.series.arc.logline).toBe('Pitch');
    expect(r.body.series.seasons).toHaveLength(1);

    // Confirm the persisted series reads back the same way.
    const reloaded = await request(app).get(`/api/pipeline/series/${ser.body.id}`);
    expect(reloaded.body.arc.logline).toBe('Pitch');
    expect(reloaded.body.seasons[0].title).toBe('Pilot');
  });

  it('POST /series/:id/seasons/:seasonId/episodes/generate returns preview without committing', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const sea = await request(app).post(`/api/pipeline/series/${ser.body.id}/seasons`).send({
      title: 'Pilot', synopsis: 'season synopsis',
    });
    seasonEpisodesSpy = vi.fn(async () => ({
      season: sea.body,
      episodes: [
        { number: 1, title: 'Ep 1', logline: 'L', synopsis: 'S', primaryCharacters: ['LINA'], arcRole: 'pilot' },
        { number: 2, title: 'Ep 2', logline: 'L2', synopsis: 'S2', primaryCharacters: ['LINA'], arcRole: 'complication' },
      ],
      runId: 'run-1', providerId: 'p', model: 'm',
    }));
    const r = await request(app)
      .post(`/api/pipeline/series/${ser.body.id}/seasons/${sea.body.id}/episodes/generate`)
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.episodes).toHaveLength(2);
    expect(r.body.committed).toBe(false);
    expect(r.body.createdIssues).toEqual([]);

    // No issues actually created.
    const issues = await request(app).get(`/api/pipeline/series/${ser.body.id}/issues`);
    expect(issues.body).toEqual([]);
  });

  it('POST /series/:id/seasons/:seasonId/episodes/generate with commit:true creates one issue per episode', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    const sea = await request(app).post(`/api/pipeline/series/${ser.body.id}/seasons`).send({
      title: 'Pilot', synopsis: 'season synopsis',
    });
    seasonEpisodesSpy = vi.fn(async () => ({
      season: sea.body,
      episodes: [
        { number: 1, title: 'Ep 1', logline: 'L1', synopsis: 'Pilot synopsis', primaryCharacters: ['LINA'], arcRole: 'pilot' },
        { number: 2, title: 'Ep 2', logline: 'L2', synopsis: 'Comp synopsis', primaryCharacters: ['LINA'], arcRole: 'complication' },
      ],
      runId: 'run-2', providerId: 'p', model: 'm',
    }));
    const r = await request(app)
      .post(`/api/pipeline/series/${ser.body.id}/seasons/${sea.body.id}/episodes/generate`)
      .send({ commit: true });
    expect(r.status).toBe(200);
    expect(r.body.committed).toBe(true);
    expect(r.body.createdIssues).toHaveLength(2);
    expect(r.body.createdIssues[0].seasonId).toBe(sea.body.id);
    expect(r.body.createdIssues[0].arcPosition).toBe(1);
    expect(r.body.createdIssues[0].title).toBe('Ep 1');
    // Synopsis lands in stages.idea.input so auto-run-text has a seed.
    expect(r.body.createdIssues[0].stages.idea.input).toContain('Pilot synopsis');
    expect(r.body.createdIssues[1].arcPosition).toBe(2);

    const issues = await request(app).get(`/api/pipeline/series/${ser.body.id}/issues`);
    expect(issues.body.map((i) => i.title)).toEqual(['Ep 1', 'Ep 2']);
  });

  it('POST /series/:id/arc/verify forwards to the planner and returns issues', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S' });
    arcVerifySpy = vi.fn(async () => ({
      issues: [
        { severity: 'high', location: 'season:2/episode:5', problem: 'character is dead in S1', suggestion: 'remove from S2' },
      ],
      runId: 'r', providerId: 'p', model: 'm',
    }));
    const r = await request(app).post(`/api/pipeline/series/${ser.body.id}/arc/verify`).send({});
    expect(r.status).toBe(200);
    expect(r.body.issues).toHaveLength(1);
    expect(r.body.issues[0].severity).toBe('high');
  });
});
