import { useRef, useCallback } from 'react';

// Horizontal swipe ≥ 50px and dominantly horizontal (dx > dy × 1.2) — keeps
// diagonal scrolls from registering as nav but stays forgiving for thumb swipes.
const SWIPE_MIN_PX = 50;
const HORIZONTAL_BIAS = 1.2;

// Ignore touches whose start OR end target is an inline button: a tap on the
// surface (e.g. fullscreen toggle) shouldn't seed a swipe, and a swipe that
// happens to release over a button shouldn't double-fire as nav + a synthetic
// button click. Optional-chain on `closest` because touch targets aren't
// guaranteed to be Elements (e.g. Text nodes, jsdom-style envs).
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
    if (isButtonTouch(e)) { touchStart.current = { x: null, y: null }; return; }
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
