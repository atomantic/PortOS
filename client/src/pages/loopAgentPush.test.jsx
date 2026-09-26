import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

vi.mock('../services/socket', () => {
  const listeners = new Map();
  return { default: {
    on: vi.fn((event, fn) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
    }),
    off: vi.fn((event, fn) => listeners.get(event)?.delete(fn)),
    emit: vi.fn(),
    receive: (event, payload) => { for (const fn of listeners.get(event) ?? []) fn(payload); },
  } };
});
vi.mock('../services/api', () => ({
  getLoops: vi.fn(), getLoopProviders: vi.fn(), getAgents: vi.fn(), killAgent: vi.fn(),
  stopLoop: vi.fn(), resumeLoop: vi.fn(), triggerLoop: vi.fn(), deleteLoop: vi.fn(),
}));
import socket from '../services/socket';
import * as api from '../services/api';
import Loops from './Loops';
import AgentsPage from './AgentsPage';

const loop = { id: 'example-loop', name: 'Example loop', intervalMs: 60000, currentIteration: 0 };
const agent = { pid: 123, agentName: 'Example agent', runtimeFormatted: '1s', cpu: 0, memory: 0 };
const flush = async (fn = () => {}) => act(async () => { fn(); await vi.advanceTimersByTimeAsync(0); });
async function visibility(state) {
  await flush(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  api.getLoops.mockResolvedValue([loop]);
  api.getLoopProviders.mockResolvedValue({ providers: [] });
  api.getAgents.mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('renders loop iteration pushes, preserves last-good data and reconciles only on reconnect/reshow', async () => {
  const view = render(<Loops />);
  await flush();
  expect(screen.getByText('#0 iterations')).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(65000); });
  expect(api.getLoops).toHaveBeenCalledTimes(1);
  api.getLoops.mockResolvedValue([{ ...loop, currentIteration: 1 }]);
  await flush(() => socket.receive('loop:iteration:complete', { id: loop.id }));
  expect(screen.getByText('#1 iterations')).toBeInTheDocument();
  api.getLoops.mockRejectedValueOnce(new Error('offline'));
  await flush(() => socket.receive('connect'));
  expect(api.getLoops).toHaveBeenCalledTimes(3);
  expect(screen.getByText('#1 iterations')).toBeInTheDocument();
  await visibility('hidden');
  await flush(() => socket.receive('loop:iteration:start', { id: loop.id }));
  expect(api.getLoops).toHaveBeenCalledTimes(3);
  await visibility('visible');
  expect(api.getLoops).toHaveBeenCalledTimes(4);
  await visibility('visible');
  expect(api.getLoops).toHaveBeenCalledTimes(4);
  view.unmount();
  expect(socket.emit).toHaveBeenCalledWith('loops:unsubscribe');
  await flush(() => { socket.receive('connect'); socket.receive('loop:updated', {}); });
  await visibility('hidden'); await visibility('visible');
  expect(api.getLoops).toHaveBeenCalledTimes(4);
});

it('renders agent snapshots without API polls and drops an older HTTP response', async () => {
  let finish;
  api.getAgents.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const view = render(<AgentsPage />);
  await flush();
  await flush(() => socket.receive('agent-processes:changed', { agents: [agent] }));
  expect(screen.getAllByText('example agent').length).toBeGreaterThan(0);
  await flush(() => finish([]));
  expect(screen.getAllByText('example agent').length).toBeGreaterThan(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(65000); });
  expect(api.getAgents).toHaveBeenCalledTimes(1);
  api.getAgents.mockRejectedValueOnce(new Error('offline'));
  await flush(() => socket.receive('connect'));
  expect(api.getAgents).toHaveBeenCalledTimes(2);
  expect(screen.getAllByText('example agent').length).toBeGreaterThan(0);
  await visibility('hidden'); await visibility('visible');
  expect(api.getAgents).toHaveBeenCalledTimes(3);
  await visibility('visible');
  expect(api.getAgents).toHaveBeenCalledTimes(3);
  view.unmount();
  expect(socket.emit).toHaveBeenCalledWith('agent-processes:unsubscribe');
  await flush(() => socket.receive('connect'));
  await visibility('hidden'); await visibility('visible');
  expect(api.getAgents).toHaveBeenCalledTimes(3);
});
