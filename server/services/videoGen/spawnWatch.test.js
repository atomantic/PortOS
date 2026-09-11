import { EventEmitter } from 'events';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  release: vi.fn(),
  handoff: vi.fn(),
  spawn: vi.fn(),
  watch: vi.fn(),
  closeWatcher: vi.fn(),
  rm: vi.fn(),
  optimize: vi.fn(),
  thumbnail: vi.fn(),
  history: [],
}));

vi.mock('../../lib/heavyJobClaim.js', () => ({ claimHeavyLocalJob: mocks.claim }));
vi.mock('../../lib/detachedSpawn.js', () => ({ spawnDetached: mocks.spawn }));
// No real renderer, caffeinate, GPU unloading, credentials, history, or disk writes.
vi.mock('../../lib/childProcess.js', () => ({ spawn: () => new EventEmitter() }));
vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal()), watch: mocks.watch }));
vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { videos: '/mock/videos' },
  rmGuarded: mocks.rm,
  formatBytes: vi.fn(),
}));
vi.mock('../../lib/ffmpeg.js', () => ({
  optimizeForStreaming: mocks.optimize,
  generateThumbnail: mocks.thumbnail,
  probeFrameCount: vi.fn(),
  probeVideoDuration: vi.fn(),
}));
vi.mock('../localMemory.js', () => ({
  prepareLocalMemory: async () => ({ blockers: [], unloaded: [] }),
  gpuBlockersMessage: vi.fn(),
}));
vi.mock('../hfToken.js', () => ({ hfChildEnv: async () => ({}) }));
vi.mock('../../lib/processEnv.js', () => ({ safeChildProcessEnv: () => ({}) }));
vi.mock('./runtimes.js', () => ({
  BYOV_RUNTIME_INFO: {},
  runtimeIsCacheOnly: () => false,
  runtimeNeedsProcessGroupKill: () => false,
  runtimeUsesMlx: () => false,
  invalidateByovReadyCache: vi.fn(),
  pickDeathFingerprint: async () => null,
}));
vi.mock('./displayPower.js', () => ({
  isDisplaySleepEnabled: () => false,
  sleepDisplayForVideo: vi.fn(),
  wakeDisplayForVideo: vi.fn(),
}));
vi.mock('./history.js', () => ({
  loadHistory: async () => mocks.history,
  mutateVideoHistory: async (mutate) => { mocks.history = mutate(mocks.history); },
}));

import { videoGenEvents } from './events.js';
import { videoJobState } from './jobState.js';
import { spawnAndWatchVideo } from './spawnWatch.js';

