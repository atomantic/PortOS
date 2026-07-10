import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  watch: vi.fn(),
  emit: vi.fn(),
  getUserTasks: vi.fn(),
  getCosTasks: vi.fn(),
  getConfig: vi.fn(),
}));

vi.mock('chokidar', () => ({ watch: (...args) => mocks.watch(...args) }));
vi.mock('./cos.js', () => ({
  cosEvents: { emit: (...args) => mocks.emit(...args) },
  getUserTasks: (...args) => mocks.getUserTasks(...args),
  getCosTasks: (...args) => mocks.getCosTasks(...args),
  getConfig: (...args) => mocks.getConfig(...args),
}));

const { getWatcherStatus, startWatching, stopWatching } = await import('./taskWatcher.js');

class FakeWatcher extends EventEmitter {
  close = vi.fn(async () => {});
}

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getConfig.mockResolvedValue({ userTasksFile: 'TASKS.md', cosTasksFile: 'COS-TASKS.md' });
  mocks.getUserTasks.mockResolvedValue({ tasks: [] });
  mocks.getCosTasks.mockResolvedValue({ tasks: [] });
});

afterEach(async () => {
  if (getWatcherStatus().watching) await stopWatching();
  vi.restoreAllMocks();
});

describe('taskWatcher event queue', () => {
  it('serializes callbacks for one file and waits for the tail during stop', async () => {
    const watcher = new FakeWatcher();
    const first = deferred();
    const order = [];
    mocks.watch.mockReturnValue(watcher);
    mocks.getUserTasks
      .mockResolvedValueOnce({ tasks: [] })
      .mockImplementationOnce(async () => {
        order.push('first:start');
        await first.promise;
        order.push('first:end');
        return { tasks: [{ id: 'a', status: 'pending' }] };
      })
      .mockImplementationOnce(async () => {
        order.push('second:start');
        return { tasks: [{ id: 'a', status: 'completed' }] };
      });

    await startWatching();
    watcher.emit('change', '/repo/TASKS.md');
    watcher.emit('change', '/repo/TASKS.md');
    await Promise.resolve();
    await Promise.resolve();

    expect(order).toEqual(['first:start']);
    let stopped = false;
    const stopping = stopWatching().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    first.resolve();
    await stopping;

    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
    expect(watcher.close).toHaveBeenCalledOnce();
  });

  it('catches a failed callback and continues the same file lane', async () => {
    const watcher = new FakeWatcher();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.watch.mockReturnValue(watcher);
    mocks.getUserTasks
      .mockResolvedValueOnce({ tasks: [] })
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValueOnce({ tasks: [{ id: 'a', status: 'pending' }] });

    await startWatching();
    watcher.emit('change', '/repo/TASKS.md');
    watcher.emit('change', '/repo/TASKS.md');
    await stopWatching();

    expect(mocks.getUserTasks).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('read failed'));
    expect(mocks.emit).toHaveBeenCalledWith('watcher:error', expect.objectContaining({
      error: 'read failed',
      event: 'change',
      file: '/repo/TASKS.md',
    }));
  });
});
