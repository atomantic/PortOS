import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserSupervisor } from './server.js';

const LAUNCH_POLL_MS = 500;
const CDP_UP = { webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/fixture' };

function fakeChild() {
  const child = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

function createSleeper() {
  const pending = [];
  return {
    pending,
    sleep(ms) {
      return new Promise((resolve) => { pending.push({ ms, resolve }); });
    },
  };
}

async function waitForSleep(sleeper) {
  const start = Date.now();
  while (sleeper.pending.length === 0) {
    if (Date.now() - start > 2000) throw new Error('supervise loop did not reach a sleep');
    await new Promise((resolve) => setImmediate(resolve));
  }
  return sleeper.pending[0].ms;
}

/** Release Chrome's 500ms launch polls and stop on the supervise wait. */
async function advanceToSuperviseSleep(sleeper) {
  let ms = await waitForSleep(sleeper);
  while (ms === LAUNCH_POLL_MS) {
    sleeper.pending.shift().resolve();
    ms = await waitForSleep(sleeper);
  }
  return ms;
}

function releasePending(sleeper) {
  const item = sleeper.pending.shift();
  if (!item) throw new Error('no pending sleep to release');
  item.resolve();
}

async function readHealth(port) {
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  return { statusCode: response.status, body: await response.json() };
}

describe('browser Chrome supervise loop', () => {
  let logSpy;
  let errorSpy;
  let warnSpy;
  let current;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    if (current) {
      await current.supervisor.shutdown();
      await current.done;
    }
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    current = null;
  });

  function start({ checkCdp, mkdir, bindSignals = false }) {
    const sleeper = createSleeper();
    const spawn = vi.fn(() => fakeChild());
    const sockets = [];
    class FakeWebSocket extends EventTarget {
      constructor(url) {
        super();
        this.url = url;
        sockets.push(this);
      }
      close() { this.dispatchEvent(new Event('close')); }
    }
    let loopError = null;
    const supervisor = createBrowserSupervisor({
      checkCdp,
      spawn,
      mkdir,
      sleep: sleeper.sleep,
      loadConfig: async () => ({
        headless: true,
        downloadDir: '/tmp/portos-browser-download-fixture',
        userDataDir: '/tmp/portos-browser-profile-fixture',
        chromePath: '/opt/example/chrome',
      }),
      applyDownloadDirPreference: async () => false,
      platform: 'linux',
      healthPort: 0,
      WebSocket: FakeWebSocket,
      bindSignals,
    });
    const done = supervisor.main().catch((err) => { loopError = err; });
    current = {
      supervisor,
      sleeper,
      spawn,
      sockets,
      done,
      get loopError() { return loopError; },
    };
    return current;
  }

  it('relaunches within the backoff window after CDP drops and reopens the keep-alive', async () => {
    let cdpUp = true;
    const session = start({
      checkCdp: async () => (cdpUp ? CDP_UP : null),
      mkdir: async () => {},
    });
    await session.supervisor.ready;
    expect(await advanceToSuperviseSleep(session.sleeper)).toBe(2000);
    expect(session.spawn).not.toHaveBeenCalled();
    const socketsAfterBoot = session.sockets.length;
    expect(socketsAfterBoot).toBeGreaterThan(0);

    cdpUp = false;
    releasePending(session.sleeper);
    expect(await advanceToSuperviseSleep(session.sleeper)).toBe(2000);
    expect(session.spawn).not.toHaveBeenCalled();

    releasePending(session.sleeper);
    expect(await waitForSleep(session.sleeper)).toBe(LAUNCH_POLL_MS);
    expect(session.spawn).toHaveBeenCalledTimes(1);
    expect(session.spawn.mock.calls[0][0]).toBe('/opt/example/chrome');
    expect(session.spawn.mock.calls[0][2]).toMatchObject({ windowsHide: true });
    expect(logSpy).toHaveBeenCalledWith('🔁 Relaunching Chrome (attempt 1)');

    cdpUp = true;
    releasePending(session.sleeper);
    expect(await advanceToSuperviseSleep(session.sleeper)).toBe(2000);
    expect(session.sockets.length).toBeGreaterThan(socketsAfterBoot);
    expect(session.sockets.at(-1).url).toBe(CDP_UP.webSocketDebuggerUrl);
    expect(logSpy).toHaveBeenCalledWith('✅ Chrome CDP recovered');
    expect(session.loopError).toBeNull();
  });

  it('reports a boot launch failure, backs off to 60s, and resets after CDP returns', async () => {
    let mkdirMode = 'fail';
    let cdpMode = 'down';
    let mkdirCalls = 0;
    const session = start({
      checkCdp: async () => (
        cdpMode === 'up' || (cdpMode === 'after-spawn' && session.spawn.mock.calls.length > 0)
          ? CDP_UP
          : null
      ),
      mkdir: async () => {
        mkdirCalls += 1;
        if (mkdirMode === 'fail') throw new Error('download directory unavailable');
      },
    });
    await session.supervisor.ready;
    const port = session.supervisor.healthServer.address().port;
    expect(await advanceToSuperviseSleep(session.sleeper)).toBe(2000);
    const health = await readHealth(port);
    expect(health.statusCode).toBe(503);
    expect(health.body).toMatchObject({
      status: 'relaunching',
      attempt: 1,
      lastError: 'download directory unavailable',
    });
    expect(errorSpy).toHaveBeenCalledWith('❌ Chrome launch failed: download directory unavailable');
    expect(session.spawn).not.toHaveBeenCalled();

    const waits = [2000];
    let pendingMs = 2000;
    while (waits.filter((ms) => ms === 60_000).length < 2) {
      releasePending(session.sleeper);
      pendingMs = await advanceToSuperviseSleep(session.sleeper);
      waits.push(pendingMs);
    }
    expect(waits).toEqual([2000, 4000, 8000, 16000, 32000, 60_000, 60_000]);
    expect(session.loopError).toBeNull();
    expect(session.spawn).not.toHaveBeenCalled();

    mkdirMode = 'ok';
    cdpMode = 'after-spawn';
    releasePending(session.sleeper);
    expect(await advanceToSuperviseSleep(session.sleeper)).toBe(2000);
    expect(session.spawn).toHaveBeenCalledTimes(1);
    expect(await readHealth(port)).toMatchObject({
      statusCode: 200,
      body: { status: 'healthy', attempt: 0, lastError: null },
    });
    expect(logSpy).toHaveBeenCalledWith('✅ Chrome CDP recovered');

    cdpMode = 'down';
    mkdirMode = 'fail';
    const mkdirBefore = mkdirCalls;
    releasePending(session.sleeper);
    expect(await advanceToSuperviseSleep(session.sleeper)).toBe(2000);
    expect(mkdirCalls).toBe(mkdirBefore);
    releasePending(session.sleeper);
    expect(await advanceToSuperviseSleep(session.sleeper)).toBe(2000);
    expect(mkdirCalls).toBeGreaterThan(mkdirBefore);
    expect(session.loopError).toBeNull();
  });

  it('SIGTERM during a pending relaunch exits without starting Chrome', async () => {
    const session = start({
      bindSignals: true,
      checkCdp: async () => null,
      mkdir: async () => { throw new Error('download directory unavailable'); },
    });
    await session.supervisor.ready;
    const port = session.supervisor.healthServer.address().port;
    expect(await advanceToSuperviseSleep(session.sleeper)).toBe(2000);
    expect(await readHealth(port)).toMatchObject({
      statusCode: 503,
      body: { status: 'relaunching', lastError: 'download directory unavailable' },
    });
    expect(session.spawn).not.toHaveBeenCalled();

    process.emit('SIGTERM');
    await session.supervisor.shutdown();
    await session.done;
    expect(session.spawn).not.toHaveBeenCalled();
    expect(session.loopError).toBeNull();
    await expect(readHealth(port)).rejects.toThrow();
  });
});
