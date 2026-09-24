import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import * as api from '../services/api';
import socket from '../services/socket';
import { useSidebarApps } from './useSidebarApps.js';

vi.mock('../services/api', () => ({
  getApps: vi.fn(),
}));

vi.mock('../services/socket', () => {
  const handlers = new Map();
  return {
    default: {
      on: vi.fn((event, handler) => {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event).push(handler);
      }),
      off: vi.fn((event, handler) => {
        if (!handlers.has(event)) return;
        const list = handlers.get(event).filter((h) => h !== handler);
        handlers.set(event, list);
      }),
      emitMockEvent: (event, data) => {
        (handlers.get(event) || []).forEach((h) => h(data));
      },
      clearHandlers: () => handlers.clear(),
    },
  };
});

describe('useSidebarApps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    socket.clearHandlers();
  });

  it('fetches on mount, filters archived apps, and sorts active apps by name', async () => {
    api.getApps.mockResolvedValue([
      { id: 'app-z', name: 'Zeta App', archived: false },
      { id: 'app-a', name: 'Alpha App', archived: false },
      { id: 'app-archived', name: 'Archived App', archived: true },
    ]);

    const { result } = renderHook(() => useSidebarApps());

    await waitFor(() => expect(result.current.length).toBe(2));
    expect(api.getApps).toHaveBeenCalledWith({ silent: true, view: 'nav' });
    expect(result.current.map((a) => a.id)).toEqual(['app-a', 'app-z']);
  });

  it('passes includeDetails to api.getApps when requested', async () => {
    api.getApps.mockResolvedValue([{ id: 'app-1', name: 'App One' }]);

    const { result } = renderHook(() => useSidebarApps({ includeDetails: true }));

    await waitFor(() => expect(result.current.length).toBe(1));
    expect(api.getApps).toHaveBeenCalledWith({ silent: true });
  });

  it('refetches and updates when apps:changed is emitted', async () => {
    api.getApps
      .mockResolvedValueOnce([{ id: 'app-1', name: 'App One' }])
      .mockResolvedValueOnce([
        { id: 'app-1', name: 'App One' },
        { id: 'app-2', name: 'App Two' },
      ]);

    const { result } = renderHook(() => useSidebarApps());

    await waitFor(() => expect(result.current.length).toBe(1));

    act(() => {
      socket.emitMockEvent('apps:changed', { action: 'create', appId: 'app-2' });
    });

    await waitFor(() => expect(result.current.length).toBe(2));
    expect(result.current.map((a) => a.id)).toEqual(['app-1', 'app-2']);
  });

  it('refetches when connect is emitted', async () => {
    api.getApps
      .mockResolvedValueOnce([{ id: 'app-1', name: 'App One' }])
      .mockResolvedValueOnce([
        { id: 'app-1', name: 'App One' },
        { id: 'app-2', name: 'App Two' },
      ]);

    const { result } = renderHook(() => useSidebarApps());

    await waitFor(() => expect(result.current.length).toBe(1));

    act(() => {
      socket.emitMockEvent('connect');
    });

    await waitFor(() => expect(result.current.length).toBe(2));
  });

  it('cleans up socket listeners on unmount', async () => {
    api.getApps.mockResolvedValue([]);

    const { unmount } = renderHook(() => useSidebarApps());
    expect(socket.on).toHaveBeenCalledWith('apps:changed', expect.any(Function));
    expect(socket.on).toHaveBeenCalledWith('connect', expect.any(Function));

    unmount();

    expect(socket.off).toHaveBeenCalledWith('apps:changed', expect.any(Function));
    expect(socket.off).toHaveBeenCalledWith('connect', expect.any(Function));
  });
});
