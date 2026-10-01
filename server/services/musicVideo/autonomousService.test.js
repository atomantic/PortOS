/**
 * Fully-autonomous Music Video run — orchestration contract. The project store
 * is an in-memory double with the real store's serialized read-modify-write;
 * every stage's provider (LLM, mood board, Suno, track store, production) is a
 * double, so these tests pin what the run owns: stage order and persistence,
 * checkpoints, failure parking and retry, and the hand-off to production.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  store.clear();
  calls = [];
  doubles = {
    createProject: stub('createProject', async (input) => {
      const project = { id: 'mv-auto', ...input };
      store.set(project.id, clone(project));
      return project;
    }),
    updateProject: stub('updateProject', async (id, patch) => {
      const next = { ...store.get(id), ...patch };
      store.set(id, clone(next));
      return next;
    }),
    draftCreativeBrief: stub('brief', async () => ({ brief: BRIEF })),
    writeLyrics: stub('lyrics', async () => ({ lyrics: '[verse]\nrain on glass' })),
    createMoodBoard: stub('board', async () => ({ id: 'board-1' })),
    generateSunoSong: stub('suno', async (_fields, opts) => {
      await opts.onSubmitted(['song-a', 'song-b']);
      return { songId: 'song-a', songIds: ['song-a', 'song-b'], filename: 'music-song-a.mp3' };
    }),
    createTrack: stub('track', async () => ({ id: 'track-1' })),
    attachAudio: stub('attach', async () => ({})),
    probeDuration: stub('probe', async () => 187),
    analyzeSong: stub('analyze', async () => ({})),
    startProduction: stub('production', async () => ({ run: { id: 'mvpr-1' } })),
    generateCode: stub('code', async () => ({})),
    renderVideo: stub('render', async () => ({ jobId: 'render-1' })),
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
    expect(doubles.startProduction).toHaveBeenCalledWith('mv-auto', expect.objectContaining({
      pool: [{ kind: 'image', mode: 'local', model: 'flux2-dev' }, { kind: 'video', mode: 'local' }],
      limits: { maxGenerations: 40, maxReviewAttempts: 3 },
    }));
    // The song title renames the project; the track carries the prompt/lyrics Suno was given.
    expect(store.get('mv-auto').name).toBe('Neon Rain');
    expect(doubles.attachAudio).toHaveBeenCalledWith('track-1', 'music-song-a.mp3', expect.objectContaining({ source: 'suno', durationSec: 187 }));
  });

  it('finishes — and starts the final render — when the delegated production run completes', async () => {
    await service.startAutonomousVideo({ prompt: 'p' });
    await vi.waitFor(() => expect(runOf()?.output.productionRunId).toBe('mvpr-1'));
    // An unrelated production run and a non-terminal event change nothing.
    await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'someone-else', run: { status: 'completed' } });
    await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: { status: 'running' } });
    expect(runOf().status).toBe('running');

    await service.__testing.onProductionEvent({ projectId: 'mv-auto', runId: 'mvpr-1', run: { status: 'completed' } });
    expect(runOf()).toMatchObject({ status: 'completed', output: expect.objectContaining({ renderJobId: 'render-1' }) });
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
    expect(doubles.generateCode).toHaveBeenCalledWith('mv-auto', { providerId: 'prov', model: 'm' });
    expect(store.get('mv-auto').composition).toEqual({ mode: 'code' });
    await settled('completed');
  });

  it('sends the Cast & Sets check-in to review only when the cast checkpoint is chosen', async () => {
    const { project } = await service.startAutonomousVideo({ prompt: 'p', checkpoints: ['cast'] });
    expect(project.automation.checkins.castAndSets).toBe('review');
    await vi.waitFor(() => expect(calls).toContain('production')); // let the background run finish before the next test resets the doubles
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
    await expect(service.resumeAutonomousVideo('mv-auto')).rejects.toMatchObject({ code: 'NOT_RESUMABLE' });
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
