// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _observeOwnedBrowserLaunch, startBrowserFixture } from './browserFixture.js';

const PHASE_MS = { vite: 50, chromium: 50, warmup: 50, cleanup: 50 };
const SCOPED = { optimizeDeps: { entries: ['src/Example.jsx'] } };

const fakeVite = () => {
  const server = { listen: vi.fn(async () => {}), close: vi.fn(async () => {}),
    resolvedUrls: { local: ['http://127.0.0.1:1/'] } };
  return { server, createServer: vi.fn(async () => server) };
};
const fakeBrowser = (page) => ({ close: vi.fn(async () => {}), newPage: vi.fn(async () => page) });
// A process-backed launch: a Playwright browser server owning `child`, and
// the client browser `connect` hands the suite. By default a graceful close
// exits the child; `close`/`kill` replace that server's own steps.
const ownedServer = ({ close, kill } = {}) => {
  const child = { exitCode: null, signalCode: null };
  const server = { process: () => child, wsEndpoint: () => 'ws://127.0.0.1:1/owned',
    close: vi.fn(close ?? (async () => { child.exitCode = 0; })),
    kill: vi.fn(kill ?? (async () => { child.signalCode = 'SIGKILL'; })) };
  return { child, server };
};
const ownedChromium = (server, browser = fakeBrowser()) => ({
  launchServer: vi.fn(async () => server), connect: vi.fn(async () => browser),
});
const stalls = () => new Promise(() => {});
// Each launch attempt's observation reports which attempt it described and
// when it was taken, so a test can prove the facts came from before the kill.
const fakeObserver = () => {
  const samples = [];
  const observeLaunch = vi.fn(() => {
    const attempt = observeLaunch.mock.calls.length;
    return () => { samples.push(attempt); return `state-${attempt}`; };
  });
  return { observeLaunch, samples };
};
const summaryDirs = [];
const stubStepSummary = () => {
  const dir = mkdtempSync(join(tmpdir(), 'fixture-summary-'));
  summaryDirs.push(dir);
  const file = join(dir, 'summary.md');
  vi.stubEnv('GITHUB_STEP_SUMMARY', file);
  return { read: () => (existsSync(file) ? readFileSync(file, 'utf8') : '') };
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const dir of summaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('startBrowserFixture', () => {
  it('retries a stalled Chromium launch once, then names the phase, reports both attempts\' facts and closes every browser that arrives late', async () => {
    // Real deadlines, sampled 2ms before each one, would race a loaded runner.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const summary = stubStepSummary();
    const { server, createServer } = fakeVite();
    const late = [fakeBrowser(), fakeBrowser()];
    const arrive = [];
    const chromium = { launch: vi.fn(() => new Promise(resolve => {
      const browser = late[arrive.length];
      arrive.push(() => resolve(browser));
    })) };
    const { observeLaunch, samples } = fakeObserver();
    let temp;
    const viteConfig = vi.fn(dir => { temp = dir; return SCOPED; });

    const failing = startBrowserFixture({ name: 'example', createServer, viteConfig, chromium, phaseMs: PHASE_MS, observeLaunch })
      .catch(caught => caught);
    // Not vi.waitFor: under fake timers it advances them on every check.
    while (!chromium.launch.mock.calls.length) await new Promise(resolve => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(22);
    expect(samples).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    // Sampled while the first launch was still pending, before its deadline.
    expect(samples).toEqual([1]);
    await vi.advanceTimersByTimeAsync(2);
    expect(chromium.launch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(25);
    vi.useRealTimers();
    const error = await failing;

    expect(error.message).toMatch(/^example startup failed during Chromium launch: timed out after 50ms \(retried after a first attempt timed out after 25ms\) \(completed: Vite server start \d+ms; cleaned up; launch facts: attempt 1 at 23ms: state-1; attempt 2 at 23ms: state-2\)$/);
    expect(summary.read()).toBe(`- ❌ ${error.message}\n`);
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(existsSync(temp)).toBe(false);
    // Each attempt is a fresh process whose own launch timeout kills it.
    expect(chromium.launch.mock.calls.map(([options]) => options.timeout)).toEqual([25, 25]);
    expect(chromium.launch.mock.calls[1][0]).toMatchObject({ env: { TMPDIR: temp } });

    arrive[1]();
    arrive[0]();
    await vi.waitFor(() => {
      expect(late[0].close).toHaveBeenCalledTimes(1);
      expect(late[1].close).toHaveBeenCalledTimes(1);
    });
  });

  it('uses the retried launch and closes the first one when it arrives late', async () => {
    const { server, createServer } = fakeVite();
    const stalled = fakeBrowser();
    const retried = fakeBrowser();
    let arrive;
    const chromium = { launch: vi.fn()
      .mockReturnValueOnce(new Promise(resolve => { arrive = () => resolve(stalled); }))
      .mockResolvedValueOnce(retried) };
    const { observeLaunch, samples } = fakeObserver();
    const summary = stubStepSummary();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const fixture = await startBrowserFixture({ name: 'example', createServer, viteConfig: () => SCOPED, chromium,
      phaseMs: { ...PHASE_MS, chromium: 2000 }, observeLaunch });

    expect(fixture.browser).toBe(retried);
    // The recovered stall keeps its facts; the retry settled before sampling.
    const ready = /^🧪 example browser fixture ready \(Vite server start \d+ms, Chromium launch \d+ms \(retried after a first attempt timed out after 1000ms\); launch facts: attempt 1 at 900ms: state-1\)$/;
    expect(log).toHaveBeenCalledWith(expect.stringMatching(ready));
    expect(samples).toEqual([1]);
    // Vitest's CI silent mode drops that console line; the step summary keeps it.
    expect(summary.read()).toMatch(new RegExp(`^- ${ready.source.slice(1, -1)}\\n$`));
    log.mockRestore();
    arrive();
    await vi.waitFor(() => expect(stalled.close).toHaveBeenCalledTimes(1));

    await fixture.close();
    expect(retried.close).toHaveBeenCalledTimes(1);
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(existsSync(fixture.temp)).toBe(false);
  });

  it('names a stalled Vite start and never listens on a server that arrives late', async () => {
    const { server } = fakeVite();
    let arrive;
    const createServer = vi.fn(() => new Promise(resolve => { arrive = () => resolve(server); }));
    const chromium = { launch: vi.fn() };

    const error = await startBrowserFixture({ name: 'example', createServer, viteConfig: () => SCOPED, chromium,
      phaseMs: PHASE_MS }).catch(caught => caught);

    expect(error.message).toMatch(/^example startup failed during Vite server start: timed out after 50ms \(completed: none; cleaned up\)$/);
    expect(chromium.launch).not.toHaveBeenCalled();

    arrive();
    await vi.waitFor(() => expect(server.close).toHaveBeenCalledTimes(1));
    expect(server.listen).not.toHaveBeenCalled();
  });

  it('closes the launched browser\'s own server and Vite when the warmup page fails', async () => {
    const { server, createServer } = fakeVite();
    const page = { close: vi.fn(async () => {}) };
    const browser = fakeBrowser(page);
    const owned = ownedServer();
    const chromium = ownedChromium(owned.server, browser);
    const cause = new Error('net::ERR_CONNECTION_REFUSED');

    const { observeLaunch, samples } = fakeObserver();

    const error = await startBrowserFixture({ name: 'example', createServer, viteConfig: () => SCOPED, chromium,
      phaseMs: PHASE_MS, observeLaunch, warmup: async () => { throw cause; } }).catch(caught => caught);

    // A launch that settled in time carries no launch facts.
    expect(error.message).toMatch(/during first page warmup: net::ERR_CONNECTION_REFUSED \(completed: Vite server start \d+ms, Chromium launch \d+ms; cleaned up\)$/);
    expect(samples).toEqual([]);
    expect(error.cause).toBe(cause);
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(chromium.connect).toHaveBeenCalledWith('ws://127.0.0.1:1/owned', { timeout: 25 });
    // A graceful close that exits the child needs no kill.
    expect(owned.server.close).toHaveBeenCalledTimes(1);
    expect(owned.child.exitCode).toBe(0);
    expect(owned.server.kill).not.toHaveBeenCalled();
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it('kills an owned browser whose graceful close stalls, inside the cleanup budget, once it has an exit status', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { server, createServer } = fakeVite();
    const owned = ownedServer({ close: stalls });
    const chromium = ownedChromium(owned.server);
    const fixture = await startBrowserFixture({ name: 'example', createServer, viteConfig: () => SCOPED, chromium, phaseMs: PHASE_MS });
    expect(chromium.launchServer).toHaveBeenCalledWith(expect.objectContaining({ env: expect.objectContaining({ TMPDIR: fixture.temp }) }));

    let settled = false;
    const closing = fixture.close().finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(14);
    expect(owned.server.kill).not.toHaveBeenCalled();
    // 30% of the budget is the graceful close's; the kill and its exit fit in the rest.
    await vi.advanceTimersByTimeAsync(1);
    await closing;

    expect(settled).toBe(true);
    expect(owned.server.kill).toHaveBeenCalledTimes(1);
    expect(owned.child.signalCode).toBe('SIGKILL');
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(existsSync(fixture.temp)).toBe(false);
  });

  it('keeps a reap without an exit status a failure — a kill that returns proves nothing', async () => {
    const { createServer } = fakeVite();
    const owned = ownedServer({ close: stalls, kill: async () => {} });
    const fixture = await startBrowserFixture({ name: 'example', createServer, viteConfig: () => SCOPED,
      chromium: ownedChromium(owned.server), phaseMs: PHASE_MS });

    const error = await fixture.close().catch(caught => caught);

    expect(error.message).toBe('browser close stalled after 15ms, then its kill returned without an exit status');
    expect(owned.server.kill).toHaveBeenCalledTimes(1);
    expect(existsSync(fixture.temp)).toBe(false);
  });

  it('reaps owned browsers that arrive after startup gave up with the same bounded cleanup, and reports one it cannot', async () => {
    // The reap's two steps share one budget with the backstop deadline around
    // it; real timers would race them on a loaded runner.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { createServer } = fakeVite();
    const reaped = ownedServer({ close: stalls });
    const unreaped = ownedServer({ close: stalls, kill: stalls });
    const arrive = [];
    const chromium = {
      launchServer: vi.fn(() => new Promise(resolve => { arrive.push(resolve); })),
      connect: vi.fn(),
    };
    const failureLine = vi.spyOn(console, 'error').mockImplementation(() => {});
    let error;
    const failing = startBrowserFixture({ name: 'example', createServer, viteConfig: () => SCOPED, chromium,
      phaseMs: PHASE_MS, observeLaunch: () => () => 'sampled' }).catch((caught) => { error = caught; });

    while (!chromium.launchServer.mock.calls.length) await new Promise(resolve => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(50);
    // Startup cleanup removes the temp dir with real I/O.
    while (!error) await new Promise(resolve => setImmediate(resolve));
    await failing;
    expect(error.message).toMatch(/^example startup failed during Chromium launch: timed out after 50ms/);

    arrive[0](reaped.server);
    arrive[1](unreaped.server);
    await vi.advanceTimersByTimeAsync(15);
    // Both graceful closes stalled for their share of the budget.
    expect(reaped.server.kill).toHaveBeenCalledTimes(1);
    expect(reaped.child.signalCode).toBe('SIGKILL');
    expect(failureLine).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30);
    expect(failureLine).toHaveBeenCalledWith('❌ example browser fixture could not close a late browser: '
      + 'browser close stalled after 15ms, then its kill stalled after 30ms (no exit status)');
    // An abandoned launch is never connected to.
    expect(chromium.connect).not.toHaveBeenCalled();
    failureLine.mockRestore();
  });

  it('only ever close()s an attached `{ launch }` adapter — a stalled one rejects naming it, never terminates it, and Vite and the temp dir still go', async () => {
    const { server, createServer } = fakeVite();
    const browser = fakeBrowser();
    browser.close = vi.fn(stalls);
    const chromium = { launch: vi.fn(async () => browser) };
    const signal = vi.spyOn(process, 'kill');
    const fixture = await startBrowserFixture({ name: 'example', createServer, viteConfig: () => SCOPED, chromium, phaseMs: PHASE_MS });
    expect(existsSync(fixture.temp)).toBe(true);

    const error = await fixture.close().catch(caught => caught);

    expect(error.message).toBe('browser close stalled after 50ms');
    expect(signal).not.toHaveBeenCalled();
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(existsSync(fixture.temp)).toBe(false);
    signal.mockRestore();
  });
});

describe('_observeOwnedBrowserLaunch', () => {
  const procStat = (pid, { name = 'chrome', parent = 42, started = 100 } = {}) =>
    `${pid} (${name}) S ${parent} 42 42 ${Array(15).fill(0).join(' ')} ${started}`;
  // Open handles retain the process identity even when the numeric PID changes.
  const fakeProc = (state) => ({
    list: (path) => {
      if (path !== '/proc/42/task') throw new Error(`unexpected ${path}`);
      return state.tids ?? ['42', '43', 'not-a-thread'];
    },
    read: vi.fn((path) => {
      if (state.unreadable) throw new Error('ENOENT');
      const thread = path.match(/^\/proc\/42\/task\/(\d+)\/children$/);
      if (thread) {
        if (thread[1] === state.unreadableThread) throw new Error('EACCES');
        return `${state.children[thread[1]] ?? ''} `;
      }
      throw new Error(`unexpected unanchored read: ${path}`);
    }),
    open: vi.fn((pid) => {
      const record = state.records[pid];
      if (!record) throw new Error('ENOENT');
      const read = vi.fn(suffix => {
        if (record.exited) throw new Error('ENOENT');
        if (suffix === 'stat') return procStat(pid, record);
        if (suffix === 'wchan') return 'folio_wait_bit_common';
        throw new Error('unavailable');
      });
      const handle = { read, list: vi.fn(() => []), close: vi.fn() };
      state.handles.push(handle);
      return handle;
    }),
  });
  const procState = () => ({ children: {}, records: {}, handles: [] });

  it('describes only the new owned browser and anchors every child read until the sample closes', () => {
    const state = { ...procState(), children: { 42: '1100 1200' },
      records: { 1100: {}, 1200: { name: 'esbuild' }, 1300: {}, 1400: { name: 'node' } } };
    const processFacts = vi.fn((proc, options) => {
      expect(proc).toEqual({ pid: 1300, exitCode: null, signalCode: null });
      expect(options.read('/proc/1300/wchan')).toBe('folio_wait_bit_common');
      expect(options.threads('/proc/1300/task')).toEqual([]);
      return 'os=linux child=uninterruptible';
    });
    const sample = _observeOwnedBrowserLaunch({ platform: 'linux', workerPid: 42, processFacts, ...fakeProc(state) });
    state.children = { 42: '1100 1200', 43: '1300 1400' };

    expect(sample()).toBe('browserChildren=1 os=linux child=uninterruptible');
    expect(processFacts).toHaveBeenCalledOnce();
    expect(state.handles.every(handle => handle.close.mock.calls.length === 1)).toBe(true);

    processFacts.mockClear();
    state.children = { 42: '1100', 43: '1300 1500' };
    state.records[1500] = { name: 'headless_shell' };
    expect(sample()).toBe('browserChildren=2');
    state.children = { 42: '1100' };
    expect(sample()).toBe('browserChildren=0');
    expect(processFacts).not.toHaveBeenCalled();
  });

  it.each(['foreign-parent', 'recycled-before-sample', 'reaped-during-sample'])(
    'does not follow an unowned or recycled PID: %s', (race) => {
      const state = procState();
      const access = fakeProc(state);
      const processFacts = vi.fn((proc, { read }) => {
        // The replacement has the same numeric PID, but the open proc handle
        // must still refer to the now-dead original process.
        state.records[1300].exited = true;
        state.records[1300] = { parent: 999, started: 101 };
        expect(() => read('/proc/1300/wchan')).toThrow('ENOENT');
        return 'os=linux child=unavailable';
      });
      const sample = _observeOwnedBrowserLaunch({ platform: 'linux', workerPid: 42, processFacts, ...access });
      state.children = { 43: '1300' };
      state.records[1300] = race === 'foreign-parent' ? { parent: 999 } : {};
      if (race === 'recycled-before-sample') {
        const originalOpen = access.open.getMockImplementation();
        access.open.mockImplementation(pid => {
          if (access.open.mock.calls.length === 2) state.records[pid] = { started: 101 };
          return originalOpen(pid);
        });
      }
      expect(sample()).toBe(race === 'reaped-during-sample'
        ? 'browserChildren=1 os=linux child=unavailable' : 'browserChildren=unavailable');
      expect(processFacts).toHaveBeenCalledTimes(race === 'reaped-during-sample' ? 1 : 0);
      expect(state.handles.every(handle => handle.close.mock.calls.length === 1)).toBe(true);
    },
  );

  it.each(['all-unreadable', 'one-unreadable', 'thread-limit', 'child-limit', 'byte-limit', 'missing-child'])(
    'fails closed on an incomplete census: %s', (failure) => {
      const state = procState();
      const processFacts = vi.fn();
      const access = fakeProc(state);
      const sample = _observeOwnedBrowserLaunch({ platform: 'linux', workerPid: 42, processFacts, ...access });
      if (failure === 'all-unreadable') state.unreadable = true;
      if (failure === 'one-unreadable') state.unreadableThread = '43';
      if (failure === 'thread-limit') state.tids = Array.from({ length: 65 }, (_, i) => String(42 + i));
      if (failure === 'child-limit') state.children = { 42: Array.from({ length: 257 }, (_, i) => String(1000 + i)).join(' ') };
      if (failure === 'byte-limit') state.children = { 42: ' '.repeat(4097) };
      if (failure === 'missing-child') state.children = { 42: '1300' };
      expect(sample()).toBe('browserChildren=unavailable');
      expect(processFacts).not.toHaveBeenCalled();
      expect(access.open.mock.calls.length).toBeLessThanOrEqual(256);
    },
  );

  it('keeps an unavailable baseline unavailable and avoids proc reads on unsupported platforms', () => {
    const state = { ...procState(), unreadable: true };
    const sample = _observeOwnedBrowserLaunch({ platform: 'linux', workerPid: 42, ...fakeProc(state) });
    state.unreadable = false;
    expect(sample()).toBe('browserChildren=unavailable');
    expect(_observeOwnedBrowserLaunch({ platform: 'darwin' })()).toBe('os=unsupported');
  });
});
