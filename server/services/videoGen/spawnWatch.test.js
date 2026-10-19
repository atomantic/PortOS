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
  splice: vi.fn(),
  thumbnail: vi.fn(),
  history: [],
  mlx: false,
}));

vi.mock('../../lib/heavyJobClaim.js', () => ({ claimHeavyLocalJob: mocks.claim }));
vi.mock('../../lib/detachedSpawn.js', () => ({ spawnDetached: mocks.spawn }));
// No real renderer, caffeinate, GPU unloading, credentials, history, or disk writes.
vi.mock('../../lib/childProcess.js', () => ({ spawn: () => new EventEmitter() }));
vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal()), watch: mocks.watch }));
vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { videos: '/mock/videos', videoThumbnails: '/mock/thumbnails' },
  rmGuarded: mocks.rm,
  unlinkGuarded: vi.fn(async () => {}),
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
  runtimeUsesMlx: () => mocks.mlx,
  invalidateByovReadyCache: vi.fn(),
  pickDeathFingerprint: async () => null,
}));
vi.mock('./extendSplice.js', () => ({ spliceExtendSource: mocks.splice }));
vi.mock('./displayPower.js', () => ({
  isDisplaySleepEnabled: () => false,
  sleepDisplayForVideo: vi.fn(),
  wakeDisplayForVideo: vi.fn(),
}));
vi.mock('./history.js', () => ({
  loadHistory: async () => mocks.history,
  mutateVideoHistory: async (mutate) => { mocks.history = mutate(mocks.history); },
}));

import { pinArch, pinPlatform } from '../../lib/testHelper.js';
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
    mocks.mlx = false;
    mocks.release.mockResolvedValue();
    mocks.handoff.mockResolvedValue();
    mocks.claim.mockResolvedValue({ ok: true, release: mocks.release, handoffTo: mocks.handoff });
    mocks.rm.mockResolvedValue();
    mocks.optimize.mockResolvedValue();
    mocks.thumbnail.mockResolvedValue('render-thumb.jpg');
    mocks.watch.mockReturnValue(Object.assign(new EventEmitter(), { close: mocks.closeWatcher }));
    child =Object.assign(new EventEmitter(), {
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

  describe('SIGABRT cause classification', () => {
    const abortWith = async (stderrText) => {
      child.stderr.emit('data', Buffer.from(stderrText));
      child.signalCode = 'SIGABRT';
      child.emit('close', null, 'SIGABRT');
      await vi.advanceTimersByTimeAsync(0);
      expect(failed).toHaveBeenCalledTimes(1);
      return failed.mock.calls[0][0].error;
    };
    const asAppleSilicon = () => {
      const restorePlatform = pinPlatform('darwin');
      const restoreArch = pinArch('arm64');
      return () => { restoreArch(); restorePlatform(); };
    };

    it('classifies from a final unterminated stderr line and arms no relaunch', async () => {
      const restore = asAppleSilicon();
      mocks.mlx = true;
      try {
        await spawnAndWatchVideo(params);
        const error = await abortWith('Loading\nlibc++abi: kIOGPUCommandBufferCallbackErrorOutOfMemory');
        expect(error).toMatch(/ran out of memory/);
        expect(mocks.spawn).toHaveBeenCalledTimes(1);
      } finally { restore(); }
    });

    it('reports an unexplained native abort when stderr carries no native line', async () => {
      const restore = asAppleSilicon();
      mocks.mlx = true;
      try {
        await spawnAndWatchVideo(params);
        const error = await abortWith('Loading weights\n');
        expect(error).toMatch(/native abort with no diagnostic/);
        expect(error).not.toMatch(/watchdog/i);
      } finally { restore(); }
    });
  });

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

  it('survives a preview watcher error such as the Windows EPERM raised when the preview dir is removed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await spawnAndWatchVideo(params);

    // An EventEmitter with no 'error' listener throws on emit — the uncaught
    // exception that took the server down.
    const error = Object.assign(new Error('EPERM: operation not permitted, watch'), { code: 'EPERM' });
    expect(() => mocks.watch.mock.results[0].value.emit('error', error)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Video preview watcher error'));
    warn.mockRestore();
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

  it('waits for physical close and upload/preview cleanup after an error on a live child', async () => {
    const cleanup = Promise.withResolvers();
    params.cleanupTempFiles.mockReturnValue(cleanup.promise);
    await spawnAndWatchVideo(params);
    child.emit('error', new Error('renderer pipe failed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(failed).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
    expect(videoJobState.activeProcess).toBe(child);
    await closeChild(1);
    expect(failed).not.toHaveBeenCalled();
    cleanup.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expectCleanup();
    expect(job.status).toBe('error');
    expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ error: 'renderer pipe failed' }));
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

  describe('native Extend source splice', () => {
    const extendSplice = { sourcePath: '/mock/videos/source.mp4', extendLatents: 3 };

    it('splices the original source into the render and records that on the history row', async () => {
      mocks.splice.mockResolvedValue({ applied: true });
      await spawnAndWatchVideo({ ...params, extendSplice });
      await closeChild(0);

      expect(mocks.splice).toHaveBeenCalledExactlyOnceWith({ ...extendSplice, outputPath: params.outputPath });
      expect(mocks.history).toEqual([expect.objectContaining({ id: params.jobId, extendSourceOriginal: true })]);
    });

    it('publishes the model output unflagged when the splice declines', async () => {
      mocks.splice.mockResolvedValue({ applied: false, reason: 'frame layout does not match' });
      await spawnAndWatchVideo({ ...params, extendSplice });
      await closeChild(0);

      expect(completed).toHaveBeenCalledTimes(1);
      expect(mocks.history).toHaveLength(1);
      expect(mocks.history[0]).not.toHaveProperty('extendSourceOriginal');
    });

    it('never touches a render that did not ask for it', async () => {
      await spawnAndWatchVideo(params);
      await closeChild(0);

      expect(mocks.splice).not.toHaveBeenCalled();
      expect(mocks.history[0]).not.toHaveProperty('extendSourceOriginal');
    });
  });
});
