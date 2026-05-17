import { useRef, useCallback } from 'react';

// Horizontal swipe ≥ 50px and dominantly horizontal (dx > dy × 1.2) — keeps
// diagonal scrolls from registering as nav but stays forgiving for thumb swipes.
const SWIPE_MIN_PX = 50;
const HORIZONTAL_BIAS = 1.2;

// Ignore touches that *originate* on an inline button so a tap on the
// surface (e.g. the fullscreen toggle) isn't seeded as a swipe-start. The
// gate runs only on touchstart: `Touch.target` on a touchend event is the
// element the touch *began* on (per spec), not where the finger released —
// so a symmetrical check in onTouchEnd would just re-check the start
// element. We don't gate on the end position either: a deliberate swipe
// crossing SWIPE_MIN_PX won't synthesize a click on a button the finger
// happens to release over (the browser's tap-slop is much smaller than
// 50px), so nav-on-release-over-button is safe to allow.
// Optional-chain on `closest` because touch targets aren't guaranteed to
// be Elements (e.g. Text nodes, jsdom-style envs).
const isButtonTouch = (e) => !!e.target?.closest?.('button');

export function useSwipeNav({ onPrevious, onNext, hasPrevious = false, hasNext = false } = {}) {
  const touchStart = useRef({ x: null, y: null });

  const onTouchStart = useCallback((e) => {
    if (isButtonTouch(e)) { touchStart.current = { x: null, y: null }; return; }
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY };
  }, []);

  const onTouchEnd = useCallback((e) => {
    const start = touchStart.current;
    if (start.x == null) return;
    const end = e.changedTouches[0];
    const dx = end.clientX - start.x;
    const dy = end.clientY - start.y;
    touchStart.current = { x: null, y: null };
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) <= Math.abs(dy) * HORIZONTAL_BIAS) return;
    if (dx > 0 && hasPrevious) onPrevious?.();
    else if (dx < 0 && hasNext) onNext?.();
  }, [hasPrevious, hasNext, onPrevious, onNext]);

  return { onTouchStart, onTouchEnd };
}
