import { afterEach, expect, it, vi } from 'vitest';
const read = vi.hoisted(() => vi.fn());
vi.mock('./fleetLlmHost.js', () => ({
  getFleetLlmHostStatus: read,
  getFleetLlmHostQueue: () => ({ active: 1, queued: 2 }),
}));
import { registerFleetHostSocket, readFleetHostStatus, noteFleetHostChanged, FLEET_HOST_OBSERVE_MS } from './fleetHostNotify.js';
const sockets = [];
function connect() {
  const handlers = {};
  const socket = { connected: true, on: (event, fn) => { handlers[event] = fn; }, emit: vi.fn(), handlers };
  registerFleetHostSocket(socket);
  sockets.push(socket);
  return socket;
}
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.handlers.disconnect();
  vi.useRealTimers();
  read.mockReset();
});
it('shares probes across viewers and HTTP reads, reports changed/failing readiness and stops after the last disconnect', async () => {
  vi.useFakeTimers();
  let finish;
  read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const a = connect(); const b = connect();
  a.handlers['fleet-host:subscribe']();
  b.handlers['fleet-host:subscribe']();
  const request = readFleetHostStatus();
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  finish({ enabled: false });
  await request;
  read.mockResolvedValue({ enabled: true });
  await vi.advanceTimersByTimeAsync(FLEET_HOST_OBSERVE_MS + 100);
  expect(a.emit).toHaveBeenCalledWith('fleet-host:changed', {});
  expect(b.emit).toHaveBeenCalledWith('fleet-host:changed', {});
  expect(read).toHaveBeenCalledTimes(2);
  await readFleetHostStatus();
  expect(read).toHaveBeenCalledTimes(2);
  await readFleetHostStatus({ refresh: true });
  expect(read).toHaveBeenCalledTimes(3);
  a.handlers.disconnect();
  read.mockRejectedValue(new Error('probe unavailable'));
  b.emit.mockClear();
  await vi.advanceTimersByTimeAsync(FLEET_HOST_OBSERVE_MS);
  expect(b.emit).toHaveBeenCalledWith('fleet-host:changed', {});
  b.handlers.disconnect();
  const calls = read.mock.calls.length;
  await vi.advanceTimersByTimeAsync(FLEET_HOST_OBSERVE_MS * 3);
  expect(read).toHaveBeenCalledTimes(calls);
});
it('drains a mutation during a probe and never emits a late sample after unsubscribe', async () => {
  vi.useFakeTimers();
  let finish;
  read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ enabled: false });
  const a = connect();
  a.handlers['fleet-host:subscribe']();
  const request = readFleetHostStatus();
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  noteFleetHostChanged();
  a.handlers['fleet-host:unsubscribe']();
  finish({ enabled: true });
  await expect(request).resolves.toEqual({ enabled: false });
  await vi.advanceTimersByTimeAsync(FLEET_HOST_OBSERVE_MS * 2);
  expect(a.emit).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledTimes(2);
});
