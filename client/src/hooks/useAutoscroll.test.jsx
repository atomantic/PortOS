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

  describe('fitToDuration (#4100)', () => {
    it('solves the speed from the SCROLLABLE travel, not the raw scrollHeight', () => {
      const { el } = makeContainer(); // 1000 tall in a 200 viewport → 800px of travel
      const ref = { current: el };
      const { result } = renderHook(() => useAutoscroll(ref, { initialPxPerSec: 30 }));

      let applied;
      act(() => { applied = result.current.fitToDuration(40); }); // 800 / 40
      expect(applied).toBe(20);
      expect(result.current.pxPerSec).toBe(20);

      // And it really takes that long: run the loop in 0.5s frames (the hook's
      // own tab-suspend clamp) until it auto-stops at the bottom. 40s wall clock
      // is the whole point — pricing the viewport in (1000/40 = 25px/s) would
      // arrive a full screenful early, at 32s.
      act(() => result.current.toggle());
      let ts = 0;
      act(() => flush(ts));
      while (result.current.playing && ts < 120_000) {
        ts += 500;
        act(() => flush(ts));
      }
      expect(result.current.playing).toBe(false);
      expect(ts).toBe(40_000);
    });

    it('clamps into the caller-supplied speed bounds', () => {
      const { el } = makeContainer();
      const ref = { current: el };
      const { result } = renderHook(() => useAutoscroll(ref, { minPxPerSec: 5, maxPxPerSec: 150 }));

      // 800px in an hour would be 0.2px/s — floored at the slider's minimum.
      let slow;
      act(() => { slow = result.current.fitToDuration(3600); });
      expect(slow).toBe(5);
      expect(result.current.pxPerSec).toBe(5);

      // 800px in 1s would be 800px/s — capped at the slider's maximum.
      let fast;
      act(() => { fast = result.current.fitToDuration(1); });
      expect(fast).toBe(150);
      expect(result.current.pxPerSec).toBe(150);
    });

    it('returns null and leaves the speed alone when there is nothing to scroll', () => {
      const { el } = makeContainer();
      el.scrollHeight = 200; // content fits the viewport exactly → zero travel
      const ref = { current: el };
      const { result } = renderHook(() => useAutoscroll(ref, { initialPxPerSec: 30 }));

      let applied;
      act(() => { applied = result.current.fitToDuration(60); });
      expect(applied).toBe(null);
      expect(result.current.pxPerSec).toBe(30);
    });

    it('returns null for a missing container or a non-positive/non-finite duration', () => {
      const { el } = makeContainer();
      const detached = renderHook(() => useAutoscroll({ current: null }));
      act(() => { expect(detached.result.current.fitToDuration(60)).toBe(null); });

      const { result } = renderHook(() => useAutoscroll({ current: el }, { initialPxPerSec: 30 }));
      for (const bad of [0, -60, NaN, Infinity, null, undefined, '60']) {
        act(() => { expect(result.current.fitToDuration(bad), String(bad)).toBe(null); });
      }
      expect(result.current.pxPerSec).toBe(30);
    });
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
