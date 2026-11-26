import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  clients: [],
  construct: vi.fn(),
  socketPath: '/tmp/example-pm2/rpc.sock',
  socketExists: false,
}));
vi.mock('fs', async original => {
  const fs = await original();
  return {
    ...fs,
    existsSync: path => path === mock.socketPath ? mock.socketExists : fs.existsSync(path),
  };
});
vi.mock('pm2', () => ({ default: { custom: function () { mock.construct(); return mock.clients.shift(); } } }));
import { getDaemonIdentity, listExistingProcessesStrict } from './pm2.js';

beforeEach(() => {
  vi.stubEnv('PM2_HOME', '/tmp/example-pm2');
  vi.stubEnv('PM2_DAEMON_RPC_PORT', mock.socketPath);
  vi.stubEnv('PM2_DAEMON_PUB_PORT', undefined);
  vi.stubEnv('PM2_INTERACTOR_RPC_PORT', undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  mock.clients.length = 0;
  mock.construct.mockClear();
  mock.socketExists = false;
});

it.skipIf(process.platform === 'win32')('does not construct a PM2 client when no daemon socket exists', async () => {
  expect(await getDaemonIdentity()).toBeNull();
  expect(await listExistingProcessesStrict()).toBeNull();
  expect(mock.construct).not.toHaveBeenCalled();
});

it('reads the process list from an existing daemon without starting or reconnecting one', async () => {
  mock.socketExists = true;
  const client = {
    connect: vi.fn(), disconnect: vi.fn(callback => callback(null)),
    Client: { launchRPC: vi.fn(callback => callback(null)), client_sock: { connected: true },
      client: { call: vi.fn((_method, _data, callback) => callback(null, [
        { name: 'portos-browser', pid: 42, pm2_env: { status: 'online' } },
      ])) }, executeRemote: vi.fn() },
  };
  mock.clients.push(client);
  expect(await listExistingProcessesStrict()).toEqual([expect.objectContaining({ name: 'portos-browser', pid: 42, status: 'online' })]);
  expect(client.Client.client.call).toHaveBeenCalledWith('getMonitorData', {}, expect.any(Function));
  expect(client.connect).not.toHaveBeenCalled();
  expect(client.Client.executeRemote).not.toHaveBeenCalled();
});

it('reads an existing daemon over RPC without invoking PM2 connect or start', async () => {
  mock.socketExists = true;
  const client = {
    connect: vi.fn(),
    disconnect: vi.fn((callback) => callback(null)),
    Client: {
      launchRPC: vi.fn((callback) => callback(null)),
      client_sock: { connected: true },
      client: { call: vi.fn((method, data, callback) => callback(null, { pm2_version: '7.1.0', node_version: '26.13.0' })) },
      executeRemote: vi.fn(),
    },
  };
  mock.clients.push(client);
  await expect(getDaemonIdentity()).resolves.toEqual({ pm2Version: '7.1.0', nodeVersion: '26.13.0' });
  expect(client.Client.client.call).toHaveBeenCalledWith('getReport', {}, expect.any(Function));
  expect(client.connect).not.toHaveBeenCalled();
  expect(client.Client.executeRemote).not.toHaveBeenCalled();
  expect(client.disconnect).toHaveBeenCalledOnce();
});

it('closes a disconnected RPC attempt at the deadline without starting a daemon', async () => {
  vi.useFakeTimers();
  mock.socketExists = true;
  const client = {
    connect: vi.fn(), disconnect: vi.fn(),
    Client: { launchRPC: vi.fn(), client_sock: { connected: false, close: vi.fn() } },
  };
  mock.clients.push(client);
  const pending = getDaemonIdentity();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await pending).toBeNull();
  expect(client.connect).not.toHaveBeenCalled();
  expect(client.Client.client_sock.close).toHaveBeenCalledOnce();
});
