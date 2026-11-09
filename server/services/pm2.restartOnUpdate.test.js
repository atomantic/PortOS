import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ connect: vi.fn(), list: vi.fn(), disconnect: vi.fn(cb => cb(null)) }));
vi.mock('pm2', () => ({ default: { custom: function () { return mocks; } } }));
import { clearJlistCache, getProcessesToRestartOnUpdate } from './pm2.js';

afterEach(() => { vi.clearAllMocks(); clearJlistCache(); });

const proc = (name, status) => ({ name, pm_id: 1, pid: 1, pm2_env: { status } });

it('restarts only running processes, so an update never starts a stopped app', async () => {
  mocks.connect.mockImplementation(cb => setImmediate(() => cb(null)));
  mocks.list.mockImplementation(cb => setImmediate(() => cb(null, [
    proc('example-api', 'online'), proc('example-worker', 'launching'),
    proc('example-ui', 'stopped'), proc('example-cron', 'errored'),
  ])));
  expect(await getProcessesToRestartOnUpdate(['example-api', 'example-worker', 'example-ui', 'example-cron', 'example-gone']))
    .toEqual(['example-api', 'example-worker']);
});

it('restarts every declared process when the PM2 state cannot be read', async () => {
  mocks.connect.mockImplementation(cb => setImmediate(() => cb(null)));
  mocks.list.mockImplementation(cb => setImmediate(() => cb(new Error('daemon unreachable'))));
  expect(await getProcessesToRestartOnUpdate(['example-api', 'example-ui'])).toEqual(['example-api', 'example-ui']);
});
