import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('evicts the output buffer when completion contains id without agentId', async () => {
    const { result } = renderHook(() => useCosPageData({ activeTab: 'agents', selectedTask: null }));
    act(() => socket.receive('cos:agent:spawned', { id: 'agent-1' }));
    await waitFor(() => expect(result.current.liveOutputs).toHaveProperty('agent-1', []));

    act(() => socket.receive('cos:agent:output', { agentId: 'agent-1', line: 'working' }));
    expect(result.current.liveOutputs['agent-1']).toHaveLength(1);

    act(() => socket.receive('cos:agent:completed', { id: 'agent-1', result: { success: true } }));
    expect(result.current.liveOutputs).not.toHaveProperty('agent-1');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  });
});
