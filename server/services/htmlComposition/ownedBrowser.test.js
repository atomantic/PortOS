import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import { basename } from 'node:path';
import { pinPlatform } from '../../lib/testHelper.js';
import { access, rm } from 'node:fs/promises';

const launch = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('./browserProcessGroup.js', async original => ({
  ...await original(), drainBrowserProcessGroup: vi.fn(async () => {}), observeBrowserProcessGroup: vi.fn(async () => 'unavailable'),
}));
vi.mock('node:fs/promises', async original => {
  const actual = await original();
  return { ...actual, rm: vi.fn(actual.rm) };
});
vi.mock('../../lib/childProcess.js', async original => ({ ...await original(), spawn: launch.spawn }));
vi.mock('../browserService.js', () => ({ loadConfig: async () => ({ chromePath: '/synthetic/chrome' }) }));
const { launchCompositionBrowser } = await import('./ownedBrowser.js');
const { drainBrowserProcessGroup, observeBrowserProcessGroup } = await import('./browserProcessGroup.js');

let child;
let profile;
let startup;
beforeEach(() => {
  vi.spyOn(process, 'kill').mockImplementation(() => true);
  vi.mocked(drainBrowserProcessGroup).mockReset().mockResolvedValue();
  vi.mocked(observeBrowserProcessGroup).mockReset().mockResolvedValue('unavailable');
  child = new EventEmitter();
  Object.assign(child, { pid: 12345, exitCode: null, signalCode: null, stderr: new PassThrough() });
  child.kill = vi.fn(signal => {
    child.signalCode = signal;
    child.emit('exit', null, signal);
    child.emit('close', null, signal);
    return true;
  });
  startup = () => { child.emit('spawn'); };
  const pipeIn = new PassThrough();
  const pipeOut = new PassThrough();
  child.stdio = [null, null, child.stderr, pipeIn, pipeOut];
  pipeIn.on('data', chunk => {
    if (chunk.toString().includes('Browser.getVersion')) {
      pipeOut.write(Buffer.from(`${JSON.stringify({ id: 0, result: { product: 'Chrome/1' } })}\0`));
    }
  });
  launch.spawn.mockReset().mockImplementation((_, args) => {
    profile = args.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
    queueMicrotask(startup);
    return child;
  });
  vi.mocked(rm).mockClear();
});
// process.getuid does not exist on Windows, where vi.spyOn would throw; define it for the test and put back whatever was there.
const originalGetuid = Object.getOwnPropertyDescriptor(process, 'getuid');
const setUid = uid => Object.defineProperty(process, 'getuid', { value: () => uid, configurable: true, writable: true });
afterEach(() => {
  child.stderr.destroy();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (originalGetuid) Object.defineProperty(process, 'getuid', originalGetuid);
  else delete process.getuid;
});

