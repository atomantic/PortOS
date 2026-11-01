import { EventEmitter } from 'events';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  diagnostics: vi.fn(),
  memory: null,
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
  signature: vi.fn(),
  profiles: null,
  outputs: new Map(),
  byov: {},
  invalidateByov: vi.fn(),
}));

vi.mock('./executionRecorder.js', () => ({ recordVideoExecution: mocks.record, recordVideoExecutionDiagnostics: mocks.diagnostics }));
vi.mock('../../lib/heavyJobClaim.js', () => ({ claimHeavyLocalJob: mocks.claim }));
vi.mock('../../lib/detachedSpawn.js', () => ({ spawnDetached: mocks.spawn }));
// No real renderer, caffeinate, GPU unloading, credentials, history, or disk writes.
vi.mock('../../lib/childProcess.js', () => ({ spawn: () => new EventEmitter() }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, watch: mocks.watch,
    existsSync: path => mocks.outputs.has(path) || actual.existsSync(path),
    statSync: path => mocks.outputs.get(path) || actual.statSync(path),
  };
});
vi.mock('./metalBufferProfiles.js', async importOriginal => ({
  ...await importOriginal(), getMetalBufferProfiles: () => mocks.profiles, metalBufferExecutionSignature: mocks.signature,
}));
vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { videos: '/mock/videos', videoThumbnails: '/mock/thumbnails' },
  rmGuarded: mocks.rm,
  unlinkGuarded: vi.fn(async () => {}),
  formatBytes: vi.fn(),
}));
vi.mock('../../lib/ffmpeg.js', () => ({
  optimizeForStreaming: mocks.optimize,
  generateThumbnail: mocks.thumbnail,
  probeFrameCount: vi.fn(async () => 25),
  probeVideoDuration: vi.fn(async () => 25 / 24),
}));
vi.mock('../localMemory.js', () => ({
  prepareLocalMemory: async () => mocks.memory,
  gpuBlockersMessage: vi.fn(),
}));
vi.mock('../hfToken.js', () => ({ hfChildEnv: async () => ({}) }));
vi.mock('../../lib/processEnv.js', () => ({ safeChildProcessEnv: () => ({}) }));
vi.mock('./runtimes.js', () => ({
  BYOV_RUNTIME_INFO: mocks.byov,
  runtimeIsCacheOnly: () => false,
  runtimeNeedsProcessGroupKill: () => false,
  runtimeUsesMlx: () => mocks.mlx,
  invalidateByovReadyCache: mocks.invalidateByov,
  pickDeathFingerprint: async () => null,
  currentMetalProfileFingerprint: async () => null,
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
import { _createMetalBufferProfiles } from './metalBufferProfiles.js';

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
    mocks.memory = { blockers: [], unloaded: [], totalGb: 128, availableGb: 120 };
    mocks.record.mockResolvedValue(true);
    mocks.diagnostics.mockResolvedValue(true);
    mocks.mlx = false;
    mocks.signature.mockResolvedValue(null);
    mocks.outputs.clear();
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

  const h3Model = () => ({ runtime: 'minimax_h3', memoryProfiles: [{ id: 'unified-8bit', minMemoryGb: 128 }] });

  it.each([[64, 'MINIMAX_H3_HEADROOM_INSUFFICIENT'], [0, 'MINIMAX_H3_HEADROOM_INSUFFICIENT'], [null, 'MINIMAX_H3_MEMORY_UNKNOWN']])('refuses H3 with live available RAM %s before launch and releases the claim', async (availableGb, code) => {
    params.model = h3Model();
    mocks.memory.availableGb = availableGb;
    await expect(spawnAndWatchVideo(params)).rejects.toMatchObject({ code });
    expect(mocks.record).toHaveBeenCalledWith(params.jobId, expect.objectContaining({ seed: 42, width: 512, numFrames: 25 }));
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.diagnostics).toHaveBeenCalledWith(params.jobId, expect.objectContaining({ termination: expect.objectContaining({ reason: 'refused' }) }));
  });

  it('refuses an unknown H3 placement requirement without inventing a budget', async () => {
    params.model = { runtime: 'minimax_h3', memoryProfiles: [] };
    await expect(spawnAndWatchVideo(params)).rejects.toMatchObject({ code: 'MINIMAX_H3_MEMORY_UNKNOWN' });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('keeps queued segment identity on resolved settings, memory and cancellation receipts', async () => {
    params.model = h3Model();
    const executionParent = { jobId: 'queue-outer', segmentIndex: 1, segmentCount: 3 };
    params.executionParent = executionParent;
    await spawnAndWatchVideo(params);
    expect(mocks.record).toHaveBeenCalledWith(params.jobId, expect.objectContaining({ seed: 42, executionParent }));
    child.stderr.emit('data', Buffer.from('H3MEMORY:{"peakAllocatedBytes":900}\n'));
    await vi.advanceTimersByTimeAsync(250);
    videoJobState.cancelEpoch += 1;
    child.signalCode = 'SIGTERM';
    child.emit('close', null, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.diagnostics).toHaveBeenLastCalledWith(params.jobId, expect.objectContaining({
      memory: { peakAllocatedBytes: 900 }, termination: expect.objectContaining({ signal: 'SIGTERM', reason: 'canceled' }),
    }), executionParent);
    expect(mocks.diagnostics.mock.calls.every(call => call[2] === executionParent)).toBe(true);
    expect(failed).toHaveBeenCalledOnce();
  });

  it('does not launch when the execution receipt cannot be made durable', async () => {
    mocks.record.mockRejectedValue(new Error('receipt storage unavailable'));
    await expect(spawnAndWatchVideo(params)).rejects.toThrow('receipt storage unavailable');
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('passes the admitted allocator envelope and drains bounded measured peaks before a signal failure', async () => {
    params.model = h3Model();
    await spawnAndWatchVideo(params);
    expect(mocks.spawn.mock.calls[0][1]).toContain('--memory-budget-bytes');
    expect(mocks.spawn.mock.calls[0][1]).toContain(String(112 * 1024 ** 3));
    child.stderr.emit('data', Buffer.from('H3MEMORY:{"peakAllocatedBytes":900,"peakRssBytes":500,"allocatorApplied":true,"allocatorLimitBytes":1024}\n'));
    child.stderr.emit('data', Buffer.from('H3MEMORY:{"peakAllocatedBytes":700,"peakRssBytes":600,"privatePath":"/private/example"}\n'));
    child.stderr.emit('data', Buffer.from('H3MEMORY:{"peakAllocatedBytes":-1,"peakRssBytes":"not-measured"}\n'));
    child.signalCode = 'SIGKILL';
    child.emit('close', null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.diagnostics).toHaveBeenLastCalledWith(params.jobId, {
      memory: { peakAllocatedBytes: 900, peakRssBytes: 600, allocatorApplied: true, allocatorLimitBytes: 1024 },
      termination: expect.objectContaining({ exitCode: null, signal: 'SIGKILL', reason: 'failed' }),
    });
    expect(failed).toHaveBeenCalledOnce();
  });

  it('retries the accumulated telemetry after a transient write failure and retains the actual signal', async () => {
    params.model = h3Model();
    await spawnAndWatchVideo(params);
    mocks.diagnostics.mockRejectedValueOnce(new Error('temporary evidence storage failure'));
    child.stderr.emit('data', Buffer.from('H3MEMORY:{"peakAllocatedBytes":900}\n'));
    await vi.advanceTimersByTimeAsync(250);
    child.signalCode = 'SIGKILL';
    child.emit('close', null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.diagnostics).toHaveBeenLastCalledWith(params.jobId, {
      memory: { peakAllocatedBytes: 900 }, termination: expect.objectContaining({ signal: 'SIGKILL', reason: 'failed' }),
    });
    expect(mocks.diagnostics).toHaveBeenCalledWith(params.jobId, { memory: { peakAllocatedBytes: 900 } });
    expect(failed).toHaveBeenCalledOnce();
  });

  it('attempts memory and signal together when an immediate close hits a final evidence write failure', async () => {
    params.model = h3Model();
    await spawnAndWatchVideo(params);
    mocks.diagnostics.mockClear();
    mocks.diagnostics.mockRejectedValueOnce(new Error('final evidence storage unavailable'));
    child.stderr.emit('data', Buffer.from('H3MEMORY:{"peakAllocatedBytes":900}\n'));
    child.signalCode = 'SIGKILL';
    child.emit('close', null, 'SIGKILL');

    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.diagnostics).toHaveBeenCalledExactlyOnceWith(params.jobId, {
      memory: { peakAllocatedBytes: 900 }, termination: expect.objectContaining({ signal: 'SIGKILL', reason: 'failed' }),
    });
    expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ error: expect.stringContaining('Process killed') }));
    expect(completed).not.toHaveBeenCalled();
  });

  it('delivers spawn failure even when its diagnostic receipt cannot be written', async () => {
    await spawnAndWatchVideo(params);
    mocks.diagnostics.mockRejectedValueOnce(new Error('termination storage unavailable'));
    child.pid = undefined;
    child.emit('error', new Error('spawn ENOENT'));
    await vi.advanceTimersByTimeAsync(0);
    expect(failed).toHaveBeenCalledOnce();
    expect(failed.mock.calls[0][0].error).toContain('spawn ENOENT');
    expect(mocks.release).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000);
    expect(videoJobState.jobs.has(params.jobId)).toBe(false);
  });

  it.each([['linux', 'x64', false], ['win32', 'x64', false], ['darwin', 'arm64', false], ['darwin', 'x64', true]])('preserves non-Metal status/history on %s %s (MLX=%s)', async (platform, arch, mlx) => {
    const restorePlatform = pinPlatform(platform);
    const restoreArch = pinArch(arch);
    mocks.mlx = mlx;
    try {
      await spawnAndWatchVideo(params);
      expect(job.metalBufferPolicy).toBeUndefined();
      expect(job.clients[0].write.mock.calls.flat().join('')).not.toMatch(/Metal buffer/);
      await closeChild(0);
      expect(mocks.history[0]).not.toHaveProperty('metalBufferPolicy');
    } finally { restoreArch(); restorePlatform(); }
  });

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
    mocks.diagnostics.mockRejectedValueOnce(new Error('termination storage unavailable'));

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

  describe('failure reason for an unforgiven exit', () => {
    const failedWith = () => failed.mock.calls[0][0];

    it('names a missing Python module in a BYOV runtime and drops its cached ready probe', async () => {
      mocks.byov['test-runtime'] = { id: 'byov-id', label: 'Example' };
      await spawnAndWatchVideo(params);
      child.stderr.emit('data', Buffer.from("ModuleNotFoundError: No module named 'foo'\n"));
      await closeChild(1);

      expect(mocks.invalidateByov).toHaveBeenCalledExactlyOnceWith('byov-id');
      expect(failedWith().error).toBe("Python module 'foo' is missing from the Example runtime. Use Install / Repair in Video Gen's model setup panel.");
      delete mocks.byov['test-runtime'];
    });

    it('names a missing Python module outside a BYOV runtime without touching the ready cache', async () => {
      await spawnAndWatchVideo(params);
      child.stderr.emit('data', Buffer.from("ModuleNotFoundError: No module named 'foo'\n"));
      await closeChild(1);

      expect(mocks.invalidateByov).not.toHaveBeenCalled();
      expect(failedWith().error).toBe("Python module 'foo' is missing. Install it into the configured Python environment and retry.");
    });

    it('reports signal death by cause rather than as an exit code', async () => {
      await spawnAndWatchVideo(params);
      child.signalCode = 'SIGTERM';
      child.emit('close', null, 'SIGTERM');
      await vi.advanceTimersByTimeAsync(0);

      expect(failedWith().error).toBe('Killed by signal SIGTERM');
    });

    it('appends how many batch videos were saved', async () => {
      params.batch = [{ id: 'batch-first', index: 0, seed: 42, filename: 'first.mp4' }, { id: 'batch-second', index: 1, seed: 43, filename: 'second.mp4' }];
      await spawnAndWatchVideo(params);
      await closeChild(7);

      expect(failedWith().error).toBe('Exit code 7 (0/2 videos saved to history)');
    });
  });

  it.each([0, 7])('preserves exit %s and its published outcome when termination evidence cannot be written', async (exitCode) => {
    await spawnAndWatchVideo(params);
    mocks.diagnostics.mockRejectedValueOnce(new Error('termination storage unavailable'));

    await closeChild(exitCode);

    expectCleanup();
    if (exitCode === 0) {
      expect(job.status).toBe('complete');
      expect(completed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ generationId: params.jobId }));
      expect(failed).not.toHaveBeenCalled();
      expect(mocks.history).toEqual([expect.objectContaining({ id: params.jobId })]);
    } else {
      expect(job.status).toBe('error');
      expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ error: 'Exit code 7' }));
      expect(completed).not.toHaveBeenCalled();
      expect(mocks.history).toEqual([]);
    }
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

  describe('proven Metal buffer reuse', () => {
    let restore;
    let saved;
    const makeChild = pid => Object.assign(new EventEmitter(), {
      pid, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null, killed: false, kill: vi.fn(),
    });
    beforeEach(() => {
      const restorePlatform = pinPlatform('darwin');
      const restoreArch = pinArch('arm64');
      restore = () => { restoreArch(); restorePlatform(); };
      mocks.mlx = true;
      mocks.signature.mockResolvedValue('a'.repeat(64));
      saved = JSON.stringify({ version: 1, entries: [] });
      mocks.profiles = _createMetalBufferProfiles({ file: 'unused', read: async () => saved,
        write: async (_file, data) => { saved = JSON.stringify(data); } });
    });
    afterEach(() => { restore(); vi.unstubAllEnvs(); });
    const abort = async () => {
      child.stderr.emit('data', Buffer.from('kIOGPUCommandBufferCallbackErrorTimeout\n'));
      child.signalCode = 'SIGABRT';
      child.emit('close', null, 'SIGABRT');
      await vi.advanceTimersByTimeAsync(0);
    };
    const recover = async () => {
      const retry = makeChild(202);
      mocks.spawn.mockResolvedValueOnce(child).mockResolvedValueOnce(retry);
      await spawnAndWatchVideo(params);
      await vi.advanceTimersByTimeAsync(1000);
      await abort();
      child = retry;
      expect(mocks.spawn).toHaveBeenCalledTimes(2);
      expect(mocks.spawn.mock.calls[0][2].env.MLX_MAX_OPS_PER_BUFFER).toBeUndefined();
      expect(mocks.spawn.mock.calls[1][2].env).toMatchObject({ MLX_MAX_OPS_PER_BUFFER: '4', MLX_MAX_MB_PER_BUFFER: '16' });
      child.stdout.emit('data', Buffer.from(JSON.stringify({ video_path: params.outputPath }) + '\n'));
      mocks.outputs.set(params.outputPath, { size: 100, mtimeMs: Date.now() });
    };

    it('learns only after verified publication, then starts matching jobs at the caps and invalidates a second watchdog', async () => {
      await recover();
      expect(JSON.parse(saved).entries).toEqual([]);
      await closeChild(0);
      expect(JSON.parse(saved).entries).toHaveLength(1);
      expect(mocks.history[0].metalBufferPolicy).toMatchObject({ policy: 'reactive-retry', abortedAttemptMs: 1000 });
      child = makeChild(303);
      mocks.spawn.mockResolvedValue(child);
      job.status = 'running';
      await spawnAndWatchVideo(params);
      expect(mocks.spawn.mock.lastCall[2].env).toMatchObject({ MLX_MAX_OPS_PER_BUFFER: '4', MLX_MAX_MB_PER_BUFFER: '16' });
      expect(job.metalBufferPolicy.policy).toBe('learned-initial');
      await abort();
      expect(mocks.spawn).toHaveBeenCalledTimes(3);
      expect(JSON.parse(saved).entries).toEqual([]);
      expect(job.status).toBe('error');
    });

    it.each(['publication', 'unverified-output', 'ownership', 'canceled', 'late-cancel', 'clear', 'failed', 'teardown'])('does not learn from %s recovery', async failure => {
      await recover();
      if (failure === 'publication') mocks.optimize.mockRejectedValue(new Error('publication failed'));
      if (failure === 'unverified-output') mocks.outputs.clear();
      if (failure === 'ownership') mocks.release.mockRejectedValue(new Error('claim release uncertain'));
      if (failure === 'canceled') child.killed = true;
      if (failure === 'late-cancel') mocks.optimize.mockImplementation(async () => { videoJobState.cancelEpoch += 1; });
      if (failure === 'clear') {
        const activeEnv = { ...mocks.spawn.mock.lastCall[2].env };
        await mocks.profiles.clear();
        expect(mocks.spawn.mock.lastCall[2].env).toEqual(activeEnv);
      }
      if (failure === 'teardown') {
        child.signalCode = 'SIGABRT';
        child.emit('close', null, 'SIGABRT');
        await vi.advanceTimersByTimeAsync(0);
      } else await closeChild(failure === 'failed' ? 1 : 0);
      expect(JSON.parse(saved).entries).toEqual([]);
    });

    it('a partially published retry batch cannot teach the next job', async () => {
      params.batch = [{ id: 'batch-first', index: 0, seed: 42, filename: 'first.mp4' }, { id: 'batch-second', index: 1, seed: 43, filename: 'second.mp4' }];
      const retry = makeChild(202);
      mocks.spawn.mockResolvedValueOnce(child).mockResolvedValueOnce(retry);
      await spawnAndWatchVideo(params);
      await abort();
      child = retry;
      child.stdout.emit('data', Buffer.from(JSON.stringify({ video_path: join('/mock/videos', 'first.mp4'), batch_index: 0, seed: 42 }) + '\n'));
      await closeChild(0);
      expect(mocks.history).toHaveLength(1);
      expect(JSON.parse(saved).entries).toEqual([]);
      expect(job.status).toBe('error');
    });

    it('a cache write error preserves an otherwise successful render', async () => {
      await recover();
      vi.spyOn(mocks.profiles, 'learn').mockRejectedValue(new Error('cache unavailable'));
      await closeChild(0);
      expect(job.status).toBe('complete');
      expect(mocks.history).toHaveLength(1);
      expect(failed).not.toHaveBeenCalled();
      expect(job.metalBufferPolicy.diagnostic).toBe('cache-write-failed');
    });

    it('does not learn a requested sampler profile whose runner reports degradation', async () => {
      params.speedProfileId = 'fast';
      await recover();
      child.stdout.emit('data', Buffer.from('SPEEDPROFILE:{"id":"fast","degraded":["adapter-unavailable"]}\n'));
      await closeChild(0);
      expect(job.status).toBe('complete');
      expect(JSON.parse(saved).entries).toEqual([]);
    });

    it('operator caps and non-MLX execution bypass learned settings', async () => {
      await mocks.profiles.learn(await mocks.profiles.lookup('a'.repeat(64)));
      vi.stubEnv('MLX_MAX_MB_PER_BUFFER', '32');
      await spawnAndWatchVideo(params);
      expect(mocks.signature).not.toHaveBeenCalled();
      expect(job.metalBufferPolicy.policy).toBe('operator');
      await closeChild(0);
      vi.unstubAllEnvs();
      mocks.mlx = false;
      await spawnAndWatchVideo(params);
      expect(mocks.spawn.mock.lastCall[2].env.MLX_MAX_MB_PER_BUFFER).toBeUndefined();
    });
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
