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

describe('taskWatcher change detection', () => {
  const bigPrompt = 'p'.repeat(17408);
  const makeTasks = (n) => Array.from({ length: n }, (_, i) => ({
    id: `t${i}`, status: 'completed', description: `task ${i}`, priority: 'MEDIUM',
    metadata: { prompt: bigPrompt, tags: ['a', { b: null }] },
  }));

  const runChange = async (before, after, file = '/repo/TASKS.md') => {
    const watcher = new FakeWatcher();
    mocks.watch.mockReturnValue(watcher);
    mocks.getUserTasks
      .mockResolvedValueOnce({ tasks: before })
      .mockResolvedValueOnce({ tasks: after });
    await startWatching();
    watcher.emit('change', file);
    await stopWatching();
    return mocks.emit.mock.calls.filter(([name]) => !['tasks:user:changed', 'watcher:started', 'watcher:stopped'].includes(name));
  };

  it('emits only the one modified task in a large prompt-heavy history without JSON-encoding it', async () => {
    const before = makeTasks(4000);
    const after = before.map((t) => ({ ...t, metadata: { ...t.metadata } }));
    after[1234] = { ...after[1234], description: 'changed' };
    const stringify = vi.spyOn(JSON, 'stringify');
    const events = await runChange(before, after);
    const bigEncodings = stringify.mock.results.filter((r) => typeof r.value === 'string' && r.value.length >= bigPrompt.length).length;
    expect(bigEncodings).toBe(0);
    expect(events).toEqual([['tasks:user:modified', { tasks: [{ old: before[1234], new: after[1234] }] }]]);
  });

  it('detects nested metadata changes but ignores key order and undefined entries', async () => {
    const base = { id: 'a', status: 'pending', description: 'd', metadata: { x: 1, y: [1, { z: null }], gone: undefined } };
    const same = { ...base, metadata: { y: [1, { z: null }], x: 1 } };
    expect(await runChange([base], [same])).toEqual([]);
    vi.clearAllMocks();
    mocks.getConfig.mockResolvedValue({ userTasksFile: 'TASKS.md', cosTasksFile: 'COS-TASKS.md' });
    const nested = { ...base, metadata: { x: 1, y: [1, { z: 0 }] } };
    const events = await runChange([base], [nested]);
    expect(events.map(([n]) => n)).toEqual(['tasks:user:modified']);
  });

  it('keeps completed, pending-revival, added and removed event protocol and order', async () => {
    const before = [
      { id: 'c', status: 'pending' }, { id: 'r', status: 'completed' }, { id: 'gone', status: 'pending' },
    ];
    const after = [
      { id: 'c', status: 'completed' }, { id: 'r', status: 'pending' }, { id: 'new', status: 'pending' },
    ];
    const events = await runChange(before, after);
    expect(events.map(([n]) => n)).toEqual([
      'tasks:user:added', 'tasks:user:completed', 'tasks:user:modified', 'tasks:user:added', 'tasks:user:removed',
    ]);
  });
});
