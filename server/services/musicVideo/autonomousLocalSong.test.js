/**
 * Autonomous Music Video — local song source. The engine registry, media queue
 * and track store are doubles; these tests pin what this module owns: choosing
 * an engine the host can run, queuing onto the pre-created track, rejoining a
 * render a previous attempt queued, and settling only once the audio has landed.
 */

import { describe, it, expect, vi } from 'vitest';
// The media queue is only reached by the default job waiter (every other test injects its own).
const queue = vi.hoisted(() => ({ events: null, jobs: {} }));
vi.mock('../mediaJobQueue/index.js', async () => {
  const { EventEmitter: Emitter } = await import('events');
  queue.events = new Emitter();
  return { mediaJobEvents: queue.events, getJob: (id) => queue.jobs[id] || null };
});

import { generateLocalSong } from './autonomousLocalSong.js';

const ENGINES = {
  musicgen: { id: 'musicgen', minDurationSec: 1, maxDurationSec: 30 },
  acestep: { id: 'acestep', lyrics: true, minDurationSec: 1, maxDurationSec: 240 },
  minimax: { id: 'minimax', lyrics: true, autoDuration: true },
};

function harness({ healthy = ['musicgen', 'acestep'], tracks = {}, jobs = {}, waited } = {}) {
  const state = { tracks: { 't-1': { id: 't-1' }, ...tracks }, jobs: { ...jobs } };
  const deps = {
    listEngines: async () => ENGINES,
    isEngineHealthy: async (id) => healthy.includes(id),
    queueGeneration: vi.fn(async () => ({ jobId: 'job-1', status: 'queued' })),
    getJob: async (id) => state.jobs[id] || null,
    getTrack: async (id) => state.tracks[id] || null,
    cancelJob: vi.fn(async () => true),
    // The completion hook attaches the audio a beat after the job reports done.
    waitForJob: vi.fn(async (id) => waited?.(state, id) ?? { id, status: 'completed', result: { filename: 'song.wav' } }),
    sleep: vi.fn(async () => { state.tracks['t-1'] = { id: 't-1', audioFilename: 'song.wav' }; }),
  };
  return { state, deps };
}

const song = { trackId: 't-1', title: 'Neon Rain', prompt: 'synthwave', lyrics: '[verse]\nrain' };

describe('engine choice', () => {
  it('takes a ready lyric-capable engine for a vocal song, any ready engine for an instrumental', async () => {
    const vocal = harness();
    await generateLocalSong(song, vocal.deps);
    expect(vocal.deps.queueGeneration.mock.calls[0][0].engine).toBe('acestep');
    const instrumental = harness();
    await generateLocalSong({ ...song, instrumental: true }, instrumental.deps);
    expect(instrumental.deps.queueGeneration.mock.calls[0][0].engine).toBe('musicgen');
  });

  it('names what is missing instead of rendering the wrong thing', async () => {
    const instrumentalOnly = harness({ healthy: ['musicgen'] });
    await expect(generateLocalSong(song, instrumentalOnly.deps)).rejects.toMatchObject({ code: 'LOCAL_SONG_NO_ENGINE', message: expect.stringContaining('sing lyrics') });
    const none = harness({ healthy: [] });
    await expect(generateLocalSong({ ...song, instrumental: true }, none.deps)).rejects.toMatchObject({ code: 'LOCAL_SONG_NO_ENGINE' });
    expect(none.deps.queueGeneration).not.toHaveBeenCalled();
  });
});

