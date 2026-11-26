import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const socket = vi.hoisted(() => {
  const handlers = new Map();
  return {
    on: (event, handler) => handlers.set(event, handler),
    off: (event, handler) => { if (handlers.get(event) === handler) handlers.delete(event); },
    emit: vi.fn(),
    receive: (event, payload) => handlers.get(event)?.(payload),
    reset: () => handlers.clear(),
  };
});

vi.mock('../../hooks/useSocket', () => ({ useSocket: () => socket }));
vi.mock('../../hooks/useSocketSubscription', () => ({ useSocketSubscription: vi.fn() }));
vi.mock('../../hooks/useMounted', () => ({ default: () => ({ current: true }) }));
vi.mock('../../services/apiAgents.js', async (importOriginal) => {
  const api = await importOriginal();
  return Object.fromEntries(Object.keys(api).map(name => [name, vi.fn(async () => ({}))]));
});
vi.mock('../../services/apiProviders.js', () => ({ getProviders: vi.fn(async () => ({})) }));
vi.mock('../../services/apiApps.js', () => ({ getApps: vi.fn(async () => ({})) }));
vi.mock('../ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

import useCosPageData from './useCosPageData';

describe('useCosPageData agent output buffers', () => {
  beforeEach(() => socket.reset());
  afterEach(() => vi.useRealTimers());

  it('evicts the output buffer when completion contains id without agentId', async () => {
    const { result } = renderHook(() => useCosPageData({ activeTab: 'agents', selectedTask: null }));
    act(() => socket.receive('cos:agent:spawned', { id: 'agent-1' }));
    await waitFor(() => expect(result.current.liveOutputs).toHaveProperty('agent-1', []));

    vi.useFakeTimers();
    act(() => socket.receive('cos:agent:output', { agentId: 'agent-1', line: 'working' }));
    act(() => vi.advanceTimersByTime(100));
    expect(result.current.liveOutputs['agent-1']).toHaveLength(1);

    await act(async () => {
      socket.receive('cos:agent:output', { agentId: 'agent-1', line: 'finishing' });
      socket.receive('cos:agent:output', { agentId: 'agent-2', line: 'still running' });
      socket.receive('cos:agent:completed', { id: 'agent-1', result: { success: true } });
      vi.advanceTimersByTime(100);
    });
    expect(result.current.liveOutputs).not.toHaveProperty('agent-1');
    expect(result.current.liveOutputs['agent-2'].map(entry => entry.line)).toEqual(['still running']);
  });

  it('publishes a burst across agents in one update, preserving order and the retention limit', async () => {
    const snapshots = [];
    const { result } = renderHook(() => {
      const data = useCosPageData({ activeTab: 'agents', selectedTask: null });
      if (snapshots.at(-1) !== data.liveOutputs) snapshots.push(data.liveOutputs);
      return data;
    });
    await act(async () => {});
    vi.useFakeTimers();
    const lines = Array.from({ length: 300 }, (_, index) => `line ${index}`);
    const send = (agentId, line) => act(() => socket.receive('cos:agent:output', { agentId, line }));

    for (const line of lines) send('agent-1', line);
    send('agent-2', 'other agent');
    act(() => vi.advanceTimersByTime(99));
    expect(snapshots).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(snapshots).toHaveLength(2);
    expect(result.current.liveOutputs['agent-1'].map(entry => entry.line)).toEqual(lines);
    expect(result.current.liveOutputs['agent-2'].map(entry => entry.line)).toEqual(['other agent']);

    for (const line of lines) send('agent-1', line);
    act(() => vi.advanceTimersByTime(100));
    expect(snapshots).toHaveLength(3);
    expect(result.current.liveOutputs['agent-1'].map(entry => entry.line)).toEqual([...lines.slice(100), ...lines]);
  });

  it('cancels the pending flush when the subscription unmounts', async () => {
    const { unmount } = renderHook(() => useCosPageData({ activeTab: 'agents', selectedTask: null }));
    await act(async () => {});
    vi.useFakeTimers();

    act(() => socket.receive('cos:agent:output', { agentId: 'agent-1', line: 'queued' }));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
