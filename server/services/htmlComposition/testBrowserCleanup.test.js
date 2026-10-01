import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _cleanupTestBrowser, _waitForTestChrome, _withTestCaptureDiagnostics } from './testBrowserCleanup.js';

function child() {
  const proc = new EventEmitter();
  proc.exitCode = null;
  proc.signalCode = null;
  proc.stderr = { destroy: vi.fn() };
  proc.kill = vi.fn(signal => {
    if (signal === 'SIGKILL') {
      proc.signalCode = signal;
      proc.emit('exit', null, signal);
    }
    return true;
  });
  return proc;
}

function startingChild() {
  const proc = child();
  proc.stderr = new EventEmitter();
  return proc;
}

function expectStartupClean(proc) {
  expect(proc.listenerCount('error')).toBe(0);
  expect(proc.listenerCount('exit')).toBe(0);
  expect(proc.stderr.listenerCount('data')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
}

describe('test Chrome startup', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits for a complete DevTools address across stderr chunks', async () => {
    const proc = startingChild();
    const ready = _waitForTestChrome(proc);
    proc.stderr.emit('data', Buffer.from('noise\nDevTools listening on ws://127.0.0.1:4'));
    proc.stderr.emit('data', Buffer.from('321/devtools/browser/example'));
    expect(proc.listenerCount('exit')).toBe(1);
    proc.stderr.emit('data', Buffer.from('\n'));
    await expect(ready).resolves.toBe('ws://127.0.0.1:4321/devtools/browser/example');
    expectStartupClean(proc);
  });

  it('reports an early exit promptly without exposing stderr paths', async () => {
    const proc = startingChild();
    const ready = _waitForTestChrome(proc);
    proc.stderr.emit('data', Buffer.from('profile at /private/example-secret is locked; ProcessSingleton failed\n'));
    proc.exitCode = 1;
    proc.emit('exit', 1, null);
    await expect(ready).rejects.toThrow('code 1, signal none; stderr: profile in use');
    await expect(ready).rejects.not.toThrow('example-secret');
    expectStartupClean(proc);
  });

  it('reports a spawn error without exposing its raw message', async () => {
    const proc = startingChild();
    const ready = _waitForTestChrome(proc);
    proc.emit('error', Object.assign(new Error('/private/example-secret/chrome'), { code: 'ENOENT' }));
    await expect(ready).rejects.toThrow('failed to spawn (ENOENT; no stderr)');
    await expect(ready).rejects.not.toThrow('example-secret');
    expectStartupClean(proc);
  });

  it('keeps the startup deadline and clears listeners on timeout', async () => {
    const proc = startingChild();
    const ready = _waitForTestChrome(proc);
    const rejected = expect(ready).rejects.toThrow('did not start within 20000ms; no stderr');
    await vi.advanceTimersByTimeAsync(20000);
    await rejected;
    expectStartupClean(proc);
  });
});

