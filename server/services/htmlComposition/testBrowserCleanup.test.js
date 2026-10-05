import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _cleanupTestBrowser, _testChromeProcessFacts, _waitForTestChrome, _withTestCaptureDiagnostics } from './testBrowserCleanup.js';

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
  expect(proc.listenerCount('spawn')).toBe(0);
  expect(proc.listenerCount('error')).toBe(0);
  expect(proc.listenerCount('exit')).toBe(0);
  expect(proc.stderr.listenerCount('data')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
}

describe('failure process observations', () => {
  // Synthetic procfs only: no host process, command, environment or profile.
  const stat = (state, parent, group = 777, session = 888) => `123 (example-secret (wrapper)) ${state} ${parent} ${group} ${session} 0 0 0`;
  it('classifies owned-child waits and worker ancestry with bounded, allowlisted output', () => {
    const read = vi.fn(path => {
      if (path === '/proc/123/stat') return stat('D', 456);
      if (path === '/proc/456/stat') return stat('R', 999);
      const id = path.split('/').at(-2);
      return { 1: 'futex_wait_queue', 2: 'ep_poll', 3: 'do_wait', 4: 'io_schedule', 5: 'pipe_read', 6: '0' }[id]
        ?? '/private/example-secret --password=example-secret';
    });
    const threads = vi.fn(() => Array.from({ length: 200 }, (_, i) => String(i + 1)));
    const result = _testChromeProcessFacts({ pid: 123 }, { platform: 'linux', workerPid: 456, read, threads });
    expect(result).toBe('os=linux child=uninterruptible worker=runnable parent=worker group=worker session=worker threads=16 threadLimit=true waits=none:1,futex:1,poll:1,pipe:1,child:1,io:1,other:10,unavailable:0');
    expect(read).toHaveBeenCalledTimes(18);
    expect(read.mock.calls.every(([path]) => /^\/proc\/(123|456)\/(stat|task\/\d+\/wchan)$/.test(path))).toBe(true);
    expect(result).not.toMatch(/123|456|777|888|999|example-secret|password|private/);
  });

  it('keeps absent, malformed and denied observations distinct from successful capture', () => {
    const denied = () => { throw new Error('/private/example-secret'); };
    expect(_testChromeProcessFacts({ pid: 123 }, { platform: 'linux', read: denied, threads: denied }))
      .toContain('child=unavailable worker=unavailable parent=unavailable group=unavailable session=unavailable threads=unavailable threadLimit=unavailable');
    const read = path => path.endsWith('/stat') ? 'malformed example-secret' : '0';
    const result = _testChromeProcessFacts({ pid: 123 }, { platform: 'linux', read, threads: () => [] });
    expect(result).toContain('child=unavailable');
    expect(result).toContain('threads=0 threadLimit=false');
    expect(result).not.toContain('example-secret');
  });

  it('separates a reparented child outside the worker group and unavailable thread waits', () => {
    const read = path => {
      if (path === '/proc/123/stat') return stat('Z', 1, 2, 3);
      if (path === '/proc/456/stat') return stat('S', 999);
      if (path.endsWith('/1/wchan')) throw new Error('denied example-secret');
      // The permitted prefix is complete, but the excess must be discarded.
      return '0'.padEnd(4096, ' ') + 'example-secret';
    };
    const result = _testChromeProcessFacts({ pid: 123 }, { platform: 'linux', workerPid: 456, read, threads: () => ['1', '2', '../example-secret'] });
    expect(result).toBe('os=linux child=zombie worker=sleeping parent=other group=other session=other threads=2 threadLimit=false waits=none:1,futex:0,poll:0,pipe:0,child:0,io:0,other:0,unavailable:1');
  });

  it('does no reads on unsupported platforms or missing child identity', () => {
    const read = vi.fn();
    const threads = vi.fn();
    expect(_testChromeProcessFacts({ pid: 123 }, { platform: 'darwin', read, threads })).toBe('os=unsupported');
    expect(_testChromeProcessFacts({}, { platform: 'linux', read, threads })).toBe('os=linux child=unavailable');
    expect(read).not.toHaveBeenCalled();
    expect(threads).not.toHaveBeenCalled();
  });
});

