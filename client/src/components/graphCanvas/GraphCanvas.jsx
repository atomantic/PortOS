/**
 * Shared SVG graph canvas — the gesture and viewport layer under every node
 * editor (FableLoom's scene graph today; storyboard recipes next).
 *
 * The caller owns layout and drawing: it passes node positions, draws edges
 * with `renderEdges`, a card's SVG body with `renderNode`, and optional HTML
 * media with `renderNodeHtml`. The canvas owns what every graph editor needs
 * the same way:
 *
 *   - tap/click/keyboard selection (`onSelect`; selection lives in the URL, so
 *     the parent navigates) and scrolling the selected card into view;
 *   - mouse-drag to reposition a card, committed once on release (`onMove`).
 *     A drag mutates the card's transform directly per pointermove; routing it
 *     through state re-rendered every card (each with a foreignObject) ~60×/s;
 *   - drag-to-pan wherever a card did not claim the gesture, and one
 *     capture-phase handler that swallows the click any drag ends with;
 *   - zoom (buttons, Fit, and ctrl/⌘ + wheel, which is also a trackpad pinch).
 *     The SVG keeps its canvas-unit `viewBox` and scales its pixel size, so
 *     positions and `onMove` coordinates stay in canvas units at any zoom.
 *
 * Touch never drags a card (it would fight scrolling), and `canDragNodes={false}`
 * turns card drags off entirely — a stacked phone layout's coordinates must
 * not persist as desktop positions; its cards are pannable surface instead.
 *
 * WebKit/iOS paints HTML inside a foreignObject at the wrong place when an
 * ancestor SVG group is transformed, so `renderNodeHtml` content is placed at
 * the SVG root with resolved coordinates (`htmlInset` relative to the card)
 * and moved in lockstep with its card during a drag.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize, Minus, Plus } from 'lucide-react';
import useDragToPan from '../../hooks/useDragToPan';
import { isTapGesture } from '../../lib/graphPicking';

const DRAG_THRESHOLD_PX = 4;
export const GRAPH_ZOOM_MIN = 0.25;
export const GRAPH_ZOOM_MAX = 2;
const ZOOM_STEP = 1.25;

const clampZoom = (z) => Math.min(GRAPH_ZOOM_MAX, Math.max(GRAPH_ZOOM_MIN, Math.round(z * 100) / 100));

/**
 * How far the pointer has travelled since pointerdown in screen px, or `null`
 * while it is still close enough to read as a click. Latches `moved` once the
 * threshold is cleared.
 */
const gestureDelta = (gesture, event) => {
  const point = { x: event.clientX, y: event.clientY };
  if (!gesture.moved && isTapGesture(gesture.start, point, DRAG_THRESHOLD_PX)) return null;
  gesture.moved = true;
  return { dx: point.x - gesture.start.x, dy: point.y - gesture.start.y };
};

