import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useAutoscroll from './useAutoscroll.js';

// Manual rAF pump — collect scheduled callbacks and flush them with explicit
// timestamps so scroll advancement is deterministic.
let rafCallbacks;
let cancelled;

const flush = (ts) => {
  const cbs = rafCallbacks;
  rafCallbacks = [];
  cbs.forEach((cb) => cb(ts));
};

const makeContainer = () => {
  const listeners = {};
  return {
    el: {
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 200,
      addEventListener: (ev, fn) => { listeners[ev] = fn; },
      removeEventListener: (ev) => { delete listeners[ev]; },
    },
    listeners,
  };
};

describe('useAutoscroll', () => {
  beforeEach(() => {
    rafCallbacks = [];
    cancelled = [];
    vi.stubGlobal('requestAnimationFrame', (cb) => { rafCallbacks.push(cb); return rafCallbacks.length; });
    vi.stubGlobal('cancelAnimationFrame', (id) => { cancelled.push(id); });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('advances scrollTop by pxPerSec while playing', () => {
    const { el } = makeContainer();
    const ref = { current: el };
    const { result } = renderHook(() => useAutoscroll(ref, { initialPxPerSec: 100 }));

    expect(result.current.playing).toBe(false);
    act(() => result.current.toggle());
    expect(result.current.playing).toBe(true);

    act(() => flush(0));    // first frame establishes lastTs
    act(() => flush(100));  // 0.1s at 100px/s → 10px
    act(() => flush(200));  // another 10px
    expect(el.scrollTop).toBe(20);
  });

  it('applies live speed changes without restarting the loop', () => {
    const { el } = makeContainer();
    const ref = { current: el };
    const { result } = renderHook(() => useAutoscroll(ref, { initialPxPerSec: 100 }));
    act(() => result.current.toggle());
    act(() => flush(0));
    act(() => result.current.setPxPerSec(200));
    act(() => flush(100)); // 0.1s at 200px/s → 20px
    expect(el.scrollTop).toBe(20);
  });

  it('auto-stops at the bottom', () => {
    const { el } = makeContainer();
    const ref = { current: el };
    const { result } = renderHook(() => useAutoscroll(ref, { initialPxPerSec: 100 }));
    act(() => result.current.toggle());
    el.scrollTop = 795; // bottom threshold = 1000 - 200 - 1 = 799
    act(() => flush(0));
    act(() => flush(100)); // +10px → 805 ≥ 799 → stop
    expect(result.current.playing).toBe(false);
    // No further frames scheduled after the stop path returned.
    expect(rafCallbacks.length).toBe(0);
  });

  it('pauses when the user wheels/touch-drags the container', () => {
    const { el, listeners } = makeContainer();
    const ref = { current: el };
    const { result } = renderHook(() => useAutoscroll(ref));
    act(() => result.current.toggle());
    expect(typeof listeners.wheel).toBe('function');
    expect(typeof listeners.touchmove).toBe('function');
    act(() => listeners.wheel());
    expect(result.current.playing).toBe(false);
    // Listeners detach while paused.
    expect(listeners.wheel).toBeUndefined();
  });

  it('cancels the rAF loop on unmount', () => {
    const { el } = makeContainer();
    const ref = { current: el };
    const { result, unmount } = renderHook(() => useAutoscroll(ref));
    act(() => result.current.toggle());
    expect(rafCallbacks.length).toBe(1);
    unmount();
    expect(cancelled.length).toBeGreaterThan(0);
  });
});
