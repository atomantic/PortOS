// Existing engine cases isolate the creative review boundary; explicit approval-flow
// cases below switch to the real model and verify pause/resume without providers.
const creativeReview = vi.hoisted(() => ({ real: false }));
vi.mock('./productionReview.js', async (load) => {
  const actual = await load();
  return { ...actual,
    assertProductionApproval: (...args) => creativeReview.real ? actual.assertProductionApproval(...args) : undefined,
    productionReadiness: (...args) => creativeReview.real ? actual.productionReadiness(...args) : {
      art: { approved: true }, storyboard: { approved: true }, proof: { approved: true }, basis: { proof: 'test-proof' }, readyForProduction: true,
      alignment: { status: 'verified' },
    },
  };
});
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
vi.mock('./projects.js', () => ({
  getProject: async (id) => (store.has(id) ? clone(store.get(id)) : null),
  mutateProjectRecord: (id, transform) => {
    const run = writeTail.then(() => {
      if (!store.has(id)) throw Object.assign(new Error('Project not found'), { status: 404 });
      const out = transform(clone(store.get(id)));
      store.set(id, clone(out.project));
      return { ...out, project: clone(out.project) };
    });
    writeTail = run.catch(() => {});
    return run;
  },
}));

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
  store.clear();
  calls = [];
  doubles = {
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

    it('resumes a parked run with raised limits, and a model swap starts a new production run with the new pool', async () => {
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
      await expect(service.resumeAutonomousVideo('mv-auto', { models: { 'image:fal': 'x' } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(runOf()).toMatchObject({ status: 'running', output: expect.objectContaining({ productionRunId: 'mvpr-2' }) });
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

  it('rejects a blank prompt', async () => {
    await expect(service.startAutonomousVideo({ prompt: '   ' })).rejects.toMatchObject({ status: 400 });
    expect(calls).toEqual([]);
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
  it('discards the song, re-runs the stage with the edited lyrics, style and Suno options, and parks there again', async () => {
    await service.startAutonomousVideo({ prompt: 'p', checkpoints: ['song'], suno: { excludeStyles: 'metal', vocalGender: 'female' } });
    await settled('awaiting-approval');
    expect(runOf()).toMatchObject({ awaiting: 'song', stage: 'analyze', output: { trackId: 'track-1', sunoSongIds: ['song-a', 'song-b'] } });
    expect(doubles.generateSunoSong).toHaveBeenLastCalledWith(expect.objectContaining({ excludeStyles: 'metal', vocalGender: 'female', model: null }), expect.any(Object));
    expect(store.get('mv-auto').trackId).toBe('track-1');

    doubles.createTrack.mockResolvedValueOnce({ id: 'track-2' });
    doubles.generateSunoSong.mockImplementationOnce(async (_fields, opts) => {
      // A fresh request: the rejected take's ids are not offered for reuse.
      expect(opts.songIds).toBeNull();
      await opts.onSubmitted(['song-c', 'song-d']);
      return { songId: 'song-d', songIds: ['song-c', 'song-d'], filename: 'music-song-d.m4a' };
    });
    const { run } = await service.resumeAutonomousVideo('mv-auto', {
      retakeSong: true, lyrics: '[verse]\nnew words', style: 'darker synthwave', suno: { vocalGender: 'male', model: 'v6' },
    });
    expect(run).toMatchObject({ status: 'running', stage: 'song', awaiting: null, output: { trackId: null, sunoSongIds: null } });
    await settled('awaiting-approval');
    expect(runOf()).toMatchObject({
      awaiting: 'song', stage: 'analyze',
      brief: { suno: { excludeStyles: 'metal', vocalGender: 'male', model: 'v6' } },
      output: { trackId: 'track-2', sunoSongIds: ['song-c', 'song-d'], lyrics: '[verse]\nnew words', sunoStyle: 'darker synthwave' },
    });
    expect(runOf().stages.song).toMatchObject({ status: 'done' });
    expect(doubles.generateSunoSong).toHaveBeenCalledTimes(2);
    expect(doubles.generateSunoSong).toHaveBeenLastCalledWith(expect.objectContaining({
      lyrics: '[verse]\nnew words', style: 'darker synthwave', excludeStyles: 'metal', vocalGender: 'male', model: 'v6',
    }), expect.any(Object));
    // The project was unlinked from the rejected track, then linked to the new one; analysis has not run.
    expect(doubles.updateProject).toHaveBeenCalledWith('mv-auto', { trackId: null });
    expect(store.get('mv-auto').trackId).toBe('track-2');
    expect(calls).not.toContain('analyze');

    // Approving the new take continues the pipeline as before.
    await service.resumeAutonomousVideo('mv-auto');
    await vi.waitFor(() => expect(calls).toContain('production'));
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
    await service.startAutonomousVideo({ prompt: 'p', checkpoints: ['song'] });
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
    await settled('awaiting-approval');
    expect(runOf()).toMatchObject({ awaiting: 'song', output: { sunoSongIds: ['song-e', 'song-f'] } });
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
    : prompt.includes('finished SONG') ? 'song' : prompt.includes('ART DIRECTION') ? 'art' : prompt.includes('STORYBOARD') ? 'storyboard' : 'final');
  const reviews = () => (runOf().orchestration?.reviews || []).map((r) => `${r.checkpoint}:${r.verdict}`);

  beforeEach(() => {
    answers = {};
    doubles.orchestrate = vi.fn(async ({ prompt }) => {
      const checkpoint = checkpointOf(prompt);
      const answer = (answers[checkpoint] || []).shift() || { verdict: 'approve', score: 8, notes: 'Ready.' };
      if (answer instanceof Error) throw answer;
      return { text: `Here is my call:\n${JSON.stringify(answer)}`, route: { providerId: 'orch', model: 'judge' }, visual: false };
    });
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
    expect(doubles.createMoodBoard).toHaveBeenCalledWith(expect.objectContaining({ stylePrompt: 'wet neon, teal and magenta' }));
    expect(doubles.generateLocalSong).toHaveBeenCalledTimes(2);
    expect(doubles.generateLocalSong.mock.calls[0][0]).toMatchObject({ lyrics: '[Chorus]\nrain rain on glass', prompt: expect.stringContaining('96 bpm') });
    // The orchestrator also judges production's plates and drafts.
    expect(doubles.startProduction).toHaveBeenCalledWith('mv-auto', expect.objectContaining({ reviewer: { providerId: 'orch', model: 'judge' } }));
    expect(doubles.orchestrate).toHaveBeenCalledWith(expect.objectContaining({ orchestrator: ORCHESTRATOR }));
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
    doubles.addFeedback = stub('feedback', async (id, input) => { store.set(id, clone(actual.recordProductionFeedback(clone(store.get(id)), input))); });
    doubles.closeFeedback = stub('resolve', async (id, input) => { store.set(id, clone(actual.resolveProductionFeedback(clone(store.get(id)), input))); });
    doubles.reviseFromFeedback = stub('replan', async (id) => {
      const project = store.get(id);
      project.scenes = project.scenes.map((scene) => ({ ...scene, prompt: 'Close on the scarf' }));
      project.productionReview.draft.storyboard = project.productionReview.draft.storyboard.map((shot) => ({ ...shot, action: 'Close on the scarf' }));
    });
    // The first re-plan fails: the stage fails for a Retry instead of approving the unchanged shot.
    doubles.reviseFromFeedback.mockRejectedValueOnce(new Error('planner offline'));
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
    expect(store.get('mv-auto').productionReview.feedback).toEqual([expect.objectContaining({ resolution: expect.stringContaining('ask again on Retry') })]);

    await service.resumeAutonomousVideo('mv-auto');
    await vi.waitFor(() => expect(runOf()?.output.renderJobId).toBe('render-1'));
    const project = store.get('mv-auto');
    expect(project.productionReview.draft).toMatchObject({ cast: 'A paper dancer in a red scarf', timingStatus: 'verified',
      storyboard: [{ camera: 'Slow push-in', action: 'Close on the scarf', lyricCueIds: ['c1', 'c2'] }] });
    // The orchestrator's change request was acted on and closed, so it no longer blocks approval.
    expect(project.productionReview.feedback.at(-1)).toEqual(expect.objectContaining({ stage: 'storyboard', target: 'shot', resolution: 'Revised by the orchestrator.', resolvedAt: expect.any(String) }));
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
    expect(reviews()).toEqual(['lyrics:approve', 'style:approve', 'song:approve', 'art:revise', 'art:approve', 'alignment:approve', 'storyboard:revise', 'storyboard:approve', 'final:revise', 'final:approve']);
    expect(runOf().orchestration.reviews.at(-2)).toMatchObject({ issues: [{ atSec: 18, text: 'Static hold' }], notes: expect.stringContaining('Judged without frames') });
    expect(doubles.finalReviewFrames.mock.calls.map(([jobId]) => jobId)).toEqual(['render-1', 'render-2']);
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
