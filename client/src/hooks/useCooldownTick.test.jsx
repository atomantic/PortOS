import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCooldownTick } from './useCooldownTick';

describe('useCooldownTick', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not start an interval when no cooldowns are active', () => {
    const onAllExpired = vi.fn();
    renderHook(() => useCooldownTick({ cooldownEnds: {}, onAllExpired }));

    act(() => vi.advanceTimersByTime(5_000));
    expect(onAllExpired).not.toHaveBeenCalled();
  });

  it('treats already-elapsed deadlines as no active cooldown', () => {
    const onAllExpired = vi.fn();
    const past = Date.now() - 1_000;
    renderHook(() => useCooldownTick({ cooldownEnds: { x: past }, onAllExpired }));

    act(() => vi.advanceTimersByTime(5_000));
    expect(onAllExpired).not.toHaveBeenCalled();
  });

  it('fires onAllExpired exactly once when every cooldown crosses its deadline', () => {
    const onAllExpired = vi.fn();
    const now = Date.now();
    renderHook(() => useCooldownTick({
      cooldownEnds: { a: now + 2_500, b: now + 1_500 },
      onAllExpired,
    }));

    act(() => vi.advanceTimersByTime(1_000));
    expect(onAllExpired).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(2_000));
    expect(onAllExpired).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(5_000));
    expect(onAllExpired).toHaveBeenCalledTimes(1);
  });

  it('reads the latest onAllExpired closure when it fires', () => {
    const first = vi.fn();
    const second = vi.fn();
    const now = Date.now();
    const props = { cooldownEnds: { a: now + 2_000 }, onAllExpired: first };
    const { rerender } = renderHook((p) => useCooldownTick(p), { initialProps: props });

    rerender({ ...props, onAllExpired: second });

    act(() => vi.advanceTimersByTime(3_000));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('clears the interval on unmount', () => {
    const onAllExpired = vi.fn();
    const now = Date.now();
    const { unmount } = renderHook(() => useCooldownTick({
      cooldownEnds: { a: now + 3_000 },
      onAllExpired,
    }));

    unmount();
    act(() => vi.advanceTimersByTime(5_000));
    expect(onAllExpired).not.toHaveBeenCalled();
  });

  it('restarts the interval when cooldownEnds gains a new active entry', () => {
    const onAllExpired = vi.fn();
    const { rerender } = renderHook(
      (p) => useCooldownTick(p),
      { initialProps: { cooldownEnds: {}, onAllExpired } },
    );

    act(() => vi.advanceTimersByTime(2_000));
    expect(onAllExpired).not.toHaveBeenCalled();

    rerender({ cooldownEnds: { a: Date.now() + 1_500 }, onAllExpired });
    act(() => vi.advanceTimersByTime(2_000));
    expect(onAllExpired).toHaveBeenCalledTimes(1);
  });

  it('does not crash when onAllExpired is omitted', () => {
    renderHook(() => useCooldownTick({ cooldownEnds: { a: Date.now() + 1_000 } }));

    expect(() => act(() => vi.advanceTimersByTime(2_000))).not.toThrow();
  });

  it('does not crash when called with no options (defaults to no active cooldowns)', () => {
    // Regression guard: useCooldownTick() used to destructure required
    // fields and throw before React could surface the misuse. The hook
    // now defaults `options` to `{}` and `cooldownEnds` to `{}`, so a
    // missing-args call is harmless — same steady state as "no active
    // cooldowns" (no interval armed, callback never fires).
    expect(() => renderHook(() => useCooldownTick())).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the interval after the expiry tick even if the caller never updates cooldownEnds', () => {
    // Regression guard for Copilot review on PR #422: a no-op onAllExpired
    // (or a network error in the caller) must not leave the 1s interval
    // re-rendering forever after the deadline passes. Callers in
    // OverviewTab/ToolsTab/WorldTab hold `cooldownEnds` in useState so the
    // reference is stable across the internal `setTick` re-renders; the
    // expected steady state after expiry is "no live timers."
    const onAllExpired = vi.fn();
    const cooldownEnds = { a: Date.now() + 1_500 };
    renderHook(() => useCooldownTick({ cooldownEnds, onAllExpired }));

    expect(vi.getTimerCount()).toBe(1);

    act(() => vi.advanceTimersByTime(2_000));
    expect(onAllExpired).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    // Advance well past any further 1s tick — no second interval armed,
    // callback stays at 1.
    act(() => vi.advanceTimersByTime(30_000));
    expect(onAllExpired).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
