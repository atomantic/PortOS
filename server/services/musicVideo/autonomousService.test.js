// Existing engine cases isolate the creative review boundary; explicit approval-flow
// cases below switch to the real model and verify pause/resume without providers.
const creativeReview = vi.hoisted(() => ({ real: false, readiness: {} }));
vi.mock('./productionReview.js', async (load) => {
  const actual = await load();
  return { ...actual,
    assertProductionApproval: (...args) => creativeReview.real ? actual.assertProductionApproval(...args) : undefined,
    productionReadiness: (...args) => creativeReview.real ? actual.productionReadiness(...args) : {
      art: { approved: true }, storyboard: { approved: true }, proof: { approved: true }, basis: { proof: 'test-proof' }, readyForProduction: true,
      alignment: { status: 'verified' }, ...creativeReview.readiness,
    },
  };
});
// Footage needs image-to-video: one fake model is text-only, every other id is not installed.
vi.mock('./productionPool.js', async (load) => ({
  ...(await load()),
  loadPoolEnv: async () => ({
    resolveVideoModel: async (id) => ({ modelId: id, model: id === 'example-text-only' ? { id, name: 'Example Text Model', supportedModes: ['text'] } : null }),
  }),
}));
vi.mock('./productionReviewService.js', () => ({
  prepareProductionReview: vi.fn(async () => {}),
  renderProductionProof: vi.fn(async () => ({ jobId: 'proof-example' })),
  attachProductionPilotProof: vi.fn(async () => {}),
}));
/**
 * Fully-autonomous Music Video run — orchestration contract. The project store
 * is an in-memory double with the real store's serialized read-modify-write;
 * every stage's provider (LLM, mood board, Suno, track store, production) is a
 * double, so these tests pin what the run owns: stage order and persistence,
 * checkpoints, failure parking and retry, and the hand-off to production.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const store = new Map();
let writeTail = Promise.resolve();
const clone = (v) => JSON.parse(JSON.stringify(v));
vi.mock('./projects.js', () => {
  return {
    getProject: async (id) => (store.has(id) ? clone(store.get(id)) : null),
    mutateProjectRecord: (id, transform) => {
      const run = writeTail.then(() => {
        if (!store.has(id)) throw Object.assign(new Error('Project not found'), { status: 404 });
        const current = clone(store.get(id));
        const out = transform(current);
        store.set(id, clone(out.project));
        return { ...out, project: clone(out.project) };
      });
      writeTail = run.catch(() => {});
      return run;
    },
  };
});

const { musicVideoEvents } = await import('./events.js');
const service = await import('./autonomousService.js');

const BRIEF = {
  title: 'Neon Rain',
  musicalDescription: 'Synthwave with a melancholic arc',
  sunoStyle: 'synthwave, dreamy, 100 bpm',
  concept: { prompt: 'A courier crosses a rainy city at night', style: 'neon noir' },
  moodBoard: { name: 'Neon Rain', description: 'wet streets', notes: ['teal and magenta'], stylePrompt: 'neon noir', negativePrompt: 'daylight' },
};

let calls;
let doubles;
const stub = (name, impl) => vi.fn(async (...args) => { calls.push(name); return impl(...args); });

beforeEach(() => {
  creativeReview.real = false;
  creativeReview.readiness = {};
  store.clear();
  calls = [];
  doubles = {
    localVideoTakesSongAudio: vi.fn(async () => false),
    createProject: stub('createProject', async (input) => {
      const project = { id: 'mv-auto', productionReview: { proof: { basis: 'test-proof', excerptId: 'test-proof' } }, excerpts: [{ id: 'test-proof', status: 'complete', filename: 'test-proof.mp4' }], ...input };
      store.set(project.id, clone(project));
      return project;
    }),
    updateProject: stub('updateProject', async (id, patch) => {
      const next = { ...store.get(id), ...patch };
      store.set(id, clone(next));
      return next;
    }),
    // Registry doubles: no provider configured → llmOf falls back to the run's own pin.
    resolveLlm: vi.fn(async () => ({ provider: null, selectedModel: null, route: null })),
    draftCreativeBrief: stub('brief', async () => ({ brief: BRIEF })),
    writeLyrics: stub('lyrics', async () => ({ lyrics: '[verse]\nrain on glass' })),
    createMoodBoard: stub('board', async () => ({ id: 'board-1' })),
    generateSunoSong: stub('suno', async (_fields, opts) => {
      await opts.onSubmitted(['song-a', 'song-b']);
      return { songId: 'song-a', songIds: ['song-a', 'song-b'], filename: 'music-song-a.mp3' };
    }),
    // The song checkpoint's submit-only path: renders are made, nothing is downloaded.
    submitSunoSong: stub('suno-submit', async (_fields, opts) => {
      await opts.onSubmitted(['song-a', 'song-b']);
      return ['song-a', 'song-b'];
    }),
    generateLocalSong: stub('local', async ({ trackId, onSubmitted }) => {
      await onSubmitted('job-local');
      return { trackId, filename: 'song.wav', jobId: 'job-local' };
    }),
    cancelLocalSong: stub('cancel-local', async () => true),
    createTrack: stub('track', async () => ({ id: 'track-1' })),
    attachAudio: stub('attach', async () => ({})),
    probeDuration: stub('probe', async () => 187),
    analyzeSong: stub('analyze', async () => ({})),
    designCoverArt: vi.fn(async () => ({})),
    startProduction: stub('production', async () => ({ run: { id: 'mvpr-1' } })),
    resumeProduction: stub('resume-production', async () => ({})),
    stopProduction: stub('stop-production', async () => ({})),
    cancelProduction: stub('cancel-production', async () => ({})),
    generateCode: stub('code', async () => ({})),
    generateDocument: stub('document', async () => ({ document: { directory: 'music-video/mv-auto/composition/example' } })),
    acceptDocument: stub('accept-document', async (id, directory) => { store.get(id).composition.document = { directory }; return {}; }),
    renderVideo: stub('render', async () => ({ jobId: 'render-1' })),
    // The overlay text pass before a final render: clean unless a test says otherwise.
    checkOverlayText: stub('text-check', async () => ({ status: 'complete', samples: 12, textSamples: 8, findings: [] })),
    // The render job stays live until a test settles it with a `render` event.
    activeRenderJobId: vi.fn(async () => 'render-1'),
    cancelRender: vi.fn(async () => true),
    resumeInterruptedCastAndSets: vi.fn(async () => false),
  };
  service.__setAutonomousDepsForTests(doubles);
});

const runOf = (id = 'mv-auto') => store.get(id)?.autonomousRun;
const settled = (status) => vi.waitFor(() => expect(runOf()?.status).toBe(status));

describe('startAutonomousVideo', () => {
  it('creates an autonomous-mode project from the prompt alone and runs to the production hand-off', async () => {
    const { project, run } = await service.startAutonomousVideo({ prompt: 'a courier crosses a rainy city', tools: ['image:local', 'video:local'], models: { 'image:local': 'flux2-dev' } });
    expect(project.mode).toBe('autonomous');
    expect(project.automation).toMatchObject({ tools: ['image:local', 'video:local'], checkins: { castAndSets: 'auto' } });
    expect(run).toMatchObject({ status: 'running', stage: 'brief' });

    // Production is delegated, so the run stays "running" at the produce stage.
    await vi.waitFor(() => expect(calls).toContain('production'));
    expect(calls).toEqual(['createProject', 'brief', 'updateProject', 'lyrics', 'board', 'updateProject', 'suno', 'track', 'probe', 'attach', 'updateProject', 'analyze', 'production']);
    expect(runOf()).toMatchObject({ status: 'running', stage: 'produce' });
    expect(runOf().output).toMatchObject({ trackId: 'track-1', moodBoardId: 'board-1', productionRunId: 'mvpr-1', sunoSongIds: ['song-a', 'song-b'] });
    // The made song gets its own single cover design, ready in the publishing kit.
    expect(doubles.designCoverArt).toHaveBeenCalledWith('mv-auto', { providerId: null, model: null });
    expect(doubles.startProduction).toHaveBeenCalledWith('mv-auto', expect.objectContaining({
      pool: [{ kind: 'image', mode: 'local', model: 'flux2-dev' }, { kind: 'video', mode: 'local' }],
      limits: { maxGenerations: 40, maxReviewAttempts: 3 },
    }));
    // The song title renames the project; the track carries the prompt/lyrics Suno was given.
    expect(store.get('mv-auto').name).toBe('Neon Rain');
    expect(doubles.attachAudio).toHaveBeenCalledWith('track-1', 'music-song-a.mp3', expect.objectContaining({ source: 'suno', durationSec: 187 }));
  });

  it('names the imported Suno song on its track only after a backup cut is released (#9982)', async () => {
    const { acquireBackupSnapshotCut } = await import('../../lib/backupSnapshotBoundary.js');
    const release = await acquireBackupSnapshotCut();
    try {
      await service.startAutonomousVideo({ prompt: 'a courier crosses a rainy city' });
      await vi.waitFor(() => expect(calls).toContain('probe'));
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(doubles.attachAudio).not.toHaveBeenCalled();
      release();
      await vi.waitFor(() => expect(doubles.attachAudio).toHaveBeenCalledOnce());
    } finally {
      release();
    }
  });

  it.each([
    { mediaMode: 'code-images', explicit: true },
    { mediaMode: 'code-images-video', explicit: false },
  ])('passes the $mediaMode authoring pin through the real production preflight', async ({ mediaMode, explicit }) => {
    const { buildProjectRecord } = await import('./projectsLogic.js');
    const production = await import('./productionService.js');
    const runner = await import('../promptRunner.js');
    const authoring = { providerId: 'fixture-author', model: 'fixture-model', effort: 'high' };
    const resolve = vi.spyOn(runner, 'resolveProviderAndModel').mockResolvedValue({
      provider: { id: authoring.providerId, type: 'api', enabled: true }, selectedModel: authoring.model,
    });
    // Exercise actual authoring and pool validation against a synthetic image
    // backend. The absent approved plan stops the run before any dispatch.
    const isVideoModeUsable = vi.fn(() => false);
    const loadEnv = vi.fn(async () => {
      if (mediaMode === 'code-images') return { settings: { imageGen: { local: { pythonPath: '/opt/example/python' } } },
        imageModels: [{ id: 'fixture-image' }], isVideoModeUsable };
      throw Object.assign(new Error('Fixture stopped after authoring validation'), { code: 'FIXTURE_PREFLIGHT_COMPLETE' });
    });
    production.__setProductionDepsForTests({ loadEnv });
    doubles.createProject.mockImplementation(async (input) => {
      const project = buildProjectRecord(input, { id: 'mv-auto', now: '2026-01-01T00:00:00.000Z' });
      store.set(project.id, clone(project));
      return project;
    });
    doubles.startProduction.mockImplementation(production.startProduction);
    doubles.resolveLlm.mockResolvedValue({ route: authoring });
    try {
      await service.startAutonomousVideo({ prompt: 'An authored world', mediaMode, models: { 'image:local': 'fixture-image' }, ...(explicit ? { authoring } : {}) });
      await settled('failed');
      expect(store.get('mv-auto')).toMatchObject({ composition: { mode: 'document' }, productionPolicy: { strategy: 'code-first' } });
      expect(resolve).toHaveBeenCalledWith(authoring);
      expect(loadEnv).toHaveBeenCalledOnce();
      expect(runOf().errorCode).toBe(mediaMode === 'code-images' ? 'PRODUCTION_MEDIUM_CONFLICT' : 'FIXTURE_PREFLIGHT_COMPLETE');
      if (mediaMode === 'code-images') {
        expect(isVideoModeUsable).not.toHaveBeenCalled();
        expect(doubles.startProduction.mock.calls[0][1].pool).toEqual([{ kind: 'image', mode: 'local', model: 'fixture-image' }]);
        expect(runOf().brief.tools).toEqual(['image:local', 'video:local']);
      }
    } finally {
      resolve.mockRestore();
      production.__setProductionDepsForTests({});
    }
  });

  // Uniquely catches a footage project left in document mode with no document failing its final render.
  it('composes a footage project that has no composition document before its final render', async () => {
    await service.startAutonomousVideo({ prompt: 'p' });
    await vi.waitFor(() => expect(runOf()?.output.productionRunId).toBe('mvpr-1'));
    Object.assign(store.get('mv-auto'), { composition: { mode: 'document', textCues: [{ id: 'cue' }] }, productionPolicy: { strategy: 'legacy' } });
    doubles.renderVideo.mockImplementationOnce(async (id) => {
      expect(store.get(id).composition).toEqual({ mode: 'composed', textCues: [{ id: 'cue' }] });
      return { jobId: 'render-1' };
    });
    await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: { status: 'completed' } });
    expect(doubles.renderVideo).toHaveBeenCalledOnce();
    expect(runOf().output).toMatchObject({ renderJobId: 'render-1' });
  });

  // Uniquely catches a failed child stop being swallowed while the delegated production keeps spending.
  it.each([
    ['stopAutonomousVideo', 'stopProduction', 'stopped', 'stop production'],
    ['cancelAutonomousVideo', 'cancelProduction', 'canceled', 'cancel production'],
  ])('%s reports a child failure but ignores an already-closed child (409/404)', async (action, dep, status, kind) => {
    await service.startAutonomousVideo({ prompt: 'p' });
    await vi.waitFor(() => expect(runOf()?.output.productionRunId).toBe('mvpr-1'));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      doubles[dep].mockRejectedValueOnce(Object.assign(new Error("already closed"), { status: 409 }));
      const closed = await service[action]('mv-auto');
      expect(closed.childStopFailures).toEqual([]);
      expect(errorLog).not.toHaveBeenCalled();
      expect(runOf().status).toBe(status);

      store.get('mv-auto').autonomousRun.status = 'running';
      doubles[dep].mockRejectedValueOnce(new Error('store write failed'));
      const failed = await service[action]('mv-auto');
      expect(failed.childStopFailures).toEqual([{ kind, id: 'mvpr-1', error: 'store write failed' }]);
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining(`could not ${kind} mvpr-1: store write failed`));
      expect(errorLog.mock.calls[0][0]).toContain('project mv-auto');
      expect(runOf().status).toBe(status);
    } finally {
      errorLog.mockRestore();
    }
  });

  it('finishes — and starts the final render — when the delegated production run completes', async () => {
    await service.startAutonomousVideo({ prompt: 'p' });
    await vi.waitFor(() => expect(runOf()?.output.productionRunId).toBe('mvpr-1'));
    // An unrelated production run and a non-terminal event change nothing.
    await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'someone-else', run: { status: 'completed' } });
    await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: { status: 'running' } });
    expect(runOf().status).toBe('running');

    await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: { status: 'completed' } });
    // Production being done is not the run being done: it reads "Rendering final video" until the render settles.
    expect(runOf()).toMatchObject({ status: 'running', stage: 'produce', stages: { produce: { status: 'running', step: 'rendering' } }, output: expect.objectContaining({ renderJobId: 'render-1' }) });
    // A repeated completion event does not start a second render.
    await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: { status: 'completed' } });
    expect(doubles.renderVideo).toHaveBeenCalledOnce();
    // Another job's settlement is not ours.
    await service.__testing.onRenderEvent({ projectId: 'mv-auto', jobId: 'other', status: 'completed' });
    expect(runOf().status).toBe('running');

    await service.__testing.onRenderEvent({ projectId: 'mv-auto', jobId: 'render-1', status: 'completed' });
    expect(runOf()).toMatchObject({ status: 'completed', stages: { produce: { status: 'done', step: null } } });
  });

  it('adopts a code-first production run\'s own current final render instead of rendering it again (#10563)', async () => {
    const { captureMusicVideoEvidence } = await import('../../lib/musicVideoDependencies.js');
    const directory = 'music-video/mv-auto/composition/example';
    // Production rendered `rendered` itself; the project now selects `selected`.
    const seed = (selected) => {
      const project = store.get('mv-auto');
      project.composition = { ...project.composition, document: { directory } };
      project.productionRuns = [{ id: 'mvpr-1', status: 'completed', documentCheckpoint: { directory }, finalRender: { status: 'completed', jobId: 'production-render', attemptId: 'attempt-1' } }];
      project.renderHistoryId = 'production-render';
      project.renderDependencies = captureMusicVideoEvidence(project);
      project.composition.document = { directory: selected };
      project.autonomousRun.output = { ...project.autonomousRun.output, renderJobId: null, productionDone: false };
    };
    await service.startAutonomousVideo({ prompt: 'p' });
    await vi.waitFor(() => expect(runOf()?.output.productionRunId).toBe('mvpr-1'));

    // A render that no longer matches the selected document is not adopted: the film renders once.
    seed(`${directory}-newer`);
    await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: { status: 'completed' } });
    expect(doubles.renderVideo).toHaveBeenCalledOnce();
    expect(runOf()).toMatchObject({ status: 'running', output: expect.objectContaining({ renderJobId: 'render-1' }) });

    // The same completion with production's render still current finishes without rendering again.
    seed(directory);
    await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: { status: 'completed' } });
    expect(doubles.renderVideo).toHaveBeenCalledOnce();
    expect(runOf()).toMatchObject({ status: 'completed', output: expect.objectContaining({ renderJobId: 'production-render', productionDone: true }), stages: { produce: { status: 'done' } } });
  });

  it('parks failed when the final render fails after production, and Retry re-renders without resuming production', async () => {
    await service.startAutonomousVideo({ prompt: 'p' });
    await vi.waitFor(() => expect(runOf()?.output.productionRunId).toBe('mvpr-1'));
    await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: { status: 'completed' } });
    await service.__testing.onRenderEvent({ projectId: 'mv-auto', jobId: 'render-1', status: 'failed', error: 'ffmpeg exit 1' });
    expect(runOf()).toMatchObject({ status: 'failed', error: 'ffmpeg exit 1', errorCode: 'FINAL_RENDER_FAILED', stages: { produce: { status: 'failed' } } });

    doubles.renderVideo.mockResolvedValueOnce({ jobId: 'render-2' });
    doubles.activeRenderJobId.mockResolvedValue('render-2');
    await service.resumeAutonomousVideo('mv-auto');
    expect(doubles.renderVideo).toHaveBeenCalledTimes(2);
    expect(runOf()).toMatchObject({ status: 'running', error: null, output: expect.objectContaining({ renderJobId: 'render-2' }), stages: { produce: { step: 'rendering' } } });
    await service.__testing.onRenderEvent({ projectId: 'mv-auto', jobId: 'render-2', status: 'completed' });
    expect(runOf().status).toBe('completed');
  });

  it('fails the run when the final render cannot start after production, and Retry tries again', async () => {
    await service.startAutonomousVideo({ prompt: 'p' });
    await vi.waitFor(() => expect(runOf()?.output.productionRunId).toBe('mvpr-1'));
    doubles.renderVideo.mockRejectedValueOnce(Object.assign(new Error('no audio'), { code: 'NO_AUDIO' }));
    await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: { status: 'completed' } });
    expect(runOf()).toMatchObject({ status: 'failed', errorCode: 'NO_AUDIO', error: expect.stringContaining('did not start') });
    await service.resumeAutonomousVideo('mv-auto');
    expect(runOf()).toMatchObject({ status: 'running', output: expect.objectContaining({ renderJobId: 'render-1' }) });
  });

  it('settles from the project record when the render ended before its job id was stored', async () => {
    doubles.activeRenderJobId.mockResolvedValue(null);
    await service.startAutonomousVideo({ prompt: 'p' });
    await vi.waitFor(() => expect(runOf()?.output.productionRunId).toBe('mvpr-1'));
    store.get('mv-auto').renderHistoryId = 'render-1';
    await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: { status: 'completed' } });
    expect(runOf().status).toBe('completed');
  });

  it('after a restart during the final render: finishes if the MP4 landed, otherwise renders again', async () => {
    await service.startAutonomousVideo({ prompt: 'p' });
    await vi.waitFor(() => expect(runOf()?.output.productionRunId).toBe('mvpr-1'));
    await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: { status: 'completed' } });
    // The previous process died mid-render.
    store.get('mv-auto').autonomousRun.processId = 'proc-previous';
    doubles.activeRenderJobId.mockResolvedValue(null);
    store.get('mv-auto').renderHistoryId = 'render-1';
    await service.resumeAutonomousVideo('mv-auto');
    expect(doubles.renderVideo).toHaveBeenCalledOnce();
    expect(runOf().status).toBe('completed');

    // Same interruption, but the render never produced a file.
    store.get('mv-auto').autonomousRun = { ...runOf(), status: 'running', processId: 'proc-previous', stages: { ...runOf().stages, produce: { ...runOf().stages.produce, status: 'running' } } };
    delete store.get('mv-auto').renderHistoryId;
    doubles.renderVideo.mockResolvedValueOnce({ jobId: 'render-3' });
    doubles.activeRenderJobId.mockResolvedValue('render-3');
    await service.resumeAutonomousVideo('mv-auto');
    expect(doubles.renderVideo).toHaveBeenCalledTimes(2);
    expect(runOf().output.renderJobId).toBe('render-3');
  });

  describe('resuming after production fails, is canceled or is replaced by hand', () => {
    const later = () => new Date(Date.now() + 1000).toISOString();
    const delegated = async (input = {}) => {
      await service.startAutonomousVideo({ prompt: 'p', tools: ['image:local', 'video:local'], models: { 'video:local': 'text-only' }, ...input });
      await vi.waitFor(() => expect(runOf()?.output.productionRunId).toBe('mvpr-1'));
      store.get('mv-auto').productionRuns = [{ id: 'mvpr-1', status: 'running', createdAt: later() }];
    };

    it('parks when its production run is canceled on its own, then adopts the run the director started instead', async () => {
      await delegated();
      store.get('mv-auto').productionRuns[0].status = 'canceled';
      await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: { status: 'canceled' } });
      expect(runOf()).toMatchObject({ status: 'needs-human', errorCode: 'PRODUCTION_CANCELED' });

      store.get('mv-auto').productionRuns.push({ id: 'mvpr-manual', status: 'running', createdAt: later() });
      await service.resumeAutonomousVideo('mv-auto');
      expect(runOf()).toMatchObject({ status: 'running', stage: 'produce', output: expect.objectContaining({ productionRunId: 'mvpr-manual' }) });
      // Resuming the adopted live run re-pins it to this process (a no-op when it already is).
      expect(doubles.resumeProduction).toHaveBeenCalledWith('mv-auto', 'mvpr-manual', { acceptBasis: true });
      expect(doubles.startProduction).toHaveBeenCalledOnce();
      // The adopted run's completion is now ours: it starts the final render.
      await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-manual', run: { status: 'completed' } });
      expect(runOf().output.renderJobId).toBe('render-1');
    });

    it('goes straight to the final render when the adopted run already completed', async () => {
      await delegated();
      await service.cancelAutonomousVideo('mv-auto');
      expect(runOf().status).toBe('canceled');
      store.get('mv-auto').productionRuns = [{ id: 'mvpr-1', status: 'canceled', createdAt: later() }, { id: 'mvpr-manual', status: 'completed', createdAt: later() }];
      await service.resumeAutonomousVideo('mv-auto');
      expect(doubles.renderVideo).toHaveBeenCalledOnce();
      expect(runOf()).toMatchObject({ status: 'running', output: expect.objectContaining({ productionRunId: 'mvpr-manual', productionDone: true, renderJobId: 'render-1' }) });
    });

    it('adopts the completed run\'s own current final render on resume instead of rendering again (#10563)', async () => {
      const { captureMusicVideoEvidence } = await import('../../lib/musicVideoDependencies.js');
      await delegated();
      await service.cancelAutonomousVideo('mv-auto');
      const project = store.get('mv-auto');
      const directory = 'music-video/mv-auto/composition/example';
      project.composition = { ...project.composition, document: { directory } };
      project.productionRuns = [{ id: 'mvpr-1', status: 'completed', createdAt: later(), documentCheckpoint: { directory }, finalRender: { status: 'completed', jobId: 'production-render', attemptId: 'attempt-1' } }];
      project.renderHistoryId = 'production-render';
      project.renderDependencies = captureMusicVideoEvidence(project);
      await service.resumeAutonomousVideo('mv-auto');
      expect(doubles.renderVideo).not.toHaveBeenCalled();
      expect(runOf()).toMatchObject({ status: 'completed', output: expect.objectContaining({ productionDone: true, renderJobId: 'production-render' }) });
    });

    // Uniquely catches a mid-run course change never reaching production's shot planner.
    it('carries a changed prompt and guidance to the parked production run on resume', async () => {
      await delegated();
      store.get('mv-auto').productionRuns[0].status = 'limit-reached';
      await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: { status: 'limit-reached', stopReason: 'generation limit' } });
      await service.resumeAutonomousVideo('mv-auto', { prompt: 'p', guidance: 'Natural chestnut shag, no pencil.' });
      expect(runOf().brief).toMatchObject({ prompt: 'p', guidance: 'Natural chestnut shag, no pencil.' });
      expect(doubles.resumeProduction).toHaveBeenCalledWith('mv-auto', 'mvpr-1', { acceptBasis: true, directive: 'p\n\nNatural chestnut shag, no pencil.' });
    });

    it('resumes a parked run with raised limits, and a model swap continues that run with the new pool', async () => {
      await delegated();
      store.get('mv-auto').productionRuns[0].status = 'limit-reached';
      await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: { status: 'limit-reached', stopReason: 'generation limit' } });
      await expect(service.resumeAutonomousVideo('mv-auto', { limits: { maxGenerations: 10 } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(runOf().brief.limits.maxGenerations).toBe(40);
      await service.resumeAutonomousVideo('mv-auto', { limits: { maxGenerations: 120 } });
      expect(doubles.resumeProduction).toHaveBeenCalledWith('mv-auto', 'mvpr-1', { acceptBasis: true, limits: { maxGenerations: 120 } });
      expect(runOf().brief.limits.maxGenerations).toBe(120);

      store.get('mv-auto').productionRuns[0].status = 'blocked';
      await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: { status: 'blocked', stopReason: 'no image-to-video' } });
      // A text-only replacement is refused like Start, before the brief or production changes.
      await expect(service.resumeAutonomousVideo('mv-auto', { models: { 'video:local': 'example-text-only' } }))
        .rejects.toMatchObject({ status: 400, code: 'VIDEO_MODEL_TEXT_ONLY', message: expect.stringMatching(/Example Text Model.*image-to-video/) });
      expect(runOf().brief.models).toEqual({ 'video:local': 'text-only' });
      expect(doubles.resumeProduction).toHaveBeenCalledTimes(1);

      await service.resumeAutonomousVideo('mv-auto', { models: { 'video:local': 'image-capable' } });
      expect(doubles.resumeProduction).toHaveBeenLastCalledWith('mv-auto', 'mvpr-1', {
        acceptBasis: true, pool: [{ kind: 'image', mode: 'local' }, { kind: 'video', mode: 'local', model: 'image-capable' }],
      });
      expect(doubles.cancelProduction).not.toHaveBeenCalled();
      expect(doubles.startProduction).toHaveBeenCalledOnce();
      expect(runOf()).toMatchObject({ status: 'running', brief: expect.objectContaining({ models: { 'video:local': 'image-capable' } }), output: expect.objectContaining({ productionRunId: 'mvpr-1' }) });
      await expect(service.resumeAutonomousVideo('mv-auto', { models: { 'image:fal': 'x' } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('starts a new production run with the swapped models when the old one cannot resume', async () => {
      await delegated();
      store.get('mv-auto').productionRuns[0].status = 'needs-human';
      await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: { status: 'needs-human', stopReason: 'review ended' } });
      doubles.startProduction.mockResolvedValueOnce({ run: { id: 'mvpr-2' } });
      // Like the real service, canceling the old run publishes its own "canceled" event.
      doubles.cancelProduction.mockImplementationOnce(async (projectId, runId) => {
        store.get(projectId).productionRuns[0].status = 'canceled';
        await service.__testing.onProductionEvent({ projectId, runId, run: { status: 'canceled' } });
      });
      await service.resumeAutonomousVideo('mv-auto', { models: { 'video:local': 'image-capable' } });
      expect(doubles.cancelProduction).toHaveBeenCalledWith('mv-auto', 'mvpr-1');
      await vi.waitFor(() => expect(runOf().output.productionRunId).toBe('mvpr-2'));
      expect(doubles.startProduction.mock.calls[1][1].pool).toEqual([{ kind: 'image', mode: 'local' }, { kind: 'video', mode: 'local', model: 'image-capable' }]);
    });

    it('re-pins a production run left running by a previous server process', async () => {
      await delegated();
      store.get('mv-auto').autonomousRun.processId = 'proc-previous';
      store.get('mv-auto').productionRuns[0].processId = 'proc-previous';
      await service.resumeAutonomousVideo('mv-auto');
      expect(doubles.resumeProduction).toHaveBeenCalledWith('mv-auto', 'mvpr-1', { acceptBasis: true });
      expect(runOf()).toMatchObject({ status: 'running', output: expect.objectContaining({ productionRunId: 'mvpr-1' }) });
    });

    it('starts a new production run when there is none left to follow', async () => {
      await delegated();
      await service.cancelAutonomousVideo('mv-auto');
      store.get('mv-auto').productionRuns[0].status = 'canceled';
      doubles.startProduction.mockResolvedValueOnce({ run: { id: 'mvpr-2' } });
      await service.resumeAutonomousVideo('mv-auto');
      await vi.waitFor(() => expect(runOf()).toMatchObject({ status: 'running', output: expect.objectContaining({ productionRunId: 'mvpr-2' }) }));
    });
  });

  it('keeps the board text-only when the run names no image tool, or caps spend on a paid one', async () => {
    await service.startAutonomousVideo({ prompt: 'p', tools: ['video:local'] });
    await vi.waitFor(() => expect(doubles.createMoodBoard).toHaveBeenCalledOnce());
    expect(doubles.createMoodBoard.mock.calls[0][1]).toEqual({ renderRoute: null });
    store.clear();
    doubles.createMoodBoard.mockClear();
    await service.startAutonomousVideo({ prompt: 'p', tools: ['image:fal'], budgetUsd: 5 });
    await vi.waitFor(() => expect(doubles.createMoodBoard).toHaveBeenCalledOnce());
    expect(doubles.createMoodBoard.mock.calls[0][1]).toEqual({ renderRoute: null });
  });

  it('parks needs-human when production parks, and failed when it fails', async () => {
    await service.startAutonomousVideo({ prompt: 'p' });
    await vi.waitFor(() => expect(runOf()?.output.productionRunId).toBe('mvpr-1'));
    await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: { status: 'limit-reached', stopReason: 'generation limit' } });
    expect(runOf()).toMatchObject({ status: 'needs-human', error: 'generation limit' });
  });

  it('renders a code-only brief directly: generate the code, render, no production run', async () => {
    await service.startAutonomousVideo({ prompt: 'p', tools: ['code:render'], authoring: { providerId: 'prov', model: 'm' } });
    await settled('running').catch(() => {});
    await vi.waitFor(() => expect(calls).toContain('render'));
    expect(calls).not.toContain('production');
    expect(calls).not.toContain('board');
    expect(doubles.acceptDocument).toHaveBeenCalledWith('mv-auto', 'music-video/mv-auto/composition/example');
    expect(doubles.generateDocument).toHaveBeenCalledWith('mv-auto', { providerId: 'prov', model: 'm' });
    expect(store.get('mv-auto').composition).toMatchObject({ mode: 'document', authoringRenderer: 'three' });
    // Queued is not finished: the run waits on the render job.
    await vi.waitFor(() => expect(runOf()).toMatchObject({ status: 'running', stage: 'produce', output: { renderJobId: 'render-1' }, stages: { produce: { step: 'rendering' } } }));
    await service.__testing.onRenderEvent({ projectId: 'mv-auto', jobId: 'render-1', status: 'completed' });
    expect(runOf().status).toBe('completed');
  });

  it('code path: a failed final render parks the run failed, and a restart re-checks the render', async () => {
    await service.startAutonomousVideo({ prompt: 'p', tools: ['code:render'], authoring: { providerId: 'prov', model: 'm' } });
    await vi.waitFor(() => expect(runOf()?.output.renderJobId).toBe('render-1'));
    await service.__testing.onRenderEvent({ projectId: 'mv-auto', jobId: 'render-1', status: 'failed', error: 'Render cancelled' });
    expect(runOf()).toMatchObject({ status: 'failed', errorCode: 'FINAL_RENDER_FAILED', error: 'Render cancelled' });

    doubles.renderVideo.mockResolvedValueOnce({ jobId: 'render-2' });
    doubles.activeRenderJobId.mockResolvedValue('render-2');
    await service.resumeAutonomousVideo('mv-auto');
    expect(runOf()).toMatchObject({ status: 'running', output: { renderJobId: 'render-2' } });
    // Interrupted while rendering: the render is still live in this process, so resume reattaches.
    store.get('mv-auto').autonomousRun.processId = 'proc-previous';
    await service.resumeAutonomousVideo('mv-auto');
    expect(doubles.renderVideo).toHaveBeenCalledTimes(2);
    expect(runOf()).toMatchObject({ status: 'running', output: { renderJobId: 'render-2' } });
  });

  it('resolves the direction LLM once per text stage: brief and lyrics run on the resolved TUI route, effort included, and the route is recorded (#9545)', async () => {
    const route = { providerId: 'claude-tui', model: 'opus', effort: 'high', transport: 'tui', source: 'tui-preferred' };
    doubles.resolveLlm.mockResolvedValue({ provider: { id: 'claude-tui' }, selectedModel: 'opus', route });
    const { project } = await service.startAutonomousVideo({ prompt: 'p', providerId: 'cloud', model: 'big', effort: 'low' });
    expect(project.automation.llm).toEqual({ providerId: 'cloud', model: 'big', effort: 'low' });
    await vi.waitFor(() => expect(calls).toContain('production'));

    // The run's pin is what gets resolved, per stage; what the resolver returns is what runs.
    const runPins = { llm: { providerId: 'cloud', model: 'big', effort: 'low' }, llmStages: null };
    expect(doubles.resolveLlm).toHaveBeenCalledWith({ stage: 'brief', automation: runPins });
    expect(doubles.resolveLlm).toHaveBeenCalledWith({ stage: 'lyrics', automation: runPins });
    expect(doubles.draftCreativeBrief).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'claude-tui', model: 'opus', effort: 'high' }));
    expect(doubles.writeLyrics).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'claude-tui', model: 'opus', effort: 'high' }));
    expect(runOf().output).toMatchObject({ briefRoute: route, lyricsRoute: route });
  });

  it('drafts lyrics on the lyrics stage\'s model, then reviews and revises them on the review stage\'s model, and the checkpoint shows the revision', async () => {
    const llmStages = { lyrics: { providerId: 'local-llm', model: 'small' }, lyricsReview: { providerId: 'cloud', model: 'big', effort: 'high' } };
    const routeOf = (pin, source) => ({ providerId: pin.providerId, model: pin.model, effort: pin.effort || null, transport: 'api', source });
    // A resolver double honoring the stage pin, like llmRoute.js does.
    doubles.resolveLlm.mockImplementation(async ({ stage, automation }) => {
      const pin = automation.llmStages?.[stage];
      return pin ? { provider: { id: pin.providerId }, selectedModel: pin.model, route: routeOf(pin, 'stage') } : { provider: null, route: null };
    });
    doubles.reviewLyrics = stub('review', async () => ({ lyrics: '[verse]\nrain against the glass', notes: 'Tightened the verse.' }));
    service.__setAutonomousDepsForTests(doubles);
    const steps = [];
    const onEvent = ({ run }) => { if (run.stages.lyrics.step) steps.push(run.stages.lyrics.step); };
    musicVideoEvents.on('autonomous', onEvent);
    try {
      const { project } = await service.startAutonomousVideo({ prompt: 'p', llmStages, checkpoints: ['lyrics'] });
      // The stage pins also reach the project's brief for the stages production runs later.
      expect(project.automation.llmStages).toEqual({ lyrics: { ...llmStages.lyrics, effort: null }, lyricsReview: llmStages.lyricsReview });
      await settled('awaiting-approval');
    } finally {
      musicVideoEvents.off('autonomous', onEvent);
    }
    expect(calls).toEqual(['createProject', 'brief', 'updateProject', 'lyrics', 'review']);
    expect(doubles.writeLyrics).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'local-llm', model: 'small', request: 'p' }));
    expect(doubles.reviewLyrics).toHaveBeenCalledWith(expect.objectContaining({
      lyrics: '[verse]\nrain on glass', description: BRIEF.musicalDescription, request: 'p', providerId: 'cloud', model: 'big', effort: 'high',
    }));
    expect(steps).toEqual(expect.arrayContaining(['draft', 'review']));
    // The checkpoint parks on the revision, keeping the draft and the critique beside it.
    expect(runOf()).toMatchObject({ awaiting: 'lyrics', stages: { lyrics: { status: 'done', step: null } } });
    expect(runOf().output).toMatchObject({
      lyricsDraft: '[verse]\nrain on glass', lyrics: '[verse]\nrain against the glass', lyricsReviewNotes: 'Tightened the verse.',
      lyricsRoute: routeOf(llmStages.lyrics, 'stage'), lyricsReviewRoute: routeOf(llmStages.lyricsReview, 'stage'),
    });
    // Each stage's route is kept on the project brief too.
    expect(store.get('mv-auto').automation.routes).toMatchObject({ lyrics: { providerId: 'local-llm' }, lyricsReview: { providerId: 'cloud' } });

    // Approving sends the revised lyrics to Suno.
    await service.resumeAutonomousVideo('mv-auto');
    await vi.waitFor(() => expect(calls).toContain('production'));
    expect(doubles.generateSunoSong.mock.calls[0][0].lyrics).toBe('[verse]\nrain against the glass');
  });

  it('skips the lyric review unless the brief asks for it, and reviews on the direction LLM when only the toggle is set', async () => {
    doubles.reviewLyrics = stub('review', async () => ({ lyrics: '[verse]\nrevised', notes: '' }));
    service.__setAutonomousDepsForTests(doubles);
    await service.startAutonomousVideo({ prompt: 'p', providerId: 'cloud', model: 'big' });
    await vi.waitFor(() => expect(calls).toContain('production'));
    expect(calls).not.toContain('review');
    expect(runOf().output).not.toHaveProperty('lyricsDraft');
    expect(runOf().output.lyrics).toBe('[verse]\nrain on glass');

    store.clear();
    calls.length = 0;
    await service.startAutonomousVideo({ prompt: 'p', providerId: 'cloud', model: 'big', lyricsReview: true });
    await vi.waitFor(() => expect(calls).toContain('production'));
    // No registry route resolves here, so both passes run on the run's own direction pin.
    expect(doubles.reviewLyrics).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'cloud', model: 'big' }));
    expect(runOf().output).toMatchObject({ lyricsDraft: '[verse]\nrain on glass', lyrics: '[verse]\nrevised', lyricsReviewNotes: '' });
  });

  it('retries only the review when the review fails after the draft was stored', async () => {
    doubles.reviewLyrics = vi.fn()
      .mockRejectedValueOnce(new Error('review provider down'))
      .mockResolvedValueOnce({ lyrics: '[verse]\nrevised', notes: 'ok' });
    service.__setAutonomousDepsForTests(doubles);
    await service.startAutonomousVideo({ prompt: 'p', lyricsReview: true });
    await settled('failed');
    expect(runOf().output.lyricsDraft).toBe('[verse]\nrain on glass');
    await service.resumeAutonomousVideo('mv-auto');
    await vi.waitFor(() => expect(calls).toContain('production'));
    expect(doubles.writeLyrics).toHaveBeenCalledTimes(1);
    expect(runOf().output.lyrics).toBe('[verse]\nrevised');
  });

  it('falls back to the run\'s own pin when the provider registry cannot be read', async () => {
    doubles.resolveLlm.mockRejectedValue(new Error('registry down'));
    await service.startAutonomousVideo({ prompt: 'p', providerId: 'cloud', model: 'big' });
    await vi.waitFor(() => expect(calls).toContain('production'));
    expect(doubles.draftCreativeBrief).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'cloud', model: 'big' }));
    expect(runOf().output.briefRoute).toBeUndefined();
  });

  it('threads the authoring effort into code generation for a code-only brief', async () => {
    await service.startAutonomousVideo({ prompt: 'p', tools: ['code:render'], authoring: { providerId: 'prov', model: 'm', effort: 'medium' } });
    await vi.waitFor(() => expect(calls).toContain('render'));
    expect(doubles.generateDocument).toHaveBeenCalledWith('mv-auto', { providerId: 'prov', model: 'm', effort: 'medium' });
  });

  it('sends the Cast & Sets check-in to review only when the cast checkpoint is chosen', async () => {
    const { project } = await service.startAutonomousVideo({ prompt: 'p', checkpoints: ['cast'] });
    expect(project.automation.checkins.castAndSets).toBe('review');
    await vi.waitFor(() => expect(calls).toContain('production')); // let the background run finish before the next test resets the doubles
  });

  it('reuses an existing mood board instead of generating one', async () => {
    await service.startAutonomousVideo({ prompt: 'p', moodBoardId: 'board-existing' });
    await vi.waitFor(() => expect(calls).toContain('production'));
    expect(calls).not.toContain('board');
    expect(runOf().output.moodBoardId).toBe('board-existing');
    expect(doubles.updateProject).toHaveBeenCalledWith('mv-auto', expect.objectContaining({ visualSpec: { moodBoardId: 'board-existing' } }));
  });

  // Uniquely catches a character style chosen at start not reaching the project or the brief.
  it('casts a chosen character style on the new project and writes the brief around that lead', async () => {
    await service.startAutonomousVideo({ prompt: 'p', guidance: 'Keep it short', characterStyleId: 'claudia-slopcore' });
    await vi.waitFor(() => expect(calls).toContain('production'));
    expect(doubles.createProject).toHaveBeenCalledWith(expect.objectContaining({ concept: { prompt: 'p', characterStyleId: 'claudia-slopcore' } }));
    const { guidance } = doubles.draftCreativeBrief.mock.calls[0][0];
    expect(guidance).toMatch(/^Keep it short\n\nThe video stars Claudia \(Claudia slopcore character style\)/);
  });

  it('rejects a blank prompt', async () => {
    await expect(service.startAutonomousVideo({ prompt: '   ' })).rejects.toMatchObject({ status: 400 });
    expect(calls).toEqual([]);
  });
});

// A finished project whose song a new run reuses; everything but the song is its own look.
const SONG_SOURCE = {
  id: 'mv-src', name: 'Example Song', trackId: 'track-src', uploadedAudioFilename: null, status: 'ready',
  concept: { prompt: 'Its own concept', songStyle: 'post-punk, driving drums, -metal' },
  visualSpec: { moodBoardId: 'board-src', references: [{ id: 'ref-1', imageId: 'img-1' }] },
  audioAnalysis: { durationSec: 20, bpm: 120, sections: [{ id: 'chorus', label: 'Chorus', startSec: 0, endSec: 20 }] },
  midiTranscription: { filename: 'song.mid' },
  lyricCues: [{ id: 'c1', text: 'rain on glass', startSec: 1, endSec: 4, words: [
    { w: 'rain', startSec: 1, endSec: 2, conf: 'interpolated' }, { w: 'on', startSec: 2, endSec: 3, conf: 'interpolated' }, { w: 'glass', startSec: 3, endSec: 4, conf: 'interpolated' }] }],
  lyricMarkers: [{ cueIndex: 0, kind: 'section', text: 'Chorus' }],
  phrases: [{ id: 'mp-1', label: 'hook', intent: 'lift', startSec: 1, endSec: 4 }],
  vocalStemFilename: 'vocals.wav', performanceConditioningSource: 'vocal-stem', lyricAlignSource: 'vocal-stem', lyricAlignSilentWords: 0,
  scenes: [{ sceneId: 'mvs-src', startSec: 0, endSec: 20 }],
  castAndSets: { status: 'complete', cast: 'Its own lead' },
  treatment: { brief: 'Its own treatment' },
  filmLook: { preset: 'example' },
  productionReview: { draft: { lyricsMode: 'vocal', timingStatus: 'verified', storyboard: [{ sceneId: 'mvs-src' }] } },
};

describe('starting on an existing project\'s song (fromProjectId)', () => {
  beforeEach(() => {
    store.set('mv-src', clone(SONG_SOURCE));
    doubles.getTrack = vi.fn(async () => ({ id: 'track-src', title: 'Example Song', prompt: 'track style', lyrics: 'rain on glass' }));
    service.__setAutonomousDepsForTests(doubles);
  });

  // Uniquely catches a reused footage song turning code-first when the request names the footage mode itself.
  it('keeps the source song\'s production policy when the request names a footage media mode, but not a code-only one', async () => {
    const { project } = await service.startAutonomousVideo({ prompt: 'p', fromProjectId: 'mv-src', mediaMode: 'code-images-video' });
    expect(project.productionPolicy).toMatchObject({ strategy: 'legacy', maxGeneratedVideoPercent: 100 });
    store.delete('mv-auto');
    const { project: codeOnly } = await service.startAutonomousVideo({ prompt: 'p', fromProjectId: 'mv-src', mediaMode: 'code-only' });
    expect(codeOnly.productionPolicy).toMatchObject({ strategy: 'code-first', maxGeneratedVideoPercent: 0 });
  });

  // Uniquely catches the install's video pin (fal, say) planning lip-sync shots the run's own video tool cannot render.
  it('sets the project\'s video settings from the run\'s own video tool', async () => {
    doubles.localVideoTakesSongAudio.mockResolvedValue(true);
    const { project } = await service.startAutonomousVideo({ prompt: 'p', fromProjectId: 'mv-src', tools: ['image:local', 'video:local'], models: { 'video:local': 'example-ltx' } });
    expect(project.videoSettings).toEqual({ backend: 'local', modelId: 'example-ltx', generationMode: 'suppliedAudio' });
    expect(doubles.localVideoTakesSongAudio).toHaveBeenCalledWith('example-ltx');
    store.delete('mv-auto');
    const { project: stills } = await service.startAutonomousVideo({ prompt: 'p', fromProjectId: 'mv-src', tools: ['image:local'] });
    expect(stills.videoSettings).toEqual({ backend: 'local', generationMode: 'image' });
  });

  // Uniquely catches a reused song re-running lyrics/Suno/analysis or the new project inheriting the source's look.
  it('copies only the song, writes no lyrics, makes no song, skips analysis, and leaves the source untouched', async () => {
    const { project, run } = await service.startAutonomousVideo({ prompt: 'skatepark at golden hour', fromProjectId: 'mv-src', checkpoints: ['lyrics', 'song', 'style'] });
    expect(project).toMatchObject({ name: 'Example Song (Auto)', trackId: 'track-src', status: 'analyzed',
      audioAnalysis: SONG_SOURCE.audioAnalysis, lyricCues: SONG_SOURCE.lyricCues, vocalStemFilename: 'vocals.wav', lyricAlignSource: 'vocal-stem' });
    expect(project.concept).toEqual({ prompt: 'skatepark at golden hour', songStyle: 'post-punk, driving drums, -metal' });
    // The source has no policy of its own, so it is a legacy footage project, and so is the copy.
    expect(project).toMatchObject({ mediaMode: 'code-images-video', productionPolicy: { strategy: 'legacy', maxGeneratedVideoPercent: 100 } });
    for (const key of ['visualSpec', 'castAndSets', 'treatment', 'filmLook']) expect(project[key]).toBeUndefined();
    expect(project.scenes).toBeUndefined();
    expect(run.brief).toMatchObject({ checkpoints: ['style'], instrumental: false, songFrom: { projectId: 'mv-src', title: 'Example Song' } });
    expect(run.output).toMatchObject({ trackId: 'track-src', lyrics: 'rain on glass', songSource: 'reused' });

    await settled('awaiting-approval');
    await service.resumeAutonomousVideo('mv-auto');
    await vi.waitFor(() => expect(calls).toContain('production'));
    expect(calls).toEqual(['createProject', 'brief', 'board', 'updateProject', 'production']);
    expect(doubles.draftCreativeBrief).toHaveBeenCalledWith(expect.objectContaining({
      song: { title: 'Example Song', style: 'post-punk, driving drums, -metal', lyrics: 'rain on glass' },
    }));
    // The brief designs the video; the song keeps its own title and style.
    expect(runOf().output).toMatchObject({ title: 'Example Song', sunoStyle: 'post-punk, driving drums, -metal' });
    expect(runOf().stages).toMatchObject({ lyrics: { status: 'done' }, song: { status: 'done' }, analyze: { status: 'done' } });
    expect(store.get('mv-auto').name).toBe('Example Song (Auto)');
    expect(store.get('mv-src')).toEqual(SONG_SOURCE);
    await expect(service.resumeAutonomousVideo('mv-auto', { retakeSong: true })).rejects.toMatchObject({ status: 409 });
  });

  it('refuses a missing source or one with no song before creating anything', async () => {
    await expect(service.startAutonomousVideo({ prompt: 'p', fromProjectId: 'mv-missing' })).rejects.toMatchObject({ status: 404 });
    store.set('mv-src', { ...clone(SONG_SOURCE), trackId: null });
    await expect(service.startAutonomousVideo({ prompt: 'p', fromProjectId: 'mv-src' })).rejects.toMatchObject({ status: 409, code: 'NO_SONG' });
    expect(calls).toEqual([]);
  });
});

describe('cancel while the final render is preparing (#11768)', () => {
  // Uniquely catches a canceled run leaving a fresh render job running, or a rejected preparation relabeling the cancel as a failure.
  const deferred = () => { let resolve; let reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
  const viaFinalRender = async (render) => {
    await service.startAutonomousVideo({ prompt: 'p' });
    await vi.waitFor(() => expect(runOf()?.output.productionRunId).toBe('mvpr-1'));
    doubles.renderVideo.mockImplementationOnce(() => render.promise);
    const done = service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: { status: 'completed' } });
    await vi.waitFor(() => expect(doubles.renderVideo).toHaveBeenCalledOnce());
    return done;
  };
  const viaProduceStage = async (render) => {
    doubles.renderVideo.mockImplementationOnce(() => render.promise);
    await service.startAutonomousVideo({ prompt: 'p', tools: ['code:render'], authoring: { providerId: 'prov', model: 'm' } });
    await vi.waitFor(() => expect(doubles.renderVideo).toHaveBeenCalledOnce());
  };

  it.each([['final render', viaFinalRender], ['produce stage', viaProduceStage]])('cancels the job a %s returns after the run was canceled', async (_, begin) => {
    const render = deferred();
    const done = begin(render);
    await vi.waitFor(() => expect(doubles.renderVideo).toHaveBeenCalledOnce());
    await service.cancelAutonomousVideo('mv-auto');
    expect(doubles.cancelRender).not.toHaveBeenCalled();
    render.resolve({ jobId: 'render-late' });
    await done;
    await vi.waitFor(() => expect(doubles.cancelRender).toHaveBeenCalledWith('render-late'));
    expect(runOf()).toMatchObject({ status: 'canceled' });
    expect(runOf().output.renderJobId).not.toBe('render-late');
  });

  it.each([['final render', viaFinalRender], ['produce stage', viaProduceStage]])('leaves a canceled run canceled when the %s preparation rejects', async (_, begin) => {
    const render = deferred();
    const done = begin(render);
    await vi.waitFor(() => expect(doubles.renderVideo).toHaveBeenCalledOnce());
    await service.cancelAutonomousVideo('mv-auto');
    render.reject(Object.assign(new Error('no audio'), { code: 'NO_AUDIO' }));
    await done;
    await new Promise((r) => setTimeout(r, 20));
    expect(runOf()).toMatchObject({ status: 'canceled', errorCode: null });
    expect(doubles.cancelRender).not.toHaveBeenCalled();
  });

  it('still cancels a render job stored before the cancel', async () => {
    await service.startAutonomousVideo({ prompt: 'p' });
    await vi.waitFor(() => expect(runOf()?.output.productionRunId).toBe('mvpr-1'));
    await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: { status: 'completed' } });
    await service.cancelAutonomousVideo('mv-auto');
    expect(doubles.cancelRender).toHaveBeenCalledWith('render-1');
  });
});

describe('stage completion after ownership is released (#12064)', () => {
  // A stop admitted ahead of failure persistence must win even while both writes wait for the store.
  it.each([
    ['cancel', 'canceled', null],
    ['stop', 'stopped', 'MUSIC_VIDEO_APPROVAL_REQUIRED'],
  ])('preserves %s when a stage failure queues behind its status write', async (action, status, code) => {
    const projects = await import('./projects.js');
    const lyrics = Promise.withResolvers();
    doubles.writeLyrics.mockImplementationOnce(() => lyrics.promise);
    await service.startAutonomousVideo({ prompt: 'p', checkpoints: ['lyrics'] });
    await vi.waitFor(() => expect(doubles.writeLyrics).toHaveBeenCalledOnce());
    const barrier = Promise.withResolvers();
    writeTail = writeTail.then(() => barrier.promise);
    const writes = vi.spyOn(projects, 'mutateProjectRecord');
    let release;
    try {
      release = service[`${action}AutonomousVideo`]('mv-auto');
      lyrics.reject(Object.assign(new Error('late stage failure'), { code }));
      await vi.waitFor(() => expect(writes).toHaveBeenCalledTimes(2));
    } finally {
      barrier.resolve();
      await release;
      await service.__testing.settleBackground();
      writes.mockRestore();
    }
    expect(runOf()).toMatchObject({ status, stage: 'lyrics', error: null, errorCode: null });
    expect(doubles.createMoodBoard).not.toHaveBeenCalled();
  });

  // A failed cancellation must leave the newly created child discoverable on its released parent.
  it('retains late production linkage when child cancellation fails', async () => {
    const production = Promise.withResolvers();
    doubles.startProduction.mockImplementationOnce(() => production.promise);
    doubles.cancelProduction.mockRejectedValueOnce(new Error('production store unavailable'));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await service.startAutonomousVideo({ prompt: 'p' });
      await vi.waitFor(() => expect(doubles.startProduction).toHaveBeenCalledOnce());
      await service.cancelAutonomousVideo('mv-auto');
      production.resolve({ run: { id: 'mvpr-late-failed-cancel' } });
      await service.__testing.settleBackground();
      expect(doubles.cancelProduction).toHaveBeenCalledWith('mv-auto', 'mvpr-late-failed-cancel');
      expect(runOf()).toMatchObject({ status: 'canceled', stage: 'produce', output: { productionRunId: 'mvpr-late-failed-cancel' } });
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('could not cancel production mvpr-late-failed-cancel'));
    } finally {
      errorLog.mockRestore();
    }
  });

  // Uniquely catches a successful late stage restoring approval/continuation after cancel, stop, or a process handoff.
  it.each(['cancel', 'stop', 'handoff'])('keeps a checkpoint released by %s terminal and preserves its finished output', async (action) => {
    const lyrics = Promise.withResolvers();
    doubles.writeLyrics.mockImplementationOnce(() => lyrics.promise);
    await service.startAutonomousVideo({ prompt: 'p', checkpoints: ['lyrics'] });
    await vi.waitFor(() => expect(doubles.writeLyrics).toHaveBeenCalledOnce());
    if (action === 'handoff') runOf().processId = 'proc-other';
    else await service[`${action}AutonomousVideo`]('mv-auto');
    const released = clone(runOf());
    lyrics.resolve({ lyrics: 'finished words' });
    await service.__testing.settleBackground();
    expect(runOf()).toMatchObject({ status: released.status, stage: 'lyrics', awaiting: released.awaiting, processId: released.processId,
      output: { lyrics: 'finished words' }, stages: { lyrics: { status: 'done' } } });
    expect(doubles.createMoodBoard).not.toHaveBeenCalled();
    expect(doubles.startProduction).not.toHaveBeenCalled();
  });

  it('still cancels late production when saving its recovery linkage fails', async () => {
    const projects = await import('./projects.js');
    const production = Promise.withResolvers();
    doubles.startProduction.mockImplementationOnce(() => production.promise);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    let write;
    try {
      await service.startAutonomousVideo({ prompt: 'p' });
      await vi.waitFor(() => expect(doubles.startProduction).toHaveBeenCalledOnce());
      await service.cancelAutonomousVideo('mv-auto');
      write = vi.spyOn(projects, 'mutateProjectRecord').mockRejectedValueOnce(new Error('link store unavailable'));
      production.resolve({ run: { id: 'mvpr-late-unlinked' } });
      await service.__testing.settleBackground();
      expect(doubles.cancelProduction).toHaveBeenCalledWith('mv-auto', 'mvpr-late-unlinked');
      expect(runOf().status).toBe('canceled');
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('link store unavailable'));
    } finally {
      write?.mockRestore();
      errorLog.mockRestore();
    }
  });

  it('preserves a replacement child when late production returns after a process handoff', async () => {
    const production = Promise.withResolvers();
    doubles.startProduction.mockImplementationOnce(() => production.promise);
    await service.startAutonomousVideo({ prompt: 'p' });
    await vi.waitFor(() => expect(doubles.startProduction).toHaveBeenCalledOnce());
    runOf().processId = 'proc-other';
    runOf().output.productionRunId = 'mvpr-replacement';
    production.resolve({ run: { id: 'mvpr-obsolete' } });
    await service.__testing.settleBackground();
    expect(doubles.cancelProduction).toHaveBeenCalledWith('mv-auto', 'mvpr-obsolete');
    expect(runOf()).toMatchObject({ status: 'running', processId: 'proc-other', output: { productionRunId: 'mvpr-replacement' } });
  });

  // Uniquely catches production being dispatched after a cancel during the preceding preparation/review.
  it('does not start production when preparation returns after cancellation', async () => {
    const { prepareProductionReview } = await import('./productionReviewService.js');
    const prepare = Promise.withResolvers();
    prepareProductionReview.mockImplementationOnce(() => prepare.promise);
    await service.startAutonomousVideo({ prompt: 'p' });
    await vi.waitFor(() => expect(runOf()?.stage).toBe('produce'));
    await service.cancelAutonomousVideo('mv-auto');
    prepare.resolve();
    await service.__testing.settleBackground();
    expect(doubles.startProduction).not.toHaveBeenCalled();
    expect(runOf()).toMatchObject({ status: 'canceled', stage: 'produce', errorCode: null });
  });

  // Uniquely catches a child created during cancellation running without an owned autonomous parent.
  it.each(['cancel', 'stop', 'handoff'])('cancels a production returned after %s while preserving the released run', async (action) => {
    const production = Promise.withResolvers();
    doubles.startProduction.mockImplementationOnce(() => production.promise);
    await service.startAutonomousVideo({ prompt: 'p' });
    await vi.waitFor(() => expect(doubles.startProduction).toHaveBeenCalledOnce());
    if (action === 'handoff') runOf().processId = 'proc-other';
    else await service[`${action}AutonomousVideo`]('mv-auto');
    const released = clone(runOf());
    production.resolve({ run: { id: 'mvpr-late' } });
    await service.__testing.settleBackground();
    expect(doubles.cancelProduction).toHaveBeenCalledWith('mv-auto', 'mvpr-late');
    expect(runOf()).toMatchObject({ status: released.status, stage: 'produce', processId: released.processId, errorCode: null });
    expect(runOf().output.productionRunId).toBe('mvpr-late');
  });

  // Uniquely catches cancellation winning the handoff write after the executor's last ownership read.
  it('cancels production when cancellation reaches the serialized handoff first', async () => {
    const projects = await import('./projects.js');
    const getProject = projects.getProject;
    let read;
    doubles.startProduction.mockImplementationOnce(async () => {
      read = vi.spyOn(projects, 'getProject').mockImplementationOnce(async (id) => {
        const snapshot = await getProject(id);
        writeTail = writeTail.then(() => { runOf().status = 'canceled'; });
        return snapshot;
      });
      return { run: { id: 'mvpr-handoff' } };
    });
    try {
      await service.startAutonomousVideo({ prompt: 'p' });
      await service.__testing.settleBackground();
      expect(doubles.cancelProduction).toHaveBeenCalledWith('mv-auto', 'mvpr-handoff');
      expect(runOf()).toMatchObject({ status: 'canceled', stage: 'produce', output: { productionRunId: 'mvpr-handoff' } });
    } finally {
      read?.mockRestore();
    }
  });

  // Uniquely catches stop reading a child id before an already-admitted write stores it.
  it('stops children stored between the initial read and the serialized status change', async () => {
    doubles.stopAutoReview = vi.fn(async () => ({}));
    service.__setAutonomousDepsForTests(doubles);
    await service.startAutonomousVideo({ prompt: 'p' });
    await vi.waitFor(() => expect(runOf()?.output.productionRunId).toBe('mvpr-1'));
    writeTail = writeTail.then(() => { Object.assign(runOf().output, { productionRunId: 'mvpr-just-stored', finalAutoReviewId: 'mvar-just-stored' }); });
    await service.stopAutonomousVideo('mv-auto');
    await service.__testing.settleBackground();
    expect(doubles.stopProduction).toHaveBeenCalledWith('mv-auto', 'mvpr-just-stored');
    expect(doubles.stopAutoReview).toHaveBeenCalledWith('mv-auto', 'mvar-just-stored');
    expect(runOf().status).toBe('stopped');
  });
});

describe('overlay text pass before the final render', () => {
  const finding = (atSec, message, severity = 'error') => ({ id: `f${atSec}`, kind: severity === 'error' ? 'overlap' : 'contrast', severity, atSec, texts: ['A'], message, count: 1 });
  const textEntries = () => (runOf()?.orchestration?.reviews || []).filter((r) => r.checkpoint === 'text');
  const start = () => service.startAutonomousVideo({ prompt: 'p', tools: ['code:render'], authoring: { providerId: 'prov', model: 'm' } });

  it.each([false, true])('preserves concurrent human feedback and resolutions during text re-authoring (failure: %s)', async (fails) => {
    doubles.acceptDocument.mockImplementation(async (id, directory) => {
      calls.push('accept-document');
      store.get(id).composition.document = { directory, source: { kind: 'generated' } };
      return {};
    });
    doubles.addFeedback = vi.fn(async (id, entry) => {
      const project = store.get(id);
      project.productionReview.feedback = [...(project.productionReview.feedback || []), { id: `fb-${entry.target}`, ...entry }];
      return { feedbackId: `fb-${entry.target}` };
    });
    doubles.closeFeedback = vi.fn(async (id, { feedbackId, resolution, reviewer }) => {
      const project = store.get(id);
      if (project.productionReview.feedback.find((f) => f.id === feedbackId)?.resolvedAt) {
        throw Object.assign(new Error('Already resolved'), { code: 'MUSIC_VIDEO_FEEDBACK_CLOSED' });
      }
      project.productionReview.feedback = project.productionReview.feedback.map((f) => (f.id === feedbackId ? { ...f, resolution, resolvedBy: reviewer, resolvedAt: 'now' } : f));
    });
    doubles.generateDocument.mockImplementationOnce(async () => ({ document: { directory: 'first' } }))
      .mockImplementationOnce(async (id) => {
        const feedback = store.get(id).productionReview.feedback;
        if (!fails) feedback[0] = { ...feedback[0], resolvedAt: 'human-time', resolution: 'Human reviewed it.' };
        feedback.push({ id: 'human-during-authoring', stage: 'proof', text: 'Keep this open', decision: 'request-changes' });
        if (fails) throw new Error('author offline');
        return { document: { directory: 'revised' } };
      });
    service.__setAutonomousDepsForTests(doubles);
    doubles.checkOverlayText
      .mockResolvedValueOnce({ status: 'complete', samples: 20, textSamples: 14, findings: [finding(3.5, '“20 MILLION YEARS” collides with “WHOLE SPECIES”.')] })
      .mockResolvedValueOnce({ status: 'complete', samples: 20, textSamples: 14, findings: [] });
    await start();
    await vi.waitFor(() => expect(runOf()?.output.renderJobId).toBe('render-1'));
    expect(doubles.checkOverlayText).toHaveBeenCalledTimes(fails ? 1 : 2);
    expect(doubles.generateDocument).toHaveBeenCalledTimes(2);
    expect(doubles.renderVideo).toHaveBeenCalledOnce();
    expect(store.get('mv-auto').productionReview.feedback).toEqual([expect.objectContaining({ stage: 'proof', target: 'text@0:03',
      text: '“20 MILLION YEARS” collides with “WHOLE SPECIES”.', resolution: fails ? 'The re-authoring failed (author offline); kept the film.' : 'Human reviewed it.',
      resolvedAt: fails ? 'now' : 'human-time' }),
      expect.objectContaining({ id: 'human-during-authoring', text: 'Keep this open' })]);
    expect(store.get('mv-auto').productionReview.feedback[1].resolvedAt).toBeUndefined();
    expect(textEntries().map((r) => r.verdict)).toEqual(fails ? ['noted'] : ['revise', 'approve']);
    if (!fails) expect(textEntries()[0]).toMatchObject({ route: null, issues: [{ atSec: 3.5, text: expect.stringContaining('collides') }] });
    // Check, re-author, check again, then render.
    const order = (fn, n = 0) => fn.mock.invocationCallOrder[n];
    expect(order(doubles.generateDocument, 1)).toBeGreaterThan(order(doubles.checkOverlayText, 0));
    if (!fails) expect(order(doubles.checkOverlayText, 1)).toBeGreaterThan(order(doubles.acceptDocument, 1));
    expect(order(doubles.renderVideo)).toBeGreaterThan(order(doubles.checkOverlayText, fails ? 0 : 1));
  });

  it('logs a hand-made document\'s problems for the director and renders it untouched', async () => {
    doubles.checkOverlayText.mockResolvedValue({ status: 'complete', samples: 20, textSamples: 14, findings: [finding(1, 'Hard to read', 'warning')] });
    await start();
    await vi.waitFor(() => expect(runOf()?.output.renderJobId).toBe('render-1'));
    expect(doubles.generateDocument).toHaveBeenCalledOnce();
    expect(textEntries()).toEqual([expect.objectContaining({ verdict: 'noted', notes: expect.stringContaining('made by hand'), issues: [{ atSec: 1, text: 'Hard to read' }] })]);
  });

  it('never holds the render on a check that cannot run', async () => {
    doubles.checkOverlayText.mockRejectedValue(new Error('Managed browser is unavailable'));
    await start();
    await vi.waitFor(() => expect(runOf()?.output.renderJobId).toBe('render-1'));
    expect(textEntries()).toEqual([expect.objectContaining({ verdict: 'noted', notes: expect.stringContaining('Managed browser is unavailable') })]);
  });
});

describe('checkpoints', () => {
  it('parks after a checkpointed stage, then approves with the director’s edited lyrics', async () => {
    await service.startAutonomousVideo({ prompt: 'p', checkpoints: ['lyrics'] });
    await settled('awaiting-approval');
    expect(runOf()).toMatchObject({ awaiting: 'lyrics', stage: 'style' });
    // Nothing spends past the checkpoint (no board, no Suno) until approval.
    expect(calls).not.toContain('board');
    expect(calls).not.toContain('suno');

    await service.resumeAutonomousVideo('mv-auto', { lyrics: '[verse]\nedited line' });
    await vi.waitFor(() => expect(calls).toContain('production'));
    expect(doubles.generateSunoSong).toHaveBeenCalledWith(expect.objectContaining({ lyrics: '[verse]\nedited line' }), expect.any(Object));
  });
});

describe('retaking the song at the song checkpoint', () => {
  it('parks on the fresh renders before any download, retakes them with edited lyrics, style and Suno options, then downloads only the picked render', async () => {
    await service.startAutonomousVideo({ prompt: 'p', checkpoints: ['song'], suno: { excludeStyles: 'metal', vocalGender: 'female' } });
    await settled('awaiting-approval');
    // Suno made the renders, but nothing was exported: a download spends the director's monthly quota.
    expect(runOf()).toMatchObject({ awaiting: 'song', stage: 'song', output: { sunoSongIds: ['song-a', 'song-b'] } });
    expect(runOf().output.trackId).toBeFalsy();
    expect(runOf().stages.song).toMatchObject({ status: 'pending', step: 'pick-take' });
    expect(doubles.submitSunoSong).toHaveBeenLastCalledWith(expect.objectContaining({ excludeStyles: 'metal', vocalGender: 'female', model: null }), expect.any(Object));
    expect(doubles.generateSunoSong).not.toHaveBeenCalled();

    doubles.submitSunoSong.mockImplementationOnce(async (_fields, opts) => {
      await opts.onSubmitted(['song-c', 'song-d']);
      return ['song-c', 'song-d'];
    });
    const { run } = await service.resumeAutonomousVideo('mv-auto', {
      retakeSong: true, lyrics: '[verse]\nnew words', style: 'darker synthwave', suno: { vocalGender: 'male', model: 'v6' },
    });
    expect(run).toMatchObject({ status: 'running', stage: 'song', awaiting: null, output: { trackId: null, sunoSongIds: null } });
    await settled('awaiting-approval');
    expect(runOf()).toMatchObject({
      awaiting: 'song', stage: 'song',
      brief: { suno: { excludeStyles: 'metal', vocalGender: 'male', model: 'v6' } },
      output: { sunoSongIds: ['song-c', 'song-d'], lyrics: '[verse]\nnew words', sunoStyle: 'darker synthwave' },
    });
    expect(doubles.submitSunoSong).toHaveBeenLastCalledWith(expect.objectContaining({
      lyrics: '[verse]\nnew words', style: 'darker synthwave', excludeStyles: 'metal', vocalGender: 'male', model: 'v6',
    }), expect.any(Object));
    expect(doubles.generateSunoSong).not.toHaveBeenCalled();

    // A pick cannot ride a retake: the retake throws these renders away.
    await expect(service.resumeAutonomousVideo('mv-auto', { retakeSong: true, sunoSongId: 'song-c' })).rejects.toMatchObject({ status: 409 });
    expect(runOf()).toMatchObject({ status: 'awaiting-approval', awaiting: 'song', output: { sunoSongIds: ['song-c', 'song-d'] } });

    // Approving downloads the picked song once (here a version the director revised in Suno),
    // links it, and does not stop on the song again.
    doubles.createTrack.mockResolvedValueOnce({ id: 'track-2' });
    doubles.generateSunoSong.mockImplementationOnce(async (_fields, opts) => {
      expect(opts).toMatchObject({ songIds: ['song-c', 'song-d'], exportSongId: 'song-revised' });
      return { songId: 'song-revised', songIds: ['song-c', 'song-d'], filename: 'music-song-revised.m4a' };
    });
    await service.resumeAutonomousVideo('mv-auto', { sunoSongId: 'song-revised' });
    await vi.waitFor(() => expect(calls).toContain('production'));
    expect(doubles.generateSunoSong).toHaveBeenCalledTimes(1);
    expect(store.get('mv-auto').trackId).toBe('track-2');
    expect(runOf().output).toMatchObject({ trackId: 'track-2', songTakeApproved: true, sunoSongPick: 'song-revised' });
    // Once past the checkpoint, a pick is refused.
    await expect(service.resumeAutonomousVideo('mv-auto', { sunoSongId: 'song-c' })).rejects.toMatchObject({ status: 409 });
  });

  it('refuses a retake anywhere but the song checkpoint, leaving the run untouched', async () => {
    await service.startAutonomousVideo({ prompt: 'p', checkpoints: ['lyrics'] });
    await settled('awaiting-approval');
    const before = runOf();
    await expect(service.resumeAutonomousVideo('mv-auto', { retakeSong: true })).rejects.toMatchObject({ status: 409, code: 'NOT_AT_SONG_CHECKPOINT' });
    expect(runOf()).toEqual(before);
    expect(calls).not.toContain('suno');
  });

  it('retakes a song whose export never finished: a run stopped in the song stage discards the dead ids and submits afresh', async () => {
    let release;
    doubles.generateSunoSong.mockImplementationOnce(async (_fields, opts) => {
      await opts.onSubmitted(['song-dead-a', 'song-dead-b']);
      opts.onProgress('exporting');
      // Suno dropped the rows: the export hangs until the director stops the run.
      await new Promise((resolve) => { release = resolve; });
      throw Object.assign(new Error('cancelled'), { code: 'SUNO_AUDIO_CANCELLED' });
    });
    // No song checkpoint, so the song stage exports straight away.
    await service.startAutonomousVideo({ prompt: 'p', checkpoints: [] });
    await vi.waitFor(() => expect(runOf().output.sunoSongIds).toEqual(['song-dead-a', 'song-dead-b']));
    await service.stopAutonomousVideo('mv-auto');
    release();
    await vi.waitFor(() => expect(runOf().status).toBe('stopped'));
    expect(runOf().stage).toBe('song');

    doubles.generateSunoSong.mockImplementationOnce(async (_fields, opts) => {
      expect(opts.songIds).toBeNull();
      await opts.onSubmitted(['song-e', 'song-f']);
      return { songId: 'song-f', songIds: ['song-e', 'song-f'], filename: 'music-song-f.m4a' };
    });
    const { run } = await service.resumeAutonomousVideo('mv-auto', { retakeSong: true, style: 'industrial electro' });
    expect(run).toMatchObject({ status: 'running', stage: 'song', output: { sunoSongIds: null, sunoStyle: 'industrial electro' } });
    await vi.waitFor(() => expect(calls).toContain('production'));
    expect(runOf().output).toMatchObject({ sunoSongIds: ['song-e', 'song-f'] });
  });

  it('applies a Suno options patch on a plain approval too', async () => {
    await service.startAutonomousVideo({ prompt: 'p', checkpoints: ['lyrics'], suno: { excludeStyles: 'metal', model: 'v5' } });
    await settled('awaiting-approval');
    await service.resumeAutonomousVideo('mv-auto', { suno: { model: null, vocalGender: 'female' } });
    await vi.waitFor(() => expect(calls).toContain('production'));
    expect(runOf().brief.suno).toEqual({ excludeStyles: 'metal', vocalGender: 'female', model: null, maxMode: null });
    expect(doubles.generateSunoSong).toHaveBeenCalledWith(expect.objectContaining({ excludeStyles: 'metal', vocalGender: 'female', model: null }), expect.any(Object));
  });
});

describe('song sub-step', () => {
  it('records the Suno sub-step on the run, pushes it over the autonomous event, and clears it when the stage settles', async () => {
    const pushed = [];
    const onEvent = (event) => pushed.push(event.run.stages.song.step);
    musicVideoEvents.on('autonomous', onEvent);
    try {
      doubles.generateSunoSong.mockImplementationOnce(async (_fields, opts) => {
        await opts.onSubmitted(['song-a', 'song-b']);
        opts.onProgress('exporting');
        await vi.waitFor(() => expect(runOf().stages.song.step).toBe('exporting'));
        return { songId: 'song-a', songIds: ['song-a', 'song-b'], filename: 'music-song-a.mp3' };
      });
      await service.startAutonomousVideo({ prompt: 'p' });
      await vi.waitFor(() => expect(calls).toContain('production'));
    } finally {
      musicVideoEvents.off('autonomous', onEvent);
    }
    expect(pushed).toContain('exporting');
    expect(runOf().stages.song).toMatchObject({ status: 'done', step: null });
  });
});

describe('failure and retry', () => {
  it('parks needs-human on a signed-out Suno, then retries that stage with the same inputs', async () => {
    doubles.generateSunoSong.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Sign in to Suno'), { code: 'PUBLISH_LOGIN_REQUIRED' });
    });
    await service.startAutonomousVideo({ prompt: 'p' });
    await settled('needs-human');
    expect(runOf()).toMatchObject({ stage: 'song', errorCode: 'PUBLISH_LOGIN_REQUIRED' });
    expect(runOf().stages.song.status).toBe('failed');
    // The earlier stages' output survived: nothing is re-drafted on retry.
    const briefCalls = calls.filter((c) => c === 'brief').length;

    await service.resumeAutonomousVideo('mv-auto');
    await vi.waitFor(() => expect(calls).toContain('production'));
    expect(calls.filter((c) => c === 'brief').length).toBe(briefCalls);
    expect(runOf().stages.song.status).toBe('done');
  });

  it('keeps the submitted Suno songs when the download fails, so a retry reuses them', async () => {
    doubles.generateSunoSong.mockImplementationOnce(async (_f, opts) => {
      await opts.onSubmitted(['song-a', 'song-b']);
      throw new Error('did not finish rendering');
    });
    await service.startAutonomousVideo({ prompt: 'p' });
    await settled('failed');
    expect(runOf().output.sunoSongIds).toEqual(['song-a', 'song-b']);

    await service.resumeAutonomousVideo('mv-auto');
    await vi.waitFor(() => expect(calls).toContain('production'));
    expect(doubles.generateSunoSong).toHaveBeenLastCalledWith(expect.any(Object), expect.objectContaining({ songIds: ['song-a', 'song-b'] }));
  });

  it('refuses to resume a finished run and to start a second advance of a live one', async () => {
    await service.startAutonomousVideo({ prompt: 'p' });
    await vi.waitFor(() => expect(runOf()?.output.productionRunId).toBe('mvpr-1'));
    await expect(service.resumeAutonomousVideo('mv-auto')).rejects.toMatchObject({ code: 'ALREADY_RUNNING' });
    await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: { status: 'completed' } });
    await service.__testing.onRenderEvent({ projectId: 'mv-auto', jobId: 'render-1', status: 'completed' });
    await expect(service.resumeAutonomousVideo('mv-auto')).rejects.toMatchObject({ code: 'NOT_RESUMABLE' });
  });
});

describe('local song source (#9473)', () => {
  it('runs end to end with Suno never touched: the track exists first, the render lands on it, then analysis', async () => {
    doubles.generateSunoSong.mockRejectedValue(new Error('Suno must not be used'));
    await service.startAutonomousVideo({ prompt: 'p', songSource: 'local', instrumental: false });
    await vi.waitFor(() => expect(calls).toContain('production'));
    expect(calls).toEqual(['createProject', 'brief', 'updateProject', 'lyrics', 'board', 'updateProject', 'track', 'local', 'updateProject', 'analyze', 'production']);
    expect(doubles.generateLocalSong).toHaveBeenCalledWith(expect.objectContaining({
      trackId: 'track-1', title: 'Neon Rain', lyrics: '[verse]\nrain on glass', instrumental: false,
      prompt: 'Synthwave with a melancholic arc\n\nsynthwave, dreamy, 100 bpm',
    }));
    expect(runOf().output).toMatchObject({ trackId: 'track-1', localTrackId: 'track-1', localSongJobId: 'job-local', songSource: 'local' });
    expect(store.get('mv-auto').trackId).toBe('track-1');
  });

  it('retries a failed render on the same track and job instead of creating a second track', async () => {
    doubles.generateLocalSong.mockImplementationOnce(async ({ onSubmitted }) => {
      await onSubmitted('job-local');
      throw new Error('out of memory');
    });
    await service.startAutonomousVideo({ prompt: 'p', songSource: 'local' });
    await settled('failed');
    await service.resumeAutonomousVideo('mv-auto');
    await vi.waitFor(() => expect(calls).toContain('production'));
    expect(calls.filter((c) => c === 'track')).toHaveLength(1);
    expect(doubles.generateLocalSong).toHaveBeenLastCalledWith(expect.objectContaining({ trackId: 'track-1', jobId: 'job-local' }));
  });

  it('falls back to the local engine when the brief opts in and Suno cannot take the request', async () => {
    doubles.generateSunoSong.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Sign in to Suno'), { code: 'PUBLISH_LOGIN_REQUIRED' });
    });
    await service.startAutonomousVideo({ prompt: 'p', localFallback: true });
    await vi.waitFor(() => expect(calls).toContain('production'));
    expect(calls).toContain('local');
    expect(runOf().output).toMatchObject({ songSource: 'local', songFallbackReason: 'Sign in to Suno', trackId: 'track-1' });
  });

  it('does not fall back without the opt-in, nor after Suno already took credits for the request', async () => {
    doubles.generateSunoSong.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Sign in to Suno'), { code: 'PUBLISH_LOGIN_REQUIRED' });
    });
    await service.startAutonomousVideo({ prompt: 'p' });
    await settled('needs-human');
    expect(calls).not.toContain('local');
  });

  it('keeps the Suno songs when the download fails even with the fallback on', async () => {
    doubles.generateSunoSong.mockImplementationOnce(async (_f, opts) => {
      await opts.onSubmitted(['song-a']);
      throw new Error('did not finish rendering');
    });
    await service.startAutonomousVideo({ prompt: 'p', localFallback: true });
    await settled('failed');
    expect(calls).not.toContain('local');
    expect(runOf().output.sunoSongIds).toEqual(['song-a']);
  });

  it.each(['stopAutonomousVideo', 'cancelAutonomousVideo'])('aborts a Suno export through %s and preserves its submitted ids without attaching audio', async (action) => {
    let signal;
    let ended = false;
    doubles.generateSunoSong.mockImplementationOnce(async (_fields, opts) => {
      signal = opts.signal;
      await opts.onSubmitted(['song-a', 'song-b']);
      try {
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
      } finally { ended = true; }
    });
    await service.startAutonomousVideo({ prompt: 'p', localFallback: true });
    await vi.waitFor(() => expect(runOf()?.output.sunoSongIds).toEqual(['song-a', 'song-b']));
    await service[action]('mv-auto');
    await vi.waitFor(() => expect(ended).toBe(true));
    expect(signal.aborted).toBe(true);
    expect(runOf()).toMatchObject({ status: action === 'stopAutonomousVideo' ? 'stopped' : 'canceled', output: { sunoSongIds: ['song-a', 'song-b'] } });
    expect(doubles.createTrack).not.toHaveBeenCalled();
    expect(doubles.generateLocalSong).not.toHaveBeenCalled();
  });

  it.each([false, true])('settles a stopped Suno attempt before resuming, honoring a later Cancel (%s)', async (cancelWhileWaiting) => {
    let rejectPending;
    doubles.generateSunoSong.mockImplementationOnce(async (_fields, opts) => {
      await opts.onSubmitted(['song-a', 'song-b']);
      return new Promise((_, reject) => { rejectPending = reject; });
    });
    await service.startAutonomousVideo({ prompt: 'example' });
    await vi.waitFor(() => expect(rejectPending).toBeTypeOf('function'));
    await service.stopAutonomousVideo('mv-auto');
    const resumed = service.resumeAutonomousVideo('mv-auto');
    const result = cancelWhileWaiting
      ? expect(resumed).rejects.toMatchObject({ code: 'NOT_RESUMABLE' })
      : expect(resumed).resolves.toMatchObject({ run: { status: 'running' } });
    if (cancelWhileWaiting) await service.cancelAutonomousVideo('mv-auto');
    expect(doubles.generateSunoSong).toHaveBeenCalledTimes(1);
    rejectPending(new Error('Export cancelled by earlier Stop'));
    await result;
    if (cancelWhileWaiting) {
      expect(runOf().status).toBe('canceled');
      expect(doubles.generateSunoSong).toHaveBeenCalledTimes(1);
    } else {
      await vi.waitFor(() => expect(calls).toContain('production'));
      expect(doubles.generateSunoSong).toHaveBeenCalledTimes(2);
      expect(doubles.generateSunoSong).toHaveBeenLastCalledWith(expect.any(Object), expect.objectContaining({ songIds: ['song-a', 'song-b'] }));
      expect(runOf()).toMatchObject({ status: 'running', error: null });
    }
  });

  it('cancels the queued render on stop and leaves the run stopped, not failed', async () => {
    let release;
    doubles.generateLocalSong.mockImplementationOnce(async ({ onSubmitted }) => {
      await onSubmitted('job-local');
      await new Promise((resolve) => { release = resolve; });
      throw new Error('The local song was canceled');
    });
    await service.startAutonomousVideo({ prompt: 'p', songSource: 'local' });
    await vi.waitFor(() => expect(runOf()?.output.localSongJobId).toBe('job-local'));
    await service.stopAutonomousVideo('mv-auto');
    expect(doubles.cancelLocalSong).toHaveBeenCalledWith('job-local');
    release();
    await new Promise((resolve) => setTimeout(resolve, 20)); // the aborted stage settles in the background
    expect(runOf()).toMatchObject({ status: 'stopped', stage: 'song' });
    expect(runOf().stages.song.status).toBe('running');
  });

  it('cancels a render queued after the run was already stopped, so no orphan job keeps the GPU busy', async () => {
    let queued;
    doubles.generateLocalSong.mockImplementationOnce(async ({ onSubmitted }) => {
      await new Promise((resolve) => { queued = resolve; }); // engine pick / enqueue still in flight
      await onSubmitted('job-late');
      return { filename: 'song.wav' };
    });
    await service.startAutonomousVideo({ prompt: 'p', songSource: 'local' });
    await vi.waitFor(() => expect(queued).toBeTypeOf('function'));
    await service.stopAutonomousVideo('mv-auto');
    expect(doubles.cancelLocalSong).not.toHaveBeenCalled(); // nothing was queued yet
    queued();
    await vi.waitFor(() => expect(doubles.cancelLocalSong).toHaveBeenCalledWith('job-late'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runOf()).toMatchObject({ status: 'stopped', stage: 'song' });
    expect(calls).not.toContain('analyze');
  });
});

describe('events and process pinning', () => {
  it('publishes every change over the autonomous event', async () => {
    const seen = [];
    const listener = (e) => seen.push(e.run.status);
    musicVideoEvents.on('autonomous', listener);
    await service.startAutonomousVideo({ prompt: 'p', checkpoints: ['song'] });
    await settled('awaiting-approval');
    musicVideoEvents.off('autonomous', listener);
    expect(seen[0]).toBe('running');
    expect(seen.at(-1)).toBe('awaiting-approval');
  });

  it('shows a run pinned to another server process as interrupted and does not advance it', async () => {
    await service.startAutonomousVideo({ prompt: 'p', checkpoints: ['lyrics'] });
    await settled('awaiting-approval');
    const stale = { ...runOf(), status: 'running', processId: 'proc-from-before-restart' };
    store.set('mv-auto', { ...store.get('mv-auto'), autonomousRun: stale });
    expect(service.presentAutonomousRun(stale).interrupted).toBe(true);
    const before = calls.length;
    await service.__testing.advance('mv-auto');
    expect(calls.length).toBe(before);
  });
});

it('parks standalone code at the art and storyboard gates, then renders the final without an animated proof', async () => {
  creativeReview.real = true;
  const { approveProductionStage, productionReviewBasis } = await vi.importActual('./productionReview.js');
  const { renderProductionProof } = await import('./productionReviewService.js');
  doubles.analyzeSong.mockImplementation(async () => {
    Object.assign(store.get('mv-auto'), {
      audioAnalysis: { durationSec: 20, sections: [{ id: 'chorus', label: 'Chorus', startSec: 18, endSec: 20 }] },
      scenes: [{ sceneId: 'shot', startSec: 0, endSec: 20, label: 'Chorus' }],
      devArtifacts: [{ id: 'guide', version: 1, file: 'guide.html', mimeType: 'text/html' }],
      productionReview: { draft: {
        cast: 'Paper dancer', environments: 'Theatre', visualLanguage: 'Ink silhouettes', motionLanguage: 'Slow orbit',
        guideArtifactId: 'guide', lyricsMode: 'instrumental', timingNotes: '',
        storyboard: [{ sceneId: 'shot', lyricCueIds: [], action: 'Dancer unfolds', staging: 'Wide theatre', camera: 'Orbit', transition: 'Fade' }],
      } },
    });
  });
  doubles.generateDocument.mockResolvedValue({ document: { directory: 'music-video/mv-auto/composition/example' } });
  const approve = stage => {
    const project = store.get('mv-auto');
    store.set(project.id, approveProductionStage(project, { stage, basis: productionReviewBasis(project)[stage] }));
  };
  await service.startAutonomousVideo({ prompt: 'Synthetic animation', tools: ['code:render'], authoring: { providerId: 'example', model: 'example-code' } });
  await settled('needs-human');
  expect(doubles.generateDocument).not.toHaveBeenCalled();
  expect(doubles.renderVideo).not.toHaveBeenCalled();
  approve('art');
  await service.resumeAutonomousVideo('mv-auto');
  await settled('needs-human');
  expect(doubles.renderVideo).not.toHaveBeenCalled();
  // An instrumental needs no typed reason; approving the storyboard is enough.
  approve('storyboard');
  await service.resumeAutonomousVideo('mv-auto');
  await vi.waitFor(() => expect(runOf()?.output.renderJobId).toBe('render-1'));
  await service.__testing.onRenderEvent({ projectId: 'mv-auto', jobId: 'render-1', status: 'completed' });
  await settled('completed');
  expect(renderProductionProof).not.toHaveBeenCalled();
  expect(store.get('mv-auto').productionReview.approvals.proof).toBeUndefined();
  expect(doubles.renderVideo).toHaveBeenCalledOnce();
  expect(doubles.generateDocument).toHaveBeenCalledOnce();
  expect(doubles.startProduction).not.toHaveBeenCalled();
});

describe('auto-approve the rest (brief.autoApprove)', () => {
  let actual;
  beforeEach(async () => {
    creativeReview.real = true;
    actual = await vi.importActual('./productionReview.js');
    // The service's persistence path, minus the operator check the route owns.
    doubles.approveProductionReview = stub('approve', async (id, input) => {
      store.set(id, clone(actual.approveProductionStage(clone(store.get(id)), input)));
    });
    doubles.wait = vi.fn(async () => {});
    service.__setAutonomousDepsForTests(doubles);
  });
  const reviewFixture = (draft = {}) => doubles.analyzeSong.mockImplementation(async () => {
    Object.assign(store.get('mv-auto'), {
      audioAnalysis: { durationSec: 20, sections: [{ id: 'chorus', label: 'Chorus', startSec: 0, endSec: 20 }] },
      scenes: [{ sceneId: 'shot', startSec: 0, endSec: 20, label: 'Chorus' }],
      devArtifacts: [{ id: 'guide', version: 1, file: 'guide.html', mimeType: 'text/html' }],
      productionReview: { draft: {
        cast: 'Paper dancer', environments: 'Theatre', visualLanguage: 'Ink silhouettes', motionLanguage: 'Slow orbit',
        guideArtifactId: 'guide', lyricsMode: 'instrumental', timingNotes: 'Synthetic instrumental master checked.',
        storyboard: [{ sceneId: 'shot', lyricCueIds: [], action: 'Dancer unfolds', staging: 'Wide theatre', camera: 'Orbit', transition: 'Fade' }],
        ...draft,
      } },
    });
  });
  const approvals = () => store.get('mv-auto').productionReview.approvals || {};

  it('is granted only with operator authority, on start or on a resume of a parked run, and then approves clean art and storyboard itself', async () => {
    reviewFixture();
    await expect(service.startAutonomousVideo({ prompt: 'p', tools: ['image:local'], autoApprove: ['art'] }))
      .rejects.toMatchObject({ status: 403, code: 'AUTH_REQUIRED' });
    expect(store.size).toBe(0);

    await service.startAutonomousVideo({ prompt: 'p', tools: ['image:local'] });
    await settled('needs-human');
    expect(runOf()).toMatchObject({ errorCode: 'MUSIC_VIDEO_APPROVAL_REQUIRED', brief: { autoApprove: [], autoApproveAuthorizedAt: null } });
    await expect(service.resumeAutonomousVideo('mv-auto', { autoApprove: ['art', 'storyboard'] }))
      .rejects.toMatchObject({ status: 403, code: 'AUTH_REQUIRED' });
    expect(runOf()).toMatchObject({ status: 'needs-human', brief: { autoApprove: [] } });
    expect(doubles.approveProductionReview).not.toHaveBeenCalled();

    await service.resumeAutonomousVideo('mv-auto', { autoApprove: ['art', 'storyboard'] }, { autoApproveAuthorized: true });
    await vi.waitFor(() => expect(doubles.startProduction).toHaveBeenCalledOnce());
    expect(runOf().brief).toMatchObject({ autoApprove: ['art', 'storyboard'], autoApproveAuthorizedAt: expect.any(String) });
    expect(doubles.approveProductionReview.mock.calls.map(([, input]) => input.stage)).toEqual(['art', 'storyboard']);
    expect(approvals()).toMatchObject({ art: { approvedBy: 'autopilot' }, storyboard: { approvedBy: 'autopilot' } });
    expect(approvals().proof).toBeUndefined();
    expect(actual.productionReadiness(store.get('mv-auto')).storyboard.approved).toBe(true);
  });

  it('never approves past a readiness problem: the run parks for a human at that stage', async () => {
    // A vocal song with no lyrics imported is a real readiness problem.
    reviewFixture({ lyricsMode: 'vocal' });
    await service.startAutonomousVideo({ prompt: 'p', tools: ['image:local'], autoApprove: ['art', 'storyboard'] }, { autoApproveAuthorized: true });
    await settled('needs-human');
    expect(runOf()).toMatchObject({ errorCode: 'MUSIC_VIDEO_APPROVAL_REQUIRED', error: expect.stringContaining('Import lyrics') });
    expect(approvals().art).toMatchObject({ approvedBy: 'autopilot' });
    expect(approvals().storyboard).toBeUndefined();
    expect(doubles.startProduction).not.toHaveBeenCalled();
  });

  // Uniquely catches a code-first plan with an unfilmable performance shot being approved and then failing production.
  it('re-plans a performance shot with no footage as a cutaway before approving the storyboard', async () => {
    reviewFixture();
    const { buildTreatmentDraft } = await import('./treatmentDraft.js');
    const { writeCompiledTreatment, applyTreatmentToProject, treatmentBasis } = await import('./treatment.js');
    const { codeFirstProductionAssets } = await import('../../lib/musicVideoMediumPlan.js');
    doubles.approveProductionReview.mockImplementation(async (id, input) => {
      let project = clone(store.get(id));
      if (input.stage === 'art' && !project.treatment) {
        // What preparing the storyboard does for a code-first project: a deterministic plan, applied.
        const compiled = writeCompiledTreatment(project, { baseRevision: 0, basis: treatmentBasis(project), draft: buildTreatmentDraft(project),
          compiledWith: { source: 'deterministic', providerId: null, model: null } });
        compiled.treatment.shotDirections = compiled.treatment.shotDirections.map((d) => ({ ...d, mode: 'performance', medium: 'procedural' }));
        project = applyTreatmentToProject(compiled, { revision: compiled.treatment.revision }).project;
      }
      store.set(id, clone(actual.approveProductionStage(project, input)));
    });
    await service.startAutonomousVideo({ prompt: 'p', tools: ['image:local'], mediaMode: 'code-images', autoApprove: ['art', 'storyboard'] }, { autoApproveAuthorized: true });
    await vi.waitFor(() => expect(doubles.approveProductionReview).toHaveBeenCalledTimes(2));
    const project = store.get('mv-auto');
    expect(project.productionPolicy).toMatchObject({ strategy: 'code-first', maxGeneratedVideoPercent: 0 });
    expect(project.treatment.shotDirections.map((d) => d.mode)).toEqual(['cutaway']);
    expect(project.treatment.appliedRevision).toBe(project.treatment.revision);
    expect(codeFirstProductionAssets(project).conflicts).toEqual([]);
    expect(approvals().storyboard).toMatchObject({ approvedBy: 'autopilot' });
  });

  it('ignores a legacy proof grant: code renders the final without rendering or approving a proof', async () => {
    reviewFixture();
    const { renderProductionProof } = await import('./productionReviewService.js');
    await service.startAutonomousVideo({ prompt: 'p', tools: ['code:render'], authoring: { providerId: 'example', model: 'example-code' },
      autoApprove: ['art', 'storyboard', 'proof'] }, { autoApproveAuthorized: true });
    await vi.waitFor(() => expect(doubles.renderVideo).toHaveBeenCalledOnce());
    expect(renderProductionProof).not.toHaveBeenCalled();
    expect(approvals().proof).toBeUndefined();
    expect(actual.productionReadiness(store.get('mv-auto')).readyForProduction).toBe(true);
  });

  describe('waiting for Cast & Sets before the art gate (#10431)', () => {
    const setCast = (castAndSets) => { store.get('mv-auto').castAndSets = castAndSets; };
    const settleCast = (patch) => {
      Object.assign(store.get('mv-auto').castAndSets, patch);
      musicVideoEvents.emit('cast-and-sets', { projectId: 'mv-auto', stage: store.get('mv-auto').castAndSets });
    };
    const startWithCastDirecting = async (autoApprove) => {
      reviewFixture();
      // The guide is not there yet: no artifact on the draft, Cast & Sets still directing.
      const analyze = doubles.analyzeSong.getMockImplementation();
      doubles.analyzeSong.mockImplementation(async (...args) => {
        await analyze(...args);
        store.get('mv-auto').productionReview.draft.guideArtifactId = null;
        setCast({ status: 'directing', processId: 'cast-proc', revision: 1, images: {}, plan: {} });
      });
      await service.startAutonomousVideo({ prompt: 'p', tools: ['image:local'], ...(autoApprove ? { autoApprove } : {}) }, { autoApproveAuthorized: true });
      await vi.waitFor(() => expect(runOf()?.stages.produce.step).toBe('cast-and-sets'));
    };

    it('does not park while Cast & Sets is directing, then auto-approves art once it settles', async () => {
      await startWithCastDirecting(['art', 'storyboard']);
      expect(runOf()).toMatchObject({ status: 'running', stage: 'produce' });
      expect(doubles.approveProductionReview).not.toHaveBeenCalled();

      // The guide lands: direction + sheet, stage in review.
      store.get('mv-auto').productionReview.draft.guideArtifactId = 'guide';
      settleCast({ status: 'review', direction: { cast: 'x' }, artifactId: 'guide' });
      await vi.waitFor(() => expect(doubles.startProduction).toHaveBeenCalledOnce());
      expect(doubles.approveProductionReview.mock.calls.map(([, input]) => input.stage)).toEqual(['art', 'storyboard']);
    });

    it('without an art grant parks for a human only after the guide exists', async () => {
      await startWithCastDirecting();
      expect(runOf().status).toBe('running');
      store.get('mv-auto').productionReview.draft.guideArtifactId = 'guide';
      settleCast({ status: 'review', direction: { cast: 'x' }, artifactId: 'guide' });
      await settled('needs-human');
      expect(runOf()).toMatchObject({ errorCode: 'MUSIC_VIDEO_APPROVAL_REQUIRED' });
      expect(doubles.approveProductionReview).not.toHaveBeenCalled();
    });

    it('parks failed with the Cast & Sets error when it fails', async () => {
      await startWithCastDirecting(['art']);
      settleCast({ status: 'failed', stopReason: 'The character image failed twice' });
      await settled('failed');
      expect(runOf()).toMatchObject({ errorCode: 'CAST_SETS_FAILED', error: expect.stringContaining('The character image failed twice') });
    });
  });
});

describe('autopilot clears the gates it was granted on its own', () => {
  let actual;
  let prepare;
  beforeEach(async () => {
    creativeReview.real = true;
    actual = await vi.importActual('./productionReview.js');
    ({ prepareProductionReview: prepare } = await import('./productionReviewService.js'));
    doubles.approveProductionReview = stub('approve', async (id, input) => {
      store.set(id, clone(actual.approveProductionStage(clone(store.get(id)), input)));
    });
    doubles.verifyAlignment = stub('verify', async (id, { basis, notes, reviewer }) => {
      const project = store.get(id);
      project.productionReview = { ...project.productionReview, alignmentBasis: basis, alignmentReview: { basis, reviewer },
        draft: { ...project.productionReview.draft, timingStatus: 'verified', timingNotes: notes } };
    });
    doubles.alignLyrics = stub('align', async () => {});
    service.__setAutonomousDepsForTests(doubles);
  });
  afterEach(() => { prepare.mockReset(); prepare.mockImplementation(async () => {}); });

  const GUIDE = { cast: 'Paper dancer', environments: 'Theatre', visualLanguage: 'Ink silhouettes', motionLanguage: 'Slow orbit', guideArtifactId: 'guide' };
  const shot = { sceneId: 'shot', lyricCueIds: [], action: 'Dancer unfolds', staging: 'Wide theatre', camera: 'Orbit', transition: 'Fade' };
  const analyzed = (extra) => doubles.analyzeSong.mockImplementation(async () => {
    Object.assign(store.get('mv-auto'), {
      audioAnalysis: { durationSec: 20, sections: [{ id: 'chorus', label: 'Chorus', startSec: 0, endSec: 20 }] },
      scenes: [{ sceneId: 'shot', startSec: 0, endSec: 20, label: 'Chorus' }],
      devArtifacts: [{ id: 'guide', version: 1, file: 'guide.html', mimeType: 'text/html' }],
      ...extra,
    });
  });
  const GRANT = [{ autoApprove: ['art', 'storyboard'] }, { autoApproveAuthorized: true }];

  it('aligns, times and verifies the lyrics of a vocal song, then approves the storyboard', async () => {
    analyzed({
      lyricCues: [
        { id: 'c1', text: 'rain on glass', startSec: 1, endSec: 4, words: [
          { w: 'rain', startSec: 1, endSec: 2, conf: 'matched' }, { w: 'on', startSec: 2, endSec: 3, conf: 'matched' }, { w: 'glass', startSec: 3, endSec: 4, conf: 'matched' }] },
        { id: 'c2', text: 'neon home', startSec: null, endSec: null },
      ],
      productionReview: { draft: { ...GUIDE, lyricsMode: 'vocal', timingStatus: 'provisional', timingNotes: '', storyboard: [shot] } },
    });
    await service.startAutonomousVideo({ prompt: 'p', tools: ['image:local'], ...GRANT[0] }, GRANT[1]);
    await vi.waitFor(() => expect(doubles.startProduction).toHaveBeenCalledOnce());
    const project = store.get('mv-auto');
    expect(doubles.alignLyrics).toHaveBeenCalledWith('mv-auto');
    expect(project.lyricCues[1]).toMatchObject({ startSec: 4, endSec: 20, words: [{ w: 'neon', conf: 'interpolated' }, { w: 'home' }] });
    expect(project.productionReview.alignmentReview.reviewer).toMatchObject({ kind: 'autopilot', runId: runOf().id });
    expect(project.productionReview.draft.storyboard[0].lyricCueIds).toEqual(['c1', 'c2']);
    expect(project.productionReview.approvals).toMatchObject({ art: { approvedBy: 'autopilot' }, storyboard: { approvedBy: 'autopilot' } });
  });

  // Uniquely catches verified timing on the source being re-judged (and held) on the copy.
  it('carries a source\'s verified lyric timing over unchanged, without re-aligning', async () => {
    const source = clone(SONG_SOURCE);
    source.productionReview.alignmentBasis = actual.productionAlignmentBasis(source);
    store.set('mv-src', source);
    doubles.getTrack = vi.fn(async () => null);
    service.__setAutonomousDepsForTests(doubles);
    prepare.mockImplementation(async (id) => {
      const project = store.get(id);
      if (project.productionReview?.draft?.storyboard) return;
      Object.assign(project, {
        scenes: [{ sceneId: 'shot', startSec: 0, endSec: 20, label: 'Chorus' }],
        devArtifacts: [{ id: 'guide', version: 1, file: 'guide.html', mimeType: 'text/html' }],
        productionReview: { ...project.productionReview, draft: { ...GUIDE, lyricsMode: 'vocal', timingStatus: 'provisional', timingNotes: '', storyboard: [shot] } },
      });
    });
    await service.startAutonomousVideo({ prompt: 'p', tools: ['image:local'], fromProjectId: 'mv-src', ...GRANT[0] }, GRANT[1]);
    await vi.waitFor(() => expect(doubles.startProduction).toHaveBeenCalledOnce());
    expect(doubles.alignLyrics).not.toHaveBeenCalled();
    expect(doubles.analyzeSong).not.toHaveBeenCalled();
    expect(doubles.verifyAlignment).toHaveBeenCalledWith('mv-auto', expect.objectContaining({ notes: expect.stringContaining('source project') }));
  });

  // Uniquely catches a run granted the storyboard parking for the director when a lyric edit stales that approval mid-production.
  it('approves a storyboard an edit staled again and resumes production', async () => {
    analyzed({ productionReview: { draft: { ...GUIDE, lyricsMode: 'instrumental', timingNotes: 'Synthetic instrumental master checked.', storyboard: [shot] } } });
    await service.startAutonomousVideo({ prompt: 'p', tools: ['image:local'], ...GRANT[0] }, GRANT[1]);
    await vi.waitFor(() => expect(doubles.startProduction).toHaveBeenCalledOnce());
    const project = store.get('mv-auto');
    project.scenes[0].lyricText = 'a changed lyric';
    project.productionRuns = [{ id: 'mvpr-1', status: 'blocked', createdAt: new Date().toISOString() }];
    expect(actual.productionReadiness(project).storyboard.approved).toBe(false);
    doubles.approveProductionReview.mockClear();
    await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: { status: 'blocked', stopReason: 'Production review needs human approval' } });
    expect(doubles.approveProductionReview).toHaveBeenCalledWith('mv-auto', expect.objectContaining({ stage: 'storyboard', approvedBy: 'autopilot' }));
    expect(actual.productionReadiness(store.get('mv-auto')).storyboard.approved).toBe(true);
    expect(doubles.resumeProduction).toHaveBeenCalledWith('mv-auto', 'mvpr-1', { acceptBasis: true });
    expect(runOf().status).toBe('running');
  });

  it('marks an instrumental song as one instead of asking for lyrics', async () => {
    analyzed({ productionReview: { draft: { ...GUIDE, lyricsMode: 'vocal', storyboard: [shot] } } });
    await service.startAutonomousVideo({ prompt: 'p', tools: ['image:local'], instrumental: true, ...GRANT[0] }, GRANT[1]);
    await vi.waitFor(() => expect(doubles.startProduction).toHaveBeenCalledOnce());
    expect(store.get('mv-auto').productionReview.draft.lyricsMode).toBe('instrumental');
    expect(doubles.alignLyrics).not.toHaveBeenCalled();
  });

  it('still parks for a human on a lyric line it cannot time', async () => {
    analyzed({
      audioAnalysis: { durationSec: 20 },
      lyricCues: [{ id: 'c1', text: 'rain on glass', startSec: null, endSec: null }, { id: 'c2', text: 'neon home', startSec: 0, endSec: 20,
        words: [{ w: 'neon', startSec: 0, endSec: 10, conf: 'matched' }, { w: 'home', startSec: 10, endSec: 20, conf: 'matched' }] }],
      productionReview: { draft: { ...GUIDE, lyricsMode: 'vocal', timingStatus: 'provisional', storyboard: [shot] } },
    });
    await service.startAutonomousVideo({ prompt: 'p', tools: ['image:local'], ...GRANT[0] }, GRANT[1]);
    await settled('needs-human');
    expect(runOf().errorCode).toBe('MUSIC_VIDEO_APPROVAL_REQUIRED');
    expect(doubles.verifyAlignment).not.toHaveBeenCalled();
    expect(doubles.startProduction).not.toHaveBeenCalled();
  });

  it.each([
    ['the aligner fails', async () => { throw new Error('aligner offline'); }, 'Lyric alignment failed (aligner offline)'],
    ['the recognizer hears none of the words', async () => {}, 'Too little of the vocal was heard'],
  ])('does not verify guessed timings when %s', async (_, align, reason) => {
    doubles.alignLyrics = stub('align', align);
    service.__setAutonomousDepsForTests(doubles);
    analyzed({
      lyricCues: [{ id: 'c1', text: 'rain on glass', startSec: null, endSec: null }, { id: 'c2', text: 'neon home', startSec: null, endSec: null }],
      productionReview: { draft: { ...GUIDE, lyricsMode: 'vocal', timingStatus: 'provisional', storyboard: [shot] } },
    });
    await service.startAutonomousVideo({ prompt: 'p', tools: ['image:local'], ...GRANT[0] }, GRANT[1]);
    await settled('needs-human');
    expect(runOf()).toMatchObject({ errorCode: 'MUSIC_VIDEO_APPROVAL_REQUIRED', error: expect.stringContaining(reason) });
    // Skipped lines split the gap by word count instead of each taking the whole song.
    expect(store.get('mv-auto').lyricCues.map((c) => [c.startSec, c.endSec])).toEqual([[0, 12], [12, 20]]);
    expect(doubles.verifyAlignment).not.toHaveBeenCalled();
    expect(doubles.startProduction).not.toHaveBeenCalled();
  });

  it('keeps holding on a failed alignment until the timings change, then verifies a re-alignment by hand', async () => {
    doubles.alignLyrics = stub('align', async () => { throw new Error('aligner offline'); });
    service.__setAutonomousDepsForTests(doubles);
    analyzed({
      lyricCues: [{ id: 'c1', text: 'rain on glass', startSec: null, endSec: null }, { id: 'c2', text: 'neon home', startSec: null, endSec: null }],
      productionReview: { draft: { ...GUIDE, lyricsMode: 'vocal', timingStatus: 'provisional', storyboard: [shot] } },
    });
    await service.startAutonomousVideo({ prompt: 'p', tools: ['image:local'], ...GRANT[0] }, GRANT[1]);
    await settled('needs-human');

    // Unchanged timings: the stored error still describes them.
    await service.resumeAutonomousVideo('mv-auto');
    await settled('needs-human');
    expect(runOf().error).toContain('Lyric alignment failed (aligner offline)');

    const heard = (w, startSec) => ({ w, startSec, endSec: startSec + 1, conf: 'matched' });
    store.get('mv-auto').lyricCues = [
      { id: 'c1', text: 'rain on glass', startSec: 0, endSec: 12, words: [heard('rain', 0), heard('on', 1), heard('glass', 2)] },
      { id: 'c2', text: 'neon home', startSec: 12, endSec: 20, words: [heard('neon', 12), heard('home', 13)] },
    ];
    await service.resumeAutonomousVideo('mv-auto');
    await vi.waitFor(() => expect(doubles.startProduction).toHaveBeenCalledOnce());
    expect(doubles.verifyAlignment).toHaveBeenCalledOnce();
  });
});

describe('orchestrated mode (brief.orchestrator)', () => {
  const ORCHESTRATOR = { providerId: 'orch', model: 'judge', effort: 'high' };
  let answers;
  const checkpointOf = (prompt) => (prompt.includes('the LYRICS') ? 'lyrics' : prompt.includes('SOUND AND LOOK') ? 'style'
    : prompt.includes('finished SONG') ? 'song' : prompt.includes('ART DIRECTION') ? 'art' : prompt.includes('STORYBOARD') ? 'storyboard'
      : prompt.includes('the STILLS') ? 'stills' : 'final');
  const reviews = () => (runOf().orchestration?.reviews || []).map((r) => `${r.checkpoint}:${r.verdict}`);

  beforeEach(() => {
    answers = {};
    doubles.orchestrate = vi.fn(async ({ prompt, images = [] }) => {
      const checkpoint = checkpointOf(prompt);
      const answer = (answers[checkpoint] || []).shift() || { verdict: 'approve', score: 8, notes: 'Ready.' };
      if (answer instanceof Error) throw answer;
      return { text: `Here is my call:\n${JSON.stringify(answer)}`, route: { providerId: 'orch', model: 'judge' }, visual: images.length > 0 };
    });
    doubles.galleryImagePath = vi.fn(async (filename) => `/gallery/${filename}`);
    doubles.alignLyrics = stub('align', async () => {});
    doubles.finalReviewFrames = vi.fn(async () => ({ images: [], frameTimes: [], facts: { error: 'no file in tests' }, cleanup: async () => {} }));
    service.__setAutonomousDepsForTests(doubles);
  });

  it('needs a signed-in session, replaces the checkpoints, and revises lyrics, style and a local song before production', async () => {
    await expect(service.startAutonomousVideo({ prompt: 'p', orchestrator: ORCHESTRATOR })).rejects.toMatchObject({ status: 403, code: 'AUTH_REQUIRED' });
    expect(store.size).toBe(0);

    answers.lyrics = [{ verdict: 'revise', score: 5, notes: 'The hook never repeats.', lyrics: '[Chorus]\nrain rain on glass' }];
    answers.style = [{ verdict: 'revise', score: 6, notes: 'Name the tempo.', sunoStyle: 'synthwave, 96 bpm, airy female vocal', lookPrompt: 'wet neon, teal and magenta' }];
    answers.song = [{ verdict: 'retake', score: 3, notes: 'The vocal is missing.' }];
    await service.startAutonomousVideo({ prompt: 'p', tools: ['image:local'], songSource: 'local', checkpoints: ['lyrics', 'song'], orchestrator: ORCHESTRATOR },
      { autoApproveAuthorized: { kind: 'session' } });
    await vi.waitFor(() => expect(doubles.startProduction).toHaveBeenCalledOnce());

    expect(runOf().brief).toMatchObject({ checkpoints: [], orchestrator: ORCHESTRATOR, orchestratorAuthorizedBy: { kind: 'session' } });
    expect(reviews()).toEqual(['lyrics:revise', 'lyrics:approve', 'style:revise', 'style:approve', 'song:retake', 'song:approve']);
    // The revisions are what the song and mood board were made from.
    expect(runOf().output).toMatchObject({ lyrics: '[Chorus]\nrain rain on glass', sunoStyle: 'synthwave, 96 bpm, airy female vocal' });
    // Its notes render on the run's own image tool (#10531).
    expect(doubles.createMoodBoard).toHaveBeenCalledWith(expect.objectContaining({ stylePrompt: 'wet neon, teal and magenta' }),
      { renderRoute: { target: 'music-video', mode: 'local', model: undefined } });
    expect(doubles.generateLocalSong).toHaveBeenCalledTimes(2);
    expect(doubles.generateLocalSong.mock.calls[0][0]).toMatchObject({ lyrics: '[Chorus]\nrain rain on glass', prompt: expect.stringContaining('96 bpm') });
    // The orchestrator also judges production's plates and drafts.
    expect(doubles.startProduction).toHaveBeenCalledWith('mv-auto', expect.objectContaining({ reviewer: { providerId: 'orch', model: 'judge' } }));
    expect(doubles.orchestrate).toHaveBeenCalledWith(expect.objectContaining({ orchestrator: ORCHESTRATOR }));
  });

  // Uniquely catches a late song-retake verdict unlinking a canceled project's track or restarting song generation.
  it('keeps the song linked when a retake review returns after cancellation', async () => {
    const review = Promise.withResolvers();
    const orchestrate = doubles.orchestrate.getMockImplementation();
    doubles.orchestrate.mockImplementation((args) => checkpointOf(args.prompt) === 'song' ? review.promise : orchestrate(args));
    await service.startAutonomousVideo({ prompt: 'p', songSource: 'local', orchestrator: ORCHESTRATOR }, { autoApproveAuthorized: true });
    await vi.waitFor(() => expect(doubles.orchestrate.mock.calls.some(([args]) => checkpointOf(args.prompt) === 'song')).toBe(true));
    await service.cancelAutonomousVideo('mv-auto');
    review.resolve({ text: JSON.stringify({ verdict: 'retake', score: 3, notes: 'Try another take.' }), route: ORCHESTRATOR, visual: false });
    await service.__testing.settleBackground();
    expect(runOf()).toMatchObject({ status: 'canceled', stage: 'analyze' });
    expect(store.get('mv-auto').trackId).toBe('track-1');
    expect(doubles.generateLocalSong).toHaveBeenCalledOnce();
    expect(doubles.startProduction).not.toHaveBeenCalled();
  });

  // Uniquely catches a run with no video tool spending on clips, the orchestrator approving stills it never saw,
  // or a flagged still not going back to production with the fix.
  it('stops production after the stills, regenerates the ones the orchestrator flags, then waits for the director', async () => {
    await service.startAutonomousVideo({ prompt: 'p', tools: ['image:local'], orchestrator: ORCHESTRATOR }, { autoApproveAuthorized: true });
    await vi.waitFor(() => expect(doubles.startProduction).toHaveBeenCalledOnce());
    expect(doubles.startProduction).toHaveBeenCalledWith('mv-auto', expect.objectContaining({ stopBefore: 'clips' }));
    store.get('mv-auto').scenes = [
      { sceneId: 'mvs-a', label: 'Intro', framePrompt: 'a skater at dusk', referenceImageId: 'a1.png' },
      { sceneId: 'mvs-b', label: 'Verse', framePrompt: 'a boardroom', referenceImageId: 'b1.png' },
    ];
    answers.stills = [{ verdict: 'revise', score: 5, notes: 'One extra hand.', issues: [{ sceneId: 'mvs-b', text: 'The chair has three hands on it.' }, { sceneId: 'mvs-x', text: 'not a shot' }] }];
    await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: { status: 'awaiting-video' } });
    expect(doubles.orchestrate).toHaveBeenLastCalledWith(expect.objectContaining({ images: ['/gallery/a1.png', '/gallery/b1.png'] }));
    expect(store.get('mv-auto').scenes[1]).toMatchObject({ referenceImageId: 'b1.png', stillFixes: { text: 'The chair has three hands on it.', pending: true, replaces: 'b1.png' } });
    expect(store.get('mv-auto').scenes[0].referenceImageId).toBe('a1.png');
    expect(doubles.resumeProduction).toHaveBeenCalledWith('mv-auto', 'mvpr-1', { acceptBasis: true, stopBefore: 'clips' });
    expect(runOf().status).toBe('running');

    // The regenerated still passes: the run waits for the director, and approving goes on to the clips with the added video tool.
    store.get('mv-auto').scenes[1].referenceImageId = 'b2.png';
    await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: { status: 'awaiting-video' } });
    expect(reviews().filter((r) => r.startsWith('stills'))).toEqual(['stills:revise', 'stills:approve']);
    expect(runOf()).toMatchObject({ status: 'awaiting-approval', awaiting: 'stills' });
    store.get('mv-auto').productionRuns = [{ id: 'mvpr-1', status: 'awaiting-video', createdAt: new Date().toISOString() }];
    store.get('mv-auto').scenes[0].shotMode = 'performance';
    doubles.resumeProduction.mockClear();
    doubles.localVideoTakesSongAudio.mockResolvedValue(true);
    await service.resumeAutonomousVideo('mv-auto', { addTools: ['video:local'] });
    expect(runOf().brief).toMatchObject({ tools: ['image:local', 'video:local'], stopBeforeVideo: false });
    expect(store.get('mv-auto').automation.tools).toEqual(['image:local', 'video:local']);
    // The added local video tool sets the project's renderer, and a performance shot keeps lip-syncing on local LTX.
    expect(store.get('mv-auto').videoSettings).toMatchObject({ backend: 'local', generationMode: 'suppliedAudio' });
    expect(store.get('mv-auto').scenes[0].shotMode).toBe('performance');
    expect(doubles.resumeProduction).toHaveBeenCalledWith('mv-auto', 'mvpr-1', expect.objectContaining({
      pool: expect.arrayContaining([expect.objectContaining({ kind: 'video', mode: 'local' })]) }));
    expect(doubles.resumeProduction.mock.calls[0][2].stopBefore).toBeUndefined();
  });

  // Old saved shot approvals do not prevent an authorized still repair.
  it('lands still repairs on shots with legacy approvals and retains their old images as takes', async () => {
    const actual = await vi.importActual('./productionReview.js');
    await service.startAutonomousVideo({ prompt: 'p', tools: ['image:local'], orchestrator: ORCHESTRATOR }, { autoApproveAuthorized: true });
    await vi.waitFor(() => expect(doubles.startProduction).toHaveBeenCalledOnce());
    const runId = runOf().id;
    Object.assign(store.get('mv-auto'), {
      audioAnalysis: { durationSec: 20, sections: [{ id: 'chorus', label: 'Chorus', startSec: 0, endSec: 20 }] },
      scenes: [{ sceneId: 'mvs-a', label: 'Intro', startSec: 0, endSec: 10, framePrompt: 'a skater at dusk', referenceImageId: 'a1.png' },
        { sceneId: 'mvs-b', label: 'Verse', startSec: 10, endSec: 20, framePrompt: 'a boardroom', referenceImageId: 'b1.png' }],
      devArtifacts: [{ id: 'guide', version: 1, file: 'guide.html', mimeType: 'text/html' }],
      productionReview: { draft: { cast: 'A skater', environments: 'Skate park', visualLanguage: 'Ink', motionLanguage: 'Glide', guideArtifactId: 'guide',
        lyricsMode: 'instrumental', timingNotes: '', storyboard: [
        { sceneId: 'mvs-a', lyricCueIds: [], action: 'Skater rolls in', staging: 'Wide', camera: 'Track', transition: 'Cut' },
        { sceneId: 'mvs-b', lyricCueIds: [], action: 'Board meets', staging: 'Medium', camera: 'Static', transition: 'Cut' }] } },
    });
    for (const stage of ['art', 'storyboard']) {
      store.set('mv-auto', clone(actual.approveProductionStage(clone(store.get('mv-auto')), { stage, basis: actual.productionReadiness(store.get('mv-auto')).basis[stage],
        approvedBy: 'orchestrator', reviewer: { kind: 'orchestrator', runId, providerId: 'orch', model: 'judge' } })));
    }
    expect(actual.shotLocks(store.get('mv-auto'))).toEqual({ 'mvs-a': 'locked', 'mvs-b': 'locked' });

    answers.stills = [{ verdict: 'revise', score: 5, notes: 'One extra hand.', issues: [{ sceneId: 'mvs-b', text: 'The chair has three hands on it.' }] }];
    await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: { status: 'awaiting-video' } });
    expect(store.get('mv-auto').scenes[1]).toMatchObject({ referenceImageId: 'b1.png', stillFixes: { text: 'The chair has three hands on it.', pending: true, replaces: 'b1.png' } });
    expect(actual.shotLocks(store.get('mv-auto'))).toEqual({ 'mvs-a': 'locked', 'mvs-b': 'locked' });
    expect(store.get('mv-auto').productionReview.feedback || []).toEqual([]);
    expect(runOf().orchestration.reviews.at(-1).notes).toContain('Regenerating 1 still');
    expect(doubles.resumeProduction).toHaveBeenCalledWith('mv-auto', 'mvpr-1', { acceptBasis: true, stopBefore: 'clips' });

    // Legacy director-created locks are no longer a precondition for repairing a still.
    store.get('mv-auto').scenes[1].referenceImageId = 'b2.png';
    store.set('mv-auto', clone(actual.setShotLocks(clone(store.get('mv-auto')), { sceneIds: ['mvs-a', 'mvs-b'], locked: true, approvedBy: 'director' })));
    doubles.resumeProduction.mockClear();
    answers.stills = [{ verdict: 'revise', score: 5, notes: 'Wrong sky.', issues: [{ sceneId: 'mvs-a', text: 'The sky is noon, not dusk.' }] }];
    await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: { status: 'awaiting-video' } });
    expect(store.get('mv-auto').scenes[0]).toMatchObject({ referenceImageId: 'a1.png', stillFixes: { text: 'The sky is noon, not dusk.', pending: true, replaces: 'a1.png' },
      takes: expect.arrayContaining([expect.objectContaining({ kind: 'image', assetId: 'a1.png' })]) });
    const last = runOf().orchestration.reviews.at(-1);
    expect(last).toMatchObject({ checkpoint: 'stills', verdict: 'revise', notes: expect.stringContaining('Regenerating 1 still') });
    expect(doubles.resumeProduction).toHaveBeenCalledWith('mv-auto', 'mvpr-1', { acceptBasis: true, stopBefore: 'clips' });
    expect(runOf().status).toBe('running');
  });

  // Uniquely catches a 69-shot run parking at the default 40 generations before every shot has a still.
  it('grows a default generation limit to the shots left, but parks at a limit the director chose', async () => {
    await service.startAutonomousVideo({ prompt: 'p', tools: ['image:local'], orchestrator: ORCHESTRATOR }, { autoApproveAuthorized: true });
    await vi.waitFor(() => expect(doubles.startProduction).toHaveBeenCalledOnce());
    store.get('mv-auto').scenes = Array.from({ length: 30 }, (_, i) => ({ sceneId: `mvs-${i}`, label: `Shot ${i}`, framePrompt: 'a skater', ...(i < 5 ? { referenceImageId: `s${i}.png` } : {}) }));
    const limited = { status: 'limit-reached', stopBefore: 'clips', limits: { maxGenerations: 40 }, usage: { generations: 40 } };
    await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: limited });
    expect(doubles.resumeProduction).toHaveBeenCalledWith('mv-auto', 'mvpr-1', { acceptBasis: true, limits: { maxGenerations: 90 } });
    expect(runOf().status).toBe('running');

    store.delete('mv-auto');
    doubles.startProduction.mockClear();
    doubles.resumeProduction.mockClear();
    await service.startAutonomousVideo({ prompt: 'p', tools: ['image:local'], orchestrator: ORCHESTRATOR, limits: { maxGenerations: 40 } }, { autoApproveAuthorized: true });
    await vi.waitFor(() => expect(doubles.startProduction).toHaveBeenCalledOnce());
    store.get('mv-auto').scenes = [{ sceneId: 'mvs-a', label: 'Intro', framePrompt: 'a skater' }];
    await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: limited });
    expect(doubles.resumeProduction).not.toHaveBeenCalled();
    expect(runOf()).toMatchObject({ status: 'needs-human', errorCode: 'PRODUCTION_PARKED' });
  });

  describe('a production run blocked on its pilot', () => {
    let pilotInputBasis;
    let pilotDependencies;
    beforeEach(async () => {
      ({ pilotInputBasis, pilotDependencies } = await import('./productionPilot.js'));
      doubles.approveProductionReview = stub('approve', async () => {});
      service.__setAutonomousDepsForTests(doubles);
    });
    const pilotFixture = async (limits) => {
      await service.startAutonomousVideo({ prompt: 'p', tools: ['image:local', 'video:local'], orchestrator: ORCHESTRATOR, ...(limits ? { limits } : {}) }, { autoApproveAuthorized: true });
      await vi.waitFor(() => expect(doubles.startProduction).toHaveBeenCalledOnce());
      store.get('mv-auto').scenes = [{ sceneId: 'mvs-a', label: 'Skate park', startSec: 0, endSec: 4, prompt: 'a skater carves the bowl', referenceImageId: 'a1.png', videoHistoryId: 'clip-1', takes: [] }];
      store.get('mv-auto').productionRuns = [{ id: 'mvpr-1', status: 'blocked', createdAt: new Date().toISOString(), pilot: { scenes: [] } }];
    };
    // A pilot review of the scene as it stands now, with the given verdict.
    const reviewPilot = (id, result) => {
      const project = store.get('mv-auto');
      project.autoReviews = [...(project.autoReviews || []), { id, status: result.verdict === 'pass' ? 'passed' : 'needs-human',
        attempts: [{ n: 1, excerptId: 'test-proof', review: { checks: {}, findings: [], ...result, dependencies: pilotDependencies(project, 'mvs-a') } }] }];
      project.productionRuns[0].pilot = { scenes: [{ sceneId: 'mvs-a', operation: 'cutaway', reviewRunId: id, inputBasis: pilotInputBasis(project, 'mvs-a') }] };
    };
    const blocked = () => service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: { status: 'blocked', stopReason: 'Pilot mvs-a: revise.' } });

    // Uniquely catches a failed pilot parking an orchestrated run, or a repair the next take never sees.
    it('repairs a failed pilot within the review limit, then accepts its last take with the findings noted', async () => {
      await pilotFixture({ maxReviewAttempts: 1 });
      reviewPilot('rev-1', { verdict: 'revise', reason: 'The skater floats above the ramp.', checks: { motion: 'fail' },
        findings: [{ severity: 'blocking', note: 'Wheels never touch the coping.' }] });
      await blocked();
      expect(store.get('mv-auto').scenes[0]).toMatchObject({ videoHistoryId: 'clip-1',
        clipFixes: { text: 'The skater floats above the ramp. Wheels never touch the coping.' } });
      expect(reviews()).toContain('pilot:revise');
      expect(doubles.resumeProduction).toHaveBeenLastCalledWith('mv-auto', 'mvpr-1', { acceptBasis: true });
      expect(runOf().status).toBe('running');

      // Production made the shot again from the fix, and that take failed too: the repair is spent.
      store.get('mv-auto').scenes[0].videoHistoryId = 'clip-2';
      reviewPilot('rev-2', { verdict: 'revise', reason: 'The landing is still soft.' });
      doubles.resumeProduction.mockClear();
      await blocked();
      expect(store.get('mv-auto').productionRuns[0].pilot.scenes[0].accepted).toMatchObject({ reviewRunId: 'rev-2', by: 'orchestrator',
        note: expect.stringContaining('The landing is still soft.') });
      expect(reviews().filter((r) => r.startsWith('pilot'))).toEqual(['pilot:revise', 'pilot:approve']);
      expect(doubles.resumeProduction).toHaveBeenCalledWith('mv-auto', 'mvpr-1', { acceptBasis: true });
      expect(runOf().status).toBe('running');
    });

    it('applies pilot repairs regardless of legacy run or director shot locks', async () => {
      const actual = await vi.importActual('./productionReview.js');
      await pilotFixture();
      const lock = (fields) => store.set('mv-auto', clone(actual.setShotLocks(clone(store.get('mv-auto')), { sceneIds: ['mvs-a'], locked: true, ...fields })));
      lock({ approvedBy: 'orchestrator', reviewer: { kind: 'orchestrator', runId: runOf().id } });
      reviewPilot('rev-1', { verdict: 'revise', reason: 'The skater floats above the ramp.' });
      await blocked();
      expect(store.get('mv-auto').scenes[0].clipFixes).toMatchObject({ text: 'The skater floats above the ramp.' });
      expect(actual.shotLocks(store.get('mv-auto'))['mvs-a']).toBe('locked');
      expect(doubles.resumeProduction).toHaveBeenLastCalledWith('mv-auto', 'mvpr-1', { acceptBasis: true });

      lock({ approvedBy: 'director' });
      store.get('mv-auto').scenes[0].videoHistoryId = 'clip-2';
      reviewPilot('rev-2', { verdict: 'revise', reason: 'The landing is soft.' });
      doubles.resumeProduction.mockClear();
      await blocked();
      expect(store.get('mv-auto').scenes[0].clipFixes).toMatchObject({ text: 'The skater floats above the ramp. The landing is soft.' });
      const last = runOf().orchestration.reviews.at(-1);
      expect(last).toMatchObject({ checkpoint: 'pilot', verdict: 'revise', notes: expect.stringContaining('generated again') });
      expect(doubles.resumeProduction).toHaveBeenCalledWith('mv-auto', 'mvpr-1', { acceptBasis: true });
      expect(runOf().status).toBe('running');
    });

    // Uniquely catches an orchestrated run parking on the proof gate after its pilot passed.
    it('approves the passing pilot as the proof from its machine review', async () => {
      await pilotFixture();
      reviewPilot('rev-1', { verdict: 'pass', reason: 'The carve lands on the downbeat.', checks: { motion: 'pass', audioSync: 'pass' } });
      creativeReview.readiness = { proof: { approved: false, problems: [] } };
      await blocked();
      expect(doubles.approveProductionReview).toHaveBeenCalledWith('mv-auto', expect.objectContaining({ stage: 'proof', basis: 'test-proof', approvedBy: 'orchestrator',
        proofReview: expect.objectContaining({ method: 'machine', watchedWithAudio: false, excerptId: 'test-proof', filename: 'test-proof.mp4',
          machineEvidence: expect.objectContaining({ audioReview: expect.stringContaining('audioSync pass') }) }) }));
      expect(reviews()).toContain('proof:approve');
      expect(doubles.resumeProduction).toHaveBeenCalledWith('mv-auto', 'mvpr-1', { acceptBasis: true });
    });

    // Uniquely catches an orchestrated run parking on a clip the machine failed to save, or retrying one forever.
    it('retries a clip that failed on infrastructure, then parks once the slot spent its retries', async () => {
      await pilotFixture();
      const busy = 'Timed out waiting for backup publication admission at <data>/backup-admission/cut. No publication writes started.';
      const failedClip = (n) => ({ key: `clip:mvs-a:base:${n}`, kind: 'clip', sceneId: 'mvs-a', revisionId: null, status: 'failed', error: busy });
      const production = store.get('mv-auto').productionRuns[0];
      production.steps = [failedClip(1)];
      await blocked();
      expect(doubles.resumeProduction).toHaveBeenLastCalledWith('mv-auto', 'mvpr-1', { acceptBasis: true });
      expect(runOf().status).toBe('running');

      // The slot's retries are spent: the third failure parks.
      doubles.resumeProduction.mockClear();
      production.retryAcknowledged = ['clip:mvs-a:base:1', 'clip:mvs-a:base:2'];
      production.steps = [failedClip(1), failedClip(2), failedClip(3)];
      await blocked();
      expect(doubles.resumeProduction).not.toHaveBeenCalled();
      expect(runOf()).toMatchObject({ status: 'needs-human', errorCode: 'PRODUCTION_PARKED' });
    });

    // Uniquely catches a pre-composed-default footage run parking on its draft render instead of composing its shots.
    it('composes a legacy footage project whose draft review stopped for want of a document', async () => {
      await pilotFixture();
      store.get('mv-auto').composition = { mode: 'document', textCues: [{ id: 'cue' }] };
      const stopped = { status: 'stopped', stopReason: 'The review paused: The draft could not render: This project has no composition document on this machine' };
      Object.assign(store.get('mv-auto').productionRuns[0], stopped);
      await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: stopped });
      expect(store.get('mv-auto').composition).toEqual({ mode: 'composed', textCues: [{ id: 'cue' }] });
      expect(doubles.resumeProduction).toHaveBeenLastCalledWith('mv-auto', 'mvpr-1', { acceptBasis: true });
      expect(runOf().status).toBe('running');
    });
  });

  // Uniquely catches an unviewable still being recorded as an approved review while the run still waits for the director.
  it('does not record approval for stills the reviewer could not see', async () => {
    await service.startAutonomousVideo({ prompt: 'p', tools: ['image:local'], orchestrator: ORCHESTRATOR }, { autoApproveAuthorized: true });
    await vi.waitFor(() => expect(doubles.startProduction).toHaveBeenCalledOnce());
    store.get('mv-auto').scenes = [{ sceneId: 'mvs-a', label: 'Intro', framePrompt: 'a skater', referenceImageId: 'a1.png' }];
    doubles.galleryImagePath.mockRejectedValue(new Error('missing'));
    await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: { status: 'awaiting-video' } });
    expect(reviews().filter((r) => r.startsWith('stills'))).toEqual(['stills:revise']);
    expect(runOf()).toMatchObject({ status: 'awaiting-approval', awaiting: 'stills' });
  });

  // Uniquely catches a cancel during the pending stills review being undone by its verdict (clearing stills, resuming production, spending).
  it('ignores a stills verdict that lands after the run was cancelled', async () => {
    await service.startAutonomousVideo({ prompt: 'p', tools: ['image:local'], orchestrator: ORCHESTRATOR }, { autoApproveAuthorized: true });
    await vi.waitFor(() => expect(doubles.startProduction).toHaveBeenCalledOnce());
    store.get('mv-auto').scenes = [{ sceneId: 'mvs-a', label: 'Intro', framePrompt: 'a skater', referenceImageId: 'a1.png' }];
    let release;
    doubles.orchestrate.mockImplementation(() => new Promise((resolve) => { release = () => resolve({
      text: JSON.stringify({ verdict: 'revise', score: 4, notes: 'Bad.', issues: [{ sceneId: 'mvs-a', text: 'wrong' }] }),
      route: { providerId: 'orch', model: 'judge' }, visual: true }); }));
    doubles.resumeProduction.mockClear();
    doubles.orchestrate.mockClear();
    const settling = service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: { status: 'awaiting-video' } });
    await vi.waitFor(() => expect(doubles.orchestrate).toHaveBeenCalled());
    await service.cancelAutonomousVideo('mv-auto');
    release();
    await settling;
    expect(runOf().status).toBe('canceled');
    expect(doubles.resumeProduction).not.toHaveBeenCalled();
    expect(store.get('mv-auto').scenes[0].referenceImageId).toBe('a1.png');
  });

  it('keeps a frame selected while a stills review is in flight', async () => {
    await service.startAutonomousVideo({ prompt: 'p', tools: ['image:local'], orchestrator: ORCHESTRATOR }, { autoApproveAuthorized: true });
    await vi.waitFor(() => expect(doubles.startProduction).toHaveBeenCalledOnce());
    store.get('mv-auto').scenes = [{ sceneId: 'mvs-a', label: 'Intro', framePrompt: 'a skater', referenceImageId: 'a1.png' }];
    let release;
    doubles.orchestrate.mockImplementation(() => new Promise((resolve) => { release = () => resolve({
      text: JSON.stringify({ verdict: 'revise', score: 4, notes: 'Bad.', issues: [{ sceneId: 'mvs-a', text: 'wrong' }] }),
      route: { providerId: 'orch', model: 'judge' }, visual: true }); }));
    doubles.resumeProduction.mockClear();
    doubles.orchestrate.mockClear();
    const settling = service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: { status: 'awaiting-video' } });
    await vi.waitFor(() => expect(doubles.orchestrate).toHaveBeenCalled());
    store.get('mv-auto').scenes[0].referenceImageId = 'director-choice.png';
    release();
    await settling;
    expect(store.get('mv-auto').scenes[0]).toMatchObject({ referenceImageId: 'director-choice.png' });
    expect(store.get('mv-auto').scenes[0].stillFixes).toBeUndefined();
    expect(runOf().orchestration.reviews.at(-1).notes).toContain('changed while the stills were being reviewed');
    expect(doubles.resumeProduction).not.toHaveBeenCalled();
  });

  // Uniquely catches the orchestrator approving art or a storyboard it still wants changed once its revisions run out.
  it('parks for the director with the open changes named when a production gate runs out of revisions', async () => {
    creativeReview.real = true;
    const actual = await vi.importActual('./productionReview.js');
    doubles.approveProductionReview = stub('approve', async (id, input) => { store.set(id, clone(actual.approveProductionStage(clone(store.get(id)), input))); });
    service.__setAutonomousDepsForTests(doubles);
    doubles.analyzeSong.mockImplementation(async () => {
      Object.assign(store.get('mv-auto'), {
        audioAnalysis: { durationSec: 20, sections: [{ id: 'chorus', label: 'Chorus', startSec: 0, endSec: 20 }] },
        scenes: [{ sceneId: 'shot', startSec: 0, endSec: 20, label: 'Chorus' }],
        devArtifacts: [{ id: 'guide', version: 1, file: 'guide.html', mimeType: 'text/html' }],
        productionReview: { draft: { cast: 'A dancer', environments: 'Theatre', visualLanguage: 'Ink', motionLanguage: 'Orbit', guideArtifactId: 'guide',
          lyricsMode: 'instrumental', timingNotes: '', storyboard: [{ sceneId: 'shot', lyricCueIds: [], action: 'Dancer unfolds', staging: 'Wide', camera: 'Orbit', transition: 'Fade' }] } },
      });
    });
    const vague = { verdict: 'revise', notes: 'Still vague.', changes: [{ field: 'cast', text: 'A dancer in a red scarf' }] };
    answers.art = [vague, vague];
    await service.startAutonomousVideo({ prompt: 'p', tools: ['code:render'], authoring: { providerId: 'example', model: 'example-code' },
      limits: { maxReviewAttempts: 1 }, orchestrator: ORCHESTRATOR }, { autoApproveAuthorized: true });
    await settled('needs-human');
    expect(runOf()).toMatchObject({ errorCode: 'MUSIC_VIDEO_APPROVAL_REQUIRED', error: expect.stringContaining('cast: A dancer in a red scarf') });
    expect(reviews().filter((r) => r.startsWith('art'))).toEqual(['art:revise', 'art:revise']);
    expect(store.get('mv-auto').productionReview.approvals?.art).toBeFalsy();
    expect(doubles.renderVideo).not.toHaveBeenCalled();
  });

  it('stops revising at the review limit and keeps a Suno song rather than spend credits on a retake', async () => {
    answers.lyrics = Array.from({ length: 5 }, (_, i) => ({ verdict: 'revise', notes: 'Again.', lyrics: `take ${i + 1}` }));
    answers.song = [{ verdict: 'retake', notes: 'Muddy mix.' }];
    await service.startAutonomousVideo({ prompt: 'p', tools: ['image:local'], limits: { maxReviewAttempts: 2 }, orchestrator: ORCHESTRATOR },
      { autoApproveAuthorized: true });
    await vi.waitFor(() => expect(doubles.startProduction).toHaveBeenCalledOnce());
    expect(reviews().slice(0, 3)).toEqual(['lyrics:revise', 'lyrics:revise', 'lyrics:approve']);
    expect(runOf().output.lyrics).toBe('take 2');
    expect(runOf().orchestration.reviews[2].notes).toMatch(/Revision limit reached/);
    expect(doubles.generateSunoSong).toHaveBeenCalledOnce();
    expect(runOf().orchestration.reviews.find((r) => r.checkpoint === 'song')).toMatchObject({ verdict: 'approve', notes: expect.stringMatching(/spends credits/) });
  });

  it('resumes a retried review from the latest revision instead of the first draft', async () => {
    answers.lyrics = [{ verdict: 'revise', notes: 'Sharper hook.', lyrics: 'take 2' }, new Error('provider timed out')];
    answers.style = [{ verdict: 'revise', notes: 'Name the tempo.', sunoStyle: 'synthwave, 96 bpm' }, new Error('provider timed out')];
    await service.startAutonomousVideo({ prompt: 'p', tools: ['image:local'], songSource: 'local', orchestrator: ORCHESTRATOR }, { autoApproveAuthorized: true });
    await settled('failed');
    expect(runOf().output.lyricsForReview).toBe('take 2');

    await service.resumeAutonomousVideo('mv-auto');
    await settled('failed');
    expect(runOf().output).toMatchObject({ lyrics: 'take 2', styleDraft: expect.objectContaining({ sunoStyle: 'synthwave, 96 bpm' }) });
    const judged = doubles.orchestrate.mock.calls.map(([{ prompt }]) => prompt);
    expect(judged.filter((prompt) => checkpointOf(prompt) === 'lyrics').at(-1)).toContain('take 2');

    await service.resumeAutonomousVideo('mv-auto');
    await vi.waitFor(() => expect(doubles.startProduction).toHaveBeenCalledOnce());
    expect(doubles.orchestrate.mock.calls.map(([{ prompt }]) => prompt).filter((prompt) => checkpointOf(prompt) === 'style').at(-1)).toContain('96 bpm');
    expect(runOf().output).toMatchObject({ sunoStyle: 'synthwave, 96 bpm', styleDraft: null, lyricsForReview: null });
    expect(reviews()).toEqual(['lyrics:revise', 'lyrics:approve', 'style:revise', 'style:approve', 'song:approve']);
  });

  it('clears art, lyric timing and storyboard like a director, then re-authors the sections it flags in the final video', async () => {
    creativeReview.real = true;
    const actual = await vi.importActual('./productionReview.js');
    doubles.approveProductionReview = stub('approve', async (id, input) => {
      store.set(id, clone(actual.approveProductionStage(clone(store.get(id)), input)));
    });
    doubles.verifyAlignment = stub('verify', async (id, { basis, notes, reviewer }) => {
      const project = store.get(id);
      expect(basis).toBe(actual.productionAlignmentBasis(project));
      project.productionReview = { ...project.productionReview, alignmentBasis: basis, alignmentReview: { basis, reviewer },
        draft: { ...project.productionReview.draft, timingStatus: 'verified', timingNotes: notes } };
    });
    // Change requests go through the real review records; the re-plan rewrites the named shot.
    doubles.addFeedback = stub('feedback', async (id, input) => {
      const project = actual.recordProductionFeedback(clone(store.get(id)), input);
      store.set(id, clone(project));
      return { feedbackId: project.productionReview.feedback.at(-1).id };
    });
    doubles.closeFeedback = stub('resolve', async (id, input) => { store.set(id, clone(actual.resolveProductionFeedback(clone(store.get(id)), input))); });
    doubles.reviseFromFeedback = stub('replan', async (id) => {
      const project = store.get(id);
      project.scenes = project.scenes.map((scene) => ({ ...scene, prompt: 'Close on the scarf' }));
      project.productionReview.draft.storyboard = project.productionReview.draft.storyboard.map((shot) => ({ ...shot, action: 'Close on the scarf' }));
      store.set(id, clone(actual.recordProductionFeedback(project, { stage: 'storyboard', basis: actual.productionReviewBasis(project).storyboard,
        target: 'shot', text: 'Human note during planning', decision: 'structure-accepted' })));
    });
    // The first re-plan fails: the stage fails for a Retry instead of approving the unchanged shot.
    doubles.reviseFromFeedback.mockImplementationOnce(async (id) => {
      const project = store.get(id);
      store.set(id, clone(actual.recordProductionFeedback(project, { stage: 'storyboard', basis: actual.productionReviewBasis(project).storyboard,
        target: 'shot', text: 'Human request during failed planning', decision: 'request-changes' })));
      throw new Error('planner offline');
    });
    service.__setAutonomousDepsForTests(doubles);
    doubles.analyzeSong.mockImplementation(async () => {
      Object.assign(store.get('mv-auto'), {
        audioAnalysis: { durationSec: 20, sections: [{ id: 'chorus', label: 'Chorus', startSec: 0, endSec: 20 }] },
        // The second line was skipped by alignment; the orchestrator times it by hand.
        lyricCues: [
          { id: 'c1', text: 'rain on glass', startSec: 1, endSec: 4, words: [
            { w: 'rain', startSec: 1, endSec: 2, conf: 'matched' }, { w: 'on', startSec: 2, endSec: 3, conf: 'matched' }, { w: 'glass', startSec: 3, endSec: 4, conf: 'matched' }] },
          { id: 'c2', text: 'neon home', startSec: null, endSec: null },
        ],
        scenes: [{ sceneId: 'shot', startSec: 0, endSec: 20, label: 'Chorus' }],
        devArtifacts: [{ id: 'guide', version: 1, file: 'guide.html', mimeType: 'text/html' }],
        // The art review looks at the renders, character sheet first.
        castAndSets: { status: 'approved', plan: { stage: { kind: 'set' }, lead: { kind: 'character' } },
          images: { stage: { status: 'done', imageId: 'stage.png' }, lead: { status: 'done', imageId: 'lead.png' }, broken: { status: 'failed', imageId: null } } },
        productionReview: { draft: {
          cast: 'A dancer', environments: 'Theatre', visualLanguage: 'Ink silhouettes', motionLanguage: 'Slow orbit',
          guideArtifactId: 'guide', lyricsMode: 'vocal', timingStatus: 'provisional', timingNotes: '',
          storyboard: [{ sceneId: 'shot', lyricCueIds: [], action: 'Dancer unfolds', staging: 'Wide theatre', camera: '', transition: 'Fade' }],
        } },
      });
    });
    answers.art = [{ verdict: 'revise', notes: 'The cast is too vague to draw twice.', changes: [{ field: 'cast', text: 'A paper dancer in a red scarf' }] }];
    const closer = { verdict: 'revise', notes: 'The chorus needs a closer shot.', changes: [{ sceneId: 'shot', text: 'Tighter on the scarf' }], fill: [{ sceneId: 'shot', camera: 'Slow push-in' }] };
    answers.storyboard = [closer, closer, { verdict: 'approve', notes: 'Clear.' }];
    answers.final = [{ verdict: 'revise', score: 6, notes: 'The ending drags.', issues: [{ atSec: 18, text: 'Static hold' }] }];

    await service.startAutonomousVideo({ prompt: 'p', tools: ['code:render'], authoring: { providerId: 'example', model: 'example-code' }, orchestrator: ORCHESTRATOR },
      { autoApproveAuthorized: true });
    await settled('failed');
    expect(runOf()).toMatchObject({ errorCode: 'ORCHESTRATOR_REVISION_FAILED', error: expect.stringContaining('planner offline') });
    expect(store.get('mv-auto').productionReview.approvals?.storyboard).toBeFalsy();
    expect(store.get('mv-auto').productionReview.feedback).toEqual([
      expect.objectContaining({ resolution: expect.stringContaining('ask again on Retry') }),
      expect.objectContaining({ text: 'Human request during failed planning' }),
    ]);
    const humanRequest = store.get('mv-auto').productionReview.feedback.at(-1);
    expect(humanRequest.resolvedAt).toBeUndefined();
    store.set('mv-auto', clone(actual.resolveProductionFeedback(store.get('mv-auto'), { feedbackId: humanRequest.id, resolution: 'Human reviewed it.' })));

    await service.resumeAutonomousVideo('mv-auto');
    await vi.waitFor(() => expect(runOf()?.output.renderJobId).toBe('render-1'));
    const project = store.get('mv-auto');
    expect(project.productionReview.draft).toMatchObject({ cast: 'A paper dancer in a red scarf', timingStatus: 'verified',
      storyboard: [{ camera: 'Slow push-in', action: 'Close on the scarf', lyricCueIds: ['c1', 'c2'] }] });
    // The orchestrator's change request was acted on and closed, so it no longer blocks approval.
    expect(project.productionReview.feedback.find((entry) => entry.text === 'Tighter on the scarf' && entry.resolution === 'Revised by the orchestrator.')).toMatchObject({ resolvedAt: expect.any(String) });
    expect(project.productionReview.feedback.find((entry) => entry.text === 'Human note during planning').resolvedAt).toBeUndefined();
    expect(project.lyricCues[1]).toMatchObject({ startSec: 4, endSec: 20, words: [{ w: 'neon', conf: 'interpolated' }, { w: 'home', endSec: 20 }] });
    expect(project.productionReview.approvals).toMatchObject({ art: { approvedBy: 'orchestrator', reviewer: { kind: 'orchestrator', providerId: 'orch' } },
      storyboard: { approvedBy: 'orchestrator' } });
    expect(project.productionReview.alignmentReview.reviewer).toMatchObject({ kind: 'orchestrator', runId: runOf().id });

    // The flagged second goes back as a change request on the film, the document is
    // re-authored with it open, and the film is rendered and watched again.
    doubles.renderVideo.mockResolvedValueOnce({ jobId: 'render-2' });
    doubles.activeRenderJobId.mockResolvedValue('render-2');
    await service.__testing.onRenderEvent({ projectId: 'mv-auto', jobId: 'render-1', status: 'completed' });
    await vi.waitFor(() => expect(runOf().output.renderJobId).toBe('render-2'));
    expect(doubles.generateDocument).toHaveBeenCalledTimes(2);
    expect(store.get('mv-auto').productionReview.feedback.at(-1)).toMatchObject({ stage: 'proof', target: 'final@0:18', text: 'Static hold',
      resolution: 'Re-authored by the orchestrator.', resolvedAt: expect.any(String) });
    await service.__testing.onRenderEvent({ projectId: 'mv-auto', jobId: 'render-2', status: 'completed' });
    await settled('completed');
    // The measured overlay text pass runs before each render of the film.
    expect(reviews()).toEqual(['lyrics:approve', 'style:approve', 'song:approve', 'art:revise', 'art:approve', 'alignment:approve', 'storyboard:revise', 'storyboard:approve', 'text:approve', 'final:revise', 'text:approve', 'final:approve']);
    expect(runOf().orchestration.reviews.at(-3)).toMatchObject({ issues: [{ atSec: 18, text: 'Static hold' }], notes: expect.stringContaining('Judged without frames') });
    expect(doubles.finalReviewFrames.mock.calls.map(([jobId]) => jobId)).toEqual(['render-1', 'render-2']);
    const artCalls = doubles.orchestrate.mock.calls.filter(([{ prompt }]) => prompt.includes('ART DIRECTION'));
    expect(artCalls[0][0].images).toEqual(['/gallery/lead.png', '/gallery/stage.png']);
    expect(runOf().orchestration.reviews.find((r) => r.checkpoint === 'art')).toMatchObject({ visual: true });
  });

  describe('final-video revision of footage', () => {
    const PRODUCTION = { id: 'mvpr-1', limits: { maxGenerations: 40, spendCapUsd: null }, usage: { generations: 10 } };
    // Runs a footage film to its first final review, which flags 0:04 (and later 0:12).
    const reachFinalReview = async (production = PRODUCTION) => {
      doubles.startAutoReview = stub('auto-review', async () => ({ run: { id: 'mvar-fix' } }));
      for (const name of ['stopAutoReview', 'cancelAutoReview', 'resumeAutoReview']) doubles[name] = stub(name, async () => ({}));
      service.__setAutonomousDepsForTests(doubles);
      doubles.analyzeSong.mockImplementation(async () => {
        Object.assign(store.get('mv-auto'), { scenes: [{ sceneId: 'a', startSec: 0, endSec: 10 }, { sceneId: 'b', startSec: 10, endSec: 20 }] });
      });
      answers.final = [
        { verdict: 'revise', notes: 'The opening stutters.', issues: [{ atSec: 4, text: 'Frozen frame' }] },
        { verdict: 'revise', notes: 'Still soft.', issues: [{ atSec: 12, text: 'Blurry' }] },
      ];
      await service.startAutonomousVideo({ prompt: 'p', tools: ['image:local'], limits: { maxReviewAttempts: 1 }, orchestrator: ORCHESTRATOR }, { autoApproveAuthorized: true });
      await vi.waitFor(() => expect(runOf()?.output.productionRunId).toBe('mvpr-1'));
      store.get('mv-auto').productionRuns = [production];
      await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: { status: 'completed' } });
      // A finished render is the project's latest, as the render service records it.
      store.get('mv-auto').renderHistoryId = 'render-1';
      await service.__testing.onRenderEvent({ projectId: 'mv-auto', jobId: 'render-1', status: 'completed' });
    };
    const rendersAgain = async () => {
      doubles.renderVideo.mockResolvedValueOnce({ jobId: 'render-2' });
      doubles.activeRenderJobId.mockResolvedValue('render-2');
    };

    it('sends flagged footage back through an auto-review it judges, within the generations production left, then stops at the limit', async () => {
      await reachFinalReview();
      await vi.waitFor(() => expect(runOf().output.finalAutoReviewId).toBe('mvar-fix'));
      expect(doubles.startAutoReview).toHaveBeenCalledWith('mv-auto', { startSec: 0, endSec: 10, limits: { maxAttempts: 2, maxGenerations: 30 },
        reviewer: { providerId: 'orch', model: 'judge' } });
      expect(runOf()).toMatchObject({ status: 'running', stages: { produce: { step: 'final-revision' } } });

      await rendersAgain();
      musicVideoEvents.emit('auto-review', { projectId: 'mv-auto', runId: 'mvar-fix', run: { id: 'mvar-fix', status: 'passed' } });
      await vi.waitFor(() => expect(runOf().output.renderJobId).toBe('render-2'));
      await service.__testing.onRenderEvent({ projectId: 'mv-auto', jobId: 'render-2', status: 'completed' });
      await settled('completed');
      expect(doubles.startAutoReview).toHaveBeenCalledOnce();
      expect(reviews().slice(-2)).toEqual(['final:revise', 'final:noted']);
      expect(runOf().orchestration.reviews.at(-1).notes).toMatch(/Revision limit reached/);
    });

    it.each([
      ['a dollar budget is set', { ...PRODUCTION, limits: { maxGenerations: 40, spendCapUsd: 5 } }, /dollar budget/],
      ['production spent its generations', { ...PRODUCTION, usage: { generations: 40 } }, /spent its generations/],
    ])('keeps the film without a revision when %s', async (_, production, why) => {
      await reachFinalReview(production);
      await settled('completed');
      expect(doubles.startAutoReview).not.toHaveBeenCalled();
      expect(runOf().orchestration.reviews.at(-1)).toMatchObject({ checkpoint: 'final', verdict: 'noted', notes: expect.stringMatching(why) });
    });

    it('carries Stop, Resume and Cancel through to the revision, and re-renders when Resume finds it already ended', async () => {
      await reachFinalReview();
      await vi.waitFor(() => expect(runOf().output.finalAutoReviewId).toBe('mvar-fix'));
      await service.stopAutonomousVideo('mv-auto');
      expect(doubles.stopAutoReview).toHaveBeenCalledWith('mv-auto', 'mvar-fix');
      await service.resumeAutonomousVideo('mv-auto');
      expect(doubles.resumeAutoReview).toHaveBeenCalledWith('mv-auto', 'mvar-fix');
      expect(runOf()).toMatchObject({ status: 'running', stages: { produce: { step: 'final-revision' } } });

      // The revision ends while the run is stopped (its event is ignored); Resume renders the revised film.
      await service.stopAutonomousVideo('mv-auto');
      doubles.resumeAutoReview.mockRejectedValueOnce(Object.assign(new Error('This run is already canceled'), { code: 'AUTO_REVIEW_CLOSED' }));
      await rendersAgain();
      await service.resumeAutonomousVideo('mv-auto');
      expect(runOf()).toMatchObject({ status: 'running', output: { renderJobId: 'render-2', finalAutoReviewId: null } });

      await service.cancelAutonomousVideo('mv-auto');
      expect(doubles.cancelAutoReview).not.toHaveBeenCalled();
    });

    it('parks for a director when Resume cannot reach the revision for another reason', async () => {
      await reachFinalReview();
      await vi.waitFor(() => expect(runOf().output.finalAutoReviewId).toBe('mvar-fix'));
      await service.stopAutonomousVideo('mv-auto');
      doubles.resumeAutoReview.mockRejectedValueOnce(Object.assign(new Error('database unavailable'), { code: 'DB_DOWN' }));
      await service.resumeAutonomousVideo('mv-auto');
      expect(runOf()).toMatchObject({ status: 'needs-human', errorCode: 'DB_DOWN', error: expect.stringContaining('database unavailable'), output: { finalAutoReviewId: 'mvar-fix' } });
      expect(doubles.renderVideo).toHaveBeenCalledOnce();

      await service.cancelAutonomousVideo('mv-auto');
      expect(doubles.cancelAutoReview).toHaveBeenCalledWith('mv-auto', 'mvar-fix');
    });

    it('parks with the reason when the revision hands off to a human, and renders again once the director resumes', async () => {
      await reachFinalReview();
      await vi.waitFor(() => expect(runOf().output.finalAutoReviewId).toBe('mvar-fix'));
      await service.__testing.onAutoReviewEvent({ projectId: 'mv-auto', runId: 'mvar-fix',
        run: { id: 'mvar-fix', status: 'needs-human', stopReason: 'The clip for scene a cannot be generated automatically' } });
      expect(runOf()).toMatchObject({ status: 'needs-human', errorCode: 'FINAL_REVISION_NEEDS_HUMAN',
        error: expect.stringContaining('cannot be generated automatically'), output: { finalAutoReviewId: 'mvar-fix', renderJobId: 'render-1' } });

      // Resume before the director finished the revision keeps the run parked.
      const closed = () => Object.assign(new Error('This run is needs-human'), { code: 'AUTO_REVIEW_CLOSED' });
      Object.assign(store.get('mv-auto'), { autoReviews: [{ id: 'mvar-fix', status: 'needs-human', attempts: [{ n: 1, revisionId: 'rev-1' }] }],
        revisions: [{ id: 'rev-1', status: 'open' }] });
      doubles.resumeAutoReview.mockRejectedValueOnce(closed());
      await service.resumeAutonomousVideo('mv-auto');
      expect(runOf()).toMatchObject({ status: 'needs-human', errorCode: 'FINAL_REVISION_NEEDS_HUMAN',
        error: expect.stringContaining('Finish or cancel the open revision'), output: { finalAutoReviewId: 'mvar-fix' } });
      expect(doubles.renderVideo).toHaveBeenCalledOnce();

      store.get('mv-auto').revisions[0].status = 'complete';
      doubles.resumeAutoReview.mockRejectedValueOnce(closed());
      await rendersAgain();
      await service.resumeAutonomousVideo('mv-auto');
      expect(runOf()).toMatchObject({ status: 'running', output: { renderJobId: 'render-2', finalAutoReviewId: null } });
    });
  });
});