export default function GraphCanvas({
  width, height, nodes, positions, nodeW, nodeH,
  selectedId = null, canDragNodes = true,
  onSelect, onMove,
  renderDefs, renderEdges, renderNode, renderNodeHtml, htmlInset,
  nodeLabel, nodeClassName,
  ariaLabel, surfaceProps = {}, surfaceClassName = '',
  zoomControls = true, children,
}) {
  const dragRef = useRef(null);
  const draggedRef = useRef(false);
  const pan = useDragToPan({
    slop: DRAG_THRESHOLD_PX,
    canStart: () => !dragRef.current,
    onPanEnd: () => { draggedRef.current = true; },
  });
  const cardRefs = useRef(new Map());
  const htmlRefs = useRef(new Map());
  const measureRef = useRef(null);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  useEffect(() => {
    if (!selectedId || !measureRef.current) return undefined;
    const el = measureRef.current.querySelector(`[data-node-id="${selectedId}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    return undefined;
  }, [selectedId, measureRef, width, height]);

  // Zoom about a point in surface (client-relative) coordinates so the canvas
  // spot under it stays put — the viewport centre for buttons, the pointer
  // for a wheel/pinch.
  const applyZoom = useCallback((next, anchor) => {
    const surface = measureRef.current;
    const prev = zoomRef.current;
    const target = clampZoom(next);
    if (target === prev) return;
    zoomRef.current = target;
    setZoom(target);
    if (!surface) return;
    const ax = anchor?.x ?? surface.clientWidth / 2;
    const ay = anchor?.y ?? surface.clientHeight / 2;
    const cx = (surface.scrollLeft + ax) / prev;
    const cy = (surface.scrollTop + ay) / prev;
    // The new SVG size lands on the next frame; scroll after it does.
    requestAnimationFrame(() => {
      surface.scrollLeft = cx * target - ax;
      surface.scrollTop = cy * target - ay;
    });
  }, [measureRef]);

  const fit = useCallback(() => {
    const surface = measureRef.current;
    if (!surface || !width || !height) return;
    const scale = Math.min(surface.clientWidth / width, surface.clientHeight / height, 1);
    applyZoom(scale || 1);
  }, [measureRef, width, height, applyZoom]);

  // React's onWheel is passive, so preventDefault (keep the page from zooming
  // under a pinch) needs a native listener.
  useEffect(() => {
    const surface = measureRef.current;
    if (!surface) return undefined;
    const onWheel = (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = surface.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY / 200);
      applyZoom(zoomRef.current * factor, { x: event.clientX - rect.left, y: event.clientY - rect.top });
    };
    surface.addEventListener('wheel', onWheel, { passive: false });
    return () => surface.removeEventListener('wheel', onWheel);
  });

  const handlePointerDown = (event, node) => {
    if (event.button !== 0) return;
    if (event.pointerType !== 'mouse' || !canDragNodes || !onMove) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const origin = positions[node.id] || { x: 0, y: 0 };
    dragRef.current = {
      id: node.id,
      cardEl: cardRefs.current.get(node.id),
      htmlEl: htmlRefs.current.get(node.id),
      start: { x: event.clientX, y: event.clientY },
      origin,
      x: origin.x,
      y: origin.y,
      moved: false,
    };
  };

  const handlePointerMove = (event) => {
    const drag = dragRef.current;
    const delta = drag && gestureDelta(drag, event);
    if (!delta) return;
    const z = zoomRef.current;
    drag.x = Math.max(0, drag.origin.x + delta.dx / z);
    drag.y = Math.max(0, drag.origin.y + delta.dy / z);
    drag.cardEl?.setAttribute('transform', `translate(${drag.x}, ${drag.y})`);
    if (drag.htmlEl && htmlInset) {
      drag.htmlEl.setAttribute('x', drag.x + htmlInset.x);
      drag.htmlEl.setAttribute('y', drag.y + htmlInset.y);
    }
  };

  const handlePointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag?.moved) return;
    draggedRef.current = true;
    onMove?.(drag.id, { x: Math.round(drag.x), y: Math.round(drag.y) });
  };

  const handleSurfacePointerDown = (event) => {
    // Cleared at the START of every gesture: a drag released outside the
    // canvas (or cancelled) never gets its click, and a stale flag would then
    // swallow the next genuine select.
    draggedRef.current = false;
    pan.panProps.onPointerDown(event);
  };

  const handleSurfaceClickCapture = (event) => {
    if (!draggedRef.current) return;
    draggedRef.current = false;
    event.stopPropagation();
  };

  const cardHandlers = (node) => ({
    onPointerDown: (e) => handlePointerDown(e, node),
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerUp,
    onPointerCancel: handlePointerUp,
    onClick: () => onSelect?.(node.id),
  });

  const zoomPct = Math.round(zoom * 100);

  return (
    <div className="relative h-full w-full">
      <div
        ref={(el) => { measureRef.current = el; pan.surfaceRef.current = el; }}
        className={`overflow-auto h-full w-full overscroll-contain cursor-grab active:cursor-grabbing ${surfaceClassName}`}
        data-zoom={zoom}
        {...surfaceProps}
        {...pan.panProps}
        onPointerDown={handleSurfacePointerDown}
        onClickCapture={handleSurfaceClickCapture}
      >
        <svg
          width={Math.ceil(width * zoom)}
          height={Math.ceil(height * zoom)}
          viewBox={`0 0 ${width} ${height}`}
          className="block select-none"
          aria-label={ariaLabel}
        >
          {renderDefs && <defs>{renderDefs()}</defs>}
          <g>{renderEdges?.()}</g>
          <g>
            {nodes.map((node) => {
              const pos = positions[node.id];
              if (!pos) return null;
              const selected = node.id === selectedId;
              return (
                <g
                  key={node.id}
                  ref={(element) => {
                    if (element) cardRefs.current.set(node.id, element);
                    else cardRefs.current.delete(node.id);
                  }}
                  data-node-id={node.id}
                  transform={`translate(${pos.x}, ${pos.y})`}
                  className={`${canDragNodes && onMove ? 'cursor-grab' : 'cursor-pointer'} ${nodeClassName?.(node) || ''}`}
                  role="button"
                  tabIndex={0}
                  aria-label={nodeLabel?.(node)}
                  aria-current={selected ? 'true' : undefined}
                  {...cardHandlers(node)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelect?.(node.id);
                    }
                  }}
                >
                  {renderNode(node, { selected, width: nodeW, height: nodeH })}
                </g>
              );
            })}
          </g>
          {renderNodeHtml && htmlInset && (
            <g>
              {nodes.map((node) => {
                const pos = positions[node.id];
                if (!pos) return null;
                return (
                  <foreignObject
                    key={node.id}
                    ref={(element) => {
                      if (element) htmlRefs.current.set(node.id, element);
                      else htmlRefs.current.delete(node.id);
                    }}
                    data-node-media-id={node.id}
                    x={pos.x + htmlInset.x}
                    y={pos.y + htmlInset.y}
                    width={htmlInset.width}
                    height={htmlInset.height}
                    {...cardHandlers(node)}
                  >
                    <div className="h-full w-full min-w-0 overflow-hidden" xmlns="http://www.w3.org/1999/xhtml">
                      {renderNodeHtml(node)}
                    </div>
                  </foreignObject>
                );
              })}
            </g>
          )}
        </svg>
      </div>
      {zoomControls && (
        <div
          className="absolute top-2 right-2 flex items-center gap-0.5 rounded-lg border border-port-border bg-port-card/95 p-0.5 shadow-sm"
          data-testid="graph-zoom-controls"
        >
          <button type="button" onClick={() => applyZoom(zoom / ZOOM_STEP)} disabled={zoom <= GRAPH_ZOOM_MIN}
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded hover:bg-port-border/50 disabled:opacity-40" aria-label="Zoom out">
            <Minus size={14} />
          </button>
          <button type="button" onClick={() => applyZoom(1)}
            className="min-h-[44px] min-w-[3rem] px-1 text-[11px] tabular-nums text-port-text-muted hover:text-port-text" aria-label="Reset zoom to 100%">
            {zoomPct}%
          </button>
          <button type="button" onClick={() => applyZoom(zoom * ZOOM_STEP)} disabled={zoom >= GRAPH_ZOOM_MAX}
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded hover:bg-port-border/50 disabled:opacity-40" aria-label="Zoom in">
            <Plus size={14} />
          </button>
          <button type="button" onClick={fit} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded hover:bg-port-border/50" aria-label="Fit graph to view">
            <Maximize size={14} />
          </button>
        </div>
      )}
      {children}
    </div>
  );
}
