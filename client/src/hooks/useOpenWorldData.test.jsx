import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const { socketHandlers, socket } = vi.hoisted(() => {
  const handlers = new Map();
  return {
    socketHandlers: handlers,
    socket: {
      connected: true,
      emit: vi.fn(),
      on: vi.fn((event, handler) => handlers.set(event, handler)),
      off: vi.fn((event, handler) => {
        if (handlers.get(event) === handler) handlers.delete(event);
      }),
    },
  };
});

vi.mock('../services/socket', () => ({ default: socket }));
vi.mock('../services/api', () => ({
  getApps: vi.fn(async () => []),
  getRunningAgents: vi.fn(async () => []),
  getCosAgents: vi.fn(async () => []),
  getCosStatus: vi.fn(async () => ({ running: false })),
  getReviewCounts: vi.fn(async () => ({ total: 0, alert: 0, todo: 0, briefing: 0, cos: 0 })),
  getInstances: vi.fn(async () => ({ self: null, peers: [], syncStatus: null })),
  getSystemHealth: vi.fn(async () => null),
  getNotificationCount: vi.fn(async () => ({ count: 0 })),
  getBackupStatus: vi.fn(async () => null),
  getCosTasks: vi.fn(async () => ({ tasks: [] })),
  getLatestHealthMetrics: vi.fn(async () => null),
  getVoiceStatus: vi.fn(async () => null),
  getCharacter: vi.fn(async () => null),
}));
vi.mock('./useAutoRefetch', () => ({ useAutoRefetch: () => ({ data: null }) }));

import { useOpenWorldData } from './useOpenWorldData';

const settleInitialFetch = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  socketHandlers.clear();
  socket.emit.mockClear();
  socket.on.mockClear();
  socket.off.mockClear();
});

afterEach(() => vi.useRealTimers());

describe('useOpenWorldData activity log batching', () => {
  it('applies a socket burst in one render without dropping entries', async () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useOpenWorldData();
    });
    await settleInitialFetch();
    const rendersAfterMount = renders;

    act(() => {
      for (let index = 0; index < 50; index += 1) {
        socketHandlers.get('cos:log')?.({ message: `event-${index}`, timestamp: index + 1 });
      }
    });
    expect(result.current.eventLogs).toEqual([]);
    expect(renders).toBe(rendersAfterMount);

    act(() => vi.advanceTimersByTime(100));

    expect(result.current.eventLogs).toHaveLength(50);
    expect(result.current.eventLogs.at(-1).message).toBe('event-49');
    expect(renders - rendersAfterMount).toBe(1);
  });

  it('drops a pending batch when the page unmounts', async () => {
    const { unmount } = renderHook(() => useOpenWorldData());
    await settleInitialFetch();
    act(() => socketHandlers.get('cos:log')?.({ message: 'pending' }));

    unmount();
    expect(() => vi.advanceTimersByTime(200)).not.toThrow();
    expect(socketHandlers.has('cos:log')).toBe(false);
  });
});
