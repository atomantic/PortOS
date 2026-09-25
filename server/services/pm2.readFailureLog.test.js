import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ connect: vi.fn(), list: vi.fn(), disconnect: vi.fn() }));
vi.mock('pm2', () => ({ default: mocks }));
import { clearJlistCache, listProcessesStrict } from './pm2.js';

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  clearJlistCache();
});

// PM2 calls back asynchronously; a synchronous mock would resolve before the
// in-flight entry is registered.
const later = (fn) => (cb) => setImmediate(() => fn(cb));
const readLines = (spy, marker) => spy.mock.calls.map(([line]) => line).filter((line) => line.includes(marker));

describe('PM2 read failure logging (#8431)', () => {
  it('logs a persistent failure once, a changed reason again, and one recovery line', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.connect.mockImplementation(later((cb) => cb(new Error('connect ECONNREFUSED'))));

    for (let i = 0; i < 3; i++) expect(await listProcessesStrict()).toBeNull();
    expect(readLines(errorSpy, 'PM2 read failed')).toHaveLength(1);

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
});
