import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), connect: vi.fn(), disconnect: vi.fn() }));
vi.mock('pm2', () => ({ default: mocks }));
vi.mock('../lib/childProcess.js', async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: mocks.spawn,
}));
import { execPm2, restartApp } from './pm2.js';

function child() {
  return Object.assign(new EventEmitter(), {
    stdout: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
    stderr: Object.assign(new EventEmitter(), { destroy: vi.fn() }), kill: vi.fn(), unref: vi.fn(),
  });
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('PM2 restart lifecycle', () => {
  it('completes overlapping restarts independently without disconnecting the shared client', async () => {
    const first = child();
    const second = child();
    mocks.spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    vi.stubEnv('max_memory_restart', '4294967296');
    vi.stubEnv('PORT', '5555');
    const pending = [restartApp('api'), restartApp('worker', '/custom-pm2')];
    second.emit('close', 0);
    expect(await pending[1]).toEqual({ success: true });
    first.emit('close', 0);
    expect(await pending[0]).toEqual({ success: true });
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.disconnect).not.toHaveBeenCalled();
    expect(mocks.spawn.mock.calls.map(([, args]) => args.slice(-2))).toEqual([
      ['restart', 'api'], ['restart', 'worker'],
    ]);
    expect(mocks.spawn.mock.calls[1][2].env.PM2_HOME).toBe('/custom-pm2');
    for (const [, , options] of mocks.spawn.mock.calls) {
      expect(options.env).not.toHaveProperty('max_memory_restart');
      expect(options.env).not.toHaveProperty('PORT');
    }
  });

  it('bounds a stalled restart and reports unconfirmed cleanup when the child never closes', async () => {
    vi.useFakeTimers();
    const stalled = child();
    mocks.spawn.mockReturnValue(stalled);
    const result = expect(restartApp('worker')).rejects.toMatchObject({
      code: 'PM2_TIMEOUT', timedOut: true, cleanupConfirmed: false, outcome: 'unknown',
    });
    await vi.advanceTimersByTimeAsync(62_000);
    await result;
    expect(stalled.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(stalled.stdout.destroy).toHaveBeenCalled();
    expect(stalled.stderr.destroy).toHaveBeenCalled();
    expect(stalled.unref).toHaveBeenCalled();
    expect(stalled.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honors a caller deadline and confirms CLI teardown without claiming the daemon mutation failed', async () => {
    vi.useFakeTimers();
    const owned = child();
    owned.kill.mockImplementation(signal => owned.emit('close', null, signal));
    mocks.spawn.mockReturnValue(owned);
    const result = expect(execPm2(['restart', 'example-worker'], { timeoutMs: 100 })).rejects.toMatchObject({
      code: 'PM2_TIMEOUT', timedOut: true, cleanupConfirmed: true, outcome: 'unknown',
    });
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(owned.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    expect(owned.stdout.listenerCount('data')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves daemon error details on a failed restart', async () => {
    const failed = child();
    mocks.spawn.mockReturnValue(failed);
    const result = expect(restartApp('missing')).rejects.toThrow('Process missing not found');
    failed.stderr.emit('data', 'Process missing not found');
    failed.emit('close', 1);
    await result;
  });
});
