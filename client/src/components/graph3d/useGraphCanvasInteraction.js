import { useCallback, useRef } from 'react';
import useHoverTooltip from '../../hooks/useHoverTooltip';
import useFirstTouchHint from '../../hooks/useFirstTouchHint';
import { isTapGesture } from '../../lib/graphPicking';

// Only a gesture on the WebGL canvas itself picks or clears a node. The
// overlay chrome — "Clear selection", the legend toggle, the loading veil —
// sits INSIDE the same wrapper these handlers are bound to, so its taps
// bubble there too; without this, tapping the legend toggle could also
// select or clear whichever node happens to project nearest that corner.
// (r3f binds its own listeners to the canvas, so the mouse path never had
// this problem.)
const isCanvasGesture = (e) => e.target?.tagName === 'CANVAS';

/**
 * Pointer/tap/tooltip wiring shared by the 3D graph scenes (BrainGraph,
 * MemoryGraph): tells a canvas tap from an orbit drag, resolves a touch tap
 * to the nearest node via the wrapper-owned screen-space pick (see
 * lib/graphPicking.js and GraphScene's `pickRef`), and tracks the hover
 * tooltip position.
 *
 * `onSelect` is called with the picked node to select it, or `null` to clear
 * the selection — the same null-safe contract each page's own `handleSelect`
 * already implements for a plain mesh click.
 *
 * Returns the refs GraphScene needs (`pickRef`, `touchGestureRef`) plus the
 * handlers to wire onto the canvas wrapper div (`onPointerDown`,
 * `onPointerUp`, `onPointerMove`) and the `<Canvas onPointerMissed>` itself.
 */
export default function useGraphCanvasInteraction({ onSelect }) {
  const dragStartRef = useRef(null);
  // Set by GraphScene: (point in canvas-local px) => node | null.
  const pickRef = useRef(null);
  // True while the in-flight gesture came from a finger, so the mesh raycast
  // and onPointerMissed can stand down for the threshold pick below.
  const touchGestureRef = useRef(false);
  const { hoveredNode, tooltipPos, handleHover, handlePointerMove } = useHoverTooltip();
  const { visible: touchHintVisible, showOnFirstTouch } = useFirstTouchHint();

  const handlePointerDown = useCallback((e) => {
    if (!isCanvasGesture(e)) return;
    showOnFirstTouch(e);
    // A second finger is a pinch-zoom or two-finger pan, never a tap — drop the
    // recorded start so neither the threshold pick nor the miss-clear can fire
    // for it (both gate on `isTapGesture`, which is false without a start).
    const secondFinger = touchGestureRef.current && !e.isPrimary;
    dragStartRef.current = secondFinger ? null : { x: e.clientX, y: e.clientY };
    touchGestureRef.current = e.pointerType === 'touch';
  }, [showOnFirstTouch]);

  // Touch selection. The raw mesh raycast needs the ray to hit a ~10px sphere;
  // instead project every node and take the nearest within a finger-sized
  // radius (see lib/graphPicking.js). Runs on `pointerup` on the wrapper, which
  // bubbles after the canvas' own pointerup and before the `click` r3f picks
  // with — so this result is what sticks. Mouse input is untouched.
  const handlePointerUp = useCallback((e) => {
    if (!touchGestureRef.current || !isCanvasGesture(e)) return;
    const end = { x: e.clientX, y: e.clientY };
    if (!isTapGesture(dragStartRef.current, end)) return; // an orbit drag
    // The CANVAS rect, not the wrapper's: the wrapper carries a 1px border, and
    // r3f's `size` measures the canvas, so mixing the two shifts every
    // projected position against the tap.
    const rect = e.target.getBoundingClientRect();
    const picked = pickRef.current?.({ x: end.x - rect.left, y: end.y - rect.top }) ?? null;
    onSelect(picked);
  }, [onSelect]);

  // Mouse only: a touch tap is resolved by handlePointerUp above (which also
  // owns clearing on an empty-space tap), and would otherwise be undone here by
  // the compatibility `click` r3f fires afterwards.
  const handlePointerMissed = useCallback((e) => {
    if (touchGestureRef.current) return;
    if (isTapGesture(dragStartRef.current, { x: e.clientX, y: e.clientY })) {
      onSelect(null);
    }
  }, [onSelect]);

  return {
    pickRef,
    touchGestureRef,
    hoveredNode,
    tooltipPos,
    handleHover,
    handlePointerMove,
    touchHintVisible,
    handlePointerDown,
    handlePointerUp,
    handlePointerMissed
  };
}
