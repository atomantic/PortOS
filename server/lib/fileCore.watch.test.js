import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, watch } from 'fs';
import { watchForFile } from './fileCore.js';

vi.mock('fs', async (importOriginal) => ({
  ...await importOriginal(),
  existsSync: vi.fn(),
  watch: vi.fn(),
}));

describe('completion watcher failure recovery', () => {
  let watcher;
  let nativeClosed;
  let stop;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    existsSync.mockReturnValue(false);
    nativeClosed = false;
    watcher = new EventEmitter();
    watcher.close = vi.fn(() => {
      if (nativeClosed) return;
      nativeClosed = true;
      queueMicrotask(() => watcher.emit('close'));
    });
    watch.mockReturnValue(watcher);
  });

  afterEach(() => {
    stop?.();
    stop = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const failNativeWatcher = () => {
    // Node closes the native handle before emitting an error. A later close()
    // is a no-op and does NOT emit the close event completion used to await.
    nativeClosed = true;
    watcher.emit('error', Object.assign(new Error('synthetic watcher failure'), { code: 'EIO' }));
  };

  it.each(['startup', 'asynchronous'])('detects completion once after %s watcher failure', async (failure) => {
    if (failure === 'startup') watch.mockImplementationOnce(() => {
      throw Object.assign(new Error('synthetic watch limit'), { code: 'ENOSPC' });
    });
    const onDetected = vi.fn();
    const shouldDetect = vi.fn(() => false);
    stop = watchForFile('done.sentinel', onDetected, { shouldDetect });
    if (failure === 'asynchronous') failNativeWatcher();

    existsSync.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(5050);
    expect(onDetected).not.toHaveBeenCalled();
    shouldDetect.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(onDetected).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('using fallback polling'));
    await vi.advanceTimersByTimeAsync(10000);
    expect(onDetected).toHaveBeenCalledTimes(1);
  });

  it('finishes a settling completion after the native watcher fails', async () => {
    const onDetected = vi.fn();
    stop = watchForFile('done.sentinel', onDetected);
    existsSync.mockReturnValue(true);
    watch.mock.calls[0][1]('rename', 'done.sentinel');
    failNativeWatcher();

    await vi.advanceTimersByTimeAsync(50);
    expect(onDetected).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('delivers an existing completion asynchronously when watcher startup fails', async () => {
    watch.mockImplementationOnce(() => {
      throw Object.assign(new Error('synthetic watch limit'), { code: 'ENOSPC' });
    });
    existsSync.mockReturnValue(true);
    const onDetected = vi.fn();

    stop = watchForFile('done.sentinel', onDetected);
    expect(onDetected).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(onDetected).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels fallback detection and releases timers after a watcher failure', async () => {
    const onDetected = vi.fn();
    stop = watchForFile('done.sentinel', onDetected);
    failNativeWatcher();
    stop();
    stop();
    existsSync.mockReturnValue(true);

    await vi.advanceTimersByTimeAsync(10000);
    expect(onDetected).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