describe('owned composition capture browser lifecycle', () => {
  it('keeps close pending until profile removal settles', async () => {
    const owner = await launchCompositionBrowser();
    // Only production ownership listens on the child.
    expect(child.listenerCount('exit')).toBe(1);
    expect(child.listenerCount('close')).toBe(1);
    const remove = rm.getMockImplementation();
    let release;
    let started;
    const removing = new Promise(resolve => { started = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    vi.mocked(rm).mockImplementationOnce(async (...values) => {
      started();
      await pending;
      return remove(...values);
    });
    let settled = false;
    const closing = owner.close().finally(() => { settled = true; });
    try {
      await removing;
      expect(settled).toBe(false);
      await expect(access(profile)).resolves.toBeUndefined();
      release();
      await closing;
      expect(settled).toBe(true);
      await expect(access(profile)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      release();
      await closing;
      await remove(profile, { recursive: true, force: true });
    }
  });

  it('retains the exact removal rejection and leaves the profile in place', async () => {
    const owner = await launchCompositionBrowser();
    const remove = rm.getMockImplementation();
    const error = Object.assign(new Error('synthetic private profile path'), { code: 'EACCES' });
    vi.mocked(rm).mockImplementationOnce(() => Promise.reject(error));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(owner.close()).rejects.toBe(error);
      await expect(access(profile)).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledWith('❌ Composition browser profile cleanup failed (other)');
    } finally { await remove(profile, { recursive: true, force: true }); }
  });

  it('uses the configured executable with a fresh sandboxed profile and disposes only its child', async () => {
    setUid(1000);
    const owner = await launchCompositionBrowser();
    expect(owner.transport.readyState).toBe(1);
    const [executable, args, options] = launch.spawn.mock.calls[0];
    expect(executable).toBe('/synthetic/chrome');
    expect(args).toContain('--headless=new');
    expect(args).toContain('--remote-debugging-pipe');
    expect(args).not.toContain('--remote-debugging-port=0');
    expect(args).not.toContain('--no-sandbox');
    expect(options.windowsHide).toBe(true);
    await expect(access(profile)).resolves.toBeUndefined();
    await Promise.all([owner.close(), owner.close()]);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    await expect(access(profile)).rejects.toThrow();
    expect(observeBrowserProcessGroup).not.toHaveBeenCalled();
  });

  it.each([
    ['a root Vitest worker drops', {}, true],
    ['a root production launch keeps', { VITEST: undefined, NODE_ENV: 'production' }, false],
  ])('%s the sandbox Chrome refuses to start as root', async (_, env, unsandboxed) => {
    setUid(0);
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    await (await launchCompositionBrowser()).close();
    expect(launch.spawn.mock.calls[0][1].includes('--no-sandbox')).toBe(unsandboxed);
  });

  it('names a recognized startup exit cause without copying browser output', async () => {
    child.stdio[3].removeAllListeners('data');
    startup = () => {
      child.emit('spawn');
      child.stderr.write('[0101/000000:ERROR:zygote_host_impl_linux.cc(101)] Running as root without --no-sandbox is not supported. /private/profile/path\n');
      setImmediate(() => { child.exitCode = 1; child.emit('exit', 1, null); child.emit('close', 1, null); });
    };
    const error = await launchCompositionBrowser().catch(caught => caught);
    expect(error.message).toBe('Composition browser exited during startup (code 1): Chrome refuses to run as root with its sandbox enabled');
    await expect(access(profile)).rejects.toThrow();
  });

  it('cleans a child and profile after a bounded startup timeout without leaking stderr', async () => {
    child.stdio[3].removeAllListeners('data');
    startup = () => { child.emit('spawn'); child.stderr.write('private profile path and diagnostics'); };
    await expect(launchCompositionBrowser({ startupMs: 20 })).rejects.toThrow(
      /startup exceeded its deadline \(elapsedMs=\d+, deadlineMs=20, phase=awaiting-handshake, spawnMs=\d+, group=(?:unavailable|not-requested)\)$/,
    );
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    await expect(access(profile)).rejects.toThrow();
    expect(child.stderr.listenerCount('data')).toBe(0);
  });

  it('reports the owned group snapshot on startup timeout without waiting for diagnostics', async () => {
    child.stdio[3].removeAllListeners('data');
    startup = () => { child.emit('spawn'); };
    vi.mocked(observeBrowserProcessGroup).mockResolvedValueOnce('leader:uninterruptible|parent:same|group:same');
    const error = await launchCompositionBrowser({ startupMs: 40 }).catch(caught => caught);
    expect(error.message).toContain('group=leader:uninterruptible|parent:same|group:same');
    expect(observeBrowserProcessGroup).toHaveBeenCalledWith(child.pid, 500);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    await expect(access(profile)).rejects.toThrow();
  });

  it('does not delay timeout or cleanup when the group observation does not settle', async () => {
    child.stdio[3].removeAllListeners('data');
    startup = () => { child.emit('spawn'); };
    vi.mocked(observeBrowserProcessGroup).mockReturnValueOnce(new Promise(() => {}));
    const error = await launchCompositionBrowser({ startupMs: 40 }).catch(caught => caught);
    expect(error.message).toContain('group=pending');
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    await expect(access(profile)).rejects.toThrow();
  });

  it('waits for the owned browser pipe handshake beyond ten seconds within its startup budget', async () => {
    child.stdio[3].removeAllListeners('data');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let settled = false;
    const opening = launchCompositionBrowser({ startupMs: 60000 }).finally(() => { settled = true; });
    await vi.waitFor(() => expect(launch.spawn).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(11000);
    expect(settled).toBe(false);
    child.stdio[4].write(Buffer.from(`${JSON.stringify({ id: 0, result: {} })}\0`));
    const owner = await opening;
    expect(owner.transport.readyState).toBe(1);
    await owner.close();
  });

  it('names a browser that never produced output, and honors a startup override only when it is a positive integer', async () => {
    const key = 'PORTOS_COMPOSITION_BROWSER_STARTUP_MS';
    const prior = process.env[key];
    child.stdio[3].removeAllListeners('data');
    startup = () => { child.emit('spawn'); };
    try {
      process.env[key] = '25';
      await expect(launchCompositionBrowser()).rejects.toThrow(/deadlineMs=25, phase=spawned-no-output/);
      // A malformed override falls back to the 20s default, so a tight explicit deadline is the only way out.
      process.env[key] = 'abc';
      child.stdio = [null, null, child.stderr, new PassThrough(), new PassThrough()];
      await expect(launchCompositionBrowser({ startupMs: 20 })).rejects.toThrow(/deadlineMs=20,/);
    } finally {
      if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
    }
  });

  it('settles a spawn failure without trying to signal a nonexistent process', async () => {
    child.stdio[3].removeAllListeners('data');
    startup = () => { child.pid = undefined; child.emit('error', Object.assign(new Error('/private/path'), { code: 'ENOENT' })); };
    await expect(launchCompositionBrowser()).rejects.toThrow('failed to start (ENOENT)');
    expect(child.kill).not.toHaveBeenCalled();
    await expect(access(profile)).rejects.toThrow();
  });

  it('preserves cancellation during startup and cleans its profile', async () => {
    const controller = new AbortController();
    child.stdio[3].removeAllListeners('data');
    startup = () => { child.emit('spawn'); controller.abort(new Error('Synthetic render canceled')); };
    await expect(launchCompositionBrowser({ signal: controller.signal })).rejects.toThrow('Synthetic render canceled');
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    await expect(access(profile)).rejects.toThrow();
  });

  it('reports unsettled child cleanup when cancellation interrupts startup', async () => {
    const controller = new AbortController();
    const onCleanupFailure = vi.fn();
    child.kill = vi.fn(() => true);
    child.stdio[3].removeAllListeners('data');
    startup = () => { child.emit('spawn'); controller.abort(new Error('Canceled during startup')); };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const opening = launchCompositionBrowser({ signal: controller.signal, shutdownMs: 100, onCleanupFailure }).catch(error => error);
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(100);
    const error = await opening;
    expect(error.message).toContain('cleanup exceeded its deadline');
    expect(onCleanupFailure).toHaveBeenCalledExactlyOnceWith(error);
    child.emit('exit', null, 'SIGKILL');
    child.emit('close', null, 'SIGKILL');
    await vi.waitFor(() => expect(rm).toHaveBeenCalled());
  });

  it('terminates the owned browser when a running render is canceled, once', async () => {
    const controller = new AbortController();
    const owner = await launchCompositionBrowser({ signal: controller.signal });
    controller.abort(new Error('Synthetic cancel'));
    await owner.close();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    await expect(access(profile)).rejects.toThrow();
  });

  it('escalates only its unresponsive child and waits for exit before removing the profile', async () => {
    child.kill = vi.fn(signal => {
      if (signal === 'SIGKILL') {
        child.signalCode = signal;
        child.emit('exit', null, signal);
        child.emit('close', null, signal);
      }
      return true;
    });
    const owner = await launchCompositionBrowser({ shutdownMs: 100 });
    const closing = owner.close();
    await expect(access(profile)).resolves.toBeUndefined();
    await closing;
    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
    await expect(access(profile)).rejects.toThrow();
  });

  it('closes owned stdio after exit and keeps the profile until child close', async () => {
    child.kill = vi.fn(signal => {
      child.signalCode = signal;
      child.emit('exit', null, signal);
      return true;
    });
    const owner = await launchCompositionBrowser();
    const closing = owner.close();
    // Let cleanup advance after exit while holding back the child's close
    // event, as with a pipe inherited by a Chrome helper.
    await Promise.resolve();
    await Promise.resolve();
    try {
      expect(child.stderr.destroyed).toBe(true);
      expect(rm).not.toHaveBeenCalled();
      await expect(access(profile)).resolves.toBeUndefined();
    } finally {
      child.emit('close', null, 'SIGTERM');
      await closing;
    }
    await expect(access(profile)).rejects.toThrow();
  });

  const answerHandshake = () => {
    const pipeIn = new PassThrough();
    const pipeOut = new PassThrough();
    child.stdio = [null, null, child.stderr, pipeIn, pipeOut];
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    pipeIn.on('data', (chunk) => {
      if (!chunk.toString().includes('Browser.getVersion')) return;
      pipeOut.write(Buffer.concat([
        Buffer.from(JSON.stringify({ id: 0, result: { product: 'Chrome/1' } })),
        Buffer.from([0]),
      ]));
    });
  };

  it('fails closed without spawning when the host cannot jail a preview', async () => {
    await expect(launchCompositionBrowser({
      isolation: 'required',
      support: { platform: 'win32', seatbeltAvailable: false, bubblewrapAvailable: false },
    })).rejects.toMatchObject({ code: 'PREVIEW_ISOLATION_UNAVAILABLE' });
    expect(launch.spawn).not.toHaveBeenCalled();
  });

  it('launches the jailed pipe browser without a DevTools port or inherited tokens', async () => {
    const restorePlatform = pinPlatform('linux');
    try {
      vi.stubEnv('MAC_CHROMIUM_TMPDIR', '/synthetic/test-temp');
      answerHandshake();
      const owner = await launchCompositionBrowser({
        isolation: 'required',
        support: { platform: 'linux', seatbeltAvailable: false, bubblewrapAvailable: true },
      });
      expect(owner.mechanism).toBe('linux-bubblewrap');
      const [executable, args, options] = launch.spawn.mock.calls[0];
      expect(executable).toBe('/usr/bin/bwrap');
      expect(args).toContain('--unshare-net');
      expect(args).toContain('--remote-debugging-pipe');
      expect(args).toContain('--no-sandbox');
      expect(args.some((arg) => String(arg).includes('127.0.0.1:9'))).toBe(true);
      expect(args.join('\n')).not.toContain('proxy-bypass');
      expect(args).not.toContain('--remote-debugging-port=0');
      expect(options.env.USER).toBe('portos-preview');
      expect(options.env.MAC_CHROMIUM_TMPDIR).toBe('/synthetic/test-temp');
      expect(options.env.PORTOS_API_TOKEN).toBeUndefined();
      expect(options.detached).toBe(true);
      await owner.close();
      expect(process.kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
    } finally {
      restorePlatform();
    }
  });

  const expectOwnedTemp = (env) => {
    const temp = env.TMPDIR;
    expect(basename(temp)).toMatch(/^pcb-/);
    for (const key of ['TMPDIR', 'TMP', 'TEMP', 'MAC_CHROMIUM_TMPDIR']) expect(env[key]).toBe(temp);
    return temp;
  };

  it('gives a non-Vitest launch an owned temp directory and deletes it on close', async () => {
    vi.stubEnv('PORTOS_TEST_TEMP_ROOT', undefined);
    const owner = await launchCompositionBrowser();
    const temp = expectOwnedTemp(launch.spawn.mock.calls[0][2].env);
    await expect(access(temp)).resolves.toBeUndefined();
    await owner.close();
    await expect(access(temp)).rejects.toThrow();
    await expect(access(profile)).rejects.toThrow();
  });

  it('injects the owned temp directory into a jailed non-Vitest launch and deletes it on close', async () => {
    vi.stubEnv('PORTOS_TEST_TEMP_ROOT', undefined);
    const restorePlatform = pinPlatform('linux');
    try {
      answerHandshake();
      const owner = await launchCompositionBrowser({
        isolation: 'required',
        support: { platform: 'linux', seatbeltAvailable: false, bubblewrapAvailable: true },
      });
      const options = launch.spawn.mock.calls[0][2];
      const temp = expectOwnedTemp(options.env);
      expect(options.env.USER).toBe('portos-preview');
      expect(options.env.PORTOS_API_TOKEN).toBeUndefined();
      await expect(access(temp)).resolves.toBeUndefined();
      await owner.close();
      await expect(access(temp)).rejects.toThrow();
    } finally {
      restorePlatform();
    }
  });

  it('deletes the owned temp directory when the browser fails during startup', async () => {
    vi.stubEnv('PORTOS_TEST_TEMP_ROOT', undefined);
    let temp;
    launch.spawn.mockImplementationOnce((command, args, options) => {
      temp = options.env.TMPDIR;
      profile = args.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
      throw new Error('spawn failed');
    });
    await expect(launchCompositionBrowser()).rejects.toThrow('spawn failed');
    expect(basename(temp)).toMatch(/^pcb-/);
    await expect(access(temp)).rejects.toThrow();
    await expect(access(profile)).rejects.toThrow();
  });

  it('deletes the owned temp directory when profile allocation fails before close', async () => {
    vi.stubEnv('PORTOS_TEST_TEMP_ROOT', undefined);
    const fsPromises = await import('node:fs/promises');
    const actualMkdtemp = fsPromises.mkdtemp;
    const created = [];
    vi.spyOn(fsPromises, 'mkdtemp').mockImplementation(async (prefix) => {
      if (String(prefix).endsWith('portos-composition-browser-')) throw new Error('profile allocation failed');
      const dir = await actualMkdtemp(prefix);
      created.push(dir);
      return dir;
    });
    await expect(launchCompositionBrowser()).rejects.toThrow('profile allocation failed');
    expect(created.map(dir => basename(dir))).toEqual([expect.stringMatching(/^pcb-/)]);
    await expect(access(created[0])).rejects.toThrow();
    expect(launch.spawn).not.toHaveBeenCalled();
  });

  it('keeps forwarding the inherited Chromium temp root while Vitest owns one', async () => {
    expect(process.env.PORTOS_TEST_TEMP_ROOT).toBeTruthy();
    const inherited = process.env.MAC_CHROMIUM_TMPDIR;
    const owner = await launchCompositionBrowser();
    expect(launch.spawn.mock.calls[0][2].env.MAC_CHROMIUM_TMPDIR).toBe(inherited);
    expect(launch.spawn.mock.calls[0][2].env.TMPDIR).toBe(process.env.TMPDIR);
    await owner.close();
    expect(vi.mocked(rm).mock.calls.some(([path]) => basename(String(path)).startsWith('pcb-'))).toBe(false);
  });

  it('keeps the egress negative control on the pipe without a jail or network flags', async () => {
    answerHandshake();
    const owner = await launchCompositionBrowser({
      isolation: 'off',
      support: { platform: 'linux', seatbeltAvailable: false, bubblewrapAvailable: false },
    });
    expect(owner.mechanism).toBe('none');
    const [executable, args] = launch.spawn.mock.calls[0];
    expect(executable).toBe('/synthetic/chrome');
    expect(args).toContain('--remote-debugging-pipe');
    expect(args.some((arg) => String(arg).includes('proxy-server'))).toBe(false);
    expect(args.some((arg) => String(arg).includes('host-resolver'))).toBe(false);
    expect(args.some((arg) => String(arg).includes('webrtc'))).toBe(false);
    if (process.getuid?.() !== 0) expect(args).not.toContain('--no-sandbox');
    await owner.close();
  });

  it('rejects a pipe that closes before its startup handshake and cleans up', async () => {
    child.stdio[3].removeAllListeners('data');
    startup = () => { child.emit('spawn'); child.stdio[4].end(); };
    await expect(launchCompositionBrowser()).rejects.toThrow('Composition browser failed to start (pipe closed)');
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    await expect(access(profile)).rejects.toThrow();
  });

  it.each([3, 4])('rejects a startup error on pipe fd %s and disposes its owned browser', async fd => {
    const pipeIn = new PassThrough();
    const pipeOut = new PassThrough();
    child.stdio = [null, null, child.stderr, pipeIn, pipeOut];
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    pipeIn.on('data', () => {
      child.stdio[fd].emit('error', Object.assign(new Error('/private/startup-path'), { code: 'EPIPE' }));
    });
    await expect(launchCompositionBrowser({ isolation: 'off' })).rejects.toThrow('Composition browser failed to start (pipe)');
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    await expect(access(profile)).rejects.toThrow();
  });

  it('retains handoff pipe failures for the CDP client and still forwards subsequent errors', async () => {
    answerHandshake();
    const owner = await launchCompositionBrowser({ isolation: 'off' });
    const error = Object.assign(new Error('Synthetic broken pipe'), { code: 'EPIPE' });
    // The launcher has returned, but the client has not subscribed yet.
    child.stdio[4].emit('error', error);
    const callback = vi.fn();
    owner.transport.send('{}', callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith(error);
    const clientError = vi.fn();
    owner.transport.on('error', clientError);
    child.stdio[3].emit('error', error);
    expect(clientError).toHaveBeenCalledExactlyOnceWith(error);
    await owner.close();
    await expect(access(profile)).rejects.toThrow();
  });

  it('retries a transient profile removal failure so a resolved close means the profile is gone', async () => {
    const owner = await launchCompositionBrowser();
    vi.mocked(rm).mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'ENOTEMPTY' }));
    await owner.close();
    expect(rm).toHaveBeenCalledTimes(2);
    await expect(access(profile)).rejects.toThrow();
  });
});


it.each([
  ['accepted signals without exit', null, null, false],
  ['public exit status without an observed event', 7, null, false],
  ['observed exit with delayed close', null, 'SIGKILL', true],
  ['unexpected child status and error text', '/private/exit-status', '/private/signal-status', false],
])('retains the deadline evidence and late profile ownership for %s', async (_, exitCode, signalCode, emitExit) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  child.kill = vi.fn(() => true);
  const signalProcess = vi.spyOn(process, 'kill');
  const controller = new AbortController();
  const owner = await launchCompositionBrowser({ signal: controller.signal });
  child.stderr.write('/private/browser-output\n');
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
  // Separate the ownership clock from the shutdown budget in the snapshot.
  await vi.advanceTimersByTimeAsync(2000);
  let result;
  const timersBeforeClose = vi.getTimerCount();
  const closing = owner.close();
  const settled = closing.then(() => { result = 'resolved'; }, error => { result = error; });
  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  await vi.advanceTimersByTimeAsync(999);
  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  await vi.advanceTimersByTimeAsync(1);
  expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
  await vi.advanceTimersByTimeAsync(200);
  child.exitCode = exitCode;
  child.signalCode = signalCode;
  if (emitExit) child.emit('exit', exitCode, signalCode);
  const malformed = typeof exitCode === 'string';
  if (malformed) child.emit('error', Object.assign(new Error('/private/error-message'), { code: '/private/error-code' }));
  await vi.advanceTimersByTimeAsync(3799);
  expect(result).toBeUndefined();
  expect(rm).not.toHaveBeenCalled();
  await expect(access(profile)).resolves.toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  await settled;
  expect(result).toBeInstanceOf(Error);
  const facts = Object.fromEntries(result.message.slice(result.message.indexOf('(') + 1, -1).split(', ').map(field => field.split('=')));
  expect(facts).toEqual({
    exit: String(emitExit), stdioClosed: String(emitExit),
    term: 'accepted', kill: 'accepted', signalError: malformed ? 'other' : 'none', elapsedMs: '5000',
    groupTerm: process.platform === 'win32' ? 'not-attempted' : 'accepted', groupKill: process.platform === 'win32' ? 'not-attempted' : 'accepted',
    groupSignalError: 'none', groupFailedSignal: 'none', groupFailedPhase: 'none',
    groupSignalObservation: 'not-requested',
    groupDeadlineObservation: process.platform === 'win32' ? 'not-requested' : 'startMs:6500|endMs:6500|unavailable',
    spawned: 'true', closed: 'false', exitCode: malformed ? 'other' : exitCode === null ? 'none' : String(exitCode),
    signalCode: malformed ? 'other' : signalCode ?? 'none',
    exitListener: String(!emitExit), closeListener: 'true', errorListener: 'true',
    spawnMs: '0', exitMs: emitExit ? '3200' : 'unobserved', closeMs: 'unobserved',
    termMs: '2000', killMs: '3000', closeStartedMs: '2000', timeoutMs: '7000',
  });
  expect(result.message).toMatch(/^Composition browser cleanup exceeded its deadline /);
  for (const privateValue of [profile, '/synthetic/chrome', String(child.pid), '/private/']) {
    expect(result.message).not.toContain(privateValue);
  }
  expect(vi.getTimerCount()).toBe(timersBeforeClose);
  expect(signalProcess.mock.calls).toEqual(process.platform === 'win32' ? [] : [[-child.pid, 'SIGTERM'], [-child.pid, 'SIGKILL']]);
  expect(child.listenerCount('error')).toBe(1);
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  controller.abort();
  expect(child.kill).toHaveBeenCalledTimes(2);
  if (!emitExit) {
    child.exitCode = null;
    child.signalCode = 'SIGKILL';
    child.emit('exit', null, 'SIGKILL');
  }
  expect(child.stderr.destroyed).toBe(true);
  // Exit alone is insufficient: the child must release inherited stdio first.
  await expect(access(profile)).resolves.toBeUndefined();
  const remove = rm.getMockImplementation();
  let removalFinished;
  const removed = new Promise(resolve => { removalFinished = resolve; });
  vi.mocked(rm).mockImplementationOnce(async (...args) => {
    await remove(...args);
    removalFinished();
  });
  child.emit('close', null, 'SIGKILL');
  if (process.platform !== 'win32') expect(drainBrowserProcessGroup).toHaveBeenCalledWith(child.pid, performance.now() + 5000, 1000, expect.objectContaining({ error: 'none' }));
  await removed;
  await expect(access(profile)).rejects.toThrow();
  expect(rm).toHaveBeenCalledExactlyOnceWith(profile, { recursive: true, force: true });
  expect(child.listenerCount('exit')).toBe(0);
  expect(child.listenerCount('close')).toBe(0);
  expect(child.listenerCount('error')).toBe(0);
  expect(vi.getTimerCount()).toBe(timersBeforeClose);
  expect(owner.close()).toBe(closing);
  await expect(owner.close()).rejects.toBe(result);
  expect(result.message).toContain('closeMs=unobserved');
});

it.skipIf(process.platform === 'win32')('waits for the retained group to stop before removing its profile', async () => {
  let drained;
  vi.mocked(drainBrowserProcessGroup).mockImplementationOnce(() => new Promise(resolve => { drained = resolve; }));
  const owner = await launchCompositionBrowser();
  expect(launch.spawn.mock.calls[0][2].detached).toBe(true);
  const closing = owner.close();
  expect(rm).not.toHaveBeenCalled();
  await expect(access(profile)).resolves.toBeUndefined();
  drained();
  await closing;
  await expect(access(profile)).rejects.toThrow();
});

it.skipIf(process.platform === 'win32')('preserves the profile when group quiescence cannot be established', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(drainBrowserProcessGroup).mockRejectedValueOnce(new Error('Composition browser group observation failed'));
  const owner = await launchCompositionBrowser();
  await expect(owner.close()).rejects.toThrow('Composition browser group observation failed');
  expect(rm).not.toHaveBeenCalled();
  await expect(access(profile)).resolves.toBeUndefined();
  expect(log).toHaveBeenCalled();
  await rm(profile, { recursive: true, force: true });
});

