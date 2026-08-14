import { useCallback, useRef, useState } from 'react';

/**
 * Hover-tooltip bookkeeping for a 3D graph canvas: which node is hovered, and
 * where its floating tooltip should sit.
 *
 * The point of the hook is the *gate*. A canvas container that tracks the
 * cursor with a bare `onPointerMove={(e) => setTooltipPos(...)}` re-renders its
 * owner on every pixel of movement, even though no tooltip is showing for the
 * overwhelming majority of those moves — and on a coarse pointer the tooltip is
 * hidden outright (`pointer-coarse:hidden`), so the work is 100% waste on the
 * weakest hardware. `handlePointerMove` drops any move that cannot paint.
 *
 * The gate reads a REF, not the `hoveredNode` state, and that is load-bearing:
 * react-three-fiber raycasts on the Canvas' own inner div while React delegates
 * the container's `onPointerMove` at the app root, so on the very event where
 * the pointer enters a node the move handler's closure still sees the PREVIOUS
 * render's state (`null`) and would skip the position update the tooltip needs
 * on its first frame — stranding it wherever it last painted. `handleHover`
 * writes the ref synchronously, so the same event that enters a node also opens
 * the gate. It also seeds `tooltipPos` from the enter event's own coordinates,
 * so the first frame is correctly placed even if no move follows.
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
