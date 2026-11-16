/**
 * rAF autoscroll for a scrollable container: advances `scrollTop` by `pxPerSec`, auto-stops at the
 * bottom, pauses on user wheel/touchmove, live speed changes via ref.
 *
 * `fitToDuration(sec)` solves the speed for a target run time from the measured scroll travel (returns
 * the applied px/s, or `null` when there is nothing to scroll). Returns `{ playing, toggle, stop,
 * pxPerSec, setPxPerSec, fitToDuration }`. Use when: SongBook play view; any teleprompter-style
 * surface.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import useMounted from './useMounted';

/**
 * Smooth autoscroll for a scrollable container (SongBook play view, any "teleprompter" surface): a requestAnimationFrame loop advances `container.scrollTop` by `pxPerSec`. Contract:
 * - Auto-stops at the bottom; a user wheel/touchmove pauses playback (manual scrolling wins; the user resumes explicitly).
 * - Speed changes apply live via a ref without restarting the loop; rAF is cancelled and listeners detach on pause/unmount, and `mountedRef` makes a frame after unmount inert.
 * - `fitToDuration(seconds)` solves the speed for a target run time instead of asking the user to guess px/s.
 *
 * containerRef must be the scrollable element (overflow-y-auto). minPxPerSec / maxPxPerSec bound what `fitToDuration` may set; pass the speed control's bounds so a fitted speed is representable.
 *
 * Returns { playing, toggle, stop, pxPerSec, setPxPerSec, fitToDuration }.
 */
export default function useAutoscroll(
  containerRef,
  { initialPxPerSec = 30, minPxPerSec = 1, maxPxPerSec = Number.MAX_SAFE_INTEGER } = {},
) {
  const [playing, setPlaying] = useState(false);
  const [pxPerSec, setPxPerSec] = useState(initialPxPerSec);
  const pxPerSecRef = useRef(pxPerSec);
  pxPerSecRef.current = pxPerSec;

  // Gates the auto-stop setState so a rAF frame that lands after unmount is
  // inert. (The AGENTS.md "never reset to true" rule is for deferred network
  // emits, where staying false is the safe direction — here it gates live UI.)
  const mountedRef = useMounted();

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

  /**
   * "Fit to duration": set the speed so the container scrolls from its current TOP to its bottom in `durationSec`. The distance is `scrollHeight - clientHeight` (scrollable travel), since the loop stops at
   * the bottom and pricing in the viewport would finish a screenful early. Measured at call time (font size, transpose re-wrap, orientation flip), so callers re-fit after anything that reflows rather than caching.
   * Rounded to whole px/s and clamped into [minPxPerSec, maxPxPerSec] so the caller's speed control can display it; a clamped fit takes longer/shorter than asked, which the caller detects by comparing against its bounds.
   *
   * @param {number} durationSec target seconds for the full scroll
   * @returns {number|null} the applied px/s, or null when there is nothing to
   *   fit — no container, a non-positive/non-finite duration, or content that
   *   already fits on screen (zero travel). Null is the "couldn't fit" sentinel,
   *   never a silent no-op at some default speed.
   */
  const fitToDuration = useCallback((durationSec) => {
    const el = containerRef.current;
    if (!el || !Number.isFinite(durationSec) || durationSec <= 0) return null;
    const distance = el.scrollHeight - el.clientHeight;
    if (distance <= 0) return null;
    const fitted = Math.min(maxPxPerSec, Math.max(minPxPerSec, Math.round(distance / durationSec)));
    setPxPerSec(fitted);
    return fitted;
  }, [containerRef, minPxPerSec, maxPxPerSec]);

  return { playing, toggle, stop, pxPerSec, setPxPerSec, fitToDuration };
}