// Watchdog timing, buffered early exits, and Gemma retry/cancellation already
// have generateVideo boundary coverage in local.test.js. These tests pin the
// missing claim ownership and finalization contracts without duplicating it.
describe('spawnAndWatchVideo claim lifecycle', () => {
  let child;
  let job;
  let params;
  let completed;
  let failed;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    mocks.history = [];
    mocks.release.mockResolvedValue();
    mocks.handoff.mockResolvedValue();
    mocks.claim.mockResolvedValue({ ok: true, release: mocks.release, handoffTo: mocks.handoff });
    mocks.rm.mockResolvedValue();
    mocks.optimize.mockResolvedValue();
    mocks.thumbnail.mockResolvedValue('render-thumb.jpg');
    mocks.watch.mockReturnValue({ close: mocks.closeWatcher });
    child = Object.assign(new EventEmitter(), {
      pid: 101,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      exitCode: null,
      signalCode: null,
      killed: false,
      kill: vi.fn(),
    });
    mocks.spawn.mockResolvedValue(child);
    job = { status: 'running', clients: [{ write: vi.fn(), end: vi.fn() }] };
    params = {
      jobId: 'claim-lifecycle', job,
      cleanupTempFiles: vi.fn().mockResolvedValue(),
      stepwiseDir: join('/mock/videos', 'preview'),
      bin: 'python3', args: ['render.py'],
      outputPath: join('/mock/videos', 'render.mp4'), filename: 'render.mp4',
      meta: { id: 'claim-lifecycle', filename: 'render.mp4', prompt: 'A lighthouse in fog', fps: 24 },
      actualSeed: 42, model: { runtime: 'test-runtime' }, modelId: 'test-model',
      width: 512, height: 512, numFrames: 25, steps: 8, videoGenSettings: {},
    };
    videoJobState.jobs.clear();
    videoJobState.jobs.set(params.jobId, job);
    videoJobState.activeProcess = null;
    videoJobState.cancelEpoch = 0;
    completed = vi.fn();
    failed = vi.fn();
    videoGenEvents.on('completed', completed);
    videoGenEvents.on('failed', failed);
  });

  afterEach(() => {
    videoGenEvents.off('completed', completed);
    videoGenEvents.off('failed', failed);
    videoJobState.jobs.clear();
    videoJobState.activeProcess = null;
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const closeChild = async (code) => {
    child.exitCode = code;
    child.emit('close', code, null);
    await vi.advanceTimersByTimeAsync(0);
  };

  const expectCleanup = () => {
    expect(videoJobState.activeProcess).toBeNull();
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(params.cleanupTempFiles).toHaveBeenCalledExactlyOnceWith({ includeUploads: true, includeUntrackedAudio: true });
    expect(mocks.closeWatcher).toHaveBeenCalledTimes(1);
    expect(mocks.rm).toHaveBeenCalledExactlyOnceWith(params.stepwiseDir, { recursive: true, force: true });
  };

  it('rejects a busy lane with 409, removes staged inputs, and leaves the current owner alone', async () => {
    const owner = { pid: 202 };
    videoJobState.activeProcess = owner;
    mocks.claim.mockResolvedValue({ ok: false, message: 'Another render owns the lane', holder: { id: 'other-render' } });

    await expect(spawnAndWatchVideo(params)).rejects.toMatchObject({
      status: 409, code: 'HEAVY_LOCAL_JOB_BUSY', context: { holder: { id: 'other-render' } },
    });

    expect(mocks.claim).toHaveBeenCalledExactlyOnceWith({ kind: 'local video generation', id: params.jobId });
    expect(videoJobState.jobs.has(params.jobId)).toBe(false);
    expect(videoJobState.activeProcess).toBe(owner);
    expect(params.cleanupTempFiles).toHaveBeenCalledExactlyOnceWith({ includeUploads: true });
    expect(mocks.rm).toHaveBeenCalledExactlyOnceWith(params.stepwiseDir, { recursive: true, force: true });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.watch).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('awaits claim release before completing so a completion subscriber can start the next render', async () => {
    const released = Promise.withResolvers();
    mocks.release.mockReturnValue(released.promise);
    await spawnAndWatchVideo(params);
    expect(mocks.handoff).toHaveBeenCalledExactlyOnceWith(child.pid);
    expect(videoJobState.activeProcess).toBe(child);

    await closeChild(0);
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(completed).not.toHaveBeenCalled();
    expect(mocks.history).toEqual([]);

    released.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expectCleanup();
    expect(job.status).toBe('complete');
    expect(mocks.history).toEqual([expect.objectContaining({ id: params.jobId, filename: params.filename, thumbnail: 'render-thumb.jpg' })]);
    expect(completed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ generationId: params.jobId, filename: params.filename }));
    expect(failed).not.toHaveBeenCalled();
    expect(job.lastPayload).toMatchObject({ type: 'complete', result: { seed: 42 } });

    await vi.advanceTimersByTimeAsync(5000);
    expect(job.clients[0].end).toHaveBeenCalledTimes(1);
    expect(videoJobState.jobs.has(params.jobId)).toBe(false);
  });

  it('releases and cleans a nonzero exit without publishing a video to history', async () => {
    await spawnAndWatchVideo(params);
    await closeChild(7);

    expectCleanup();
    expect(job.status).toBe('error');
    expect(job.lastPayload).toMatchObject({ type: 'error' });
    expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ generationId: params.jobId, error: 'Exit code 7' }));
    expect(completed).not.toHaveBeenCalled();
    expect(mocks.history).toEqual([]);
  });

  it('handles error followed by close exactly once, including upload and preview cleanup', async () => {
    await spawnAndWatchVideo(params);
    child.emit('error', new Error('renderer pipe failed'));
    await closeChild(1);

    expectCleanup();
    expect(job.status).toBe('error');
    expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ error: 'Failed to spawn python3: renderer pipe failed' }));
    expect(completed).not.toHaveBeenCalled();
    expect(mocks.history).toEqual([]);
  });

  it('releases the claim when the detached launcher rejects before returning a child', async () => {
    mocks.spawn.mockRejectedValue(new Error('launcher unavailable'));

    await expect(spawnAndWatchVideo(params)).rejects.toThrow('launcher unavailable');

    expectCleanup();
    expect(job.status).toBe('error');
    expect(mocks.handoff).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ error: 'launcher unavailable' }));
    expect(completed).not.toHaveBeenCalled();
  });

  it('reports finalization failure after releasing the lane instead of stranding a complete job', async () => {
    mocks.optimize.mockRejectedValue(new Error('output could not be optimized'));
    await spawnAndWatchVideo(params);
    await closeChild(0);

    expectCleanup();
    expect(job.status).toBe('error');
    expect(job.lastPayload).toMatchObject({ type: 'error', error: 'Generation failed: output could not be optimized' });
    expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ error: 'output could not be optimized' }));
    expect(completed).not.toHaveBeenCalled();
    expect(mocks.history).toEqual([]);
  });
});
