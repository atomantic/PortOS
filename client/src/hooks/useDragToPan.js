import { useCallback, useRef, useState } from 'react';
import { isTapGesture } from '../lib/graphPicking';

/**
 * Shared drag-to-pan gesture: a mouse-only pointer drag scrolls a surface by
 * writing `scrollLeft`/`scrollTop` directly (the pane's own scroll position
 * IS the viewport, so no transform or `scrollIntoView` cost). A drag under
 * `slop` px reads as a tap/click and never touches scroll; a drag past it
 * pans, and the pan swallows the click that would otherwise fire on release
 * (`panProps.onClickCapture`) so ending over a button doesn't activate it.
 *
 * `canStart(event)` lets a caller opt a gesture out before it's claimed — an
 * interactive child (ModelComparison's `closest('button, input, …')`) or
 * another gesture that already owns this pointerdown (LoomCanvas asks its own
 * node-drag `dragRef`). `onPanEnd(moved)` lets a caller fold this gesture's
 * "did it drag" signal into its own combined click-suppression ref when it
 * has more than one drag source landing on the same surface.
 */
export default function useDragToPan({
  enabled = true,
  axis = 'both',
  slop,
  canStart,
  onPanEnd,
} = {}) {
  const surfaceRef = useRef(null);
  const gestureRef = useRef(null);
  const pannedRef = useRef(false);
  const [isPanning, setIsPanning] = useState(false);

  const onPointerDown = useCallback((event) => {
    if (!enabled || event.pointerType !== 'mouse' || event.button !== 0) return;
    if (canStart && !canStart(event)) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    surface.setPointerCapture?.(event.pointerId);
    gestureRef.current = {
      start: { x: event.clientX, y: event.clientY },
      scrollLeft: surface.scrollLeft,
      scrollTop: surface.scrollTop,
      moved: false,
    };
  }, [enabled, canStart]);

  const onPointerMove = useCallback((event) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    const point = { x: event.clientX, y: event.clientY };
    if (!gesture.moved) {
      if (isTapGesture(gesture.start, point, slop)) return;
      gesture.moved = true;
      setIsPanning(true);
    }
    const surface = surfaceRef.current;
    if (!surface) return;
    if (axis !== 'y') surface.scrollLeft = gesture.scrollLeft - (point.x - gesture.start.x);
    if (axis !== 'x') surface.scrollTop = gesture.scrollTop - (point.y - gesture.start.y);
  }, [axis, slop]);

  const endPan = useCallback(() => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (!gesture?.moved) return;
    pannedRef.current = true;
    setIsPanning(false);
    onPanEnd?.(true);
  }, [onPanEnd]);

  const onClickCapture = useCallback((event) => {
    if (!pannedRef.current) return;
    pannedRef.current = false;
    event.stopPropagation();
  }, []);

  return {
    surfaceRef,
    panProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endPan,
      onPointerCancel: endPan,
      onClickCapture,
    },
    panned: pannedRef,
    isPanning,
  };
}
