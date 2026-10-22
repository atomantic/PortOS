import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ connect: vi.fn(), list: vi.fn(), disconnect: vi.fn(cb => cb(null)) }));
vi.mock('pm2', () => ({ default: { custom: function () { return mocks; } } }));
import { clearJlistCache, listProcessesStrict } from './pm2.js';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  clearJlistCache();
});

const later = (fn) => (cb) => setImmediate(() => fn(cb));
const readLines = (spy, marker) => spy.mock.calls.map(([line]) => line).filter((line) => line.includes(marker));

describe('PM2 read failure logging (#8431)', () => {
  it('logs a persistent failure once, a changed reason again, and one recovery line', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.connect.mockImplementation(later((cb) => cb(new Error('connect ECONNREFUSED'))));

    for (let i = 0; i < 3; i++) expect(await listProcessesStrict()).toBeNull();
    expect(readLines(errorSpy, 'PM2 read failed')).toEqual(['❌ PM2 read failed (home=default): connect ECONNREFUSED']);

    mocks.connect.mockImplementation(later((cb) => cb(new Error('daemon timeout'))));
    await listProcessesStrict();
    expect(readLines(errorSpy, 'PM2 read failed')).toHaveLength(2);

    mocks.connect.mockImplementation(later((cb) => cb(null)));
    mocks.list.mockImplementation(later((cb) => cb(null, [])));
    expect(await listProcessesStrict()).toEqual([]);
    clearJlistCache();
    await listProcessesStrict();
    expect(readLines(logSpy, 'PM2 read recovered')).toHaveLength(1);
  });

  // #12852: the most common stall symptom carries its own busy-versus-starved attribution.
  it('attributes an RPC timeout to process CPU, GC, host load and context switches', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.connect.mockImplementation(() => {});

    const read = listProcessesStrict();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await read).toBeNull();
    expect(readLines(errorSpy, 'PM2 read failed')).toEqual([expect.stringMatching(
      /^❌ PM2 read failed \(home=default\): pm2 RPC timed out; client disconnect requested, daemon outcome unknown wallMs=15000 cpuMs=\d+ load1=\d+(\.\d+)? cpus=\d+ gcMs=\d+ invCtx=\d+$/,
    )]);
  });
});
