/**
 * `{ visible, showOnFirstTouch }` — reveals a brief one-time touch gesture hint, then auto-hides it.
 *
 * Use when: 3D canvases whose primary one-finger gesture needs an initial explanation.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export const FIRST_TOUCH_HINT_DURATION_MS = 2500;

/**
 * Shows a short-lived hint once, when a canvas first receives a touch gesture.
 *
 * Canvas controls intentionally use `touch-action: none`, so a first finger
 * drag rotates the scene instead of scrolling the page. Keeping this state in
 * one hook makes that gesture explicit without changing the control itself.
 */
export default function useFirstTouchHint({ durationMs = FIRST_TOUCH_HINT_DURATION_MS } = {}) {
  const [visible, setVisible] = useState(false);
  const shownRef = useRef(false);
  const timeoutRef = useRef(null);

  useEffect(() => () => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
  }, []);

  const showOnFirstTouch = useCallback((event) => {
    if (event.pointerType !== 'touch' || shownRef.current) return;
    shownRef.current = true;
    setVisible(true);
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null;
      setVisible(false);
    }, durationMs);
  }, [durationMs]);

  return { visible, showOnFirstTouch };
}
