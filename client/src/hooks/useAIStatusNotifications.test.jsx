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
    dismiss: (id) => { toastCalls.push({ type: 'dismiss', id }); },
  }
);
vi.mock('../components/ui/Toast', () => ({ default: toastFn }));

const { useAIStatusNotifications } = await import('./useAIStatusNotifications.js');

function emit(event) {
  for (const fn of handlers) fn(event);
}

const errorCalls = () => toastCalls.filter(c => c.type === 'error');
const dismissCalls = () => toastCalls.filter(c => c.type === 'dismiss');

beforeEach(() => {
  vi.useFakeTimers();
  handlers.clear();
  toastCalls.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useAIStatusNotifications — background-op error coalescing', () => {
  it('collapses a burst of background-op failures from one provider into ONE counted toast', () => {
    renderHook(() => useAIStatusNotifications());

    // Simulate an unattended multi-goal check-in: 5 concurrent background calls
    // to the same failing provider, each with a unique op id (as startAIOp mints).
    act(() => {
      for (let i = 0; i < 5; i++) {
        const id = `op-${i}`;
        emit({ id, phase: 'start', silent: true, background: true, providerId: 'prov-1', providerName: 'Example Provider' });
        emit({ id, phase: 'error', silent: true, background: true, providerId: 'prov-1', providerName: 'Example Provider', message: 'HTTP 401 Unauthorized' });
      }
    });

    // Every background error routes to the SAME provider-keyed toast id — one
    // toast, not five. The first shows the real reason; later ones add a count.
    const errs = errorCalls();
    const uniqueIds = new Set(errs.map(c => c.opts?.id));
    expect(uniqueIds.size).toBe(1);
    expect([...uniqueIds][0]).toMatch(/^ai-bg-error::prov-1::/);

    // The counted toast keeps the first real reason visible — since these
    // events can all land before a paint, the counted toast is often the only
    // one the user ever sees, so a bare count would strip the actionable reason.
    const last = errs[errs.length - 1];
    expect(last.message).toBe('Example Provider failed on 5 background AI calls — HTTP 401 Unauthorized');

    // The first failure surfaced the provider's real reason.
    expect(errs[0].message).toBe('HTTP 401 Unauthorized');
  });

  it('keeps user-triggered (non-background) failures immediate, individual, and with the real reason', () => {
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

  it('does NOT coalesce silent-but-user-triggered ops (op-less goal actions) — they still toast individually', () => {
    renderHook(() => useAIStatusNotifications());

    // generateGoalPhases / decomposeGoal / checkInGoal call the provider WITHOUT
    // `op`, so they are silent (no start toast) but they are NOT background work —
    // the user clicked a button. Two such failures from the same provider within
    // the coalescing window must remain two individual toasts labelled with their
    // own reason, never merged into "failed on 2 background AI calls".
    act(() => {
      emit({ id: 'goal-decompose', phase: 'error', silent: true, background: false, providerId: 'prov-1', providerName: 'Example Provider', message: 'decompose failed: 401' });
      emit({ id: 'goal-checkin', phase: 'error', silent: true, background: false, providerId: 'prov-1', providerName: 'Example Provider', message: 'check-in failed: 401' });
    });

    const errs = errorCalls();
    expect(errs).toHaveLength(2);
    expect(errs.map(c => c.opts?.id).sort()).toEqual(['goal-checkin', 'goal-decompose']);
    expect(errs.map(c => c.message).sort()).toEqual(['check-in failed: 401', 'decompose failed: 401']);
    // None of them is the coalescing toast.
    expect(errs.some(c => /^ai-bg-error::/.test(c.opts?.id))).toBe(false);
  });

  it('counts DISTINCT operations, not error events — one op emitting two error events increments once', () => {
    renderHook(() => useAIStatusNotifications());

    // An LM Studio model-load failure emits an error phase, then the outer
    // callProviderAISimple emits the final error too — both with the SAME op id.
    act(() => {
      emit({ id: 'op-A', phase: 'error', silent: true, background: true, providerId: 'prov-1', providerName: 'Example Provider', message: 'Failed to load model' });
      emit({ id: 'op-A', phase: 'error', silent: true, background: true, providerId: 'prov-1', providerName: 'Example Provider', message: 'completion failed' });
      emit({ id: 'op-B', phase: 'error', silent: true, background: true, providerId: 'prov-1', providerName: 'Example Provider', message: 'Failed to load model' });
    });

    const errs = errorCalls();
    // Two distinct ops (A, B) → count 2, NOT 3 (op-A's second error is deduped).
    expect(errs[errs.length - 1].message).toBe('Example Provider failed on 2 background AI calls — Failed to load model');
  });

  it('coalesces background failures per-provider, not across providers', () => {
    renderHook(() => useAIStatusNotifications());

    act(() => {
      emit({ id: 'x1', phase: 'error', silent: true, background: true, providerId: 'prov-a', providerName: 'Provider A', message: 'a fail' });
      emit({ id: 'x2', phase: 'error', silent: true, background: true, providerId: 'prov-b', providerName: 'Provider B', message: 'b fail' });
      emit({ id: 'x3', phase: 'error', silent: true, background: true, providerId: 'prov-a', providerName: 'Provider A', message: 'a fail again' });
    });

    const errs = errorCalls();
    // Ids are provider-keyed (with a window-seq suffix): two distinct providers →
    // two distinct toasts, and prov-a's two failures share one id.
    const provAIds = new Set(errs.filter(c => /::prov-a::/.test(c.opts?.id)).map(c => c.opts?.id));
    const provBIds = new Set(errs.filter(c => /::prov-b::/.test(c.opts?.id)).map(c => c.opts?.id));
    expect(provAIds.size).toBe(1);
    expect(provBIds.size).toBe(1);

    const provA = errs.filter(c => /::prov-a::/.test(c.opts?.id));
    expect(provA[provA.length - 1].message).toBe('Provider A failed on 2 background AI calls — a fail');
  });

  it('coalesces SLOW background failures too — dismisses each orphan-prone spinner, collapses to one counted toast', () => {
    renderHook(() => useAIStatusNotifications());

    // Two background ops both cross the 2.5s slow threshold, so each opens its own
    // Infinity-duration loading spinner (a timeout / unreachable-endpoint burst).
    act(() => {
      emit({ id: 'slow-a', phase: 'start', silent: true, background: true, providerId: 'prov-1', providerName: 'Example Provider', message: 'Calling…' });
      emit({ id: 'slow-b', phase: 'start', silent: true, background: true, providerId: 'prov-1', providerName: 'Example Provider', message: 'Calling…' });
    });
    act(() => { vi.advanceTimersByTime(3000); });
    expect(toastCalls.filter(c => c.type === 'loading').map(c => c.opts?.id).sort()).toEqual(['slow-a', 'slow-b']);

    act(() => {
      emit({ id: 'slow-a', phase: 'error', silent: true, background: true, providerId: 'prov-1', providerName: 'Example Provider', message: 'endpoint timeout' });
      emit({ id: 'slow-b', phase: 'error', silent: true, background: true, providerId: 'prov-1', providerName: 'Example Provider', message: 'endpoint timeout' });
    });

    // Both orphan-prone spinners are dismissed by id (else they spin forever)...
    expect(dismissCalls().map(c => c.id).sort()).toEqual(['slow-a', 'slow-b']);
    // ...and the two slow failures collapse into ONE provider-keyed counted toast,
    // not two stacked red toasts — this is the exact flood the issue is about.
    const errs = errorCalls();
    const ids = new Set(errs.map(c => c.opts?.id));
    expect(ids.size).toBe(1);
    expect(errs[errs.length - 1].message).toBe('Example Provider failed on 2 background AI calls — endpoint timeout');
  });

  it('gives each fresh window a distinct toast id so a lapsed window cannot dismiss its successor', () => {
    renderHook(() => useAIStatusNotifications());

    act(() => {
      emit({ id: 'w1', phase: 'error', silent: true, background: true, providerId: 'prov-1', providerName: 'Example Provider', message: 'first' });
    });
    act(() => { vi.advanceTimersByTime(5000); }); // window lapses
    act(() => {
      emit({ id: 'w2', phase: 'error', silent: true, background: true, providerId: 'prov-1', providerName: 'Example Provider', message: 'second' });
    });

    const errs = errorCalls();
    // Same provider, two windows → two DIFFERENT toast ids (Toast never cancels a
    // prior add()'s auto-dismiss timer, so a reused id would let window 1's
    // pending dismissal remove window 2's toast).
    expect(errs[0].opts?.id).not.toBe(errs[errs.length - 1].opts?.id);
    expect(errs[0].opts?.id).toMatch(/^ai-bg-error::prov-1::/);
  });

  it('keeps the coalesced toast alive across staggered same-window failures until the window lapses after the LAST one', () => {
    renderHook(() => useAIStatusNotifications());

    act(() => {
      emit({ id: 's1', phase: 'error', silent: true, background: true, providerId: 'prov-1', providerName: 'Example Provider', message: 'first' });
    });
    // Second failure 3.5s later — still inside the 4s rolling window.
    act(() => { vi.advanceTimersByTime(3500); });
    act(() => {
      emit({ id: 's2', phase: 'error', silent: true, background: true, providerId: 'prov-1', providerName: 'Example Provider', message: 'second' });
    });
    const coalescedId = errorCalls()[0].opts?.id;

    // Coalesced toasts render with duration: Infinity, so Toast schedules no
    // auto-dismiss of its own. Advance to t=6 (where a stale per-add 6s timer
    // from the t=0 toast would have fired) — the toast must still be alive.
    act(() => { vi.advanceTimersByTime(2500); });
    expect(dismissCalls().some(c => c.id === coalescedId)).toBe(false);

    // The window is measured from the LAST failure (t=3.5), so it lapses at
    // t=7.5; advance past it and the hook dismisses exactly this window's toast.
    act(() => { vi.advanceTimersByTime(2000); });
    expect(dismissCalls().filter(c => c.id === coalescedId)).toHaveLength(1);
  });

  it('starts a fresh coalescing window after the previous one lapses', () => {
    renderHook(() => useAIStatusNotifications());

    act(() => {
      emit({ id: 'g1', phase: 'error', silent: true, background: true, providerId: 'prov-1', providerName: 'Example Provider', message: 'first reason' });
    });
    // Advance past the rolling window so the entry is cleaned up.
    act(() => { vi.advanceTimersByTime(5000); });
    act(() => {
      emit({ id: 'g2', phase: 'error', silent: true, background: true, providerId: 'prov-1', providerName: 'Example Provider', message: 'second reason' });
    });

    const errs = errorCalls();
    // Both are the first-in-window, so both show their real reason (count 1).
    expect(errs[0].message).toBe('first reason');
    expect(errs[errs.length - 1].message).toBe('second reason');
  });
});
