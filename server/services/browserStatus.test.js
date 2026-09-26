import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('./browserService.js', () => ({ browserEvents: new EventEmitter(), getFullStatus: vi.fn() }));
import { browserEvents, getFullStatus } from './browserService.js';
let status;
let clients;
const initial = { connected: true, process: { status: 'online' }, pages: [], downloads: { files: [] } };
function connect() {
  const handlers = new Map();
  const socket = { connected: true, on: (event, fn) => handlers.set(event, fn), emit: vi.fn() };
  status.registerBrowserStatusSocket(socket);
  const send = event => handlers.get(event)();
  clients.push(send);
  send('browser:subscribe');
  return { socket, send };
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  browserEvents.removeAllListeners();
  getFullStatus.mockReset().mockResolvedValue(initial);
  status = await import('./browserStatus.js');
  clients = [];
});
afterEach(async () => {
  for (const send of clients) send('disconnect');
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
});
it('shares observations and cached reads, pushes external changes, and stops at last disconnect', async () => {
  const a = connect();
  const b = connect();
  await vi.advanceTimersByTimeAsync(0);
  expect(getFullStatus).toHaveBeenCalledExactlyOnceWith({ strict: true });
  expect(await status.getBrowserStatusSnapshot()).toEqual(initial);
  expect(getFullStatus).toHaveBeenCalledTimes(1);
  a.socket.emit.mockClear();
  await vi.advanceTimersByTimeAsync(status.BROWSER_OBSERVE_MS);
  expect(a.socket.emit).not.toHaveBeenCalled();
  getFullStatus.mockResolvedValue({ ...initial, pages: [{ id: 'example-page' }], downloads: { files: [{ name: 'example.txt' }] } });
  await vi.advanceTimersByTimeAsync(status.BROWSER_OBSERVE_MS);
  expect(a.socket.emit).toHaveBeenCalledExactlyOnceWith('browser:changed', {});
  a.send('browser:unsubscribe');
  b.send('disconnect');
  const calls = getFullStatus.mock.calls.length;
  await vi.advanceTimersByTimeAsync(status.BROWSER_OBSERVE_MS * 3);
  expect(getFullStatus).toHaveBeenCalledTimes(calls);
});
it('preserves failed reads as errors and recovers on service invalidation without waiting for a timer', async () => {
  const a = connect();
  await vi.advanceTimersByTimeAsync(0);
  getFullStatus.mockRejectedValue(new Error('Probe unavailable'));
  await vi.advanceTimersByTimeAsync(status.BROWSER_OBSERVE_MS);
  await expect(status.getBrowserStatusSnapshot()).rejects.toThrow('Probe unavailable');
  getFullStatus.mockResolvedValue({ ...initial, connected: false });
  browserEvents.emit('status:changed');
  await vi.advanceTimersByTimeAsync(0);
  expect(await status.getBrowserStatusSnapshot()).toMatchObject({ connected: false });
  expect(a.socket.emit).toHaveBeenCalledTimes(3);
});
it('discards a sample invalidated mid-flight, never overlaps, and restarts across a draining unsubscribe', async () => {
  let finish;
  getFullStatus.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const a = connect();
  await vi.advanceTimersByTimeAsync(status.BROWSER_OBSERVE_MS * 2);
  browserEvents.emit('pages:changed');
  browserEvents.emit('downloads:changed');
  expect(getFullStatus).toHaveBeenCalledTimes(1);
  a.send('disconnect');
  const b = connect();
  finish({ ...initial, pages: [{ id: 'stale' }] });
  await vi.advanceTimersByTimeAsync(0);
  expect(await status.getBrowserStatusSnapshot()).toEqual(initial);
  expect(a.socket.emit).not.toHaveBeenCalled();
  expect(b.socket.emit).toHaveBeenCalledWith('browser:changed', {});
});
