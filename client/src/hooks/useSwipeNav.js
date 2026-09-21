import { useRef, useCallback } from 'react';

// Horizontal swipe ≥ 50px and dominantly horizontal (dx > dy × 1.2) — keeps
// diagonal scrolls from registering as nav but stays forgiving for thumb swipes.
const SWIPE_MIN_PX = 50;
const HORIZONTAL_BIAS = 1.2;
const EMPTY_TOUCH_START = { x: null, y: null };

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
const isViewportZoomed = () => {
  const scale = globalThis.visualViewport?.scale;
  return typeof scale === 'number' && scale > 1;
};

export function useSwipeNav({ onPrevious, onNext, hasPrevious = false, hasNext = false } = {}) {
  const touchStart = useRef(EMPTY_TOUCH_START);

  const resetTouchStart = useCallback(() => {
    touchStart.current = EMPTY_TOUCH_START;
  }, []);

  const onTouchStart = useCallback((e) => {
    // A second finger must cancel the one-finger gesture. Otherwise iOS can
    // report the end of a pinch as a long horizontal swipe and change the
    // preview while the user is zooming it.
    if (e.touches?.length !== 1 || isButtonTouch(e) || isViewportZoomed()) {
      touchStart.current = EMPTY_TOUCH_START;
      return;
    }
    const t = e.touches[0];
    if (!t) { touchStart.current = EMPTY_TOUCH_START; return; }
    touchStart.current = { x: t.clientX, y: t.clientY };
  }, []);

  const onTouchEnd = useCallback((e) => {
    const start = touchStart.current;
    if (start.x == null) return;
    // Ignore the first finger leaving a multi-touch gesture, and any pan
    // after the browser has zoomed the visual viewport. The latter is how a
    // user inspects the enlarged image without accidentally navigating away.
    if ((e.touches?.length || 0) > 0 || isViewportZoomed()) {
      touchStart.current = EMPTY_TOUCH_START;
      return;
    }
    const end = e.changedTouches[0];
    if (!end) { touchStart.current = EMPTY_TOUCH_START; return; }
    const dx = end.clientX - start.x;
    const dy = end.clientY - start.y;
    touchStart.current = EMPTY_TOUCH_START;
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) <= Math.abs(dy) * HORIZONTAL_BIAS) return;
    if (dx > 0 && hasPrevious) onPrevious?.();
    else if (dx < 0 && hasNext) onNext?.();
  }, [hasPrevious, hasNext, onPrevious, onNext]);

  return { onTouchStart, onTouchEnd, onTouchCancel: resetTouchStart };
}
