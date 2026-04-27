import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { GripVertical, MoveDiagonal2 } from 'lucide-react';
import { GRID_COLS, GRID_DEFAULT_H, WIDTH_TO_COLS, WIDGETS_BY_ID } from './widgetRegistry.jsx';
import useContainerWidth from '../../hooks/useContainerWidth';

// Free-form 12-column grid with snap-to-grid drag and resize.
//
// Items: [{ id, x, y, w, h }] where x/y/w/h are integer grid units
//   - x: 0..11 (column origin)
//   - y: 0..n  (row origin; rows are uniform ROW_HEIGHT_PX tall)
//   - w: 1..12 (column span)
//   - h: 1..n  (row span)
//
// In edit mode each item exposes a top-right move handle and a bottom-right
// resize handle. Pointer events power both so the same handlers work for
// mouse and touch. Pointer capture isn't used because the drag math reads
// window-level coordinates regardless of which element the pointer crosses
// — the listener lives on `window` for the duration of the gesture.
//
// Collision policy after drag/resize: pin the moved item at its dropped
// position, then slot every other item into the smallest y that doesn't
// collide with anything already placed (top-left items processed first).
// Tetris-style compaction — same feel as react-grid-layout / gridstack.

const ROW_HEIGHT_PX = 80;
const GAP_PX = 16;
const MIN_W = 2;
const MIN_H = 2;
// Mobile breakpoint: below this width the grid collapses to a single column
// stacked vertically. Drag/resize is disabled — phones don't have the screen
// real estate to make positional editing useful, and the touch targets would
// fight scrolling.
const MOBILE_BREAKPOINT_PX = 640;

function getColWidth(containerWidth) {
  return (containerWidth - GAP_PX * (GRID_COLS - 1)) / GRID_COLS;
}

function rectFor(item, colWidth) {
  return {
    left: item.x * (colWidth + GAP_PX),
    top: item.y * (ROW_HEIGHT_PX + GAP_PX),
    width: item.w * colWidth + (item.w - 1) * GAP_PX,
    height: item.h * ROW_HEIGHT_PX + (item.h - 1) * GAP_PX,
  };
}

function overlaps(a, b) {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}

