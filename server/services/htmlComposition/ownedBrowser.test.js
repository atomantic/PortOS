import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { access, rm } from 'node:fs/promises';

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
const endpoint = 'ws://127.0.0.1:12345/devtools/browser/synthetic-browser';
beforeEach(() => {
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
    queueMicrotask(startup);
    return child;
  });
  vi.mocked(rm).mockClear();
});
afterEach(() => { child.stderr.destroy(); });

describe('owned composition capture browser lifecycle', () => {
  it('uses the configured executable with a fresh sandboxed profile and disposes only its child', async () => {
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

  it('retries a transient profile removal failure so a resolved close means the profile is gone', async () => {
    const owner = await launchCompositionBrowser();
    vi.mocked(rm).mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'ENOTEMPTY' }));
    await owner.close();
    expect(rm).toHaveBeenCalledTimes(2);
    await expect(access(profile)).rejects.toThrow();
  });
});
