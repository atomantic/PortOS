import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../services/agents.js', () => ({ getRunningAgents: vi.fn() }));
import { getRunningAgents } from '../services/agents.js';
import { registerAgentProcessHandlers } from './agentProcesses.js';

const sockets = [];
function connect() {
  const socket = new EventEmitter();
  socket.emit = vi.fn(socket.emit.bind(socket));
  registerAgentProcessHandlers(socket);
  sockets.push(socket);
  socket.emit('agent-processes:subscribe');
  return socket;
}
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.emit('disconnect');
  vi.useRealTimers();
});
it('shares scans, pushes changed snapshots, survives failures and stops after the last viewer', async () => {
  getRunningAgents.mockResolvedValue([{ pid: 123, cpu: 1, runtime: 100, startTime: 1000 }]);
  const first = connect();
  const second = connect();
  await vi.advanceTimersByTimeAsync(0);
  expect(getRunningAgents).toHaveBeenCalledTimes(1);
  expect(second.emit).toHaveBeenCalledWith('agent-processes:changed', { agents: [expect.objectContaining({ pid: 123 })] });
  first.emit.mockClear();
  getRunningAgents.mockResolvedValue([{ pid: 123, cpu: 1, runtime: 100, startTime: 1001 }]);
  await vi.advanceTimersByTimeAsync(3000);
  expect(first.emit).not.toHaveBeenCalled();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  getRunningAgents.mockRejectedValueOnce(new Error('probe unavailable'));
  await vi.advanceTimersByTimeAsync(3000);
  expect(log).toHaveBeenCalled();
  log.mockRestore();
  getRunningAgents.mockResolvedValue([]);
  await vi.advanceTimersByTimeAsync(3000);
  expect(second.emit).toHaveBeenCalledWith('agent-processes:changed', { agents: [] });
  first.emit('agent-processes:unsubscribe');
  getRunningAgents.mockClear();
  await vi.advanceTimersByTimeAsync(3000);
  expect(getRunningAgents).toHaveBeenCalledTimes(1);
  second.emit('disconnect');
  getRunningAgents.mockClear();
  await vi.advanceTimersByTimeAsync(30000);
  expect(getRunningAgents).not.toHaveBeenCalled();
});
it('never overlaps a pending probe and discards it after disconnect', async () => {
  let finish;
  getRunningAgents.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const socket = connect();
  await vi.advanceTimersByTimeAsync(12000);
  expect(getRunningAgents).toHaveBeenCalledTimes(1);
  socket.emit('disconnect');
  socket.emit.mockClear();
  finish([]);
  await vi.advanceTimersByTimeAsync(12000);
  expect(socket.emit).not.toHaveBeenCalled();
  expect(getRunningAgents).toHaveBeenCalledTimes(1);
});
