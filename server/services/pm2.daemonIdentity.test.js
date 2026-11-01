import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mock = vi.hoisted(() => ({ clients: [], construct: vi.fn() }));
vi.mock('pm2', () => ({ default: { custom: function () { mock.construct(); return mock.clients.shift(); } } }));
import { getDaemonIdentity } from './pm2.js';

const directory = mkdtempSync(join(tmpdir(), 'pm2-identity-'));
const socketPath = join(directory, 'rpc.sock');
const originalSocket = process.env.PM2_DAEMON_RPC_PORT;

beforeEach(() => { process.env.PM2_DAEMON_RPC_PORT = socketPath; });
afterEach(() => {
  vi.useRealTimers();
  mock.clients.length = 0;
  mock.construct.mockClear();
  rmSync(socketPath, { force: true });
});
afterAll(() => {
  if (originalSocket === undefined) delete process.env.PM2_DAEMON_RPC_PORT;
  else process.env.PM2_DAEMON_RPC_PORT = originalSocket;
  rmSync(directory, { recursive: true, force: true });
});

it.skipIf(process.platform === 'win32')('does not construct a PM2 client when no daemon socket exists', async () => {
  expect(await getDaemonIdentity()).toBeNull();
  expect(mock.construct).not.toHaveBeenCalled();
});

it('reads an existing daemon over RPC without invoking PM2 connect or start', async () => {
  writeFileSync(socketPath, 'fixture');
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
  writeFileSync(socketPath, 'fixture');
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
