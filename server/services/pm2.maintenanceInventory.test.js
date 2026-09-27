import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ connect: vi.fn(), list: vi.fn(), disconnect: vi.fn() }));
vi.mock('pm2', () => ({ default: mocks }));
import { clearJlistCache, listMaintenanceProcesses, listProcessesStrict } from './pm2.js';

afterEach(() => { vi.clearAllMocks(); clearJlistCache(); });

it('reads fresh maintenance identities even while the display inventory remains cached', async () => {
  mocks.connect.mockImplementation(cb => setImmediate(() => cb(null)));
  const original = { name: 'portos-server', pm_id: 13, pid: 1013,
    pm2_env: { status: 'online', pm_cwd: '/tmp/example-install', pm_exec_path: '/tmp/example-install/server/start.js', secret: 'not-projected' } };
  mocks.list.mockImplementation(cb => setImmediate(() => cb(null, [original])));
  expect((await listProcessesStrict())[0].status).toBe('online');
  mocks.list.mockImplementation(cb => setImmediate(() => cb(null, [{ ...original, pid: 0, pm2_env: { ...original.pm2_env, status: 'stopped' } }])));
  expect(await listMaintenanceProcesses()).toEqual([{ name: 'portos-server', pmId: 13, pid: 0,
    status: 'stopped', cwd: '/tmp/example-install', script: '/tmp/example-install/server/start.js' }]);
  expect(mocks.list).toHaveBeenCalledTimes(2);
});

it('rejects malformed or failed daemon reads instead of declaring an empty producer set', async () => {
  mocks.connect.mockImplementation(cb => setImmediate(() => cb(null)));
  mocks.list.mockImplementation(cb => setImmediate(() => cb(null, null)));
  await expect(listMaintenanceProcesses()).rejects.toThrow('unavailable');
  mocks.list.mockImplementation(cb => setImmediate(() => cb(new Error('failed'))));
  await expect(listMaintenanceProcesses()).rejects.toThrow('unavailable');
  expect(mocks.disconnect).toHaveBeenCalledTimes(2);
});
