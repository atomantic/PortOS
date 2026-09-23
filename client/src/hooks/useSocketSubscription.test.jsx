import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// Mock the socket singleton so the test can drive the 'connect' handlers the
// hook registers and observe the subscribe/unsubscribe emits.
const handlers = new Map();
const emitted = [];
const socketState = { connected: false };
vi.mock('../services/socket', () => ({
  default: {
    get connected() { return socketState.connected; },
    on: (event, fn) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
    },
    off: (event, fn) => { handlers.get(event)?.delete(fn); },
    emit: (event, payload) => { emitted.push([event, payload]); },
  },
}));

const { useSocketSubscription } = await import('./useSocketSubscription.js');

const fire = (event, payload) => act(() => {
  for (const fn of [...(handlers.get(event) || [])]) fn(payload);
});

beforeEach(() => {
  handlers.clear();
  emitted.length = 0;
  socketState.connected = false;
});
afterEach(cleanup);

describe('useSocketSubscription', () => {
  it('subscribes once at mount and RE-SUBSCRIBES on every reconnect', () => {
    // The server rebuilds an empty per-socket subscriber Set on reconnect
    // (server/services/socket.js registerSubscriber), so a one-shot emit at
    // mount goes permanently dead the first time it fires (#8110).
    renderHook(() => useSocketSubscription('notifications'));
    expect(emitted.filter(([e]) => e === 'notifications:subscribe')).toHaveLength(1);

    fire('connect');
    fire('connect');
    expect(emitted.filter(([e]) => e === 'notifications:subscribe')).toHaveLength(3);
  });

  it('calls onResubscribe on the first connect after mounting disconnected', () => {
    // A component can mount while the socket is still connecting, or while
    // reconnecting after an outage that also broke its own initial HTTP
    // fetch. Skipping that first connect would leave stale data uncorrected
    // until some LATER reconnect, so onResubscribe fires for every connect,
    // including the first one a mount observes.
    const onResubscribe = vi.fn();
    renderHook(() => useSocketSubscription('loops', { onResubscribe }));

    fire('connect');
    expect(onResubscribe).toHaveBeenCalledTimes(1);

    fire('connect');
    expect(onResubscribe).toHaveBeenCalledTimes(2);
  });

  it('calls onResubscribe on every reconnect when mounted while already connected', () => {
    socketState.connected = true;
    const onResubscribe = vi.fn();
    renderHook(() => useSocketSubscription('errors', { onResubscribe }));

    fire('connect');
    fire('connect');
    expect(onResubscribe).toHaveBeenCalledTimes(2);
  });

  it('always calls the CURRENT onResubscribe, not the one from first render', () => {
    const first = vi.fn();
    const second = vi.fn();
    socketState.connected = true;
    const { rerender } = renderHook(
      ({ onResubscribe }) => useSocketSubscription('errors', { onResubscribe }),
      { initialProps: { onResubscribe: first } }
    );
    rerender({ onResubscribe: second });

    fire('connect');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes only when the LAST consumer of a namespace unmounts', () => {
    const a = renderHook(() => useSocketSubscription('instances'));
    const b = renderHook(() => useSocketSubscription('instances'));

    // One subscribe for the namespace, not two.
    expect(emitted.filter(([e]) => e === 'instances:subscribe')).toHaveLength(1);

    a.unmount();
    expect(emitted.some(([e]) => e === 'instances:unsubscribe')).toBe(false);

    b.unmount();
    expect(emitted.filter(([e]) => e === 'instances:unsubscribe')).toHaveLength(1);
  });

  it('resubscribing after the last consumer unmounts starts a fresh subscription', () => {
    const first = renderHook(() => useSocketSubscription('cos'));
    first.unmount();
    expect(emitted.filter(([e]) => e === 'cos:subscribe')).toHaveLength(1);
    expect(emitted.filter(([e]) => e === 'cos:unsubscribe')).toHaveLength(1);

    renderHook(() => useSocketSubscription('cos'));
    expect(emitted.filter(([e]) => e === 'cos:subscribe')).toHaveLength(2);
  });

  it('drops its connect listener once the last consumer unmounts', () => {
    const { unmount } = renderHook(() => useSocketSubscription('agents'));
    expect(handlers.get('connect')?.size ?? 0).toBe(1);
    unmount();
    expect(handlers.get('connect')?.size ?? 0).toBe(0);
  });
});
