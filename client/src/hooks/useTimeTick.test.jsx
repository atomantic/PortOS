import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTimeTick, __resetTimeTickForTests } from './useTimeTick';

describe('useTimeTick', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetTimeTickForTests();
  });

  afterEach(() => {
    __resetTimeTickForTests();
    vi.useRealTimers();
  });

  it('returns the current Date.now() initially', () => {
    vi.setSystemTime(new Date('2026-05-21T12:00:00Z'));
    const { result } = renderHook(() => useTimeTick(60000));
    expect(result.current).toBe(Date.parse('2026-05-21T12:00:00Z'));
  });

  it('re-renders at the configured interval with a fresh now value', () => {
    vi.setSystemTime(new Date('2026-05-21T12:00:00Z'));
    const { result } = renderHook(() => useTimeTick(60000));
    const initial = result.current;

    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(result.current).toBeGreaterThan(initial);
    expect(result.current).toBe(initial + 60000);
  });

  it('subscribers at the same intervalMs share one underlying setInterval', () => {
    const intervalSpy = vi.spyOn(window, 'setInterval');

    const a = renderHook(() => useTimeTick(60000));
    const b = renderHook(() => useTimeTick(60000));
    const c = renderHook(() => useTimeTick(60000));

    const calls60s = intervalSpy.mock.calls.filter(([, ms]) => ms === 60000);
    expect(calls60s).toHaveLength(1);

    a.unmount();
    b.unmount();
    c.unmount();

    intervalSpy.mockRestore();
  });

  it('subscribers at different intervalMs each get their own timer', () => {
    const intervalSpy = vi.spyOn(window, 'setInterval');

    renderHook(() => useTimeTick(60000));
    renderHook(() => useTimeTick(1000));

    expect(intervalSpy.mock.calls.filter(([, ms]) => ms === 60000)).toHaveLength(1);
    expect(intervalSpy.mock.calls.filter(([, ms]) => ms === 1000)).toHaveLength(1);

    intervalSpy.mockRestore();
  });

  it('clears the underlying timer when the last subscriber unmounts', () => {
    const clearSpy = vi.spyOn(window, 'clearInterval');

    const a = renderHook(() => useTimeTick(60000));
    const b = renderHook(() => useTimeTick(60000));

    a.unmount();
    expect(clearSpy).not.toHaveBeenCalled();

    b.unmount();
    expect(clearSpy).toHaveBeenCalledTimes(1);

    clearSpy.mockRestore();
  });
});
