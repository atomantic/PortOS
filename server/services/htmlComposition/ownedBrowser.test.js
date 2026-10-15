import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { access, mkdir, rm } from 'node:fs/promises';
import { createOwnedBrowserDiagnostics } from '../../test/ownedBrowserDiagnostics.js';

const launch = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:fs/promises', async original => {
  const actual = await original();
  return { ...actual, rm: vi.fn(actual.rm) };
});
vi.mock('../../lib/childProcess.js', async original => ({ ...await original(), spawn: launch.spawn }));
vi.mock('../browserService.js', () => ({ loadConfig: async () => ({ chromePath: '/synthetic/chrome' }) }));
const { launchCompositionBrowser } = await import('./ownedBrowser.js');

let child;
let profile;
let startup;
let diagnostics;
const endpoint = 'ws://127.0.0.1:12345/devtools/browser/synthetic-browser';
beforeEach(() => {
  diagnostics = createOwnedBrowserDiagnostics();
  child = new EventEmitter();
  Object.assign(child, { pid: 12345, exitCode: null, signalCode: null, stderr: new PassThrough() });
  child.kill = vi.fn(signal => {
    child.signalCode = signal;
    child.emit('exit', null, signal);
    child.emit('close', null, signal);
    return true;
  });
  startup = () => {
    child.emit('spawn');
    child.stderr.write(`DevTools listening on ${endpoint.slice(0, 25)}`);
    child.stderr.write(`${endpoint.slice(25)}\n`);
  };
  launch.spawn.mockReset().mockImplementation((_, args) => {
    profile = args.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
    diagnostics.track(child, args);
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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (originalGetuid) Object.defineProperty(process, 'getuid', originalGetuid);
  else delete process.getuid;
});

describe('owned composition capture browser lifecycle', () => {
  it('keeps close pending until removal settles and distinguishes later profile recreation in diagnostics', async () => {
    const owner = await launchCompositionBrowser();
    const remove = rm.getMockImplementation();
    let release;
    let started;
    const removing = new Promise(resolve => { started = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    vi.mocked(rm).mockImplementationOnce((...args) => diagnostics.remove(async (...values) => {
      started();
      await pending;
      return remove(...values);
    }, ...args));
    let settled = false;
    const closing = owner.close().finally(() => { settled = true; });
    try {
      await removing;
      const owned = diagnostics.children[0];
      expect(settled).toBe(false);
      expect(diagnostics.describe(owned)).toContain('exit=true close=true removal=pending presentAfterRemoval=unknown presentNow=true');
      release();
      await closing;
      expect(diagnostics.describe(owned)).toContain('removal=resolved presentAfterRemoval=false presentNow=false');
      // A later writer is a negative control, not evidence about Chrome helpers.
      await mkdir(profile);
      const report = diagnostics.describe(owned);
      expect(report).toContain('removal=resolved presentAfterRemoval=false presentNow=true');
      expect(report).not.toContain(profile);
    } finally {
      release();
      await closing;
      await remove(profile, { recursive: true, force: true });
    }
  });

  it('retains the exact removal rejection while diagnostics distinguish it from recreation', async () => {
    const owner = await launchCompositionBrowser();
    const remove = rm.getMockImplementation();
    const error = Object.assign(new Error('synthetic private profile path'), { code: 'EACCES' });
    vi.mocked(rm).mockImplementationOnce((...args) => diagnostics.remove(() => Promise.reject(error), ...args));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(owner.close()).rejects.toBe(error);
      const report = diagnostics.describe(diagnostics.children[0]);
      expect(report).toContain('removal=rejected:EACCES presentAfterRemoval=true presentNow=true');
      expect(report).not.toContain(profile);
      expect(report).not.toContain(error.message);
      expect(log).toHaveBeenCalledWith('❌ Composition browser profile cleanup failed (other)');
    } finally { await remove(profile, { recursive: true, force: true }); }
  });

  it('uses the configured executable with a fresh sandboxed profile and disposes only its child', async () => {
    setUid(1000);
    const owner = await launchCompositionBrowser();
    expect(owner.webSocketDebuggerUrl).toBe(endpoint);
    const [executable, args, options] = launch.spawn.mock.calls[0];
    expect(executable).toBe('/synthetic/chrome');
    expect(args).toContain('--headless=new');
    expect(args).toContain('--remote-debugging-address=127.0.0.1');
    expect(args).not.toContain('--no-sandbox');
    expect(options.windowsHide).toBe(true);
    await expect(access(profile)).resolves.toBeUndefined();
    await Promise.all([owner.close(), owner.close()]);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    await expect(access(profile)).rejects.toThrow();
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
    startup = () => { child.emit('spawn'); child.stderr.write('private profile path and diagnostics'); };
    await expect(launchCompositionBrowser({ startupMs: 20 })).rejects.toThrow('startup exceeded its deadline');
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    await expect(access(profile)).rejects.toThrow();
    expect(child.stderr.listenerCount('data')).toBe(0);
  });

  it('settles a spawn failure without trying to signal a nonexistent process', async () => {
    startup = () => { child.pid = undefined; child.emit('error', Object.assign(new Error('/private/path'), { code: 'ENOENT' })); };
    await expect(launchCompositionBrowser()).rejects.toThrow('failed to start (ENOENT)');
    expect(child.kill).not.toHaveBeenCalled();
    await expect(access(profile)).rejects.toThrow();
  });

  it('preserves cancellation during startup and cleans its profile', async () => {
    const controller = new AbortController();
    startup = () => { child.emit('spawn'); controller.abort(new Error('Synthetic render canceled')); };
    await expect(launchCompositionBrowser({ signal: controller.signal })).rejects.toThrow('Synthetic render canceled');
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    await expect(access(profile)).rejects.toThrow();
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
    expect(options.env.PORTOS_API_TOKEN).toBeUndefined();
    expect(options.detached).toBe(true);
    await owner.close();
    expect(process.kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
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


it('retains the cleanup deadline failure but removes its owned profile after a late close', async () => {
  child.kill = vi.fn(() => true);
  const owner = await launchCompositionBrowser({ shutdownMs: 30 });
  await expect(owner.close()).rejects.toThrow(/cleanup exceeded its deadline.*term=accepted, kill=accepted, signalError=none/);
  expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
  await expect(access(profile)).resolves.toBeUndefined();
  child.signalCode = 'SIGKILL';
  child.emit('exit', null, 'SIGKILL');
  // Exit alone is insufficient: the child must release inherited stdio first.
  await expect(access(profile)).resolves.toBeUndefined();
  child.emit('close', null, 'SIGKILL');
  await vi.waitFor(async () => { await expect(access(profile)).rejects.toThrow(); });
  await expect(owner.close()).rejects.toThrow('cleanup exceeded its deadline');
});