it('keeps Windows legacy ownership on the retained direct child', async () => {
  const restorePlatform = pinPlatform('win32');
  try {
    const owner = await launchCompositionBrowser();
    expect(launch.spawn.mock.calls[0][2].detached).toBe(false);
    await owner.close();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    expect(process.kill).not.toHaveBeenCalled();
    expect(drainBrowserProcessGroup).not.toHaveBeenCalled();
    await expect(access(profile)).rejects.toThrow();
  } finally {
    restorePlatform();
  }
});

it.skipIf(process.platform === 'win32')('latches the first group failure across direct-child escalation and late cleanup', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  child.kill = vi.fn(() => true);
  vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error('/private/error'), { code: 'EPERM' }); });
  const owner = await launchCompositionBrowser();
  const result = owner.close().catch(error => error);
  await vi.advanceTimersByTimeAsync(5000);
  const error = await result;
  expect(error.message).toContain('groupTerm=threw, groupKill=not-attempted, groupSignalError=EPERM');
  expect(error.message).toContain('groupFailedSignal=SIGTERM, groupFailedPhase=shutdown');
  expect(error.message).toContain('term=accepted, kill=accepted, signalError=none');
  expect(error.message).not.toContain('/private');
  expect(process.kill).toHaveBeenCalledExactlyOnceWith(-child.pid, 'SIGTERM');
  expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  await vi.waitFor(() => expect(drainBrowserProcessGroup).toHaveBeenCalledWith(child.pid, 10000, 1000,
    expect.objectContaining({ error: 'EPERM', failedSignal: 'SIGTERM', failedPhase: 'shutdown' })));
  await vi.waitFor(() => expect(rm).toHaveBeenCalled());
});

