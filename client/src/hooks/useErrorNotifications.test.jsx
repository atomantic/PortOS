import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

const handlers = new Map();
const emitted = [];
vi.mock('../services/socket', () => ({
  default: {
    connected: true,
    on: (event, fn) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
    },
    off: (event, fn) => { handlers.get(event)?.delete(fn); },
    emit: (event, payload) => { emitted.push([event, payload]); },
  },
}));

const toast = vi.hoisted(() => {
  const fn = vi.fn();
  fn.error = vi.fn();
  fn.success = vi.fn();
  return fn;
});
vi.mock('../components/ui/Toast', () => ({ default: toast }));

const { useErrorNotifications } = await import('./useErrorNotifications.js');

const fire = (event, payload) => act(() => {
  for (const fn of [...(handlers.get(event) || [])]) fn(payload);
});

beforeEach(() => {
  handlers.clear();
  emitted.length = 0;
  toast.mockClear();
  toast.error.mockClear();
  toast.success.mockClear();
});
afterEach(cleanup);

describe('useErrorNotifications reconnect (#8110)', () => {
  it('re-emits errors:subscribe on every socket reconnect', () => {
    renderHook(() => useErrorNotifications());
    expect(emitted.filter(([e]) => e === 'errors:subscribe')).toHaveLength(1);

    fire('connect');
    fire('connect');
    // Mounted while already connected (socket.connected: true), so both
    // 'connect' events are genuine reconnects.
    expect(emitted.filter(([e]) => e === 'errors:subscribe')).toHaveLength(3);
  });

  it('keeps surfacing server errors as toasts after a reconnect', () => {
    renderHook(() => useErrorNotifications());
    fire('connect');

    fire('error:notified', { code: 'SOMETHING_FAILED', message: 'Something failed', severity: 'error' });
    expect(toast.error).toHaveBeenCalledWith('Something failed', expect.any(Object));
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useErrorNotifications());
    unmount();
    expect(emitted.some(([e]) => e === 'errors:unsubscribe')).toBe(true);
  });
});
