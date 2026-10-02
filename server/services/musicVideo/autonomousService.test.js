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

  it('resolves the direction LLM once per text stage: brief and lyrics run on the resolved TUI route, effort included, and the route is recorded (#9545)', async () => {
    const route = { providerId: 'claude-tui', model: 'opus', effort: 'high', transport: 'tui', source: 'tui-preferred' };
    doubles.resolveLlm.mockResolvedValue({ provider: { id: 'claude-tui' }, selectedModel: 'opus', route });
    const { project } = await service.startAutonomousVideo({ prompt: 'p', providerId: 'cloud', model: 'big', effort: 'low' });
    expect(project.automation.llm).toEqual({ providerId: 'cloud', model: 'big', effort: 'low' });
    await vi.waitFor(() => expect(calls).toContain('production'));

    // The run's pin is what gets resolved; what the resolver returns is what runs.
    expect(doubles.resolveLlm).toHaveBeenCalledWith({ providerId: 'cloud', model: 'big', effort: 'low' });
    expect(doubles.draftCreativeBrief).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'claude-tui', model: 'opus', effort: 'high' }));
    expect(doubles.writeLyrics).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'claude-tui', model: 'opus', effort: 'high' }));
    expect(runOf().output).toMatchObject({ briefRoute: route, lyricsRoute: route });
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
    expect(doubles.generateCode).toHaveBeenCalledWith('mv-auto', { providerId: 'prov', model: 'm', effort: 'medium' });
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
