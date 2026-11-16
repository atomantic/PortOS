/**
 * `{ hoveredNode, tooltipPos, handleHover, handlePointerMove }` for a canvas hover tooltip.
 *
 * `handlePointerMove` drops any move that cannot paint a tooltip (nothing hovered, or a touch pointer, where it is `pointer-coarse:hidden`). Use for any 3D graph/canvas view with a cursor-following tooltip (BrainGraph): pass `{ x: e.clientX, y: e.clientY }` to `handleHover` from the mesh's `onPointerOver` so the first frame is placed.
 */

import { useCallback, useRef, useState } from 'react';

/**
 * Hover-tooltip bookkeeping for a 3D graph canvas: which node is hovered and where its floating tooltip sits. The point is the *gate*: a bare `onPointerMove={(e) => setTooltipPos(...)}` re-renders the owner on every pixel of movement though no tooltip shows for most moves (and on a coarse pointer it is `pointer-coarse:hidden`), so `handlePointerMove` drops any move that cannot paint.
 *
 * The gate reads a REF, not the `hoveredNode` state, which is load-bearing: r3f raycasts on the Canvas' inner div while React delegates `onPointerMove` at the app root, so on the event where the pointer enters a node the closure still sees the PREVIOUS state (`null`) and would skip the position update, stranding the tooltip where it last painted.
 * `handleHover` writes the ref synchronously and seeds `tooltipPos` from the enter event's coordinates, so the first frame is placed even if no move follows.
 */
export default function useHoverTooltip() {
  const [hoveredNode, setHoveredNode] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  // Mirrors hoveredNode for the pointer-move gate, which runs before state flushes.
  const hoveredRef = useRef(null);

  // `point` is optional: pass `{ x, y }` (client coords) from the enter event so
  // the tooltip's first paint lands under the cursor.
  const handleHover = useCallback((node, point) => {
    hoveredRef.current = node;
    setHoveredNode(node);
    if (node && point) setTooltipPos({ x: point.x, y: point.y });
  }, []);

  const handlePointerMove = useCallback((e) => {
    if (!hoveredRef.current) return;
    // A touch move can never show the tooltip — it is `pointer-coarse:hidden`,
    // and a finger has no hover to preview with.
    if (e.pointerType === 'touch') return;
    setTooltipPos({ x: e.clientX, y: e.clientY });
  }, []);

  return { hoveredNode, tooltipPos, handleHover, handlePointerMove };
}
