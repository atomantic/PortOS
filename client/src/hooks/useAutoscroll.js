import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Smooth autoscroll for a scrollable container (SongBook play view, or any
 * "teleprompter" surface): a requestAnimationFrame loop advances
 * `container.scrollTop` by `pxPerSec`. Behavior contract:
 *
 * - Auto-stops (pauses) when the container reaches the bottom.
 * - A user wheel or touchmove on the container pauses playback — manual
 *   scrolling always wins; the user resumes explicitly.
 * - Speed changes apply live (read through a ref) without restarting the loop.
 * - rAF is cancelled and listeners detach on pause/unmount; a `mountedRef`
 *   guards the auto-stop setState so a frame that lands after unmount is inert.
 *
 * containerRef — ref to the scrollable element (must have overflow-y-auto).
 * Returns { playing, toggle, stop, pxPerSec, setPxPerSec }.
 */
export default function useAutoscroll(containerRef, { initialPxPerSec = 30 } = {}) {
  const [playing, setPlaying] = useState(false);
  const [pxPerSec, setPxPerSec] = useState(initialPxPerSec);
  const pxPerSecRef = useRef(pxPerSec);
  pxPerSecRef.current = pxPerSec;

  // Reset to true in setup, not just initialized: StrictMode dev runs effects
  // setup→cleanup→setup on the same instance (refs persist), so a cleanup-only
  // guard would stay false forever and wheel-pause / bottom-stop would no-op.
  // (The CLAUDE.md "never reset to true" rule is for deferred network emits,
  // where staying false is the safe direction — here it gates live UI.)
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!playing) return undefined;
    const el = containerRef.current;
    if (!el) return undefined;

    let rafId = null;
    let lastTs = null;
    // Fractional-pixel accumulator: scrollTop assignment can round on some
    // engines, so slow speeds (< 1px/frame) would otherwise never move.
    let carry = 0;

    const step = (ts) => {
      if (lastTs != null) {
        const dt = Math.min((ts - lastTs) / 1000, 0.5); // clamp tab-suspend gaps
        carry += pxPerSecRef.current * dt;
        const whole = Math.floor(carry);
        if (whole >= 1) {
          el.scrollTop += whole;
          carry -= whole;
        }
        // Bottom reached (±1px slack for fractional layout heights) → auto-stop.
        if (el.scrollTop >= el.scrollHeight - el.clientHeight - 1) {
          if (mountedRef.current) setPlaying(false);
          return;
        }
      }
      lastTs = ts;
      rafId = requestAnimationFrame(step);
    };

    // Manual scroll intent pauses playback; the passive flag keeps native
    // scrolling responsive (we never preventDefault).
    const pause = () => { if (mountedRef.current) setPlaying(false); };
    el.addEventListener('wheel', pause, { passive: true });
    el.addEventListener('touchmove', pause, { passive: true });

    rafId = requestAnimationFrame(step);
    return () => {
      if (rafId != null) cancelAnimationFrame(rafId);
      el.removeEventListener('wheel', pause);
      el.removeEventListener('touchmove', pause);
    };
  }, [playing, containerRef]);

  const toggle = useCallback(() => setPlaying((p) => !p), []);
  const stop = useCallback(() => setPlaying(false), []);

  return { playing, toggle, stop, pxPerSec, setPxPerSec };
}
