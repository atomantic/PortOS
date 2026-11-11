import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mock = vi.hoisted(() => ({ imported: vi.fn(), construct: vi.fn(), clients: [], spawn: vi.fn() }));
vi.mock('pm2', () => {
  mock.imported();
  return { default: { custom: function (options) { mock.construct(options); return mock.clients.shift(); } } };
});
vi.mock('../lib/childProcess.js', async original => ({ ...(await original()), spawn: mock.spawn }));

beforeEach(() => { vi.resetModules(); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.clearAllMocks(); mock.clients.length = 0; });

const client = error => ({
  connect: vi.fn(cb => cb(null)), start: vi.fn((_options, cb) => cb(null, [])),
  disconnect: vi.fn(cb => cb(null)), list: vi.fn(),
  Client: { launchRPC: vi.fn(cb => cb(error)), executeRemote: vi.fn(),
    client: { call: vi.fn((_method, _data, cb) => cb(null, [])) } },
});

it('ordinary and maintenance reads never start a missing daemon, including custom homes', async () => {
  const pm2 = await import('./pm2.js');
  const readers = [() => pm2.listProcesses(), () => pm2.listProcessesStrict(),
    () => pm2.listProcessesStrict('/tmp/example-private-pm2'), () => pm2.listMaintenanceProcesses()];
  for (const read of readers) {
    const unavailable = client(new Error('daemon unavailable'));
    mock.clients.push(unavailable);
    if (read === readers[3]) await expect(read()).rejects.toThrow('daemon unavailable');
    else expect(await read()).toEqual(read === readers[0] ? [] : null);
    expect(unavailable.Client.launchRPC).toHaveBeenCalledOnce();
    expect(unavailable.connect).not.toHaveBeenCalled();
    expect(unavailable.Client.executeRemote).not.toHaveBeenCalled();
  }
  expect(mock.construct).toHaveBeenCalledWith({ pm2_home: '/tmp/example-private-pm2' });
  expect(mock.spawn).not.toHaveBeenCalled();
});

it('reads use established RPC without the daemon-launching list fallback, while mutations still connect', async () => {
  const pm2 = await import('./pm2.js');
  const reader = client(null);
  mock.clients.push(reader);
  expect(await pm2.listProcessesStrict()).toEqual([]);
  expect(reader.Client.client.call).toHaveBeenCalledWith('getMonitorData', {}, expect.any(Function));
  expect(reader.list).not.toHaveBeenCalled();
  const writer = client(null);
  mock.clients.push(writer);
  expect(await pm2.startApp('example')).toEqual({ success: true, process: [] });
  expect(writer.connect).toHaveBeenCalledOnce();
  expect(writer.Client.launchRPC).not.toHaveBeenCalled();
});

it.skipIf(process.platform === 'win32')('rejects an oversized home before PM2 import, construction or filesystem side effects', async () => {
  const home = join(tmpdir(), `portos-pm2-missing-${'a'.repeat(180)}`);
  vi.stubEnv('PM2_HOME', home);
  const pm2 = await import('./pm2.js');
  expect(await pm2.listProcesses()).toEqual([]);
  expect(await pm2.listProcessesStrict()).toBeNull();
  await expect(pm2.listMaintenanceProcesses()).rejects.toMatchObject({ code: 'PM2_SOCKET_PATH_TOO_LONG' });
  await expect(pm2.startApp('example')).rejects.toMatchObject({ code: 'PM2_SOCKET_PATH_TOO_LONG' });
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('PM2_SOCKET_PATH_TOO_LONG'));
  expect(mock.imported).not.toHaveBeenCalled();
  expect(mock.construct).not.toHaveBeenCalled();
  expect(mock.spawn).not.toHaveBeenCalled();
  expect(existsSync(home)).toBe(false);
});

it.skipIf(process.platform === 'win32')('checks custom homes and byte lengths of every overridden socket before importing PM2', async () => {
  const pm2 = await import('./pm2.js');
  expect(await pm2.listProcessesStrict(join(tmpdir(), 'a'.repeat(180)))).toBeNull();
  for (const key of ['PM2_DAEMON_RPC_PORT', 'PM2_DAEMON_PUB_PORT', 'PM2_INTERACTOR_RPC_PORT']) {
    vi.stubEnv(key, `/tmp/${'é'.repeat(60)}`);
    await expect(pm2.listMaintenanceProcesses()).rejects.toMatchObject({ code: 'PM2_SOCKET_PATH_TOO_LONG' });
    vi.unstubAllEnvs();
  }
  expect(mock.imported).not.toHaveBeenCalled();
  expect(mock.construct).not.toHaveBeenCalled();
});
