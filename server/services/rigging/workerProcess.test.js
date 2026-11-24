import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRiggingWorker } from './workerProcess.js';

// A worker that ignores SIGTERM and only dies on SIGKILL, like Blender wedged in native code.
function stubbornChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn((signal) => {
    if (signal === 'SIGKILL') {
      child.signalCode = 'SIGKILL';
      child.emit('close', null);
    }
  });
  return child;
}

const run = (child, extra = {}) => runRiggingWorker({
  python: 'python', script: 'w.py', jobFile: 'j.json', spawnImpl: () => child, ...extra,
});

describe('runRiggingWorker termination', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('escalates a timed-out worker that ignores SIGTERM to SIGKILL and settles once', async () => {
    const child = stubbornChild();
    const result = run(child, { timeoutMs: 60_000, killGraceMs: 1000 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    const { code, tail } = await result;
    expect(code).toBeNull();
    expect(tail).toContain('exceeded 1 minutes and was terminated');
  });

  it('aborts via signal with SIGKILL escalation and clears the timeout', async () => {
    const child = stubbornChild();
    const controller = new AbortController();
    const result = run(child, { signal: controller.signal, killGraceMs: 500 });
    controller.abort();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(500);
    const { tail } = await result;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(tail).toContain('cancelled');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not spawn when already aborted', async () => {
    const spawnImpl = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const { code } = await runRiggingWorker({ python: 'p', script: 's', jobFile: 'j', spawnImpl, signal: controller.signal });
    expect(code).toBe(-1);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('does not escalate once the worker exited on SIGTERM', async () => {
    const child = stubbornChild();
    child.kill = vi.fn(() => { child.exitCode = 0; child.emit('close', 0); });
    const controller = new AbortController();
    const result = run(child, { signal: controller.signal, killGraceMs: 500 });
    controller.abort();
    await result;
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
