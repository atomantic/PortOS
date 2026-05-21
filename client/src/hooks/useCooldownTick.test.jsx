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
});
