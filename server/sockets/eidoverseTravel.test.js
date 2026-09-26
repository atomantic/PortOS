import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../services/eidoverseTravel.js', () => ({ listEidoverseDestinations: vi.fn() }));
import { listEidoverseDestinations } from '../services/eidoverseTravel.js';
import { instanceEvents } from '../services/instanceEvents.js';
import { registerEidoverseTravelHandlers } from './eidoverseTravel.js';

const sockets = [];
function connect() {
  const incoming = new EventEmitter();
  const socket = { on: incoming.on.bind(incoming), emit: vi.fn() };
  registerEidoverseTravelHandlers(socket);
  sockets.push(incoming);
  return { receive: incoming.emit.bind(incoming), sent: socket.emit };
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.emit('disconnect');
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  vi.resetAllMocks();
});

it('shares one probe loop, emits only changes, and stops after the last disconnect', async () => {
  vi.useFakeTimers();
  listEidoverseDestinations.mockResolvedValue({ destinations: [] });
  const first = connect();
  const second = connect();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(listEidoverseDestinations).not.toHaveBeenCalled();
  first.receive('eidoverse-travel:subscribe');
  first.receive('eidoverse-travel:subscribe');
  second.receive('eidoverse-travel:subscribe');
  await vi.advanceTimersByTimeAsync(30_000);
  expect(listEidoverseDestinations).toHaveBeenCalledTimes(1);
  expect(first.sent).toHaveBeenCalledExactlyOnceWith('eidoverse-travel:destinations', { destinations: [] });
  expect(second.sent).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(listEidoverseDestinations).toHaveBeenCalledTimes(2);
  expect(first.sent).toHaveBeenCalledTimes(1);

  const snapshot = { destinations: [{ peerId: 'example-peer', label: 'Example world' }] };
  listEidoverseDestinations.mockResolvedValue(snapshot);
  instanceEvents.emit('peers:updated', []);
  await vi.advanceTimersByTimeAsync(0);
  expect(first.sent).toHaveBeenLastCalledWith('eidoverse-travel:destinations', snapshot);
  first.receive('eidoverse-travel:unsubscribe');
  second.receive('disconnect');
  const calls = listEidoverseDestinations.mock.calls.length;
  instanceEvents.emit('peers:updated', []);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(listEidoverseDestinations).toHaveBeenCalledTimes(calls);
});

it('coalesces invalidations during a probe, drops stale results, and recovers after failure', async () => {
  vi.useFakeTimers();
  let finish;
  listEidoverseDestinations.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue({ destinations: [] });
  const first = connect();
  first.receive('eidoverse-travel:subscribe');
  await vi.advanceTimersByTimeAsync(30_000);
  instanceEvents.emit('peers:updated', []);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(listEidoverseDestinations).toHaveBeenCalledTimes(1);
  finish({ destinations: [{ peerId: 'stale-peer', label: 'Stale world' }] });
  await vi.advanceTimersByTimeAsync(0);
  expect(listEidoverseDestinations).toHaveBeenCalledTimes(2);
  expect(first.sent).toHaveBeenCalledExactlyOnceWith('eidoverse-travel:destinations', { destinations: [] });

  listEidoverseDestinations.mockResolvedValue({ destinations: [{ peerId: 'new-peer', label: 'New world' }] });
  await vi.advanceTimersByTimeAsync(30_000);
  listEidoverseDestinations.mockRejectedValueOnce(new Error('private runtime detail'));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(first.sent).toHaveBeenLastCalledWith('eidoverse-travel:destinations', { destinations: [] });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(first.sent).toHaveBeenLastCalledWith('eidoverse-travel:destinations', {
    destinations: [{ peerId: 'new-peer', label: 'New world' }],
  });
});

it('does not publish a pending probe after its subscriber generation ends', async () => {
  vi.useFakeTimers();
  let finish;
  listEidoverseDestinations.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue({ destinations: [] });
  const first = connect();
  first.receive('eidoverse-travel:subscribe');
  await vi.advanceTimersByTimeAsync(30_000);
  first.receive('disconnect');
  const second = connect();
  second.receive('eidoverse-travel:subscribe');
  await vi.advanceTimersByTimeAsync(30_000);
  expect(listEidoverseDestinations).toHaveBeenCalledTimes(1);
  finish({ destinations: [{ peerId: 'old-peer', label: 'Old world' }] });
  await vi.advanceTimersByTimeAsync(0);
  expect(first.sent).not.toHaveBeenCalled();
  expect(second.sent).toHaveBeenCalledExactlyOnceWith('eidoverse-travel:destinations', { destinations: [] });
});