describe('test Chrome startup', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits for a complete DevTools address across stderr chunks', async () => {
    const proc = startingChild();
    const observeProcess = vi.fn();
    const ready = _waitForTestChrome(proc, 20000, undefined, { observeProcess });
    proc.stderr.emit('data', Buffer.from('noise\nDevTools listening on ws://127.0.0.1:4'));
    proc.stderr.emit('data', Buffer.from('321/devtools/browser/example'));
    expect(proc.listenerCount('exit')).toBe(1);
    proc.stderr.emit('data', Buffer.from('\n'));
    await expect(ready).resolves.toBe('ws://127.0.0.1:4321/devtools/browser/example');
    expect(observeProcess).not.toHaveBeenCalled();
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
    const ready = _waitForTestChrome(proc, 20000, undefined, { observeProcess: () => { throw new Error('example-secret'); } });
    proc.emit('error', Object.assign(new Error('/private/example-secret/chrome'), { code: 'ENOENT' }));
    await expect(ready).rejects.toThrow('failed to spawn (ENOENT; no stderr; process: os=unavailable)');
    await expect(ready).rejects.not.toThrow('example-secret');
    expectStartupClean(proc);
  });

  it('reports redacted startup facts on a silent timeout without paths or output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'example-secret-'));
    const proc = startingChild();
    proc.pid = 123;
    const ready = _waitForTestChrome(proc, 20000, { source: 'playwright', executable: join(root, 'missing', 'chrome-headless-shell'), profile: join(root, 'profile') });
    const rejected = expect(ready).rejects.toThrow(
      'no stderr; startup: source=playwright kind=headless-shell version=unavailable spawned=yes pid=yes state=running profile=missing devToolsActivePort=false',
    );
    proc.emit('spawn');
    await vi.advanceTimersByTimeAsync(20000);
    await rejected;
    await expect(ready).rejects.not.toThrow('example-secret');
    expectStartupClean(proc);
    rmSync(root, { recursive: true });
  });

  it('keeps the startup deadline and clears listeners on timeout', async () => {
    const proc = startingChild();
    const observeProcess = vi.fn(() => 'os=linux child=sleeping');
    const ready = _waitForTestChrome(proc, 20000, undefined, { observeProcess });
    const rejected = expect(ready).rejects.toThrow('did not start within 20000ms; no stderr; process: os=linux child=sleeping');
    await vi.advanceTimersByTimeAsync(19999);
    expect(observeProcess).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(observeProcess).toHaveBeenCalledExactlyOnceWith(proc);
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
    vi.spyOn(console, 'error').mockImplementation(() => {});
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
    const observeProcess = vi.fn();
    await _cleanupTestBrowser({ proc, cleanup: vi.fn(), observeProcess });
    expect(observeProcess).not.toHaveBeenCalled();
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

  it.each([
    ['accepted but running', true, null, 'none', 'accepted'],
    ['rejected with a delivery error', false, null, 'EPERM', 'rejected'],
    ['exit state without an observed event', true, 'SIGKILL', 'none', 'accepted'],
  ])('distinguishes %s at the unchanged termination deadline', async (_name, accepted, signalCode, errorCode, result) => {
    const proc = child();
    proc.pid = 123456;
    proc.kill.mockImplementation(signal => {
      if (errorCode !== 'none') proc.emit('error', Object.assign(new Error('/private/example-secret'), { code: errorCode }));
      if (signal === 'SIGKILL') proc.signalCode = signalCode;
      return accepted;
    });
    const cleanup = vi.fn();
    const observeProcess = vi.fn(() => 'os=linux child=zombie worker=runnable parent=worker');
    const pending = _cleanupTestBrowser({ proc, cleanup, observeProcess });
    const rejected = expect(pending).rejects.toThrow(
      `child termination exceeded 10000ms deadline; teardown: stage=child-termination term=${result} kill=${result}`
        + ` exitCode=none signal=${signalCode ?? 'none'} exitObserved=false signalError=${errorCode}; process: os=linux child=zombie worker=runnable parent=worker`,
    );
    await vi.advanceTimersByTimeAsync(9999);
    expect(observeProcess).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(observeProcess).toHaveBeenCalledExactlyOnceWith(proc);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(proc.stderr.destroy).toHaveBeenCalledOnce();
    expect(proc.listenerCount('exit')).toBe(0);
    expect(proc.listenerCount('error')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const logs = console.error.mock.calls.flat().join('\n');
    expect(logs).not.toContain('123456');
    expect(logs).not.toContain('example-secret');
  });

  it('reports both deadlines and cleans data even if disconnect and child exit never settle', async () => {
    const proc = child();
    proc.kill.mockImplementation(() => true);
    const cleanup = vi.fn();
    const result = _cleanupTestBrowser({
      browser: { close: () => new Promise(() => {}) }, proc, cleanup,
      observeProcess: () => { throw new Error('example-secret'); },
    });
    const rejected = expect(result).rejects.toThrow(
      'Test Chrome browser disconnect exceeded 5000ms deadline; Test Chrome child termination exceeded 10000ms deadline',
    );
    await vi.advanceTimersByTimeAsync(15000);
    await rejected;
    await expect(result).rejects.toThrow('process: os=unavailable');
    await expect(result).rejects.not.toThrow('example-secret');
    expect(proc.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(proc.stderr.destroy).toHaveBeenCalledOnce();
    expect(proc.listenerCount('exit')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