describe('generateLocalSong', () => {
  it('queues the render onto the track, stores the job id, and settles when the audio has landed', async () => {
    const { deps } = harness();
    const onSubmitted = vi.fn();
    const out = await generateLocalSong({ ...song, onSubmitted }, deps);
    expect(deps.queueGeneration).toHaveBeenCalledWith({
      prompt: 'synthwave', lyrics: '[verse]\nrain', instrumentalOnly: false, engine: 'acestep', durationSec: 180, trackId: 't-1', title: 'Neon Rain',
    });
    expect(onSubmitted).toHaveBeenCalledWith('job-1');
    expect(out).toEqual({ trackId: 't-1', filename: 'song.wav', jobId: 'job-1' });
    expect(deps.sleep).toHaveBeenCalled(); // waited out the hook's attach
  });

  it('sends no lyrics for an instrumental and lets an auto-duration engine choose the length', async () => {
    const { deps } = harness({ healthy: ['minimax'] });
    await generateLocalSong({ ...song, instrumental: true }, deps);
    const body = deps.queueGeneration.mock.calls[0][0];
    expect(body).toMatchObject({ engine: 'minimax', instrumentalOnly: true, durationMode: 'auto' });
    expect(body).not.toHaveProperty('lyrics');
    expect(body).not.toHaveProperty('durationSec');
  });

  it('does not render again when the track already has audio, and rejoins a live job from a previous attempt', async () => {
    const done = harness({ tracks: { 't-1': { id: 't-1', audioFilename: 'song.wav' } } });
    await generateLocalSong(song, done.deps);
    expect(done.deps.queueGeneration).not.toHaveBeenCalled();

    const live = harness({ jobs: { 'job-0': { id: 'job-0', status: 'running' } } });
    await generateLocalSong({ ...song, jobId: 'job-0' }, live.deps);
    expect(live.deps.queueGeneration).not.toHaveBeenCalled();
    expect(live.deps.waitForJob).toHaveBeenCalledWith('job-0', expect.any(Object));
  });

  it('starts a new render when the previous job failed or was canceled', async () => {
    const { deps } = harness({ jobs: { 'job-0': { id: 'job-0', status: 'canceled' } } });
    const out = await generateLocalSong({ ...song, jobId: 'job-0' }, deps);
    expect(deps.queueGeneration).toHaveBeenCalledTimes(1);
    expect(out.jobId).toBe('job-1');
  });

  it('fails the stage when the render fails or the audio never reaches the track', async () => {
    const failed = harness({ waited: async (_s, id) => ({ id, status: 'failed', error: 'out of memory' }) });
    await expect(generateLocalSong(song, failed.deps)).rejects.toMatchObject({ code: 'LOCAL_SONG_FAILED', message: expect.stringContaining('out of memory') });

    const lost = harness();
    lost.deps.sleep = vi.fn(async () => {});
    await expect(generateLocalSong(song, lost.deps)).rejects.toMatchObject({ code: 'LOCAL_SONG_ATTACH_TIMEOUT' });
  });

  it('fails clearly when the track was deleted while the run waited', async () => {
    const { deps } = harness();
    await expect(generateLocalSong({ ...song, trackId: 'gone' }, deps)).rejects.toMatchObject({ status: 404 });
  });
});

describe('the default job waiter', () => {
  const waitWith = (jobId, opts = {}) => {
    const { deps } = harness();
    const { waitForJob: _injected, ...rest } = deps; // fall back to the module's own waiter
    return generateLocalSong({ ...song, jobId }, { ...rest, ...opts, getJob: async (id) => queue.jobs[id] || { id, status: 'running' } });
  };

  it('settles on the queue event for its own job only, then detaches its listeners', async () => {
    const pending = waitWith('job-9');
    await vi.waitFor(() => expect(queue.events.listenerCount('completed')).toBe(1));
    queue.events.emit('completed', { id: 'someone-else', status: 'completed' });
    queue.events.emit('completed', { id: 'job-9', status: 'completed', result: { filename: 'song.wav' } });
    await expect(pending).resolves.toMatchObject({ jobId: 'job-9', filename: 'song.wav' });
    expect(queue.events.listenerCount('completed') + queue.events.listenerCount('failed') + queue.events.listenerCount('canceled')).toBe(0);
  });

  it('turns a cancel (the run was stopped) into a failed stage, and a stuck queue into a timeout', async () => {
    const canceled = waitWith('job-8');
    await vi.waitFor(() => expect(queue.events.listenerCount('canceled')).toBe(1));
    queue.events.emit('canceled', { id: 'job-8', status: 'canceled' });
    await expect(canceled).rejects.toMatchObject({ code: 'LOCAL_SONG_FAILED' });

    const cancelJob = vi.fn(async () => true);
    await expect(waitWith('job-7', { timeoutMs: 5, cancelJob })).rejects.toMatchObject({ code: 'LOCAL_SONG_TIMEOUT' });
    expect(cancelJob).toHaveBeenCalledWith('job-7'); // the abandoned render must not keep the GPU busy
  });
});
