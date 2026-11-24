import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import socket from '../services/socket';
import { useSocketResource } from './useSocketResource';

vi.mock('../services/socket', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: new EventEmitter() };
});

const event = 'resource:changed';
const events = [event];

afterEach(() => vi.useRealTimers());

describe('useSocketResource', () => {
  it('ignores unrelated events and drops queued work and late results on a resource switch', async () => {
    const stale = Promise.withResolvers();
    const load = vi.fn().mockReturnValueOnce(stale.promise).mockResolvedValue('current');
    const { result, rerender } = renderHook(({ resourceKey }) => useSocketResource(load, {
      events,
      resourceKey,
      matchesEvent: payload => payload.key === resourceKey,
    }), { initialProps: { resourceKey: 'old' } });

    await act(async () => {});
    await act(async () => { socket.emit(event, { key: 'old' }); });
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => { rerender({ resourceKey: 'new' }); });
    expect(load.mock.calls[0][0].signal.aborted).toBe(true);
    expect(load.mock.calls[1][0]).toMatchObject({ reconcile: true, events: [] });

    await act(async () => {
      socket.emit(event, { key: 'old' });
      stale.resolve('stale');
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBe('current');
  });

  it('keeps a local mutation when a pre-mutation read settles', async () => {
    const stale = Promise.withResolvers();
    const load = vi.fn()
      .mockResolvedValueOnce(['initial'])
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(['local', 'b']);
    const { result } = renderHook(() => useSocketResource(load, { events }));
    await act(async () => {});
    await act(async () => { socket.emit(event, 'a'); });
    act(() => { result.current.updateData(previous => [...previous, 'local']); });
    await act(async () => { stale.resolve(['stale']); });
    expect(result.current.data).toEqual(['initial', 'local']);
    expect(load).toHaveBeenCalledTimes(2);

    await act(async () => { socket.emit(event, 'b'); });
    expect(load.mock.calls[2][0].events).toEqual([{ event, payload: 'b' }]);
    expect(result.current.data).toEqual(['local', 'b']);
  });

  it('carries ordered events past a superseded timeout and allows a full retry after a failed read', async () => {
    vi.useFakeTimers();
    const stalled = Promise.withResolvers();
    const load = vi.fn()
      .mockResolvedValueOnce('initial')
      .mockReturnValueOnce(stalled.promise)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('reconciled');
    const { result } = renderHook(() => useSocketResource(load, { events, requestTimeoutMs: 100 }));
    await act(async () => {});
    await act(async () => { socket.emit(event, 'a'); });
    await act(async () => { socket.emit(event, 'b'); });
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(load.mock.calls[1][0].signal.aborted).toBe(true);
    expect(load.mock.calls[2][0]).toMatchObject({
      reconcile: false,
      events: [{ event, payload: 'a' }, { event, payload: 'b' }],
    });
    expect(result.current).toMatchObject({ data: 'initial', error: { message: 'offline' } });

    await act(async () => { await result.current.refetch(); });
    expect(load.mock.calls[3][0]).toMatchObject({ reconcile: true, events: [] });
    await act(async () => { stalled.resolve('stale'); });
    expect(result.current).toMatchObject({ data: 'reconciled', error: null });
  });
});
