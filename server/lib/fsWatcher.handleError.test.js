import { EventEmitter } from 'node:events';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ handles: [] }));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal()),
  watch: vi.fn(() => {
    const handle = Object.assign(new EventEmitter(), { close: vi.fn() });
    native.handles.push(handle);
    return handle;
  }),
}));

const { watchPaths } = await import('./fsWatcher.js');

let root;
beforeEach(async () => {
  native.handles.length = 0;
  root = await realpath(await mkdtemp(join(tmpdir(), 'fswatcher-err-')));
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('watchPaths native handle errors', () => {
  it('attaches an error listener to every handle and forwards the error', async () => {
    const w = watchPaths([root], { persistent: false });
    const errors = [];
    w.on('error', err => errors.push(err));
    await vi.waitFor(() => expect(native.handles).toHaveLength(1));
    expect(native.handles[0].listenerCount('error')).toBeGreaterThan(0);
    const eperm = Object.assign(new Error('EPERM: operation not permitted, watch'), { code: 'EPERM' });
    native.handles[0].emit('error', eperm);
    expect(errors).toEqual([eperm]);
    await w.close();
    expect(native.handles[0].close).toHaveBeenCalledTimes(1);
  });

  it('does not throw when a handle errors and nobody listens for error', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const w = watchPaths([root]);
    await vi.waitFor(() => expect(native.handles).toHaveLength(1));
    expect(() => native.handles[0].emit('error', new Error('EPERM'))).not.toThrow();
    expect(log).toHaveBeenCalled();
    await w.close();
    log.mockRestore();
  });
});
