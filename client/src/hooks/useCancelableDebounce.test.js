import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useCancelableDebounce from './useCancelableDebounce.js';

// The mechanism behind #8187: a debounced state→URL mirror armed well before
// a navigation must not be free to fire AFTER that navigation and clobber
// it. React's own effect-cleanup-on-unmount is not sufficient — it runs
// asynchronously relative to a synchronous `navigate()` call, leaving a
// window under load. `cancel()` closes that window by letting a call site
// drop the pending callback synchronously, in the same tick as the
// navigation, rather than waiting on unmount.
describe('useCancelableDebounce', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fires the scheduled callback after the delay elapses', () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useCancelableDebounce());
    const [schedule] = result.current;

    act(() => { schedule(fn, 300); });
    expect(fn).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(300); });
    expect(fn).toHaveBeenCalledOnce();
  });

  it('never fires a callback cancelled before its delay elapses, even after the delay passes', () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useCancelableDebounce());
    const [schedule, cancel] = result.current;

    act(() => { schedule(fn, 300); });
    act(() => { cancel(); });
    act(() => { vi.advanceTimersByTime(1000); });

    expect(fn).not.toHaveBeenCalled();
  });

  it('replaces a still-pending call when scheduled again, running only the latest', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result } = renderHook(() => useCancelableDebounce());
    const [schedule] = result.current;

    act(() => { schedule(first, 300); });
    act(() => { vi.advanceTimersByTime(150); });
    act(() => { schedule(second, 300); });
    act(() => { vi.advanceTimersByTime(300); });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it('cancels a pending call on unmount as a safety net for the ordinary case', () => {
    const fn = vi.fn();
    const { result, unmount } = renderHook(() => useCancelableDebounce());
    const [schedule] = result.current;

    act(() => { schedule(fn, 300); });
    unmount();
    act(() => { vi.advanceTimersByTime(1000); });

    expect(fn).not.toHaveBeenCalled();
  });
});