it.skipIf(process.platform === 'win32').each(['observed', 'pending'])('retains %s OS evidence after a group SIGKILL refusal without extending shutdown', async observation => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  child.kill = vi.fn(() => true);
  vi.mocked(process.kill).mockImplementation((_, name) => {
    if (name === 'SIGKILL') throw Object.assign(new Error('/private/signal-error'), { code: 'EPERM' });
    return true;
  });
  let finishObservation;
  if (observation === 'pending') {
    const pending = new Promise(resolve => { finishObservation = resolve; });
    vi.mocked(observeBrowserProcessGroup).mockReturnValue(pending);
  } else {
    vi.mocked(observeBrowserProcessGroup)
      .mockResolvedValueOnce('leader:sleeping|parent:same|group:same|uid:same|ruid:same|live:2|zombies:0|foreignUid:0|states:sleeping:2|capped:false')
      .mockResolvedValueOnce('leader:absent|parent:absent|group:absent|uid:absent|ruid:absent|live:0|zombies:1|foreignUid:0|states:zombie:1|capped:false');
  }
  const owner = await launchCompositionBrowser();
  let error;
  const closing = owner.close();
  const settled = closing.catch(result => { error = result; });
  await vi.advanceTimersByTimeAsync(4999);
  expect(error).toBeUndefined();
  expect(rm).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await settled;
  expect(error.message).toContain('groupTerm=accepted, groupKill=threw, groupSignalError=EPERM');
  expect(error.message).toContain('groupFailedSignal=SIGKILL, groupFailedPhase=shutdown');
  expect(error.message).toContain('exit=false, stdioClosed=false, term=accepted, kill=accepted');
  expect(error.message).toContain('elapsedMs=5000');
  if (observation === 'observed') {
    expect(error.message).toContain('groupSignalObservation=startMs:1000|endMs:1000|leader:sleeping|parent:same');
    expect(error.message).toContain('groupDeadlineObservation=startMs:4500|endMs:4500|leader:absent');
  } else {
    expect(error.message).toContain('groupSignalObservation=pending, groupDeadlineObservation=pending');
    const original = error.message;
    finishObservation('leader:absent');
    await Promise.resolve();
    expect(error.message).toBe(original);
  }
  expect(observeBrowserProcessGroup.mock.calls).toEqual([[child.pid, 500], [child.pid, 500]]);
  expect(error.message).not.toContain('/private');
  expect(process.kill.mock.calls).toEqual([[-child.pid, 'SIGTERM'], [-child.pid, 'SIGKILL']]);
  expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  expect(rm).not.toHaveBeenCalled();
  child.emit('exit', null, 'SIGKILL');
  expect(rm).not.toHaveBeenCalled();
  child.emit('close', null, 'SIGKILL');
  await vi.waitFor(() => expect(rm).toHaveBeenCalledExactlyOnceWith(profile, { recursive: true, force: true }));
  await expect(owner.close()).rejects.toBe(error);
});
