import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../services/apps.js', () => ({ getAllApps: vi.fn() }));
vi.mock('../services/pm2.js', () => ({ listProcessesStrict: vi.fn() }));
import { getAllApps } from '../services/apps.js';
import { listProcessesStrict } from '../services/pm2.js';
import { registerProcessHandlers } from './processes.js';
const sockets = [];
function connect() {
  const socket = new EventEmitter();
  socket.emit = vi.fn(socket.emit.bind(socket));
  registerProcessHandlers(socket);
  sockets.push(socket);
  socket.emit('processes:subscribe');
  return socket;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  getAllApps.mockResolvedValue([{ id: 'app-a', pm2Home: '/example/pm2' }, { id: 'app-b', pm2Home: '/example/pm2' }]);
  listProcessesStrict.mockResolvedValue([{ name: 'example-process', status: 'online', uptime: 100 }]);
});
afterEach(() => { for (const socket of sockets.splice(0)) socket.emit('disconnect'); vi.useRealTimers(); });
it('shares probes by home, pushes changes and failures, and releases the last subscriber', async () => {
  const first = connect(); const second = connect();
  await vi.advanceTimersByTimeAsync(0);
  expect(listProcessesStrict.mock.calls).toEqual([[null], ['/example/pm2']]);
  expect(first.emit).toHaveBeenCalledWith('processes:changed', expect.objectContaining({ appIds: ['app-a', 'app-b'], defaultHome: false }));
  first.emit.mockClear(); second.emit.mockClear();
  listProcessesStrict.mockResolvedValue([{ name: 'example-process', status: 'online', uptime: 1600 }]);
  await vi.advanceTimersByTimeAsync(1500);
  expect(first.emit).not.toHaveBeenCalled();
  listProcessesStrict.mockResolvedValue([{ name: 'example-process', status: 'stopped' }]);
  await vi.advanceTimersByTimeAsync(1500);
  expect(second.emit).toHaveBeenCalledWith('processes:changed', expect.objectContaining({ processes: [expect.objectContaining({ status: 'stopped' })] }));
  listProcessesStrict.mockResolvedValue(null);
  await vi.advanceTimersByTimeAsync(1500);
  expect(second.emit).toHaveBeenCalledWith('processes:changed', expect.objectContaining({ processes: null }));
  listProcessesStrict.mockResolvedValue([]);
  await vi.advanceTimersByTimeAsync(1500);
  expect(second.emit).toHaveBeenCalledWith('processes:changed', expect.objectContaining({ processes: [] }));
  first.emit('processes:unsubscribe'); listProcessesStrict.mockClear();
  await vi.advanceTimersByTimeAsync(1500);
  expect(listProcessesStrict).toHaveBeenCalledTimes(2);
  second.emit('disconnect'); listProcessesStrict.mockClear();
  await vi.advanceTimersByTimeAsync(15000);
  expect(listProcessesStrict).not.toHaveBeenCalled();
});
it('drops an in-flight sample after the last viewer disconnects', async () => {
  let finish;
  listProcessesStrict.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const socket = connect();
  await vi.advanceTimersByTimeAsync(0);
  socket.emit('disconnect'); socket.emit.mockClear();
  finish([]);
  await vi.advanceTimersByTimeAsync(15000);
  expect(socket.emit).not.toHaveBeenCalled();
  expect(listProcessesStrict).toHaveBeenCalledTimes(1);
});
