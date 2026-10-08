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

const syntheticResources = {
  arch: 'unsupported',
  cpus: () => 4,
  usage: () => ({ userCPUTime: 0, systemCPUTime: 12, maxRSS: 34 }),
  disk: () => ({ bavail: 2, bsize: 4096, ffree: 5 }),
};
const resourceText = {
  '/proc/pressure/cpu': 'some avg10=1.25 avg60=2.00 avg300=3.00 total=4',
  '/proc/pressure/memory': 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0',
  '/proc/pressure/io': 'some avg10=3.50 avg60=4.00 avg300=5.00 total=6',
  '/proc/meminfo': 'MemAvailable: 42 kB\n',
};
const resourceExpected = '; resources: cpus=4 workerUserMicros=0 workerSystemMicros=12 workerMaxRssKiB=34 childCpuTicks=23'
  + ' cpuAvg10=1.25 memoryAvg10=0 ioAvg10=3.5 memAvailableKiB=42 tmpFreeBytes=8192 tmpFreeInodes=5; syscalls: table=unsupported';

function expectStartupClean(proc) {
  expect(proc.listenerCount('spawn')).toBe(0);
  expect(proc.listenerCount('error')).toBe(0);
  expect(proc.listenerCount('exit')).toBe(0);
  expect(proc.stderr.listenerCount('data')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
}

describe('failure process observations', () => {
  // Synthetic procfs only: no host process, command, environment or profile.
  const stat = (state, parent, group = 777, session = 888) => `123 (example-secret (wrapper)) ${state} ${parent} ${group} ${session} 0 0 0 0 0 0 0 12 11`;
  it('classifies owned-child waits and worker ancestry with bounded, allowlisted output', () => {
    const read = vi.fn(path => {
      if (path === '/proc/123/stat') return stat('D', 456);
      if (path === '/proc/456/stat') return stat('R', 999);
      if (path === '/proc/123/wchan') return 'folio_wait_bit_common';
      if (Object.hasOwn(resourceText, path)) return resourceText[path];
      const id = path.split('/').at(-2);
      return { 1: 'futex_wait_queue', 2: 'ep_poll', 3: 'do_wait', 4: 'io_schedule', 5: 'pipe_read', 6: '0' }[id]
        ?? '/private/example-secret --password=example-secret';
    });
    const threads = vi.fn(() => Array.from({ length: 200 }, (_, i) => String(i + 1)));
    const result = _testChromeProcessFacts({ pid: 123 }, { platform: 'linux', workerPid: 456, read, threads, ...syntheticResources });
    expect(result).toBe('os=linux child=uninterruptible worker=runnable parent=worker group=worker session=worker leadWait=page threads=16 threadLimit=true waits=none:1,futex:1,poll:1,pipe:1,child:1,io:1,page:0,completion:0,lock:0,other:10,unavailable:0' + resourceExpected);
    expect(read).toHaveBeenCalledTimes(23);
    expect(read.mock.calls.every(([path]) => /^\/proc\/(?:(123|456)\/(stat|wchan|task\/\d+\/wchan)|pressure\/(cpu|memory|io)|meminfo)$/.test(path))).toBe(true);
    expect(result).not.toMatch(/123|456|777|888|999|example-secret|password|private/);
  });

  it('keeps absent, malformed and denied observations distinct from successful capture', () => {
    const denied = () => { throw new Error('/private/example-secret'); };
    expect(_testChromeProcessFacts({ pid: 123 }, { platform: 'linux', read: denied, threads: denied, cpus: denied, usage: denied, disk: denied }))
      .toContain('child=unavailable worker=unavailable parent=unavailable group=unavailable session=unavailable leadWait=unavailable threads=unavailable threadLimit=unavailable');
    for (const malformed of ['malformed example-secret', '123 (example-secret) R', '123 (example-secret) toString 1 2 3']) {
      const read = path => path.endsWith('/stat') ? malformed : '0';
      const result = _testChromeProcessFacts({ pid: 123 }, { platform: 'linux', read, threads: () => [], ...syntheticResources });
      expect(result).toContain('child=unavailable');
      expect(result).toContain('threads=0 threadLimit=false');
      expect(result).not.toContain('example-secret');
    }
  });

  it('separates a reparented child outside the worker group and unavailable thread waits', () => {
    const read = path => {
      if (path === '/proc/123/stat') return stat('Z', 1, 2, 3);
      if (path === '/proc/456/stat') return stat('S', 999);
      if (Object.hasOwn(resourceText, path)) return resourceText[path];
      if (path.endsWith('/1/wchan')) throw new Error('denied example-secret');
      // The permitted prefix is complete, but the excess must be discarded.
      return '0'.padEnd(4096, ' ') + 'example-secret';
    };
    const result = _testChromeProcessFacts({ pid: 123 }, { platform: 'linux', workerPid: 456, read, threads: () => ['1', '2', '../example-secret'], ...syntheticResources });
    expect(result).toBe('os=linux child=zombie worker=sleeping parent=other group=other session=other leadWait=none threads=2 threadLimit=false waits=none:1,futex:0,poll:0,pipe:0,child:0,io:0,page:0,completion:0,lock:0,other:0,unavailable:1' + resourceExpected);
  });

  it('keeps unknown wait symbols private instead of inferring a subsystem', () => {
    const read = path => {
      if (path.endsWith('/stat')) return stat('D', 456);
      if (Object.hasOwn(resourceText, path)) return resourceText[path];
      if (path === '/proc/123/wchan') return 'wait_for_completion';
      return { 1: 'do_wait_for_common', 2: '__mutex_lock', 3: 'folio_wait_bit_common', 4: '__mutex_lock.example-secret' }[path.split('/').at(-2)];
    };
    const result = _testChromeProcessFacts({ pid: 123 }, {
      platform: 'linux', workerPid: 456, read, threads: () => ['1', '2', '3', '4'], ...syntheticResources,
    });
    expect(result).toContain('child=uninterruptible');
    expect(result).toContain('leadWait=completion');
    expect(result).toContain('page:1,completion:1,lock:1,other:1,unavailable:0');
    expect(result).not.toMatch(/example-secret|wait_for_completion|mutex|folio/);
  });

  it('preserves child facts when resources are denied, invalid or outside the prefix', () => {
    const denied = () => { throw new Error('/private/example-secret'); };
    const read = path => {
      if (path.endsWith('/stat')) return stat('D', 456).replace('12 11', '99999999999999999999 11');
      if (path === '/proc/pressure/cpu') return 'some avg10=101 avg60=0';
      if (path === '/proc/pressure/memory') return 'some avg10=example-secret avg60=0';
      if (path === '/proc/pressure/io') return ' '.repeat(4096) + 'some avg10=0';
      if (path === '/proc/meminfo') return 'MemAvailable: 99999999999999999999 kB\n';
      return '0';
    };
    const result = _testChromeProcessFacts({ pid: 123 }, {
      platform: 'linux', workerPid: 456, read, threads: () => [], cpus: denied,
      usage: () => ({ userCPUTime: 'example-secret', systemCPUTime: -1, maxRSS: Infinity }),
      disk: () => ({ bavail: -2, bsize: -4096, ffree: NaN }),
    });
    expect(result).toContain('child=uninterruptible worker=uninterruptible');
    expect(result).toContain('cpus=unavailable workerUserMicros=unavailable workerSystemMicros=unavailable workerMaxRssKiB=unavailable childCpuTicks=unavailable');
    expect(result).toContain('cpuAvg10=unavailable memoryAvg10=unavailable ioAvg10=unavailable memAvailableKiB=unavailable tmpFreeBytes=unavailable tmpFreeInodes=unavailable');
    expect(result).not.toMatch(/example-secret|private|NaN|Infinity/);
    const unavailable = _testChromeProcessFacts({ pid: 123 }, {
      platform: 'linux', read: path => path.endsWith('/stat') ? stat('S', 456) : denied(),
      threads: () => [], cpus: denied, usage: denied, disk: denied,
    });
    expect(unavailable).toContain('child=sleeping');
    expect(unavailable).toContain('tmpFreeBytes=unavailable');
  });

  it('does no reads on unsupported platforms or missing/settled child identity', () => {
    const read = vi.fn();
    const threads = vi.fn();
    const resources = { cpus: vi.fn(), usage: vi.fn(), disk: vi.fn() };
    expect(_testChromeProcessFacts({ pid: 123 }, { platform: 'darwin', read, threads, ...resources })).toBe('os=unsupported');
    expect(_testChromeProcessFacts({}, { platform: 'linux', read, threads, ...resources })).toBe('os=linux child=unavailable');
    expect(_testChromeProcessFacts({ pid: 123, exitCode: 0 }, { platform: 'linux', read, threads, ...resources })).toBe('os=linux child=settled');
    expect(_testChromeProcessFacts({ pid: 123, signalCode: 'SIGTERM' }, { platform: 'linux', read, threads, ...resources })).toBe('os=linux child=settled');
    expect(read).not.toHaveBeenCalled();
    expect(threads).not.toHaveBeenCalled();
    for (const observation of Object.values(resources)) expect(observation).not.toHaveBeenCalled();
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
    const ready = _waitForTestChrome(proc, 20000, { source: 'playwright', executable: join(root, 'missing', 'chrome-headless-shell'), profile: join(root, 'profile') },
      { observeProcess: () => 'os=unavailable' });
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
    proc.pid = 123;
    const read = vi.fn(path => resourceText[path] ?? (path.endsWith('/stat') ? '123 (example-secret) D 456 777 888' : 'folio_wait_bit_common'));
    const observeProcess = vi.fn(owned => _testChromeProcessFacts(owned, {
      platform: 'linux', workerPid: 456, read, threads: () => [], ...syntheticResources,
    }));
    const ready = _waitForTestChrome(proc, 20000, undefined, { observeProcess });
    const rejected = expect(ready).rejects.toThrow('did not start within 20000ms; no stderr; process: os=linux child=uninterruptible');
    await vi.advanceTimersByTimeAsync(19999);
    expect(observeProcess).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(observeProcess).toHaveBeenCalledExactlyOnceWith(proc);
    await expect(ready).rejects.toThrow('leadWait=page');
    await expect(ready).rejects.toThrow('cpuAvg10=1.25 memoryAvg10=0 ioAvg10=3.5');
    await expect(ready).rejects.not.toThrow('example-secret');
    expectStartupClean(proc);
  });

  it('captures capped syscall categories only at failure, without leaking registers or inventing denied observations', async () => {
    const proc = startingChild();
    proc.pid = 123;
    const registers = ' 0xexample-secret 456 777 /private/example-secret';
    const read = vi.fn(path => {
      if (path.endsWith('/stat')) return '123 (example-secret) D 456 777 888';
      if (path.endsWith('/wchan')) return 'folio_wait_bit_common';
      if (path === '/proc/123/syscall') return '9' + registers;
      if (path.endsWith('/syscall')) {
        const id = path.split('/').at(-2);
        if (id === '4') throw new Error('denied example-secret');
        return ({ 1: '202' + registers, 2: 'running', 3: '-1' + registers, 5: '257' + registers, 6: '318' + registers, 7: '999' + registers, 8: 'malformed example-secret', 9: '9'.padEnd(4096, ' ') + registers })[id] ?? '0' + registers;
      }
      return resourceText[path];
    });
    const observeProcess = owned => _testChromeProcessFacts(owned, {
      platform: 'linux', workerPid: 456, read, threads: () => Array.from({ length: 100 }, (_, i) => String(i + 1)),
      ...syntheticResources, arch: 'x64',
    });
    const ready = _waitForTestChrome(proc, 20000, undefined, { observeProcess });
    const rejected = expect(ready).rejects.toThrow('did not start within 20000ms');
    await vi.advanceTimersByTimeAsync(19999);
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    await expect(ready).rejects.toThrow('syscalls: table=x64-native lead=memory threads=running:1,outside:1,read:7,write:0,open:1,metadata:0,memory:1,futex:1,poll:0,process:0,entropy:1,device:0,other:1,unavailable:2');
    await expect(ready).rejects.not.toThrow(/example-secret|0x|\/private\/|456|777|888/);
    expect(read).toHaveBeenCalledTimes(40);
    expect(read.mock.calls.filter(([path]) => path.endsWith('/syscall'))).toHaveLength(17);
    expect(read.mock.calls.every(([path]) => /^\/proc\/(?:(123|456)\/(stat|wchan|syscall|task\/\d+\/(wchan|syscall))|pressure\/(cpu|memory|io)|meminfo)$/.test(path))).toBe(true);
    expectStartupClean(proc);
  });

  it('keeps denied leader syscalls and unavailable thread lists distinct from empty or unsupported samples', () => {
    const read = vi.fn(path => {
      if (path.endsWith('/syscall')) throw new Error('denied example-secret');
      return resourceText[path] ?? '0';
    });
    const options = { platform: 'linux', read, ...syntheticResources, arch: 'x64' };
    const denied = _testChromeProcessFacts({ pid: 123 }, { ...options, threads: () => { throw new Error('denied'); } });
    expect(denied).toContain('syscalls: table=x64-native lead=unavailable threads=unavailable');
    const empty = _testChromeProcessFacts({ pid: 123 }, { ...options, threads: () => [] });
    expect(empty).toContain('syscalls: table=x64-native lead=unavailable threads=running:0,outside:0');
    read.mockClear();
    expect(_testChromeProcessFacts({ pid: 123 }, { ...options, arch: 'arm64', threads: () => [] })).toContain('syscalls: table=unsupported');
    expect(read.mock.calls.some(([path]) => path.endsWith('/syscall'))).toBe(false);
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
      'Test Chrome browser disconnect exceeded 5000ms deadline; process: os=unavailable; Test Chrome child termination exceeded 10000ms deadline',
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