describe('real capture diagnostics boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps live capture moving and forwards progress/results with bounded numeric phase timings', async () => {
    const page = { check: vi.fn(), evaluate: vi.fn(), send: vi.fn() };
    const progress = vi.fn();
    const encode = _withTestCaptureDiagnostics(async (traced, contract, path, options) => {
      expect(path).toBe('/private/example-output.mp4');
      expect(options.offsetSec).toBe(10);
      for (let n = 0; n < 3; n++) {
        page.evaluate.mockImplementationOnce(async () => { await vi.advanceTimersByTimeAsync(10000); });
        page.send.mockImplementationOnce(async () => { await vi.advanceTimersByTimeAsync(10000); });
        await traced.evaluate(`globalThis.portosComposition.seek(${10 + n})`);
        await traced.send('Page.captureScreenshot', { format: 'png' });
        options.onProgress((n + 1) / 3, { frame: n + 1, frames: 3 });
        expect(options.signal.aborted).toBe(false);
      }
      return { sampleHistogram: { 1: 3 } };
    });
    await expect(encode(page, { durationSec: 3, fps: 1 }, '/private/example-output.mp4', { onProgress: progress, offsetSec: 10 }))
      .resolves.toEqual({ sampleHistogram: { 1: 3 } });
    expect(progress.mock.calls).toEqual([[1 / 3, { frame: 1, frames: 3 }], [2 / 3, { frame: 2, frames: 3 }], [1, { frame: 3, frames: 3 }]]);
    expect(page.evaluate.mock.calls.map(([expression]) => expression)).toEqual([
      'globalThis.portosComposition.seek(10)', 'globalThis.portosComposition.seek(11)', 'globalThis.portosComposition.seek(12)',
    ]);
    const lines = console.log.mock.calls.map(([line]) => line);
    expect(lines).toHaveLength(5);
    expect(lines.at(-1)).toContain('frames=3/3 elapsedMs=60000 idleMs=0 setupMs=0 seekMs=30000 captureMs=30000 encodeMs=0');
    expect(lines.join('\n')).not.toContain('example-output');
    expect(console.error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts a stalled encoder drain with its last completed frame and clears the watchdog', async () => {
    let ownedStopped = false;
    const encode = _withTestCaptureDiagnostics(async (page, contract, path, { signal, onProgress }) => {
      await page.evaluate('globalThis.portosComposition.seek(0)');
      await page.send('Page.captureScreenshot');
      onProgress(1, { frame: 1, frames: 1 });
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => {
        ownedStopped = true;
        reject(signal.reason);
      }, { once: true }));
    });
    const result = encode({ evaluate: async () => {}, send: async () => {} }, { durationSec: 1, fps: 1 }, '/private/example-output.mp4');
    const rejected = expect(result).rejects.toThrow('Test Chrome capture stalled; phase=encode frames=1/1 elapsedMs=30000 idleMs=30000');
    await vi.advanceTimersByTimeAsync(30000);
    await rejected;
    expect(ownedStopped).toBe(true);
    expect(console.error.mock.calls.flat().join('\n')).not.toContain('example-output');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops a late browser response after the test deadline before starting an encoder', async () => {
    const deadline = new AbortController();
    const timedOut = new Error('Test deadline');
    let reply;
    const response = new Promise(resolve => { reply = resolve; });
    const startedEncoder = vi.fn();
    const encode = _withTestCaptureDiagnostics(async page => {
      await page.send('Emulation.setDeviceMetricsOverride');
      page.check();
      startedEncoder();
    }, { getTestSignal: () => deadline.signal });
    const result = encode({ send: () => response, check() {} }, { durationSec: 1, fps: 12 }, '/private/example-output.mp4');
    const rejected = expect(result).rejects.toBe(timedOut);
    deadline.abort(timedOut);
    reply();
    await rejected;
    expect(startedEncoder).not.toHaveBeenCalled();
    expect(console.error.mock.calls.flat().join('\n')).toContain('phase=setup frames=0/12');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves a caller cancellation and removes diagnostics on the failure path', async () => {
    const controller = new AbortController();
    const canceled = new Error('Render canceled');
    const encode = _withTestCaptureDiagnostics(async (page, contract, path, { signal }) => {
      controller.abort(canceled);
      signal.throwIfAborted();
    });
    await expect(encode({}, { durationSec: 1, fps: 12 }, '/private/example-output.mp4', { signal: controller.signal }))
      .rejects.toBe(canceled);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('owned test Chrome cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not wait for a signal-exited child whose exit event already fired', async () => {
    const proc = child();
    proc.signalCode = 'SIGTERM';
    proc.emit('exit', null, 'SIGTERM');
    const cleanup = vi.fn();
    await _cleanupTestBrowser({ proc, cleanup });
    expect(proc.kill).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(proc.stderr.destroy).toHaveBeenCalledOnce();
    expect(proc.listenerCount('exit')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('observes synchronous termination and cancels escalation', async () => {
    const proc = child();
    proc.kill.mockImplementation(signal => {
      proc.signalCode = signal;
      proc.emit('exit', null, signal);
    });
    await _cleanupTestBrowser({ proc, cleanup: vi.fn() });
    expect(proc.kill.mock.calls).toEqual([['SIGTERM']]);
    expect(proc.listenerCount('exit')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('escalates an ignored SIGTERM and waits for delayed exit without waiting for inherited stderr', async () => {
    const proc = child();
    proc.kill.mockImplementation(signal => {
      if (signal === 'SIGKILL') {
        proc.signalCode = signal;
        setTimeout(() => proc.emit('exit', null, signal), 100);
      }
    });
    const cleanup = vi.fn();
    const result = _cleanupTestBrowser({ proc, cleanup });
    await vi.advanceTimersByTimeAsync(3000);
    expect(proc.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(cleanup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(cleanup).toHaveBeenCalledOnce();
    expect(proc.stderr.destroy).toHaveBeenCalledOnce();
    expect(proc.listenerCount('exit')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still terminates the child and cleans data when disconnect rejects', async () => {
    const proc = child();
    const cleanup = vi.fn();
    const result = _cleanupTestBrowser({
      browser: { close: () => Promise.reject(new Error('disconnect failed')) }, proc, cleanup,
    });
    const rejected = expect(result).rejects.toThrow('disconnect failed');
    await vi.advanceTimersByTimeAsync(3000);
    await rejected;
    expect(proc.kill).toHaveBeenLastCalledWith('SIGKILL');
    expect(cleanup).toHaveBeenCalledOnce();
    expect(proc.stderr.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports both deadlines and cleans data even if disconnect and child exit never settle', async () => {
    const proc = child();
    proc.kill.mockImplementation(() => true);
    const cleanup = vi.fn();
    const result = _cleanupTestBrowser({
      browser: { close: () => new Promise(() => {}) }, proc, cleanup,
    });
    const rejected = expect(result).rejects.toThrow(
      'Test Chrome browser disconnect exceeded 5000ms deadline; Test Chrome child termination exceeded 10000ms deadline',
    );
    await vi.advanceTimersByTimeAsync(15000);
    await rejected;
    expect(proc.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(proc.stderr.destroy).toHaveBeenCalledOnce();
    expect(proc.listenerCount('exit')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