function sameRect(a, b) {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

// Shared drag/resize handle. Move and resize are visually + behaviorally
// near-identical (icon, position, drag kind), so they share one component
// instead of duplicating the button block.
function DragHandle({ kind, item, icon: Icon, onStart, className }) {
  return (
    <button
      type="button"
      onPointerDown={(e) => onStart(e, item, kind)}
      aria-label={`${kind === 'move' ? 'Move' : 'Resize'} ${item.id}`}
      className={`absolute z-20 p-1 bg-port-bg/90 border border-port-border rounded text-gray-300 hover:text-white hover:border-port-accent ${className}`}
      style={{ touchAction: 'none' }}
    >
      <Icon size={14} />
    </button>
  );
}

// Pin the moved item at its dropped position, then slide every other item
// upward to the smallest y that doesn't collide with anything already
// placed. Combines collision-resolve and compact in one pass: the moved
// item goes first (so it acts as an obstacle for everyone else) and the
// rest are processed in current (y, x) order so top-left items keep
// precedence. Returns a new array — never mutates input.
function placeAndCompact(items, movedId) {
  const moved = items.find((i) => i.id === movedId);
  if (!moved) return items.map((it) => ({ ...it }));
  const rest = items
    .filter((i) => i.id !== movedId)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const placed = [{ ...moved }];
  for (const item of rest) {
    let y = 0;
    while (placed.some((p) => overlaps({ ...item, y }, p))) y += 1;
    placed.push({ ...item, y });
  }
  return placed;
}

// Auto-place a new widget at the bottom of the grid, left-aligned. Used when
// LayoutEditor adds a widget to a layout without specifying coordinates.
export function placeNewWidget(items, widgetId) {
  const meta = WIDGETS_BY_ID[widgetId];
  const w = WIDTH_TO_COLS[meta?.width] ?? 4;
  const h = meta?.defaultH ?? GRID_DEFAULT_H;
  const bottom = items.reduce((max, it) => Math.max(max, it.y + it.h), 0);
  return [...items, { id: widgetId, x: 0, y: bottom, w, h }];
}

// Synthesize a row-flow grid from a plain widget id list. Mirrors the
// previous CSS-grid layout so unmigrated layouts open in the same visual
// arrangement they had before the grid feature shipped.
export function synthesizeGrid(widgetIds) {
  const items = [];
  let cursorX = 0;
  let cursorY = 0;
  let rowMaxH = 0;
  for (const id of widgetIds) {
    const meta = WIDGETS_BY_ID[id];
    if (!meta) continue;
    const w = WIDTH_TO_COLS[meta.width] ?? 4;
    const h = meta.defaultH ?? GRID_DEFAULT_H;
    if (cursorX + w > GRID_COLS) {
      cursorX = 0;
      cursorY += rowMaxH;
      rowMaxH = 0;
    }
    items.push({ id, x: cursorX, y: cursorY, w, h });
    cursorX += w;
    rowMaxH = Math.max(rowMaxH, h);
  }
  return items;
}

// Reconcile a saved grid against the visible widget list. Adds positions for
// any widgets missing from the grid (auto-placed at the bottom) and drops
// grid entries whose widget is no longer in the layout (gated off, deleted,
// etc.). Keeps the renderer's input always coherent with what should display.
export function reconcileGrid(grid, visibleIds) {
  const visible = new Set(visibleIds);
  const present = new Set();
  let kept = [];
  for (const item of grid) {
    if (!visible.has(item.id)) continue;
    if (present.has(item.id)) continue;
    present.add(item.id);
    kept.push(item);
  }
  for (const id of visibleIds) {
    if (present.has(id)) continue;
    kept = placeNewWidget(kept, id);
  }
  return kept;
}

export default function DashboardGrid({ items, editable, onChange, renderItem }) {
  const [containerRef, containerWidth] = useContainerWidth();
  // Drag state lives outside React when active to avoid a setState on every
  // pointermove (would spam re-renders of every widget). React only learns
  // about the new ghost when we call setDragGhost, throttled by RAF.
  const dragRef = useRef(null);
  const [dragGhost, setDragGhost] = useState(null);

  const isMobile = containerWidth > 0 && containerWidth < MOBILE_BREAKPOINT_PX;

  const totalRows = useMemo(
    () => items.reduce((max, it) => Math.max(max, it.y + it.h), 0),
    [items]
  );
  const containerHeight = totalRows * (ROW_HEIGHT_PX + GAP_PX);

  const startDrag = useCallback((e, item, kind) => {
    if (!editable || isMobile) return;
    // Prevent text selection mid-drag. preventDefault on the handle's
    // pointerdown is enough because the listener lives on window and we
    // never let the pointer leave the gesture.
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      id: item.id,
      kind,
      startPointer: { x: e.clientX, y: e.clientY },
      startItem: { ...item },
      ghost: { ...item },
    };
    setDragGhost({ ...item });
  }, [editable, isMobile]);

  useEffect(() => {
    if (!dragGhost) return undefined;
    const colWidth = getColWidth(containerWidth);
    let raf = 0;

    const onPointerMove = (e) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.startPointer.x;
      const dy = e.clientY - drag.startPointer.y;
      const colStep = colWidth + GAP_PX;
      const rowStep = ROW_HEIGHT_PX + GAP_PX;

      let next;
      if (drag.kind === 'move') {
        const newX = Math.max(0, Math.min(GRID_COLS - drag.startItem.w, Math.round(drag.startItem.x + dx / colStep)));
        const newY = Math.max(0, Math.round(drag.startItem.y + dy / rowStep));
        next = { ...drag.startItem, x: newX, y: newY };
      } else {
        const newW = Math.max(MIN_W, Math.min(GRID_COLS - drag.startItem.x, Math.round(drag.startItem.w + dx / colStep)));
        const newH = Math.max(MIN_H, Math.round(drag.startItem.h + dy / rowStep));
        next = { ...drag.startItem, w: newW, h: newH };
      }
      // Snap dedup: pointermove fires at 200+ Hz, but `next` only changes
      // when the cursor crosses a snap boundary. Skip the React update
      // when we're still inside the same snap cell — saves ~60 widget
      // re-renders per drag and keeps the rAF callback a no-op.
      if (sameRect(drag.ghost, next)) return;
      drag.ghost = next;
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (dragRef.current) setDragGhost({ ...dragRef.current.ghost });
        });
      }
    };

    const finish = (commit) => {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      const drag = dragRef.current;
      dragRef.current = null;
      setDragGhost(null);
      if (!drag || !commit) return;
      // Skip the write entirely when nothing actually changed — avoids a
      // 200 OK on every accidental click on the drag handle.
      if (sameRect(drag.startItem, drag.ghost)) return;
      const updated = items.map((it) => (it.id === drag.id ? { ...it, ...drag.ghost } : it));
      onChange(placeAndCompact(updated, drag.id));
    };

    const onPointerUp = () => finish(true);
    const onPointerCancel = () => finish(false);

    // Passive listeners — none of these handlers call preventDefault.
    // preventDefault on the pointerdown (in startDrag) is enough to suppress
    // text selection mid-drag.
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerup', onPointerUp, { passive: true });
    window.addEventListener('pointercancel', onPointerCancel, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      if (raf) cancelAnimationFrame(raf);
    };
  // dragGhost in the deps array re-installs the listeners only when the
  // gesture starts/ends — pointermove updates dragRef.current directly.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragGhost ? 'active' : 'idle', items, onChange, containerWidth]);

  // Mobile fallback: stack widgets full-width in source order. Uses CSS flow
  // (no absolute positioning) so the layout adapts to widget content height.
  if (isMobile) {
    return (
      <div ref={containerRef} className="space-y-4">
        {items.map((item) => (
          <div key={item.id} className="w-full">
            {renderItem(item)}
          </div>
        ))}
      </div>
    );
  }

  const colWidth = getColWidth(containerWidth);

  return (
    <div
      ref={containerRef}
      className="relative w-full"
      style={{ height: containerWidth ? containerHeight : 'auto', minHeight: '4rem' }}
    >
      {items.map((item) => {
        const isDragging = dragGhost?.id === item.id;
        const renderRect = rectFor(item, colWidth);
        return (
          <div
            key={item.id}
            className={`absolute ${isDragging ? 'opacity-40' : ''} ${dragGhost ? '' : 'transition-[left,top,width,height] duration-150'}`}
            style={{
              left: renderRect.left,
              top: renderRect.top,
              width: renderRect.width,
              height: renderRect.height,
            }}
          >
            <div className={`relative w-full h-full overflow-hidden rounded-xl ${editable ? 'ring-1 ring-port-border' : ''}`}>
              {renderItem(item)}
              {editable && containerWidth > 0 && (
                <>
                  <DragHandle
                    kind="move" item={item} icon={GripVertical} onStart={startDrag}
                    className="top-1.5 right-1.5 cursor-move"
                  />
                  <DragHandle
                    kind="resize" item={item} icon={MoveDiagonal2} onStart={startDrag}
                    className="bottom-1 right-1 cursor-se-resize"
                  />
                </>
              )}
            </div>
          </div>
        );
      })}

      {/* Drop preview during drag — outline showing where the item will
          land after snap. Pointer-events:none so it never intercepts the
          gesture. */}
      {dragGhost && containerWidth > 0 && (
        <div
          className="absolute pointer-events-none border-2 border-dashed border-port-accent rounded-xl bg-port-accent/10 z-30"
          style={rectFor(dragGhost, colWidth)}
        />
      )}
    </div>
  );
}
