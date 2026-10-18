import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lstat, rm } from 'node:fs/promises';
import { startOwnedBrowserFixture } from './browserFixture.js';

vi.mock('node:fs/promises', async original => {
  const actual = await original();
  return { ...actual, lstat: vi.fn(actual.lstat), rm: vi.fn(actual.rm) };
});

const stalls = () => new Promise(() => {});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const roots = [];
const owned = () => {
  const profile = mkdtempSync(join(tmpdir(), 'playwright_chromiumdev_profile-'));
  roots.push(profile);
  const canonicalProfile = realpathSync(profile);
  const clearProfile = () => rmSync(profile, { recursive: true, force: true });
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null,
    spawnargs: ['example-chrome', `--user-data-dir=${profile}`] });
  const server = {
    process: () => child, wsEndpoint: () => 'ws://127.0.0.1:1/owned',
    close: vi.fn(async () => { child.exitCode = 0; clearProfile(); }),
    kill: vi.fn(async () => { child.signalCode = 'SIGKILL'; clearProfile(); }),
  };
  const browser = { close: vi.fn(async () => {}) };
  const chromium = { launchServer: vi.fn(async () => server), connect: vi.fn(async () => browser) };
  const start = () => startOwnedBrowserFixture({ chromium, startupMs: 100, cleanupMs: 100,
    launchOptions: { executablePath: 'example-chrome', headless: true, args: ['--mute-audio'] } });
  return { child, server, browser, chromium, start, profile, canonicalProfile, clearProfile };
};
// Synthetic launch/connect readiness only; real filesystem completion uses the
// operation handshake below rather than a number of event-loop turns.
const flushUntil = async check => {
  for (let i = 0; i < 1000; i++) {
    if (check()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('Synthetic fixture did not settle');
};
const recordRoot = fixture => {
  const temp = fixture.chromium.launchServer.mock.calls[0][0].env.TMPDIR;
  roots.push(temp);
  mkdirSync(join(temp, 'playwright_chromiumdev_profile-example'));
  writeFileSync(join(temp, 'playwright_chromiumdev_profile-example', 'owned'), 'fixture');
  return temp;
};
const rootRemoval = temp => {
  const completed = deferred();
  const remove = rm.getMockImplementation();
  const stat = lstat.getMockImplementation();
  let removed = false;
  rm.mockImplementation(async (...args) => {
    const result = await remove(...args);
    if (args[0] === temp) removed = true;
    return result;
  });
  lstat.mockImplementation((...args) => stat(...args).catch(error => {
    if (removed && args[0] === temp && error.code === 'ENOENT') {
      // The real removal and final absence check have completed. One turn
      // drains their promise continuations, including deadline disposal; no
      // filesystem work is being polled or presumed complete after N turns.
      setImmediate(completed.resolve);
    }
    throw error;
  }));
  return completed.promise;
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  lstat.mockReset();
  rm.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('owned server browser fixture lifecycle', () => {
  it('reaps only its owned server after hung graceful close, confirms profile removal, and caches close', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fixture = owned();
    const other = owned();
    fixture.child.spawnargs = ['example-chrome', '--user-data-dir', fixture.profile];
    fixture.server.close.mockImplementation(stalls);
    const exit = deferred();
    fixture.server.kill.mockImplementation(async () => { await exit.promise; fixture.child.signalCode = 'SIGKILL'; });
    const started = await fixture.start();
    const temp = recordRoot(fixture);
    expect(fixture.chromium.launchServer).toHaveBeenCalledWith(expect.objectContaining({
      executablePath: 'example-chrome', headless: true, args: ['--mute-audio'], timeout: 100, artifactsDir: temp,
      env: expect.objectContaining({ TMPDIR: temp, TMP: temp, TEMP: temp, MAC_CHROMIUM_TMPDIR: temp }),
    }));
    const closing = started.close();
    expect(started.close()).toBe(closing);
    await vi.advanceTimersByTimeAsync(29);
    expect(fixture.server.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.server.kill).toHaveBeenCalledTimes(1);
    expect(existsSync(temp)).toBe(true);
    expect(rm).not.toHaveBeenCalled();
    exit.resolve();
    await closing;
    expect(started.close()).toBe(closing);
    expect(existsSync(temp)).toBe(false);
    expect(rm.mock.calls).toEqual([
      [fixture.canonicalProfile, { recursive: true, force: true }],
      [temp, { recursive: true, force: true }],
    ]);
    expect(fixture.browser.close).toHaveBeenCalledTimes(1);
    expect(existsSync(fixture.profile)).toBe(false);
    expect(existsSync(other.profile)).toBe(true);
    expect(other.server.kill).not.toHaveBeenCalled();
    expect(other.server.close).not.toHaveBeenCalled();
    expect(fixture.child.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['during close', 'before close'])('releases inherited pipes only after owned exit %s and verifies cleanup', async timing => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Make filesystem completion deterministic while preserving real identity
    // and absence checks at the public fixture boundary.
    rm.mockImplementation(async (path, options) => rmSync(path, options));
    lstat.mockImplementation(async path => lstatSync(path));
    const fixture = owned();
    const pipesClosed = deferred();
    const remaining = new Set(['stdout', 'stderr']);
    const pipes = [...remaining].map(name => ({ destroy: vi.fn(() => {
      remaining.delete(name);
      if (!remaining.size) pipesClosed.resolve();
    }) }));
    [fixture.child.stdout, fixture.child.stderr] = pipes;
    fixture.child.stdio = [null, ...pipes];
    fixture.server.close.mockImplementation(() => pipesClosed.promise);
    fixture.server.kill.mockImplementation(() => pipesClosed.promise);
    const started = await fixture.start();
    const temp = recordRoot(fixture);
    if (timing === 'before close') fixture.child.exitCode = 0;
    const result = started.close().catch(error => error);
    if (timing === 'during close') {
      await vi.advanceTimersByTimeAsync(29);
      for (const pipe of pipes) expect(pipe.destroy).not.toHaveBeenCalled();
      fixture.child.exitCode = 0;
      fixture.child.emit('exit', 0, null);
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBeUndefined();
    for (const pipe of pipes) expect(pipe.destroy).toHaveBeenCalledTimes(1);
    expect(fixture.server.kill).not.toHaveBeenCalled();
    expect(existsSync(temp)).toBe(false);
    expect(existsSync(fixture.profile)).toBe(false);
    expect(fixture.child.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['returns without exit', 'never settles'])('rejects when owned kill %s and preserves the private root', async mode => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fixture = owned();
    fixture.server.close.mockImplementation(stalls);
    fixture.server.kill.mockImplementation(mode === 'never settles' ? stalls : async () => {});
    const started = await fixture.start();
    const temp = recordRoot(fixture);
    const closing = started.close();
    const result = closing.catch(error => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBeInstanceOf(Error);
    expect(started.close()).toBe(closing);
    expect(fixture.server.kill).toHaveBeenCalledTimes(1);
    expect(rm).not.toHaveBeenCalled();
    expect(existsSync(temp)).toBe(true);
    expect(fixture.child.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['fails', 'stalls', 'leaves root'])('rejects when private root removal %s despite confirmed exit', async mode => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fixture = owned();
    const started = await fixture.start();
    const temp = recordRoot(fixture);
    rm.mockImplementation(mode === 'stalls' ? stalls : mode === 'fails'
      ? async () => { throw new Error('synthetic removal failure'); } : async () => {});
    const closing = started.close();
    const result = closing.catch(error => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBeInstanceOf(Error);
    expect(started.close()).toBe(closing);
    expect(fixture.child.exitCode).toBe(0);
    expect(existsSync(temp)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['missing', 'duplicate', 'escaped', 'unrelated', 'symlink'])('refuses %s profile ownership without removing other directories', async mode => {
    const fixture = owned();
    const other = owned();
    const external = mkdtempSync(join(tmpdir(), 'unrelated-browser-'));
    roots.push(external);
    const unrelated = join(external, 'playwright_chromiumdev_profile-example');
    mkdirSync(unrelated);
    if (mode === 'missing') fixture.child.spawnargs = ['example-chrome'];
    if (mode === 'duplicate') fixture.child.spawnargs.push(`--user-data-dir=${other.profile}`);
    if (mode === 'escaped') fixture.child.spawnargs = [`--user-data-dir=${external}/../playwright_chromiumdev_profile-example`];
    if (mode === 'unrelated') fixture.child.spawnargs = [`--user-data-dir=${unrelated}`];
    if (mode === 'symlink') {
      fixture.clearProfile();
      symlinkSync(other.profile, fixture.profile, 'dir');
    }
    const started = await fixture.start();
    const temp = recordRoot(fixture);
    await expect(started.close()).rejects.toThrow('cleanup failed');
    expect(fixture.child.exitCode).toBe(0);
    expect(rm).not.toHaveBeenCalled();
    expect(existsSync(temp)).toBe(true);
    expect(existsSync(other.profile)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  it('does not wait for a stalled connected client before reaping the owned process', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fixture = owned();
    fixture.browser.close.mockImplementation(stalls);
    const started = await fixture.start();
    const temp = recordRoot(fixture);
    const removed = rootRemoval(temp);
    const closing = started.close().catch(error => error);
    await removed;
    expect(existsSync(temp)).toBe(false);
    expect(fixture.child.exitCode).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(await closing).toBeInstanceOf(Error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves a profile replaced with a symlink after launch instead of deleting its target', async () => {
    const fixture = owned();
    const other = owned();
    fixture.server.close.mockImplementation(async () => { fixture.child.exitCode = 0; });
    const started = await fixture.start();
    const temp = recordRoot(fixture);
    fixture.clearProfile();
    symlinkSync(other.profile, fixture.profile, 'dir');
    await expect(started.close()).rejects.toThrow('cleanup failed');
    expect(rm).not.toHaveBeenCalled();
    expect(existsSync(temp)).toBe(true);
    expect(existsSync(other.profile)).toBe(true);
  });

  it.each(['launch', 'connect'])('cleans failed %s before rejecting startup', async phase => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fixture = owned();
    const failure = deferred();
    fixture.chromium[phase === 'launch' ? 'launchServer' : 'connect'].mockReturnValue(failure.promise);
    const starting = fixture.start().catch(error => error);
    await flushUntil(() => fixture.chromium.launchServer.mock.calls.length > 0);
    const temp = recordRoot(fixture);
    failure.reject(new Error('synthetic startup failure'));
    const error = await starting;
    expect(error.message).toBe('Owned browser startup failed; cleaned up');
    expect(existsSync(temp)).toBe(false);
    expect(fixture.server.close).toHaveBeenCalledTimes(phase === 'launch' ? 0 : 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects abandoned launch with unconfirmed cleanup, then reaps its late server exactly once without connecting', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fixture = owned();
    const launch = deferred();
    fixture.chromium.launchServer.mockReturnValue(launch.promise);
    fixture.server.close.mockImplementation(stalls);
    const starting = fixture.start().catch(error => error);
    await flushUntil(() => fixture.chromium.launchServer.mock.calls.length > 0);
    const temp = recordRoot(fixture);
    const removed = rootRemoval(temp);
    await vi.advanceTimersByTimeAsync(200);
    expect((await starting).message).toBe('Owned browser startup failed; cleanup unconfirmed');
    expect(existsSync(temp)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    launch.resolve(fixture.server);
    await vi.advanceTimersByTimeAsync(30);
    await removed;
    expect(existsSync(temp)).toBe(false);
    expect(fixture.chromium.connect).not.toHaveBeenCalled();
    expect(fixture.server.close).toHaveBeenCalledTimes(1);
    expect(fixture.server.kill).toHaveBeenCalledTimes(1);
    expect(rm).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reaps during an abandoned connection and disconnects its late client without repeating cleanup', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fixture = owned();
    const connection = deferred();
    fixture.chromium.connect.mockReturnValue(connection.promise);
    const starting = fixture.start().catch(error => error);
    await flushUntil(() => fixture.chromium.connect.mock.calls.length > 0);
    const temp = recordRoot(fixture);
    await vi.advanceTimersByTimeAsync(100);
    expect((await starting).message).toBe('Owned browser startup failed; cleaned up');
    expect(existsSync(temp)).toBe(false);
    connection.resolve(fixture.browser);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.browser.close).toHaveBeenCalledTimes(1);
    expect(fixture.server.close).toHaveBeenCalledTimes(1);
    expect(rm).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports an unconfirmed late reap and preserves its evidence after startup has already rejected', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const failure = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fixture = owned();
    const launch = deferred();
    fixture.chromium.launchServer.mockReturnValue(launch.promise);
    fixture.server.close.mockImplementation(stalls);
    fixture.server.kill.mockImplementation(stalls);
    const starting = fixture.start().catch(error => error);
    await flushUntil(() => fixture.chromium.launchServer.mock.calls.length > 0);
    const temp = recordRoot(fixture);
    await vi.advanceTimersByTimeAsync(200);
    expect((await starting).message).toContain('cleanup unconfirmed');
    launch.resolve(fixture.server);
    await vi.advanceTimersByTimeAsync(100);
    expect(failure).toHaveBeenCalledExactlyOnceWith(
      '❌ Owned browser fixture late cleanup failed; exit or private root removal is unconfirmed');
    expect(fixture.server.kill).toHaveBeenCalledTimes(1);
    expect(existsSync(temp)).toBe(true);
    expect(existsSync(fixture.profile)).toBe(true);
    expect(rm).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes the private root when an abandoned launch eventually rejects', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fixture = owned();
    const launch = deferred();
    fixture.chromium.launchServer.mockReturnValue(launch.promise);
    const starting = fixture.start().catch(error => error);
    await flushUntil(() => fixture.chromium.launchServer.mock.calls.length > 0);
    const temp = recordRoot(fixture);
    const removed = rootRemoval(temp);
    await vi.advanceTimersByTimeAsync(200);
    expect((await starting).message).toContain('cleanup unconfirmed');
    launch.reject(new Error('synthetic abandoned launch failure'));
    await removed;
    expect(existsSync(temp)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(rm).toHaveBeenCalledTimes(1);
    expect(fixture.server.close).not.toHaveBeenCalled();
  });

  it('never gives an external/CDP adapter a process termination capability', async () => {
    const external = { launch: vi.fn(stalls), connectOverCDP: vi.fn(stalls) };
    await expect(startOwnedBrowserFixture({ chromium: external })).rejects.toThrow('requires launchServer/connect');
    expect(external.launch).not.toHaveBeenCalled();
    expect(external.connectOverCDP).not.toHaveBeenCalled();
  });
});
