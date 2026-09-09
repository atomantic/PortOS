import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// Mock the socket singleton so the test can drive the handlers the hook
// registers and observe the subscriptions it emits.
const handlers = new Map();
const emitted = [];
vi.mock('../services/socket', () => ({
  default: {
    on: (event, fn) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
    },
    off: (event, fn) => { handlers.get(event)?.delete(fn); },
    emit: (event, payload) => { emitted.push([event, payload]); },
  },
}));

const useBeeperRealtime = (await import('./useBeeperRealtime.js')).default;

const fire = (event, payload) => act(() => {
  for (const fn of [...(handlers.get(event) || [])]) fn(payload);
});

describe('useBeeperRealtime', () => {
  beforeEach(() => { handlers.clear(); emitted.length = 0; });
  afterEach(cleanup);

  it('subscribes at mount and RE-SUBSCRIBES on every socket connect', () => {
    // The server rebuilds an empty per-socket subscriber Set on reconnect, so a
    // one-shot emit at mount leaves the surface permanently dead after a
    // laptop sleep — the same scar `useMoltworldWs` carries.
    renderHook(() => useBeeperRealtime());
    expect(emitted.filter(([event]) => event === 'beeper:subscribe')).toHaveLength(1);

    fire('connect');
    fire('connect');
    expect(emitted.filter(([event]) => event === 'beeper:subscribe')).toHaveLength(3);
  });

  it('unsubscribes and detaches every listener on unmount', () => {
    const { unmount } = renderHook(() => useBeeperRealtime());
    unmount();
    expect(emitted.some(([event]) => event === 'beeper:unsubscribe')).toBe(true);
    expect(handlers.get('beeper:invalidate')?.size ?? 0).toBe(0);
    expect(handlers.get('beeper:realtime')?.size ?? 0).toBe(0);
    expect(handlers.get('connect')?.size ?? 0).toBe(0);
  });

  it('hands each invalidation frame to the caller and keeps the last one', () => {
    const onInvalidate = vi.fn();
    const { result } = renderHook(() => useBeeperRealtime({ onInvalidate }));

    const frame = { kind: 'message.upserted', chatID: 'chat-1', ids: ['m1'], seq: 3, ts: null };
    fire('beeper:invalidate', frame);

    expect(onInvalidate).toHaveBeenCalledWith(frame);
    expect(result.current.lastInvalidation).toEqual(frame);
  });

  it('does not re-subscribe when the caller passes a new inline callback each render', () => {
    const { rerender } = renderHook(() => useBeeperRealtime({ onInvalidate: () => {} }));
    rerender();
    rerender();
    expect(emitted.filter(([event]) => event === 'beeper:subscribe')).toHaveLength(1);
  });

  it('starts at null (not-yet-known) and never reports a state the server has not sent', () => {
    const { result } = renderHook(() => useBeeperRealtime());
    expect(result.current.connectionState).toBeNull();

    fire('beeper:realtime', { state: 'connected', lastEventAt: null, lastPingAt: null });
    expect(result.current.connectionState).toBe('connected');

    // A malformed frame preserves the last good snapshot rather than blanking
    // the dot (validate shape, not truthiness).
    fire('beeper:realtime', {});
    expect(result.current.connectionState).toBe('connected');
  });

  it('seeds from the status payload, and stops seeding once the socket has spoken', () => {
    const { result } = renderHook(() => useBeeperRealtime());

    act(() => result.current.seedRealtime({ state: 'down' }));
    expect(result.current.connectionState).toBe('down');

    fire('beeper:realtime', { state: 'connected' });
    act(() => result.current.seedRealtime({ state: 'down' }));
    expect(result.current.connectionState).toBe('connected');
  });
});
