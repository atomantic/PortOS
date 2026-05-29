import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { mockNoPeers, mockNoPeerSync } from '../lib/mockPathsDataRoot.js';

const fileStore = new Map();

vi.mock('../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  PATHS: { data: '/mock/data' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn(async (path, data) => { fileStore.set(path, data); }),
  readJSONFile: vi.fn(async (path, fallback) => (fileStore.has(path) ? fileStore.get(path) : fallback)),
}));

// Both mocks needed: vitest.setup.js's global `instances.js` mock uses importOriginal, which leaves the per-file `peerSync.js` mock unable to suppress the createSeries dynamic-import hoist error alone.
vi.mock('../services/instances.js', () => mockNoPeers());
vi.mock('../services/sharing/peerSync.js', () => mockNoPeerSync());

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
let volumeVerifySpy;
vi.mock('../services/pipeline/arcPlanner.js', async () => {
  const actual = await vi.importActual('../services/pipeline/arcPlanner.js');
  return {
    ...actual,
    generateArcOverview: vi.fn((...args) => arcGenerateSpy(...args)),
    generateSeasonEpisodes: vi.fn((...args) => seasonEpisodesSpy(...args)),
    verifyArc: vi.fn((...args) => arcVerifySpy(...args)),
    verifyVolume: vi.fn((...args) => volumeVerifySpy(...args)),
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
    // Forward proof/final variant + i2i flag so the route's slotKey + slot
    // record reflect the schema-validated body (target defaults to 'proof').
    variant: opts?.target === 'final' ? 'final' : 'proof',
    fromProof: opts?.target === 'final' && opts?.useProofAsBase === true,
  })),
  // Front cover render. Returns shape the route merges with the persisted cover:
  // { jobId, mode, prompt, coverScript, variant, fromProof }.
  enqueueComicCover: vi.fn(async (_issueId, body) => ({
    jobId: `cover-job-${++uuidCounter}`,
    mode: 'local',
    prompt: 'cover art prompt',
    coverScript: body?.coverScript ?? 'default cover concept',
    variant: body?.target === 'final' ? 'final' : 'proof',
    fromProof: body?.target === 'final' && body?.useProofAsBase === true,
  })),
  // Back cover render — symmetric with front cover; the route's persist
  // logic differs only in field names (backCover slot + backCoverScript).
  enqueueComicBackCover: vi.fn(async (_issueId, body) => ({
    jobId: `backcover-job-${++uuidCounter}`,
    mode: 'local',
    prompt: 'back cover art prompt',
    backCoverScript: body?.backCoverScript ?? 'default back cover concept',
    variant: body?.target === 'final' ? 'final' : 'proof',
    fromProof: body?.target === 'final' && body?.useProofAsBase === true,
  })),
  // Volume (season) front + back cover. Route writes to series.seasons[].cover
  // / .backCover via seriesSvc.updateSeasonOnSeries, so the mock shape mirrors
  // the comic-cover mocks.
  enqueueVolumeCover: vi.fn(async (_seriesId, _seasonId, body) => ({
    jobId: `vol-cover-job-${++uuidCounter}`,
    mode: 'local',
    prompt: 'volume cover art prompt',
    coverScript: body?.coverScript ?? 'default volume cover concept',
    variant: body?.target === 'final' ? 'final' : 'proof',
    fromProof: body?.target === 'final' && body?.useProofAsBase === true,
  })),
  enqueueVolumeBackCover: vi.fn(async (_seriesId, _seasonId, body) => ({
    jobId: `vol-backcover-job-${++uuidCounter}`,
    mode: 'local',
    prompt: 'volume back cover art prompt',
    backCoverScript: body?.backCoverScript ?? 'default volume back cover concept',
    variant: body?.target === 'final' ? 'final' : 'proof',
    fromProof: body?.target === 'final' && body?.useProofAsBase === true,
  })),
  // Single-scene video render. Returns the shape the route forwards verbatim
  // to clients: { jobId, prompt, sceneIndex, issue, stage }.
  enqueueStoryboardSceneVideo: vi.fn(async (issueId, sceneIndex) => ({
    jobId: `scene-vid-${++uuidCounter}`,
    prompt: `scene video prompt ${sceneIndex}`,
    sceneIndex,
    issue: { id: issueId, stages: { storyboards: { scenes: [] } } },
    stage: { scenes: [] },
  })),
  enqueueStoryboardShotStartFrame: vi.fn(async (issueId, sceneIndex, shotIndex) => ({
    jobId: `shot-img-${++uuidCounter}`,
    mode: 'local',
    prompt: `shot ${shotIndex} prompt`,
    sceneIndex,
    shotIndex,
    issue: { id: issueId, stages: { storyboards: { scenes: [] } } },
    stage: { scenes: [] },
  })),
  // Pure helper used by the route to construct the in-flight slot record.
  // Kept inline (not vi.fn) so the route's call-site logic is exercised
  // without forcing every test to thread a mock implementation through.
  buildRenderSlot: ({ slotKey, jobId, prompt, width, height, fromProof = false, filename = null }) => ({
    jobId,
    filename,
    prompt: prompt || null,
    width: width ?? null,
    height: height ?? null,
    createdAt: new Date().toISOString(),
    ...(slotKey === 'finalImage' ? { fromProof } : {}),
  }),
  refineComicPanelPrompt: vi.fn(async (issueId, pi, ni) => ({
    panel: { description: 'refined panel body' },
    page: { panels: [] },
    issue: { id: issueId, stages: { comicPages: { pages: [] } } },
    stage: { pages: [] },
    runId: 'run-mock-comic',
    changes: ['mock change'],
    providerId: 'mock-provider',
  })),
  refineStoryboardScenePrompt: vi.fn(async (issueId, idx) => ({
    scene: { description: 'refined scene body' },
    issue: { id: issueId, stages: { storyboards: { scenes: [] } } },
    stage: { scenes: [] },
    runId: 'run-mock-scene',
    changes: ['mock change'],
    providerId: 'mock-provider',
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

// Audio service mocks — avoid touching the real TTS pipeline + filesystem
// while still exercising the route's voice-resolution + persist flow.
vi.mock('../services/pipeline/audio.js', () => ({
  listAllVoices: vi.fn(async () => [{ id: 'kokoro:af_heart', engine: 'kokoro', voice: 'af_heart', label: 'Heart' }]),
  synthesizeToFile: vi.fn(async ({ voiceId }) => ({
    filename: `vo-mock-${++uuidCounter}.wav`,
    latencyMs: 5,
    engine: 'kokoro',
    voiceId: voiceId || null,
  })),
  parseVoiceId: vi.fn((v) => {
    if (!v) return { engine: null, voice: null };
    const m = v.match(/^([a-z]+):(.+)$/);
    return m ? { engine: m[1], voice: m[2] } : { engine: null, voice: v };
  }),
  extractDialogueLines: vi.fn((issue) => {
    const scenes = issue?.stages?.storyboards?.scenes || [];
    const out = [];
    let n = 1;
    for (const s of scenes) {
      for (const d of (s.dialogue || [])) {
        if (!d?.line?.trim()) continue;
        out.push({
          id: `line-${String(n).padStart(3, '0')}`,
          characterId: null,
          characterName: d.character || null,
          text: d.line,
          voiceIdOverride: null,
          audioJobId: null,
          audioFilename: null,
        });
        n += 1;
      }
    }
    return { lines: out, preservedCount: 0 };
  }),
  resolveVoiceForLine: vi.fn((line, series, { explicit } = {}) => {
    if (explicit) return explicit;
    if (line?.voiceIdOverride) return line.voiceIdOverride;
    if (line?.characterId && series?.characters) {
      const c = series.characters.find((x) => x?.id === line.characterId);
      if (c?.voiceId) return c.voiceId;
    }
    return null;
  }),
}));
vi.mock('../services/voice/tts.js', () => ({
  synthesize: vi.fn(async () => ({ wav: Buffer.from('w'), latencyMs: 1, engine: 'kokoro' })),
  listVoices: vi.fn(async () => ({ engine: 'kokoro', voices: [] })),
  VALID_ENGINES: new Set(['kokoro', 'piper']),
}));

const musicLibraryStore = new Map();
let lastImportedName = null;
const assertSafe = (name) => {
  if (typeof name !== 'string' || name.includes('..') || name.includes('/')) {
    const e = new Error('Invalid music filename');
    e.status = 400; e.code = 'VALIDATION_ERROR';
    throw e;
  }
};
vi.mock('../services/pipeline/musicLibrary.js', () => ({
  MUSIC_UPLOAD_MAX_BYTES: 50 * 1024 * 1024,
  MUSIC_SOURCE: { UPLOAD: 'upload', LIBRARY: 'library', GEN: 'gen' },
  isSupportedMusicUpload: vi.fn(() => true),
  listMusicLibrary: vi.fn(async () => Array.from(musicLibraryStore.values())),
  importUploadedTrack: vi.fn(async (_tmpPath, originalName) => {
    lastImportedName = originalName;
    const filename = `music-uuid-${++uuidCounter}.mp3`;
    musicLibraryStore.set(filename, { filename, label: originalName.replace(/\.[^.]+$/, ''), sizeBytes: 11, updatedAt: new Date().toISOString() });
    return { filename, sizeBytes: 11 };
  }),
  statMusicTrack: vi.fn(async (filename) => {
    assertSafe(filename);
    return musicLibraryStore.get(filename) || null;
  }),
  deleteMusicTrack: vi.fn(async (filename) => {
    assertSafe(filename);
    const existed = musicLibraryStore.has(filename);
    musicLibraryStore.delete(filename);
    return existed;
  }),
}));

vi.mock('../lib/multipart.js', () => ({
  uploadSingle: () => (req, _res, next) => {
    req.file = req.body?._mockFile || null;
    delete req.body?._mockFile;
    next();
  },
  optionalUpload: () => (_req, _res, next) => next(),
  uploadFields: () => (_req, _res, next) => next(),
}));

// Controllable mergeSeries for series merge route contract tests.
const mergeSeriesMock = vi.fn();
vi.mock('../services/recordMerge.js', async () => {
  const actual = await vi.importActual('../services/recordMerge.js');
  return { ...actual, mergeSeries: (...args) => mergeSeriesMock(...args) };
});

// Controllable mergeFieldsWithAI for series/merge/ai-resolve error contracts.
const mergeFieldsWithAIMock = vi.fn();
vi.mock('../services/recordMergeAI.js', async () => {
  const actual = await vi.importActual('../services/recordMergeAI.js');
  return { ...actual, mergeFieldsWithAI: (...args) => mergeFieldsWithAIMock(...args) };
});

// Editorial analysis — spy the service + batch runner so route tests assert
// dispatch/validation without hitting an LLM provider or the SSE machinery.
const getSeriesEditorialMock = vi.fn(async () => ({ coverage: { analyzed: 0, total: 0 }, roadmap: [], characters: [], protagonist: null, supportingArcs: [] }));
const analyzeIssueMock = vi.fn(async () => ({ status: 'complete', sections: [], characters: [], rollup: {} }));
const getIssueAnalysisMock = vi.fn(async () => null);
vi.mock('../services/pipeline/editorialAnalysis.js', () => ({
  getSeriesEditorial: (...a) => getSeriesEditorialMock(...a),
  analyzeIssue: (...a) => analyzeIssueMock(...a),
  getIssueAnalysis: (...a) => getIssueAnalysisMock(...a),
}));
const startSeriesAnalysisMock = vi.fn(async () => ({ runId: 'ed-run-1', alreadyRunning: false }));
vi.mock('../services/pipeline/editorialAnalysisRunner.js', () => ({
  startSeriesAnalysis: (...a) => startSeriesAnalysisMock(...a),
  attachClient: vi.fn(() => false),
  cancelSeriesAnalysis: vi.fn(() => true),
  isSeriesAnalysisActive: vi.fn(() => false),
}));

const pipelineRouter = (await import('./pipeline.js')).default;
const universeSvc = await import('../services/universeBuilder.js');

function makeApp() {
  const app = express();
  // Mirror production's `express.json({ limit: '55mb' })` in server/index.js so
  // tests can exercise the route's own size handling (e.g. 200K-char extract
  // corpus truncation) without hitting the default 100KB body cap first.
  app.use(express.json({ limit: '55mb' }));
  app.use('/api/pipeline', pipelineRouter);
  app.use(errorMiddleware);
  return app;
}

describe('pipeline routes', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    vi.clearAllMocks();
    mergeSeriesMock.mockReset();
    mergeFieldsWithAIMock.mockReset();
  });

  it('POST /series → 201 with created series', async () => {
    const app = makeApp();
    const r = await request(app).post('/api/pipeline/series').send({
      name: 'Salt Run',
      universeId: 'u-test',
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

  it('POST /series rejects a missing universe with 400 (hierarchy invariant)', async () => {
    const app = makeApp();
    const noUni = await request(app).post('/api/pipeline/series').send({ name: 'Orphan' });
    expect(noUni.status).toBe(400);
    const emptyUni = await request(app).post('/api/pipeline/series').send({ name: 'Orphan', universeId: '   ' });
    expect(emptyUni.status).toBe(400);
    const nullUni = await request(app).post('/api/pipeline/series').send({ name: 'Orphan', universeId: null });
    expect(nullUni.status).toBe(400);
  });

  it('GET /series/duplicates returns grouped shape (static path not swallowed by /:id)', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/pipeline/series/duplicates');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('series');
    expect(res.body).toHaveProperty('orphans');
  });

  it('POST /series/merge rejects identical survivor/loser ids with 400 (Zod refine)', async () => {
    // Zod catches same-id at schema level → 400 with generic validation code.
    const app = makeApp();
    const res = await request(app)
      .post('/api/pipeline/series/merge')
      .send({ survivorId: 'ser-1', loserId: 'ser-1' });
    expect(res.status).toBe(400);
  });

  it('POST /series/merge returns { merged: true, cascade } on success', async () => {
    const app = makeApp();
    mergeSeriesMock.mockResolvedValueOnce({
      survivorId: 'ser-uuid-1',
      loserId: 'ser-uuid-2',
      merged: true,
      cascade: { issuesToRepoint: 0, loserCollectionItemCount: 0 },
    });

    const res = await request(app)
      .post('/api/pipeline/series/merge')
      .send({ survivorId: 'ser-uuid-1', loserId: 'ser-uuid-2' });
    expect(res.status).toBe(200);
    expect(res.body.merged).toBe(true);
    expect(res.body).toHaveProperty('cascade');
    expect(res.body.survivorId).toBe('ser-uuid-1');
    expect(mergeSeriesMock).toHaveBeenCalledWith(
      'ser-uuid-1', 'ser-uuid-2', {}, expect.objectContaining({ fieldOverrides: {} }),
    );
  });

  describe('POST /series/merge/ai-resolve error contracts', () => {
    it('400 when survivorId === loserId (Zod schema guard)', async () => {
      const res = await request(makeApp())
        .post('/api/pipeline/series/merge/ai-resolve')
        .send({ survivorId: 'ser-1', loserId: 'ser-1', fields: ['logline'] });
      expect(res.status).toBe(400);
      expect(mergeFieldsWithAIMock).not.toHaveBeenCalled();
    });

    it('400 when survivorId does not match ser-<uuid> pattern', async () => {
      const res = await request(makeApp())
        .post('/api/pipeline/series/merge/ai-resolve')
        .send({ survivorId: 'u-1', loserId: 'ser-uuid-2', fields: ['logline'] });
      expect(res.status).toBe(400);
      expect(mergeFieldsWithAIMock).not.toHaveBeenCalled();
    });

    it('422 MERGE_AI_NO_MERGEABLE_FIELDS when fields are not non-empty strings on both sides', async () => {
      const { ServerError } = await import('../lib/errorHandler.js');
      mergeFieldsWithAIMock.mockRejectedValueOnce(
        new ServerError('No mergeable text fields', { status: 422, code: 'MERGE_AI_NO_MERGEABLE_FIELDS' }),
      );

      // Pre-populate series so the route can fetch them.
      const app = makeApp();
      await request(app).post('/api/pipeline/series').send({ name: 'AI-A', universeId: 'u-1' });
      await request(app).post('/api/pipeline/series').send({ name: 'AI-B', universeId: 'u-1' });
      const seriesSvc = await import('../services/pipeline/series.js');
      const all = await seriesSvc.listSeries();
      const [serA, serB] = all;

      const res = await request(app)
        .post('/api/pipeline/series/merge/ai-resolve')
        .send({ survivorId: serA.id, loserId: serB.id, fields: ['logline'] });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('MERGE_AI_NO_MERGEABLE_FIELDS');
    });

    it('503 MERGE_AI_NO_PROVIDER when no AI provider is configured', async () => {
      const { ServerError } = await import('../lib/errorHandler.js');
      mergeFieldsWithAIMock.mockRejectedValueOnce(
        new ServerError('No AI provider available', { status: 503, code: 'MERGE_AI_NO_PROVIDER' }),
      );

      const app = makeApp();
      await request(app).post('/api/pipeline/series').send({ name: 'P-A', universeId: 'u-1', logline: 'x' });
      await request(app).post('/api/pipeline/series').send({ name: 'P-B', universeId: 'u-1', logline: 'y' });
      const seriesSvc = await import('../services/pipeline/series.js');
      const all = await seriesSvc.listSeries();
      const [serA, serB] = all;

      const res = await request(app)
        .post('/api/pipeline/series/merge/ai-resolve')
        .send({ survivorId: serA.id, loserId: serB.id, fields: ['logline'] });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('MERGE_AI_NO_PROVIDER');
    });

    it('502 LLM_INVALID_JSON when the LLM returns unparseable JSON', async () => {
      const { ServerError } = await import('../lib/errorHandler.js');
      mergeFieldsWithAIMock.mockRejectedValueOnce(
        new ServerError('LLM returned invalid JSON', { status: 502, code: 'LLM_INVALID_JSON' }),
      );

      const app = makeApp();
      await request(app).post('/api/pipeline/series').send({ name: 'J-A', universeId: 'u-1', logline: 'x' });
      await request(app).post('/api/pipeline/series').send({ name: 'J-B', universeId: 'u-1', logline: 'y' });
      const seriesSvc = await import('../services/pipeline/series.js');
      const all = await seriesSvc.listSeries();
      const [serA, serB] = all;

      const res = await request(app)
        .post('/api/pipeline/series/merge/ai-resolve')
        .send({ survivorId: serA.id, loserId: serB.id, fields: ['logline'] });
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('LLM_INVALID_JSON');
    });
  });

  it('PATCH /series/:id 404s for unknown id', async () => {
    const app = makeApp();
    const r = await request(app).patch('/api/pipeline/series/ser-nope').send({ name: 'x' });
    expect(r.status).toBe(404);
  });

  it('PATCH /series/:id preserves arc.readerMap through the route schema (no key-strip)', async () => {
    // Regression: arcSchema must list readerMap, or Zod strips it and the
    // wholesale arc replace in updateSeries silently wipes the user's map.
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'RM', universeId: 'u-test' });
    const patch = await request(app).patch(`/api/pipeline/series/${ser.body.id}`).send({
      arc: {
        logline: 'spine',
        summary: 'sum',
        readerMap: { hooks: [{ label: 'Who fell?' }], beats: [{ kind: 'reveal', intensity: 0.7 }] },
      },
    });
    expect(patch.status).toBe(200);
    expect(patch.body.arc.readerMap).toBeTruthy();
    expect(patch.body.arc.readerMap.hooks).toHaveLength(1);
    expect(patch.body.arc.readerMap.beats[0].kind).toBe('reveal');
    // And a subsequent arc edit that re-sends the full arc keeps it.
    const edit = await request(app).patch(`/api/pipeline/series/${ser.body.id}`).send({
      arc: { ...patch.body.arc, logline: 'new spine' },
    });
    expect(edit.body.arc.logline).toBe('new spine');
    expect(edit.body.arc.readerMap.hooks).toHaveLength(1);
  });

  it('POST /series/:id/issues creates an issue under the series', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
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
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    const r = await request(app).post(`/api/pipeline/issues/${iss.body.id}/stages/idea/generate`).send({ seedInput: 'foundry mystery' });
    expect(r.status).toBe(200);
    expect(r.body.stage.status).toBe('ready');
    expect(r.body.stage.output).toContain('mock-output:idea');
  });

  it('POST /issues/:id/stages/:stageId/generate rejects visual stages', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    const r = await request(app).post(`/api/pipeline/issues/${iss.body.id}/stages/comicPages/generate`).send({});
    expect(r.status).toBe(400);
    expect(r.body.code || r.body.error).toBeTruthy();
  });

  describe('POST /issues/:id/stages/:stageId/restore', () => {
    it('restores a prior runHistory snapshot and snapshots the displaced current state', async () => {
      const app = makeApp();
      const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
      const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
      const issueId = iss.body.id;
      // First run → no snapshot yet.
      const r1 = await request(app)
        .post(`/api/pipeline/issues/${issueId}/stages/idea/generate`)
        .send({ seedInput: 'mystery v1' });
      const firstRunId = r1.body.stage.lastRunId;
      // Second run → snapshots v1.
      const r2 = await request(app)
        .post(`/api/pipeline/issues/${issueId}/stages/idea/generate`)
        .send({ seedInput: 'mystery v2' });
      expect(r2.body.stage.runHistory).toHaveLength(1);
      expect(r2.body.stage.runHistory[0].runId).toBe(firstRunId);
      // Restore v1.
      const restored = await request(app)
        .post(`/api/pipeline/issues/${issueId}/stages/idea/restore`)
        .send({ runId: firstRunId });
      expect(restored.status).toBe(200);
      expect(restored.body.stage.lastRunId).toBe(firstRunId);
      expect(restored.body.stage.status).toBe('edited');
      // The just-replaced v2 now sits at the top of history.
      expect(restored.body.stage.runHistory[0].runId).toBe(r2.body.stage.lastRunId);
    });

    it('rejects when the runId is not in the current snapshot list', async () => {
      const app = makeApp();
      const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
      const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
      const r = await request(app)
        .post(`/api/pipeline/issues/${iss.body.id}/stages/idea/restore`)
        .send({ runId: 'run-never-generated' });
      expect(r.status).toBe(400);
    });

    it('rejects non-text stages', async () => {
      const app = makeApp();
      const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
      const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
      const r = await request(app)
        .post(`/api/pipeline/issues/${iss.body.id}/stages/comicPages/restore`)
        .send({ runId: 'r1' });
      expect(r.status).toBe(400);
    });

    it('rejects empty runId via Zod', async () => {
      const app = makeApp();
      const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
      const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
      const r = await request(app)
        .post(`/api/pipeline/issues/${iss.body.id}/stages/idea/restore`)
        .send({ runId: '' });
      expect(r.status).toBe(400);
    });
  });

  it('POST /issues/:id/stages/comicPages/visual enqueues an image job', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
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
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
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
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/episodeVideo/visual`)
      .send({});
    expect(r.status).toBe(400);
  });

  it('GET /issues/recent?limit=0 clamps to 1 (route forwards to service which owns coercion)', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'A' });
    await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'B' });
    const r = await request(app).get('/api/pipeline/issues/recent?limit=0');
    expect(r.status).toBe(200);
    // Without alignment, the route's `Number(...) || 10` would return up
    // to 10 issues even when the caller explicitly passed 0.
    expect(r.body).toHaveLength(1);
  });

  it('GET /issues/recent returns the most-recently-updated issues with denormalized seriesName', async () => {
    const app = makeApp();
    const ser1 = await request(app).post('/api/pipeline/series').send({ name: 'Alpha', universeId: 'u-test' });
    const ser2 = await request(app).post('/api/pipeline/series').send({ name: 'Beta', universeId: 'u-test' });
    const iss1 = await request(app).post(`/api/pipeline/series/${ser1.body.id}/issues`).send({ title: 'Old' });
    // Bump iss1's updatedAt back so iss2 is unambiguously the most recent.
    await new Promise((r) => setTimeout(r, 10));
    const iss2 = await request(app).post(`/api/pipeline/series/${ser2.body.id}/issues`).send({ title: 'Newer' });
    const r = await request(app).get('/api/pipeline/issues/recent?limit=10');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body[0].id).toBe(iss2.body.id);
    expect(r.body[0].seriesName).toBe('Beta');
    expect(r.body.find((i) => i.id === iss1.body.id)?.seriesName).toBe('Alpha');
  });

  // Service-layer tests cover withHistory:true/false; these pin the route
  // wiring on the endpoints UI lists hit so a future change can't silently
  // re-introduce stage runHistory on list payloads.
  describe('list endpoints strip runHistory at the HTTP boundary', () => {
    async function seedIssueWithHistory(app) {
      const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
      const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
      await request(app).post(`/api/pipeline/issues/${iss.body.id}/stages/idea/generate`).send({ seedInput: 'v1' });
      const r = await request(app).post(`/api/pipeline/issues/${iss.body.id}/stages/idea/generate`).send({ seedInput: 'v2' });
      expect(r.body.stage.runHistory).toHaveLength(1);
      return { seriesId: ser.body.id, issueId: iss.body.id };
    }

    it.each([
      ['non-paginated', '', (body) => body, { withHistory: false }],
      ['paginated', '?offset=0&limit=10', (body) => body.items, { paginated: true, withHistory: false }],
    ])('GET /series/:id/issues (%s) strips stages.*.runHistory and forwards withHistory:false', async (_label, qs, pickItems, expectedArgs) => {
      const issuesSvc = await import('../services/pipeline/issues.js');
      const app = makeApp();
      const { seriesId, issueId } = await seedIssueWithHistory(app);
      const spy = vi.spyOn(issuesSvc, 'listIssues');
      const r = await request(app).get(`/api/pipeline/series/${seriesId}/issues${qs}`);
      expect(r.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ seriesId, ...expectedArgs }));
      const items = pickItems(r.body);
      expect(Array.isArray(items)).toBe(true);
      expect(items.find((i) => i.id === issueId).stages.idea.runHistory).toEqual([]);
      spy.mockRestore();
    });

    it('GET /issues/recent forwards withHistory:false and projects stages out of the response', async () => {
      const issuesSvc = await import('../services/pipeline/issues.js');
      const app = makeApp();
      // Tiny seed so the response is non-empty and we can assert the
      // route's `stages`-dropping projection actually holds.
      const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
      await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'T' });
      const spy = vi.spyOn(issuesSvc, 'listRecentIssues');
      const r = await request(app).get('/api/pipeline/issues/recent?limit=5');
      expect(r.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ withHistory: false }));
      expect(r.body[0]).not.toHaveProperty('stages');
      spy.mockRestore();
    });
  });

  it('POST /issues/:id/stages/storyboards/scenes/:index/video returns the enqueued jobId', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/storyboards/scenes/0/video`)
      .send({ aspectRatio: '16:9' });
    expect(r.status).toBe(200);
    expect(r.body.jobId).toMatch(/^scene-vid-/);
    expect(r.body.sceneIndex).toBe(0);
  });

  it('POST /issues/:id/stages/storyboards/scenes/:index/video rejects a non-integer index', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/storyboards/scenes/nope/video`)
      .send({});
    expect(r.status).toBe(400);
  });

  it('POST /issues/:id/stages/storyboards/scenes/:sceneIndex/shots/:shotIndex/render returns the enqueued jobId', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/storyboards/scenes/0/shots/2/render`)
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.jobId).toMatch(/^shot-img-/);
    expect(r.body.sceneIndex).toBe(0);
    expect(r.body.shotIndex).toBe(2);
  });

  it('POST /issues/:id/stages/storyboards/scenes/:sceneIndex/shots/:shotIndex/render rejects bad indices', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/storyboards/scenes/nope/shots/0/render`)
      .send({});
    expect(r.status).toBe(400);
  });

  it('POST /issues/:id/stages/comicPages/pages/:p/panels/:n/refine-prompt returns the refined panel + changes', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/comicPages/pages/0/panels/0/refine-prompt`)
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.runId).toBe('run-mock-comic');
    expect(r.body.panel.description).toBe('refined panel body');
    expect(r.body.changes).toEqual(['mock change']);
  });

  it('POST /issues/:id/stages/storyboards/scenes/:index/refine-prompt returns the refined scene', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/storyboards/scenes/0/refine-prompt`)
      .send({ providerId: 'codex', model: 'gpt-4o' });
    expect(r.status).toBe(200);
    expect(r.body.runId).toBe('run-mock-scene');
    expect(r.body.scene.description).toBe('refined scene body');
  });

  it('POST /issues/:id/auto-run-text returns runId + sseUrl', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
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

  // ---- storyboards/extract-scenes ----

  it('POST /issues/:id/stages/storyboards/extract-scenes 400s when the source stage is empty', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/storyboards/extract-scenes`)
      .send({ from: 'teleplay' });
    expect(r.status).toBe(400);
    expect(r.body.error || r.body.message).toMatch(/empty/i);
  });

  it('POST /issues/:id/stages/storyboards/extract-scenes 409s when scenes already exist (no force)', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    await request(app).patch(`/api/pipeline/issues/${iss.body.id}`).send({
      stages: {
        teleplay: { status: 'ready', output: '## TEASER\n\n**INT. ROOM — NIGHT**\n\nAction.' },
        storyboards: { scenes: [{ slugline: 'EXT. CITY', description: 'pre-existing' }] },
      },
    });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/storyboards/extract-scenes`)
      .send({ from: 'teleplay' });
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

    // Phase B.4: canon lives on the linked universe. Seed a universe via
    // the service layer (this test mounts only /api/pipeline, not the
    // universe-builder router), link the series to it, then run extraction
    // — the universe's canon should reach the extractor via getSeriesCanon.
    const app = makeApp();
    const uni = await universeSvc.createUniverse({
      name: 'U',
      characters: [{ name: 'Alice', physicalDescription: 'tall, freckles' }],
    });
    const ser = await request(app).post('/api/pipeline/series').send({
      name: 'S', universeId: uni.id,
    });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    await request(app).patch(`/api/pipeline/issues/${iss.body.id}`).send({
      stages: { teleplay: { status: 'ready', output: '## TEASER\n\n**INT. VAULT — NIGHT**\n\nThey break in.' } },
    });

    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/storyboards/extract-scenes`)
      .send({ from: 'teleplay' });

    expect(r.status).toBe(200);
    expect(r.body.sceneCount).toBe(2);
    expect(r.body.runId).toBe('run-scenes-1');
    expect(r.body.sourceKind).toBe('teleplay');
    // visualPrompt → description aliasing for UI compat
    expect(r.body.stage.scenes[0].description).toBe('a high-tech vault, two figures in tactical gear, dim red emergency light');
    expect(r.body.stage.scenes[0].slugline).toBe('INT. VAULT — NIGHT');
    expect(r.body.stage.scenes[0].imageJobId).toBeNull();
    // Rich fields ride along
    expect(r.body.stage.scenes[0].heading).toBe('Scene 1 — Vault');
    expect(r.body.stage.scenes[0].dialogue[0]).toEqual({ character: 'ALICE', line: 'Quiet.' });
    expect(r.body.stage.lastRunId).toBe('run-scenes-1');
    expect(r.body.stage.status).toBe('ready');

    // Universe canon was forwarded to the extractor for bible deference.
    const firstCall = spy.mock.calls[0][0];
    expect(firstCall.characters[0].name).toBe('Alice');
    expect(firstCall.sourceKind).toBe('teleplay');
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
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
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
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    await request(app).patch(`/api/pipeline/issues/${iss.body.id}`).send({
      stages: {
        teleplay: { status: 'ready', output: '## TEASER\n\n**INT. ROOM — NIGHT**' },
        storyboards: { scenes: [{ slugline: 'OLD', description: 'will be replaced' }] },
      },
    });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/storyboards/extract-scenes`)
      .send({ from: 'teleplay', force: true });

    expect(r.status).toBe(200);
    expect(r.body.sceneCount).toBe(1);
    expect(r.body.stage.scenes[0].description).toBe('fresh scene');
    spy.mockRestore();
  });

  // ---- comicPages/extract-pages ----

  it('POST /issues/:id/stages/comicPages/extract-pages 400s when comicScript is empty', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/comicPages/extract-pages`)
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.code || r.body.error).toMatch(/PIPELINE_NO_SOURCE_FOR_PAGE_EXTRACT|empty/i);
  });

  it('POST /issues/:id/stages/comicPages/extract-pages 409s when comicPages already has pages (no force)', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
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
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
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
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
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

  it('POST /issues/:id/stages/comicPages/extract-pages seeds blank cover.script from parsed coverConcept', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    const script = [
      '## Cover concept',
      'A lone figure stands on a crumbling bridge.',
      '',
      '## Page 1',
      '',
      'Panel 1',
      '**Description:** The bridge at dusk.',
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
    // Response reflects the seeded cover
    expect(r.body.stage.cover.script).toBe('A lone figure stands on a crumbling bridge.');
    expect(r.body.stage.cover.imageJobId).toBeNull();
    expect(r.body.stage.cover.prompt).toBeNull();
    // Persisted issue also carries the seeded cover
    expect(r.body.issue.stages.comicPages.cover.script).toBe('A lone figure stands on a crumbling bridge.');
  });

  it('POST /issues/:id/stages/comicPages/extract-pages does not clobber an existing cover.script', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    const script = [
      '## Cover concept',
      'A brand-new concept from the re-run.',
      '',
      '## Page 1',
      '',
      'Panel 1',
      '**Description:** The bridge at dawn.',
      '**Caption:** (none)',
      '**Dialogue:** (none)',
      '**SFX:** (none)',
    ].join('\n');
    // Pre-seed the issue with an existing user-edited cover script
    await request(app).patch(`/api/pipeline/issues/${iss.body.id}`).send({
      stages: {
        comicScript: { status: 'ready', output: script },
        comicPages: { cover: { script: 'user edit', imageJobId: 'old-job', prompt: 'old prompt' } },
      },
    });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/comicPages/extract-pages`)
      .send({});
    expect(r.status).toBe(200);
    // The existing cover must be preserved exactly — no clobber
    expect(r.body.stage.cover.script).toBe('user edit');
    expect(r.body.issue.stages.comicPages.cover.script).toBe('user edit');
  });

  // ---- :stageId/extract-canon (manual canon extraction from comicScript / teleplay) ----

  it('POST /issues/:id/stages/:stageId/extract-canon 400s when stage is not comicScript or teleplay', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/prose/extract-canon`)
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PIPELINE_CANON_EXTRACT_BAD_STAGE');
  });

  it('POST /issues/:id/stages/:stageId/extract-canon 400s when the script stage is empty', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/comicScript/extract-canon`)
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PIPELINE_CANON_EXTRACT_NO_CORPUS');
  });

  it('POST /issues/:id/stages/:stageId/extract-canon 400s when series has no linked universe', async () => {
    const app = makeApp();
    // The POST /series route now requires a universe, but legacy/imported
    // orphan series can still exist on disk — create one via the (permissive)
    // service directly to exercise the extract-canon no-universe guard.
    const seriesSvc = await import('../services/pipeline/series.js');
    const ser = await seriesSvc.createSeries({ name: 'S', universeId: null });
    const iss = await request(app).post(`/api/pipeline/series/${ser.id}/issues`).send({ title: 'I' });
    await request(app).patch(`/api/pipeline/issues/${iss.body.id}`).send({
      stages: { comicScript: { status: 'ready', output: '## Page 1\n\n### Panel 1\n**Description:** A barkeep slides a glass.' } },
    });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/comicScript/extract-canon`)
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PIPELINE_CANON_EXTRACT_NO_UNIVERSE');
  });

  it('POST /issues/:id/stages/comicScript/extract-canon merges into the linked universe and returns counts', async () => {
    const canonSvc = await import('../services/universeCanon.js');
    const spy = vi.spyOn(canonSvc, 'extractCanonFromProse').mockImplementation(async (universeId, opts) => ({
      universe: { id: universeId, name: 'U', characters: [{ id: 'c1', name: 'Barkeep' }], places: [], objects: [] },
      results: {
        characters: { extracted: [{ name: 'Barkeep' }], runId: 'run-c' },
        places: { extracted: [], runId: 'run-p' },
        objects: { extracted: [], runId: 'run-o' },
      },
      _spiedOpts: opts,
    }));

    const app = makeApp();
    const uni = await universeSvc.createUniverse({ name: 'U' });
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: uni.id });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    await request(app).patch(`/api/pipeline/issues/${iss.body.id}`).send({
      stages: {
        comicScript: { status: 'ready', output: '## Page 1\n\n### Panel 1\n**Description:** A barkeep slides a glass to Lina.' },
      },
    });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/comicScript/extract-canon`)
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.sourceStage).toBe('comicScript');
    expect(r.body.extracted).toEqual({ characters: 1, places: 0, objects: 0 });
    expect(r.body.universe.id).toBe(uni.id);
    expect(r.body.truncated).toBe(false);

    // Service was called with the script's output as corpus + stamp opts.
    expect(spy).toHaveBeenCalledTimes(1);
    const [calledUniverseId, calledOpts] = spy.mock.calls[0];
    expect(calledUniverseId).toBe(uni.id);
    expect(calledOpts.corpus).toContain('A barkeep slides a glass to Lina.');
    expect(calledOpts.parallel).toBe(true);
    expect(calledOpts.autoLock).toBe(true);
    expect(calledOpts.sourceSeriesId).toBe(ser.body.id);
    spy.mockRestore();
  });

  it('POST /issues/:id/stages/:stageId/extract-canon truncates corpus over 200K chars and flags it', async () => {
    const canonSvc = await import('../services/universeCanon.js');
    const spy = vi.spyOn(canonSvc, 'extractCanonFromProse').mockResolvedValue({
      universe: { id: 'u-mock', characters: [], places: [], objects: [] },
      results: {
        characters: { extracted: [] },
        places: { extracted: [] },
        objects: { extracted: [] },
      },
    });

    const app = makeApp();
    const uni = await universeSvc.createUniverse({ name: 'U' });
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: uni.id });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    // 250K chars — exceeds the 200K extract cap (well under STAGE_OUTPUT_MAX=400K).
    const oversized = 'PANEL DESCRIPTION. '.repeat(14_000);
    expect(oversized.length).toBeGreaterThan(200_000);
    await request(app).patch(`/api/pipeline/issues/${iss.body.id}`).send({
      stages: { comicScript: { status: 'ready', output: oversized } },
    });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/comicScript/extract-canon`)
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.truncated).toBe(true);
    // Service receives a clamped corpus, not the full 250K input.
    expect(spy.mock.calls[0][1].corpus.length).toBe(200_000);
    spy.mockRestore();
  });

  it('POST /issues/:id/stages/teleplay/extract-canon reads the teleplay stage output', async () => {
    const canonSvc = await import('../services/universeCanon.js');
    const spy = vi.spyOn(canonSvc, 'extractCanonFromProse').mockResolvedValue({
      universe: { id: 'u-mock', characters: [], places: [], objects: [] },
      results: {
        characters: { extracted: [{ name: 'Hostess' }, { name: 'Bouncer' }] },
        places: { extracted: [{ name: 'The Velvet Room' }] },
        objects: { extracted: [] },
      },
    });

    const app = makeApp();
    const uni = await universeSvc.createUniverse({ name: 'U' });
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: uni.id });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    await request(app).patch(`/api/pipeline/issues/${iss.body.id}`).send({
      stages: {
        teleplay: { status: 'ready', output: 'INT. VELVET ROOM - NIGHT\n\nHOSTESS greets the BOUNCER at the door.' },
      },
    });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/teleplay/extract-canon`)
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.sourceStage).toBe('teleplay');
    expect(r.body.extracted).toEqual({ characters: 2, places: 1, objects: 0 });
    expect(spy.mock.calls[0][1].corpus).toContain('VELVET ROOM');
    spy.mockRestore();
  });

  // ---- comicPages/pages/:pageIndex/render ----

  it('POST /issues/:id/stages/comicPages/pages/:pageIndex/render 400s for a non-integer pageIndex', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/comicPages/pages/abc/render`)
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.code || r.body.error).toMatch(/PIPELINE_COMIC_PAGE_BAD_INDEX|integer/i);
  });

  it('POST /issues/:id/stages/comicPages/pages/:pageIndex/render persists imageJobId + prompt onto the target page', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
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
    // No explicit target → defaults to proof (per the route schema).
    // The render lands on pages[1].proofImage, not the legacy imageJobId slot.
    expect(r.body.stage.pages[1].proofImage.jobId).toBe(r.body.jobId);
    expect(r.body.stage.pages[1].proofImage.prompt).toBe(r.body.prompt);
    expect(r.body.stage.pages[1].proofImage.filename).toBeNull();
    // Other page untouched — has no slot record either.
    expect(r.body.stage.pages[0].proofImage).toBeFalsy();
    expect(r.body.stage.status).toBe('edited');
  });

  it('POST /issues/:id/stages/comicPages/pages/:pageIndex/render 404s when pageIndex is out of range', async () => {
    // The service throws on out-of-range pageIndex; the route validates the
    // page exists up front and returns 404 instead of letting the service
    // bubble a generic Error.
    const visualStages = await import('../services/pipeline/visualStages.js');
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
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

  // ---- comicPages/cover/render ----

  it('POST /issues/:id/stages/comicPages/cover/render returns jobId + prompt and persists cover on the issue', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/comicPages/cover/render`)
      .send({ coverScript: 'Hero stands atop the foundry, smoke rising' });
    expect(r.status).toBe(200);
    expect(r.body.jobId).toMatch(/^cover-job-/);
    expect(r.body.prompt).toBe('cover art prompt');
    // Persistence: cover carries the user's script + the proof slot
    // record. No `target` in the request → defaults to 'proof' per schema.
    expect(r.body.cover.script).toBe('Hero stands atop the foundry, smoke rising');
    expect(r.body.cover.proofImage.jobId).toBe(r.body.jobId);
    expect(r.body.cover.proofImage.prompt).toBe(r.body.prompt);
    expect(r.body.cover.proofImage.filename).toBeNull();
    // Top-level issue + stage are also returned.
    expect(r.body.issue.id).toBe(iss.body.id);
    expect(r.body.stage.cover.proofImage.jobId).toBe(r.body.jobId);
  });

  it('POST /issues/:id/stages/comicPages/cover/render 404s for an unknown issue', async () => {
    const app = makeApp();
    const r = await request(app)
      .post('/api/pipeline/issues/iss-nope/stages/comicPages/cover/render')
      .send({});
    expect(r.status).toBe(404);
  });

  it('POST /issues/:id/stages/comicPages/cover/render 400s when the body fails schema validation', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    // `width` must be an integer; sending a string triggers Zod validation failure.
    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/comicPages/cover/render`)
      .send({ width: 'not-a-number' });
    expect(r.status).toBe(400);
  });

  // ---- proof/final target + useProofAsBase semantics ----
  // The render schemas (comicCoverRenderSchema + comicPageRenderSchema) carry a
  // `target` enum ('proof'|'final', default 'proof') and `useProofAsBase`
  // boolean. The route uses `slotKeyForVariant(result.variant)` to land the
  // in-flight job on the matching slot (proofImage vs finalImage) and stamps
  // `fromProof` on final-slot records so the UI can show "(upscaled from
  // proof)" provenance.

  it('POST /issues/:id/stages/comicPages/cover/render target=final + useProofAsBase=true persists onto finalImage with fromProof:true, leaving the prior proof slot untouched', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    // Seed a prior proof via the render route (the PATCH /issues schema strips
    // unknown cover fields, so proofImage can only land here via render).
    const proof = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/comicPages/cover/render`)
      .send({ coverScript: 'Hero stands atop the foundry' });
    expect(proof.status).toBe(200);
    const priorProofJobId = proof.body.cover.proofImage.jobId;

    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/comicPages/cover/render`)
      .send({ target: 'final', useProofAsBase: true });
    expect(r.status).toBe(200);
    expect(r.body.cover.finalImage.jobId).toBe(r.body.jobId);
    expect(r.body.cover.finalImage.filename).toBeNull();
    expect(r.body.cover.finalImage.fromProof).toBe(true);
    // sanitizeRenderSlot only stamps fromProof on the final slot — proof
    // records omit the field. Assert absence so a future schema regression
    // that leaks fromProof onto proof slots fails loud.
    expect(r.body.cover.proofImage.jobId).toBe(priorProofJobId);
    expect(r.body.cover.proofImage).not.toHaveProperty('fromProof');
  });

  it('POST /issues/:id/stages/comicPages/pages/:pageIndex/render target=final + useProofAsBase=true persists onto pages[i].finalImage with fromProof:true, leaving the prior proof slot untouched', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    await request(app).patch(`/api/pipeline/issues/${iss.body.id}`).send({
      stages: {
        comicPages: {
          pages: [{ panels: [{ description: 'p1', caption: '', dialogue: [], sfx: '' }] }],
        },
      },
    });
    // Seed a prior proof via the render route (default target = 'proof').
    const proof = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/comicPages/pages/0/render`)
      .send({});
    expect(proof.status).toBe(200);
    const priorProofJobId = proof.body.stage.pages[0].proofImage.jobId;

    const r = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/comicPages/pages/0/render`)
      .send({ target: 'final', useProofAsBase: true });
    expect(r.status).toBe(200);
    expect(r.body.stage.pages[0].finalImage.jobId).toBe(r.body.jobId);
    expect(r.body.stage.pages[0].finalImage.filename).toBeNull();
    expect(r.body.stage.pages[0].finalImage.fromProof).toBe(true);
    expect(r.body.stage.pages[0].proofImage.jobId).toBe(priorProofJobId);
    expect(r.body.stage.pages[0].proofImage).not.toHaveProperty('fromProof');
  });

  it('POST page+cover render schemas reject invalid `target` enum values with 400', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    // Zod enum on comicPageRenderSchema rejects before the service dispatches,
    // so no pages-seeding is needed — validation happens on body parse.
    const pageRes = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/comicPages/pages/0/render`)
      .send({ target: 'bogus' });
    expect(pageRes.status).toBe(400);
    const coverRes = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/comicPages/cover/render`)
      .send({ target: 'bogus' });
    expect(coverRes.status).toBe(400);
  });

  // ---- cover-script write semantics ----
  // The four cover render routes only write `script` when the request body
  // actually carried the script field. Blur-save owns the field; the render
  // route races against it, so writing the *resolved* value (which falls back
  // to the persisted record's script when absent) would clobber a concurrent
  // blur. Distinguish absent (preserve) from empty string (intentional clear).

  it('POST /issues/:id/stages/comicPages/cover/render preserves persisted cover.script when body omits coverScript', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    // Seed the script via a first render carrying it.
    const first = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/comicPages/cover/render`)
      .send({ coverScript: 'Hero stands atop the foundry' });
    expect(first.status).toBe(200);
    expect(first.body.cover.script).toBe('Hero stands atop the foundry');
    // Second render omits coverScript — the script must NOT be overwritten
    // with the service's fallback ('default cover concept' in the mock).
    const second = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/comicPages/cover/render`)
      .send({ target: 'final', useProofAsBase: true });
    expect(second.status).toBe(200);
    expect(second.body.cover.script).toBe('Hero stands atop the foundry');
  });

  it('POST /issues/:id/stages/comicPages/cover/render clears cover.script when body carries empty string', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/comicPages/cover/render`)
      .send({ coverScript: 'Hero stands atop the foundry' });
    // Explicit empty string is an intentional clear — distinct from absent.
    const cleared = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/comicPages/cover/render`)
      .send({ coverScript: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.cover.script).toBe('');
  });

  it('POST /issues/:id/stages/comicPages/back-cover/render preserves persisted backCover.script when body omits backCoverScript', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    const first = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/comicPages/back-cover/render`)
      .send({ backCoverScript: 'Quiet rain over the empty market' });
    expect(first.status).toBe(200);
    expect(first.body.backCover.script).toBe('Quiet rain over the empty market');
    const second = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/comicPages/back-cover/render`)
      .send({ target: 'final', useProofAsBase: true });
    expect(second.status).toBe(200);
    expect(second.body.backCover.script).toBe('Quiet rain over the empty market');
    // Explicit empty string clears — distinct from absent.
    const cleared = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/stages/comicPages/back-cover/render`)
      .send({ backCoverScript: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.backCover.script).toBe('');
  });

  it('POST /series/:id/seasons/:seasonId/cover/render preserves persisted cover.script when body omits coverScript', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const sea = await request(app).post(`/api/pipeline/series/${ser.body.id}/seasons`).send({ title: 'Vol 1' });
    const first = await request(app)
      .post(`/api/pipeline/series/${ser.body.id}/seasons/${sea.body.id}/cover/render`)
      .send({ coverScript: 'Collected arc hero shot' });
    expect(first.status).toBe(200);
    expect(first.body.season.cover.script).toBe('Collected arc hero shot');
    const second = await request(app)
      .post(`/api/pipeline/series/${ser.body.id}/seasons/${sea.body.id}/cover/render`)
      .send({ target: 'final', useProofAsBase: true });
    expect(second.status).toBe(200);
    expect(second.body.season.cover.script).toBe('Collected arc hero shot');
    const cleared = await request(app)
      .post(`/api/pipeline/series/${ser.body.id}/seasons/${sea.body.id}/cover/render`)
      .send({ coverScript: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.season.cover.script).toBe('');
  });

  it('POST /series/:id/seasons/:seasonId/back-cover/render preserves persisted backCover.script when body omits backCoverScript', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const sea = await request(app).post(`/api/pipeline/series/${ser.body.id}/seasons`).send({ title: 'Vol 1' });
    const first = await request(app)
      .post(`/api/pipeline/series/${ser.body.id}/seasons/${sea.body.id}/back-cover/render`)
      .send({ backCoverScript: 'Atmospheric companion image' });
    expect(first.status).toBe(200);
    expect(first.body.season.backCover.script).toBe('Atmospheric companion image');
    const second = await request(app)
      .post(`/api/pipeline/series/${ser.body.id}/seasons/${sea.body.id}/back-cover/render`)
      .send({ target: 'final', useProofAsBase: true });
    expect(second.status).toBe(200);
    expect(second.body.season.backCover.script).toBe('Atmospheric companion image');
    const cleared = await request(app)
      .post(`/api/pipeline/series/${ser.body.id}/seasons/${sea.body.id}/back-cover/render`)
      .send({ backCoverScript: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.season.backCover.script).toBe('');
  });

  // -----------------------
  // Season routes (Phase 2 of Story Arc Planning)
  // -----------------------

  it('GET /series/:id/seasons returns [] for a fresh series', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
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
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const r1 = await request(app).post(`/api/pipeline/series/${ser.body.id}/seasons`).send({ title: 'Pilot' });
    expect(r1.status).toBe(201);
    expect(r1.body.id).toMatch(/^sea-/);
    expect(r1.body.number).toBe(1);
    const r2 = await request(app).post(`/api/pipeline/series/${ser.body.id}/seasons`).send({ title: 'Aftermath' });
    expect(r2.body.number).toBe(2);
  });

  it('POST /series/:id/seasons rejects entry with neither title nor number', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const r = await request(app).post(`/api/pipeline/series/${ser.body.id}/seasons`).send({});
    expect(r.status).toBe(400);
  });

  it('PATCH /series/:id/seasons/:seasonId updates fields', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
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
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const r = await request(app)
      .patch(`/api/pipeline/series/${ser.body.id}/seasons/sea-nope`)
      .send({ title: 'x' });
    expect(r.status).toBe(404);
  });

  it('DELETE /series/:id/seasons/:seasonId un-groups child issues by default', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
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
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
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
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const sea = await request(app).post(`/api/pipeline/series/${ser.body.id}/seasons`).send({ title: 'Pilot' });
    const r = await request(app).delete(`/api/pipeline/series/${ser.body.id}/seasons/${sea.body.id}`)
      .send({ reassignTo: 'sea-ghost' });
    expect(r.status).toBe(400);
  });

  it('PATCH /issues/:id accepts seasonId + arcPosition', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const sea = await request(app).post(`/api/pipeline/series/${ser.body.id}/seasons`).send({ title: 'Pilot' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'Ep 1' });
    const r = await request(app).patch(`/api/pipeline/issues/${iss.body.id}`)
      .send({ seasonId: sea.body.id, arcPosition: 3 });
    expect(r.status).toBe(200);
    expect(r.body.seasonId).toBe(sea.body.id);
    expect(r.body.arcPosition).toBe(3);
  });

  it('PATCH /issues/:id preserves per-stage locked flags through validation', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'Ep 1' });
    const r = await request(app).patch(`/api/pipeline/issues/${iss.body.id}`)
      .send({ stages: { idea: { locked: true } } });
    expect(r.status).toBe(200);
    expect(r.body.stages.idea.locked).toBe(true);
    expect(r.body.stages.idea.status).toBe('empty');
  });

  it('PATCH /series/:id accepts arc payload', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
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

  it('PATCH /series/:id/arc-fields/:field/lock merges a single arc field lock', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({
      name: 'S',
      universeId: 'u-test',
      locked: { arcFields: { logline: true } },
    });
    const r = await request(app)
      .patch(`/api/pipeline/series/${ser.body.id}/arc-fields/themes/lock`)
      .send({ locked: true });
    expect(r.status).toBe(200);
    expect(r.body.locked.arcFields).toEqual({ logline: true, themes: true });
  });

  // -----------------------
  // Arc planning routes (Phase 3 of Story Arc Planning)
  // -----------------------

  it('POST /series/:id/arc/generate returns preview without committing by default', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'Salt Run', universeId: 'u-test' });
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
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'Salt Run', universeId: 'u-test' });
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
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
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
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const sea = await request(app).post(`/api/pipeline/series/${ser.body.id}/seasons`).send({
      title: 'Pilot', synopsis: 'season synopsis',
    });
    seasonEpisodesSpy = vi.fn(async () => ({
      season: sea.body,
      episodes: [
        { number: 1, title: 'Ep 1', logline: 'L1', synopsis: 'Pilot synopsis', primaryCharacters: ['LINA'], arcRole: 'pilot', lengthProfile: 'extended' },
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
    // Non-default lengthProfile must be forwarded from the episode into the created issue.
    expect(r.body.createdIssues[0].lengthProfile).toBe('extended');
    expect(r.body.createdIssues[1].arcPosition).toBe(2);

    const issues = await request(app).get(`/api/pipeline/series/${ser.body.id}/issues`);
    expect(issues.body.map((i) => i.title)).toEqual(['Ep 1', 'Ep 2']);
  });

  it('POST /series/:id/arc/verify forwards to the planner and returns issues', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
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

  it('POST /series/:id/seasons/:seasonId/verify forwards to the volume verifier', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    volumeVerifySpy = vi.fn(async (_seriesId, seasonId) => ({
      issues: [
        { severity: 'medium', location: 'episode:3', problem: 'beats plateau', suggestion: 'escalate ep 3' },
      ],
      runId: 'rv', providerId: 'p', model: 'm', seasonId,
    }));
    const r = await request(app)
      .post(`/api/pipeline/series/${ser.body.id}/seasons/sea-fake/verify`)
      .send({ providerOverride: 'anthropic' });
    expect(r.status).toBe(200);
    expect(r.body.issues).toHaveLength(1);
    expect(r.body.issues[0].location).toBe('episode:3');
    expect(volumeVerifySpy).toHaveBeenCalledWith(ser.body.id, 'sea-fake', expect.objectContaining({ providerOverride: 'anthropic' }));
  });

  describe('audio stage routes', () => {
    async function seedIssueWithStoryboards(app) {
      const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
      const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
      await request(app).patch(`/api/pipeline/issues/${iss.body.id}`).send({
        stages: {
          storyboards: {
            scenes: [{
              slugline: 'INT. KITCHEN — NIGHT',
              dialogue: [
                { character: 'JEAN', line: 'I told you he was coming.' },
                { character: 'DON CARLOS', line: 'Quiet now.' },
              ],
            }],
          },
        },
      });
      return iss.body;
    }

    it('POST /audio/extract-lines populates lines[] from storyboards dialogue', async () => {
      const app = makeApp();
      const iss = await seedIssueWithStoryboards(app);
      const r = await request(app)
        .post(`/api/pipeline/issues/${iss.id}/stages/audio/extract-lines`)
        .send({});
      expect(r.status).toBe(200);
      expect(r.body.lineCount).toBe(2);
      expect(r.body.stage.lines).toHaveLength(2);
      expect(r.body.stage.lines[0].text).toMatch(/coming/);
    });

    it('POST /audio/extract-lines 409s on second call without force:true', async () => {
      const app = makeApp();
      const iss = await seedIssueWithStoryboards(app);
      await request(app).post(`/api/pipeline/issues/${iss.id}/stages/audio/extract-lines`).send({});
      const r = await request(app)
        .post(`/api/pipeline/issues/${iss.id}/stages/audio/extract-lines`)
        .send({});
      expect(r.status).toBe(409);
    });

    it('POST /audio/extract-lines with force:true replaces existing lines', async () => {
      const app = makeApp();
      const iss = await seedIssueWithStoryboards(app);
      await request(app).post(`/api/pipeline/issues/${iss.id}/stages/audio/extract-lines`).send({});
      const r = await request(app)
        .post(`/api/pipeline/issues/${iss.id}/stages/audio/extract-lines`)
        .send({ force: true });
      expect(r.status).toBe(200);
      expect(r.body.lineCount).toBe(2);
    });

    it('POST /audio/lines/:idx/render persists audioFilename on the matching line', async () => {
      const app = makeApp();
      const iss = await seedIssueWithStoryboards(app);
      await request(app).post(`/api/pipeline/issues/${iss.id}/stages/audio/extract-lines`).send({});
      const r = await request(app)
        .post(`/api/pipeline/issues/${iss.id}/stages/audio/lines/0/render`)
        .send({});
      expect(r.status).toBe(200);
      expect(r.body.filename).toMatch(/^vo-mock-/);
      expect(r.body.lineIdx).toBe(0);
      expect(r.body.engine).toBe('kokoro');
      // Refetch the issue and confirm the audio filename landed.
      const issAfter = await request(app).get(`/api/pipeline/issues/${iss.id}`);
      expect(issAfter.body.stages.audio.lines[0].audioFilename).toMatch(/^vo-mock-/);
    });

    it('POST /audio/lines/:idx/render 404s for out-of-range index', async () => {
      const app = makeApp();
      const iss = await seedIssueWithStoryboards(app);
      await request(app).post(`/api/pipeline/issues/${iss.id}/stages/audio/extract-lines`).send({});
      const r = await request(app)
        .post(`/api/pipeline/issues/${iss.id}/stages/audio/lines/99/render`)
        .send({});
      expect(r.status).toBe(404);
    });

    it('POST /audio/lines/:idx/render 400s for non-integer index', async () => {
      const app = makeApp();
      const iss = await seedIssueWithStoryboards(app);
      const r = await request(app)
        .post(`/api/pipeline/issues/${iss.id}/stages/audio/lines/nope/render`)
        .send({});
      expect(r.status).toBe(400);
    });
  });

  describe('music library routes', () => {
    beforeEach(() => {
      musicLibraryStore.clear();
      lastImportedName = null;
    });

    async function seedIssue(app) {
      const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
      const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
      return iss.body;
    }

    it('GET /audio/music-library returns the current track list', async () => {
      const app = makeApp();
      musicLibraryStore.set('music-1.mp3', { filename: 'music-1.mp3', label: 'theme', sizeBytes: 100, updatedAt: '2026-05-15T00:00:00.000Z' });
      const r = await request(app).get('/api/pipeline/audio/music-library');
      expect(r.status).toBe(200);
      expect(r.body.tracks).toHaveLength(1);
      expect(r.body.tracks[0].filename).toBe('music-1.mp3');
    });

    it('POST /audio/music/upload imports the file and attaches it to the issue', async () => {
      const app = makeApp();
      const iss = await seedIssue(app);
      const r = await request(app)
        .post(`/api/pipeline/issues/${iss.id}/stages/audio/music/upload`)
        // The mock multipart parser pulls req.file out of req.body._mockFile so
        // this test can sidestep the real streaming parser without losing the
        // route's req.file contract.
        .send({ _mockFile: { path: '/tmp/uploaded.mp3', originalname: 'My Theme.mp3', mimetype: 'audio/mpeg', size: 11 } });
      expect(r.status).toBe(200);
      expect(r.body.music.source).toBe('upload');
      expect(r.body.music.trackFilename).toMatch(/^music-uuid-/);
      // Persisted on the issue
      const after = await request(app).get(`/api/pipeline/issues/${iss.id}`);
      expect(after.body.stages.audio.music.trackFilename).toBe(r.body.music.trackFilename);
      expect(lastImportedName).toBe('My Theme.mp3');
    });

    it('POST /audio/music/upload 400s when no file is uploaded', async () => {
      const app = makeApp();
      const iss = await seedIssue(app);
      const r = await request(app)
        .post(`/api/pipeline/issues/${iss.id}/stages/audio/music/upload`)
        .send({});
      expect(r.status).toBe(400);
    });

    it('POST /audio/music/attach attaches an existing library track', async () => {
      const app = makeApp();
      const iss = await seedIssue(app);
      musicLibraryStore.set('shared.mp3', { filename: 'shared.mp3', label: 'shared', sizeBytes: 100, updatedAt: '2026-05-15T00:00:00.000Z' });
      const r = await request(app)
        .post(`/api/pipeline/issues/${iss.id}/stages/audio/music/attach`)
        .send({ trackFilename: 'shared.mp3', label: 'Library pick' });
      expect(r.status).toBe(200);
      expect(r.body.music.source).toBe('library');
      expect(r.body.music.trackFilename).toBe('shared.mp3');
      expect(r.body.music.label).toBe('Library pick');
    });

    it('POST /audio/music/attach 404s when the track is not in the library', async () => {
      const app = makeApp();
      const iss = await seedIssue(app);
      const r = await request(app)
        .post(`/api/pipeline/issues/${iss.id}/stages/audio/music/attach`)
        .send({ trackFilename: 'ghost.mp3' });
      expect(r.status).toBe(404);
    });

    it('POST /audio/music/attach 400s on path-traversal filenames', async () => {
      const app = makeApp();
      const iss = await seedIssue(app);
      const r = await request(app)
        .post(`/api/pipeline/issues/${iss.id}/stages/audio/music/attach`)
        .send({ trackFilename: '../etc/passwd' });
      expect(r.status).toBe(400);
    });

    it('POST /audio/music/attach 404s with PIPELINE_ISSUE_NOT_FOUND when the issue does not exist', async () => {
      const app = makeApp();
      musicLibraryStore.set('shared.mp3', { filename: 'shared.mp3', label: 'shared', sizeBytes: 100, updatedAt: '2026-05-15T00:00:00.000Z' });
      const r = await request(app)
        .post('/api/pipeline/issues/iss-does-not-exist/stages/audio/music/attach')
        .send({ trackFilename: 'shared.mp3' });
      expect(r.status).toBe(404);
      // Pin both status AND code — the precheck-removal equivalence depends
      // on `updateStageWithLatest` preserving the same error shape the dropped
      // `getIssue` precheck would have raised.
      expect(r.body.code).toBe('PIPELINE_ISSUE_NOT_FOUND');
    });

    it('DELETE /audio/music clears music from the issue without deleting the library entry', async () => {
      const app = makeApp();
      const iss = await seedIssue(app);
      musicLibraryStore.set('shared.mp3', { filename: 'shared.mp3', label: 'shared', sizeBytes: 100, updatedAt: '2026-05-15T00:00:00.000Z' });
      await request(app)
        .post(`/api/pipeline/issues/${iss.id}/stages/audio/music/attach`)
        .send({ trackFilename: 'shared.mp3' });
      const r = await request(app)
        .delete(`/api/pipeline/issues/${iss.id}/stages/audio/music`)
        .send();
      expect(r.status).toBe(200);
      expect(r.body.stage.music).toBeNull();
      // Library entry survives the issue detach
      expect(musicLibraryStore.has('shared.mp3')).toBe(true);
    });

    it('DELETE /audio/music 404s with PIPELINE_ISSUE_NOT_FOUND when the issue does not exist', async () => {
      const app = makeApp();
      const r = await request(app)
        .delete('/api/pipeline/issues/iss-does-not-exist/stages/audio/music')
        .send();
      expect(r.status).toBe(404);
      expect(r.body.code).toBe('PIPELINE_ISSUE_NOT_FOUND');
    });

    it('DELETE /audio/music-library/:filename removes the file from the library', async () => {
      const app = makeApp();
      musicLibraryStore.set('doomed.mp3', { filename: 'doomed.mp3', label: 'doomed', sizeBytes: 1, updatedAt: '2026-05-15T00:00:00.000Z' });
      const r = await request(app)
        .delete('/api/pipeline/audio/music-library/doomed.mp3')
        .send();
      expect(r.status).toBe(200);
      expect(r.body.deleted).toBe(true);
      expect(musicLibraryStore.has('doomed.mp3')).toBe(false);
    });

    it('DELETE /audio/music-library/:filename returns deleted:false when the file is already gone', async () => {
      const app = makeApp();
      const r = await request(app)
        .delete('/api/pipeline/audio/music-library/ghost.mp3')
        .send();
      expect(r.status).toBe(200);
      expect(r.body.deleted).toBe(false);
    });
  });
});

describe('editorial roadmap routes', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    vi.clearAllMocks();
  });

  it('GET /series/:id/editorial returns 404 for an unknown series', async () => {
    const r = await request(makeApp()).get('/api/pipeline/series/ser-nope/editorial');
    expect(r.status).toBe(404);
    expect(getSeriesEditorialMock).not.toHaveBeenCalled();
  });

  it('GET /series/:id/editorial dispatches the aggregate for a known series', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const r = await request(app).get(`/api/pipeline/series/${ser.body.id}/editorial`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('coverage');
    expect(getSeriesEditorialMock).toHaveBeenCalledWith(ser.body.id);
  });

  it('POST /issues/:id/editorial/analyze validates body and dispatches', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });

    const bad = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/editorial/analyze`)
      .send({ force: 'yes' });
    expect(bad.status).toBe(400);

    const ok = await request(app)
      .post(`/api/pipeline/issues/${iss.body.id}/editorial/analyze`)
      .send({ force: true });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('complete');
    expect(analyzeIssueMock).toHaveBeenCalledWith(iss.body.id, { force: true });
  });

  it('POST /issues/:id/editorial/analyze returns 404 for an unknown issue', async () => {
    const r = await request(makeApp())
      .post('/api/pipeline/issues/iss-nope/editorial/analyze')
      .send({});
    expect(r.status).toBe(404);
    expect(analyzeIssueMock).not.toHaveBeenCalled();
  });

  it('POST /series/:id/editorial/analyze returns runId + sseUrl', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const r = await request(app).post(`/api/pipeline/series/${ser.body.id}/editorial/analyze`).send({});
    expect(r.status).toBe(200);
    expect(r.body.runId).toBe('ed-run-1');
    expect(r.body.sseUrl).toBe(`/api/pipeline/series/${ser.body.id}/editorial/analyze/progress`);
    expect(startSeriesAnalysisMock).toHaveBeenCalled();
  });

  it('GET /issues/:id/editorial returns a none-status stub when never analyzed', async () => {
    const app = makeApp();
    const ser = await request(app).post('/api/pipeline/series').send({ name: 'S', universeId: 'u-test' });
    const iss = await request(app).post(`/api/pipeline/series/${ser.body.id}/issues`).send({ title: 'I' });
    const r = await request(app).get(`/api/pipeline/issues/${iss.body.id}/editorial`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('none');
  });
});
