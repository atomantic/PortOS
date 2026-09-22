import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SYSTEM_ACTIVITY_COALESCE_MS,
  __resetSystemActivityForTests,
  useSystemActivity,
} from './useSystemActivity';

const handlers = new Map();
vi.mock('../services/socket', () => ({
  default: {
    on: (event, fn) => {
      const list = handlers.get(event) || [];
      list.push(fn);
      handlers.set(event, list);
    },
    off: (event, fn) => {
      handlers.set(event, (handlers.get(event) || []).filter((item) => item !== fn));
    },
  },
}));

const getSystemActivity = vi.fn();
vi.mock('../services/api', () => ({
  getSystemActivity: (...args) => getSystemActivity(...args),
}));

const idle = { activity: { idle: true, activeCount: 0, queuedCount: 0, blockers: [] }, jobs: [] };
const busy = { activity: { idle: false, activeCount: 1, queuedCount: 0, blockers: [] }, jobs: [{ id: 'job-1', status: 'running' }] };

const fire = (event) => {
  for (const handler of handlers.get(event) || []) handler();
};

beforeEach(() => {
  handlers.clear();
  getSystemActivity.mockReset();
  getSystemActivity.mockResolvedValue(idle);
});

afterEach(() => {
  cleanup();
  __resetSystemActivityForTests();
  vi.useRealTimers();
});

describe('useSystemActivity', () => {
  it('coalesces an event burst into one bounded read', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSystemActivity());
    await act(async () => { await Promise.resolve(); });
    expect(getSystemActivity).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('ready');

    getSystemActivity.mockResolvedValue(busy);
    await act(async () => {
      fire('system:activity');
      fire('system:activity');
      fire('system:activity');
      await vi.advanceTimersByTimeAsync(SYSTEM_ACTIVITY_COALESCE_MS);
    });
    expect(getSystemActivity).toHaveBeenCalledTimes(2);
    expect(result.current.snapshot.activity.idle).toBe(false);
  });

  it('reconciles a missed frame when the socket reconnects', async () => {
    const { result } = renderHook(() => useSystemActivity());
    await act(async () => { await Promise.resolve(); });
    getSystemActivity.mockResolvedValue(busy);
    await act(async () => { fire('connect'); });
    expect(getSystemActivity).toHaveBeenCalledTimes(2);
    expect(result.current.snapshot.jobs).toHaveLength(1);
  });

  it('keeps the previous snapshot and refuses idle when a read fails', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSystemActivity());
    await act(async () => { await Promise.resolve(); });
    expect(result.current.status).toBe('ready');

    getSystemActivity.mockRejectedValue(new Error('offline'));
    await act(async () => {
      fire('system:activity');
      await vi.advanceTimersByTimeAsync(SYSTEM_ACTIVITY_COALESCE_MS);
    });
    expect(result.current.status).toBe('error');
    expect(result.current.snapshot).toEqual(idle);
    expect(result.current.status === 'ready' && result.current.snapshot.activity.idle).toBe(false);
  });

  it('does not publish an idle snapshot for a malformed payload', async () => {
    getSystemActivity.mockResolvedValue({ jobs: [] });
    const { result } = renderHook(() => useSystemActivity());
    await act(async () => { await Promise.resolve(); });
    expect(result.current.status).toBe('error');
    expect(result.current.snapshot).toBeNull();
  });

  it('defers an invalidation that arrives while the tab is hidden', async () => {
    vi.useFakeTimers();
    let visibility = 'visible';
    const original = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    try {
      renderHook(() => useSystemActivity());
      await act(async () => { await Promise.resolve(); });
      const reads = getSystemActivity.mock.calls.length;
      visibility = 'hidden';
      await act(async () => {
        fire('system:activity');
        await vi.advanceTimersByTimeAsync(SYSTEM_ACTIVITY_COALESCE_MS);
      });
      expect(getSystemActivity).toHaveBeenCalledTimes(reads);

      visibility = 'visible';
      getSystemActivity.mockResolvedValue(busy);
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await Promise.resolve();
      });
      expect(getSystemActivity).toHaveBeenCalledTimes(reads + 1);
    } finally {
      if (original) Object.defineProperty(document, 'visibilityState', original);
    }
  });

  it('does not read on a timer while idle', async () => {
    vi.useFakeTimers();
    renderHook(() => useSystemActivity());
    await act(async () => { await Promise.resolve(); });
    const reads = getSystemActivity.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(getSystemActivity).toHaveBeenCalledTimes(reads);
  });
});
