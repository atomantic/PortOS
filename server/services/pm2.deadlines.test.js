import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), clients: [] }));
vi.mock('pm2', () => ({ default: { custom: function () { return mocks.clients.shift(); } } }));
vi.mock('../lib/childProcess.js', async original => ({ ...(await original()), spawn: mocks.spawn }));
import { clearJlistCache, listProcessesStrict, stopApp } from './pm2.js';

const client = () => {
  const list = vi.fn();
  return { connect: vi.fn(cb => cb(null)), list, stop: vi.fn(), disconnect: vi.fn(cb => cb(null)),
    Client: { launchRPC: vi.fn(cb => cb(null)), client: { call: (_method, _data, cb) => list(cb) } } };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  clearJlistCache();
  vi.useRealTimers();
  vi.restoreAllMocks();
  mocks.clients.length = 0;
  mocks.spawn.mockReset();
});

it('expires a shared native list, starts a fresh read and ignores its predecessor’s late callback', async () => {
  const first = client();
  const second = client();
  mocks.clients.push(first, second);
  const pending = [listProcessesStrict(), listProcessesStrict()];
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await Promise.all(pending)).toEqual([null, null]);
  expect(first.list).toHaveBeenCalledTimes(1);
  expect(first.disconnect).toHaveBeenCalledTimes(1);

  const next = listProcessesStrict();
  await vi.advanceTimersByTimeAsync(0);
  const stale = [{ name: 'stale', pm2_env: { status: 'online' } }];
  first.list.mock.calls[0][0](null, stale);
  const joined = listProcessesStrict();
  second.list.mock.calls[0][0](null, []);
  expect(await Promise.all([next, joined])).toEqual([[], []]);
  expect(second.list).toHaveBeenCalledTimes(1);
  expect(await listProcessesStrict()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it('closes a native connection that arrives after timeout without issuing its delayed RPC', async () => {
  const delayed = client();
  delayed.Client.launchRPC.mockImplementation(() => {});
  mocks.clients.push(delayed);
  const pending = listProcessesStrict();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await pending).toBeNull();
  delayed.disconnect.mockImplementation(cb => cb(new Error('late socket cleanup failed')));
  delayed.Client.launchRPC.mock.calls[0][0](null);
  await vi.advanceTimersByTimeAsync(0);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('late socket cleanup failed'));
  expect(delayed.list).not.toHaveBeenCalled();
  expect(delayed.disconnect).toHaveBeenCalledTimes(2);
});

it('a completed mutation closes only its own client while a list is pending', async () => {
  const reader = client();
  const writer = client();
  mocks.clients.push(reader);
  const pending = listProcessesStrict();
  await vi.advanceTimersByTimeAsync(0);
  mocks.clients.push(writer);
  writer.stop.mockImplementation((name, cb) => cb(null));
  expect(await stopApp('example-worker')).toEqual({ success: true });
  expect(writer.disconnect).toHaveBeenCalledTimes(1);
  expect(reader.disconnect).not.toHaveBeenCalled();
  reader.list.mock.calls[0][0](null, []);
  expect(await pending).toEqual([]);
});

it('reports unavailable rather than success when an owned native client cannot disconnect', async () => {
  const broken = client();
  broken.list.mockImplementation(cb => cb(null, []));
  broken.disconnect.mockImplementation(cb => cb(new Error('socket teardown failed')));
  mocks.clients.push(broken);
  expect(await listProcessesStrict()).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds native teardown when disconnect never calls back', async () => {
  const stalled = client();
  stalled.list.mockImplementation(cb => cb(null, []));
  stalled.disconnect.mockImplementation(() => {});
  mocks.clients.push(stalled);
  const pending = listProcessesStrict();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await pending).toBeNull();
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('disconnect timed out'));
  expect(vi.getTimerCount()).toBe(0);
});


it('bounds a custom-home native read and releases its shared slot for a fresh read', async () => {
  const stalled = client();
  mocks.clients.push(stalled);
  const pending = listProcessesStrict('/tmp/example-pm2');
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await pending).toBeNull();
  expect(stalled.disconnect).toHaveBeenCalledOnce();

  const fresh = client();
  fresh.list.mockImplementation(cb => cb(null, []));
  mocks.clients.push(fresh);
  expect(await listProcessesStrict('/tmp/example-pm2')).toEqual([]);
  expect(fresh.Client.launchRPC).toHaveBeenCalledOnce();
  expect(fresh.connect).not.toHaveBeenCalled();
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
