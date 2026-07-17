import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Capture ai:status handlers registered on the socket so tests can drive events.
const handlers = new Set();
vi.mock('../services/socket', () => ({
  default: {
    on: (evt, fn) => { if (evt === 'ai:status') handlers.add(fn); },
    off: (evt, fn) => { if (evt === 'ai:status') handlers.delete(fn); },
  },
}));

// Record every toast call so we can assert count + message + id.
const toastCalls = [];
const toastFn = Object.assign(
  (...args) => { toastCalls.push({ type: 'default', args }); },
  {
    error: (message, opts) => { toastCalls.push({ type: 'error', message, opts }); },
    success: (message, opts) => { toastCalls.push({ type: 'success', message, opts }); },
    loading: (message, opts) => { toastCalls.push({ type: 'loading', message, opts }); },
    dismiss: () => {},
  }
);
vi.mock('../components/ui/Toast', () => ({ default: toastFn }));

const { useAIStatusNotifications } = await import('./useAIStatusNotifications.js');

function emit(event) {
  for (const fn of handlers) fn(event);
}

const errorCalls = () => toastCalls.filter(c => c.type === 'error');

beforeEach(() => {
  vi.useFakeTimers();
  handlers.clear();
  toastCalls.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useAIStatusNotifications — silent-op error coalescing', () => {
  it('collapses a burst of silent-op failures from one provider into ONE counted toast', () => {
    renderHook(() => useAIStatusNotifications());

    // Simulate an unattended multi-goal check-in: 5 concurrent silent calls to
    // the same failing provider, each with a unique op id (as startAIOp mints).
    act(() => {
      for (let i = 0; i < 5; i++) {
        const id = `op-${i}`;
        emit({ id, phase: 'start', silent: true, providerId: 'prov-1', providerName: 'Example Provider' });
        emit({ id, phase: 'error', silent: true, providerId: 'prov-1', providerName: 'Example Provider', message: 'HTTP 401 Unauthorized' });
      }
    });

    // Every silent error routes to the SAME provider-keyed toast id — one toast,
    // not five. The first shows the real reason; later ones update to a count.
    const errs = errorCalls();
    const uniqueIds = new Set(errs.map(c => c.opts?.id));
    expect(uniqueIds.size).toBe(1);
    expect([...uniqueIds][0]).toBe('ai-silent-error::prov-1');

    const last = errs[errs.length - 1];
    expect(last.message).toBe('Example Provider failed on 5 background AI calls');

    // The first failure surfaced the provider's real reason.
    expect(errs[0].message).toBe('HTTP 401 Unauthorized');
  });

  it('keeps user-triggered (non-silent) failures immediate, individual, and with the real reason', () => {
    renderHook(() => useAIStatusNotifications());

    act(() => {
      const a = 'op-user-a';
      emit({ id: a, phase: 'start', silent: false, providerId: 'prov-1', providerName: 'Example Provider' });
      emit({ id: a, phase: 'error', silent: false, providerId: 'prov-1', providerName: 'Example Provider', message: 'HTTP 500 boom' });

      const b = 'op-user-b';
      emit({ id: b, phase: 'start', silent: false, providerId: 'prov-1', providerName: 'Example Provider' });
      emit({ id: b, phase: 'error', silent: false, providerId: 'prov-1', providerName: 'Example Provider', message: 'timeout' });
    });

    const errs = errorCalls();
    // Two distinct failures → two distinct toasts, each keyed by its own op id.
    expect(errs).toHaveLength(2);
    expect(errs[0].opts?.id).toBe('op-user-a');
    expect(errs[0].message).toBe('HTTP 500 boom');
    expect(errs[1].opts?.id).toBe('op-user-b');
    expect(errs[1].message).toBe('timeout');
  });

  it('coalesces silent failures per-provider, not across providers', () => {
    renderHook(() => useAIStatusNotifications());

    act(() => {
      emit({ id: 'x1', phase: 'error', silent: true, providerId: 'prov-a', providerName: 'Provider A', message: 'a fail' });
      emit({ id: 'x2', phase: 'error', silent: true, providerId: 'prov-b', providerName: 'Provider B', message: 'b fail' });
      emit({ id: 'x3', phase: 'error', silent: true, providerId: 'prov-a', providerName: 'Provider A', message: 'a fail again' });
    });

    const errs = errorCalls();
    const ids = new Set(errs.map(c => c.opts?.id));
    expect(ids).toEqual(new Set(['ai-silent-error::prov-a', 'ai-silent-error::prov-b']));

    const provA = errs.filter(c => c.opts?.id === 'ai-silent-error::prov-a');
    expect(provA[provA.length - 1].message).toBe('Provider A failed on 2 background AI calls');
  });

  it('starts a fresh coalescing window after the previous one lapses', () => {
    renderHook(() => useAIStatusNotifications());

    act(() => {
      emit({ id: 'g1', phase: 'error', silent: true, providerId: 'prov-1', providerName: 'Example Provider', message: 'first reason' });
    });
    // Advance past the rolling window so the entry is cleaned up.
    act(() => { vi.advanceTimersByTime(5000); });
    act(() => {
      emit({ id: 'g2', phase: 'error', silent: true, providerId: 'prov-1', providerName: 'Example Provider', message: 'second reason' });
    });

    const errs = errorCalls();
    // Both are the first-in-window, so both show their real reason (count 1).
    expect(errs[0].message).toBe('first reason');
    expect(errs[errs.length - 1].message).toBe('second reason');
  });
});
