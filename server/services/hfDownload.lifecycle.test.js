import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from '../lib/childProcess.js';
import { downloadHfRepo } from './hfDownload.js';

vi.mock('../lib/childProcess.js', async (importOriginal) => ({
  ...await importOriginal(), spawn: vi.fn(),
}));
vi.mock('./hfToken.js', () => ({ getHfTokenInfo: async () => ({ token: null }) }));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('Hugging Face download cancellation', () => {
  it.each([false, true])('settles cancellation when SIGTERM is ignored: %s', async (ignoresTerm) => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(),
      exitCode: null, signalCode: null, killed: false,
    });
    const close = (signal) => {
      child.signalCode = signal;
      child.emit('close', null, signal);
    };
    child.kill = vi.fn((signal) => {
      child.killed = true;
      if (signal === 'SIGKILL' || !ignoresTerm) queueMicrotask(() => close(signal));
      return true;
    });
    const spawned = Promise.withResolvers();
    spawn.mockImplementation(() => { spawned.resolve(); return child; });
    const onEvent = vi.fn();
    const handle = downloadHfRepo({ repo: 'example/model', pythonPath: 'fixture-python', onEvent });
    try {
      await spawned.promise;
      handle.kill();
      handle.kill();
      await vi.advanceTimersByTimeAsync(8_000);
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(
        ignoresTerm ? ['SIGTERM', 'SIGKILL'] : ['SIGTERM'],
      );
      await expect(handle.promise).resolves.toMatchObject({ ok: false, errorKind: 'cancelled' });
      expect(onEvent).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'cancelled' }));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      if (child.signalCode === null) close('SIGKILL');
      await handle.promise;
      child.stdout.destroy();
      child.stderr.destroy();
    }
  });
});
