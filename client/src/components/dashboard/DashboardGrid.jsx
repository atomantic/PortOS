import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback, memo } from 'react';
import { GripVertical, MoveDiagonal2, GripHorizontal, ChevronsDownUp } from 'lucide-react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { GRID_COLS, GRID_DEFAULT_H, WIDTH_TO_COLS, WIDGETS_BY_ID } from './widgetRegistry.jsx';
import useContainerWidth from '../../hooks/useContainerWidth';
import { dndTransformToCss } from '../../lib/dndTransform';

// Free-form 12-column grid with snap-to-grid drag, resize, and content-sized
// cells that float up into whatever whitespace is above them.
//
// Items: [{ id, x, y, w, h, fixedH? }] where x/y/w/h are integer grid units
//   - x: 0..11 (column origin)
//   - y: 0..n  (row origin; ordering/authoring coordinate — see below)
//   - w: 1..12 (column span)
//   - h: 1..n  (row span, each row ROW_HEIGHT_PX tall)
//   - fixedH: the user dragged a height onto this cell; honor `h` exactly
//
// HEIGHT IS MEASURED, NOT DECLARED. A widget's card is only as tall as its
// content, so `h` is not the rendered height — it's the pre-measurement
// fallback (first paint, and what older clients read out of a saved layout).
// Cells the user has explicitly resized carry `fixedH: true` and keep their
// declared height, clipping content the way the whole grid used to.
//
// Columns are laid out from x/w in grid units; vertical position is packed in
// PIXELS by `packVertically` — each cell drops as high as it can go without
// landing on an already-placed cell that shares a column. That's what
// reclaims dead whitespace: an 80px-tall card in a 5-row slot no longer
// reserves 400px, and the cards below it float up through the gap. Stored `y`
// still decides reading order (and therefore packing order), so the visual
// result always matches the order the user arranged.
//
// In edit mode each item exposes a top-right move handle and a bottom-right
// resize handle — plus, on a cell that's already pinned, a bottom-left
// auto-fit handle that hands the height back to the content. Pointer events
// power the two drags so the same handlers work for mouse and touch. Pointer
// capture isn't used because the drag math reads window-level coordinates
// regardless of which element the pointer crosses — the listener lives on
// `window` for the duration of the gesture.
//
// Below MOBILE_BREAKPOINT_PX the grid collapses to a single column, so x/w
// have nowhere to go — but ORDER still does. There, edit mode swaps the two
// grid handles for one reorder handle that sorts the stack via dnd-kit (the
// same PointerSensor/KeyboardSensor pairing as every other sortable list in
// the app); on drop the whole grid is re-flowed so its reading order matches
// the new stack order (`reflowToOrder`). The free-form 2-D drag stays
// hand-rolled — arbitrary grid placement isn't what a sortable list does —
// but the 1-D case is exactly dnd-kit's job, and going through it is what
// buys touch, keyboard, multi-pointer and edge auto-scroll for free.
//
// Collision policy after drag/resize (`placeAndCompact`): pin the moved item
// at its dropped position, then slot every other item into the smallest y that
// doesn't collide with anything already placed (top-left items processed
// first). Tetris-style compaction — same feel as react-grid-layout /
// gridstack. This runs in GRID UNITS and settles what gets persisted; the
// pixel pack above is what actually gets drawn. The two agree because a
// commit first re-expresses the layout in pack space (`toPackSpace`), so the
// y/h it compacts are the ones the pack produced.

const ROW_HEIGHT_PX = 80;
const GAP_PX = 16;
const ROW_STEP_PX = ROW_HEIGHT_PX + GAP_PX;
const MIN_W = 2;
const MIN_H = 2;
// Floor applied to every cell in edit mode only. A widget that renders nothing
// collapses to zero out of view — which is the point — but a zero-height cell
// has nowhere to put the move/resize handles, so Arrange gives it enough room
// to grab.
const EDIT_MIN_HEIGHT_PX = 48;
// Mobile breakpoint: below this width the grid collapses to a single column
// stacked vertically. Free-form move/resize is off there — a phone has no
// room for positional editing — but drag-to-reorder is on (see above).
// Deliberately NOT exported: a caller that needs to know which affordance is
// live gets it from `onLayoutModeChange`, because this threshold is measured
// against the CONTAINER and re-deriving it outside would read the viewport.
const MOBILE_BREAKPOINT_PX = 640;

function getColWidth(containerWidth) {
  return (containerWidth - GAP_PX * (GRID_COLS - 1)) / GRID_COLS;
}

// Reading order: top-to-bottom, then left-to-right. This is the order the
// single-column mobile stack renders in, and the order `reflowToOrder`
// consumes. `placeAndCompact` returns the moved item first regardless of
// where it landed, so grid array order can't be trusted for this.
function byReadingOrder(a, b) {
  return a.y - b.y || a.x - b.x;
}

// Grid rows ↔ pixels. A span of `h` rows covers h row boxes plus the gaps
// between them; the inverse rounds so a measured height round-trips to the
// row count that renders closest to it.
export function rowsToPx(h) {
  return h * ROW_HEIGHT_PX + (h - 1) * GAP_PX;
}
export function pxToRows(px) {
  return Math.max(1, Math.round((px + GAP_PX) / ROW_STEP_PX));
}

// Rendered height of one cell. Auto-height cells (the default) are exactly as
// tall as they measured; `fixedH` cells keep the height the user dragged onto
// them. `h` is the fallback until the first measurement lands — which is also
// why every commit refreshes it (see `toPackSpace`).
//
// Keyed on PRESENCE, not truthiness: a widget that renders nothing (several
// self-hide on empty data) measures a legitimate 0, and collapsing that into
// "not measured yet" would hand it back the whole declared slot — the exact
// dead band this grid exists to reclaim, in the one case where the reclaim is
// total.
export function itemHeightPx(item, heights = {}) {
  if (!item.fixedH && item.id in heights) return heights[item.id];
  return rowsToPx(item.h);
}

function shareColumns(a, b) {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x);
}
function shareRows(a, b) {
  return !(a.y + a.h <= b.y || b.y + b.h <= a.y);
}

// Masonry float. Walk cells in reading order and drop each one as high as it
// will go without landing on an already-placed cell that shares a column.
// Returns Map<id, { top, height }> in pixels.
//
// This is the whole point of the auto-height grid: a card shorter than its
// slot no longer reserves the leftover rows, and whatever sits under it rises
// through the gap instead of leaving a band of dead space across the row.
// Reading order (not grid-array order) is what keeps the result stable — the
// caller must pass items already sorted by `byReadingOrder`.
// `minHeight` floors every cell — passed in edit mode so a widget that
// currently renders nothing still has something to grab the handles on.
export function packVertically(ordered, heights = {}, minHeight = 0) {
  const placed = [];
  const rects = new Map();
  for (const item of ordered) {
    const height = Math.max(minHeight, itemHeightPx(item, heights));
    let top = 0;
    for (const p of placed) {
      if (!shareColumns(item, p)) continue;
      top = Math.max(top, p.top + p.height + GAP_PX);
    }
    placed.push({ x: item.x, w: item.w, top, height });
    rects.set(item.id, { top, height });
  }
  return rects;
}

// Horizontal geometry — the only part still derived straight from grid units.
function columnRect(item, colWidth) {
  return {
    left: item.x * (colWidth + GAP_PX),
    width: item.w * colWidth + (item.w - 1) * GAP_PX,
  };
}

// Re-express the layout in the pack's own coordinate space: `y` becomes the
// row the cell actually renders at and `h` the rows it actually occupies.
// Once heights are measured, stored y/h are only an ordering hint and a
// fallback — a drag that reasoned in them would move the cursor and the card
// at different speeds, and would compare the dragged cell's position against
// coordinates nothing is drawn at. Every commit goes through here, which is
// also what keeps persisted y/h honest for the next cold load (and for a
// client too old to know about `fixedH`).
function toPackSpace(items, rects) {
  return items.map((it) => {
    const rect = rects.get(it.id);
    if (!rect) return { ...it };
    return { ...it, y: Math.round(rect.top / ROW_STEP_PX), h: pxToRows(rect.height) };
  });
}

function overlaps(a, b) {
  return shareColumns(a, b) && shareRows(a, b);
}

function sameRect(a, b) {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

// Everything that differs between the three handles, on one row each. `kind`
// already discriminates them, so icon/size/placement hang off it rather than
// travelling as separate props.
const HANDLE_KINDS = {
  move: { label: 'Move', Icon: GripVertical, size: 14, className: 'top-1.5 right-1.5 p-1 cursor-move' },
  resize: { label: 'Resize', Icon: MoveDiagonal2, size: 14, className: 'bottom-1 right-1 p-1 cursor-se-resize' },
  // Only rendered on a cell whose height the user pinned — clicking it hands
  // the height back to the content so the cell can shrink and let its
  // neighbours float up again.
  'auto-height': {
    label: 'Auto-fit height',
    Icon: ChevronsDownUp,
    size: 14,
    className: 'bottom-1 left-1 p-1 cursor-pointer',
  },
  reorder: {
    label: 'Reorder',
    Icon: GripHorizontal,
    size: 18,
    // Fatter target than the desktop pair: this one is only ever hit by a thumb.
    className: 'top-1.5 right-1.5 p-2.5 cursor-grab active:cursor-grabbing',
  },
};

// Shared drag/resize/reorder handle. `handleProps` is how dnd-kit's sortable
// attributes + listeners reach the reorder variant; the two grid handles pass
// their own onPointerDown instead. `touchAction: 'none'` is what makes any of
// them work under a finger — without it the browser claims the pointer stream
// for scrolling.
function DragHandle({ kind, item, onPointerDown, onClick, handleProps }) {
  const { label, Icon, size, className } = HANDLE_KINDS[kind];
  return (
    <button
      type="button"
      onPointerDown={onPointerDown}
      onClick={onClick}
      // The registry label, not the raw id — this is read aloud.
      aria-label={`${label} ${WIDGETS_BY_ID[item.id]?.label ?? item.id}`}
      className={`absolute z-20 bg-port-bg/90 border border-port-border rounded text-gray-300 hover:text-white hover:border-port-accent ${className}`}
      style={{ touchAction: 'none' }}
      {...handleProps}
    >
      <Icon size={size} aria-hidden="true" />
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
  const rest = items.filter((i) => i.id !== movedId).sort(byReadingOrder);
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

// Row-flow items into the 12-column grid following `orderedIds`, preserving
// each item's w/h and dropping anything not in the order. This is how a mobile
// reorder becomes a grid: the single-column stack has no x/y to drop onto, so
// the new stack order is re-flowed into fresh coordinates. Items that already
// sit in flow order (the common case) come back with the same coordinates.
export function reflowToOrder(items, orderedIds = items.map((it) => it.id)) {
  const byId = new Map(items.map((it) => [it.id, it]));
  const flowed = [];
  let cursorX = 0;
  let cursorY = 0;
  let rowMaxH = 0;
  for (const id of orderedIds) {
    const item = byId.get(id);
    if (!item) continue;
    const w = Math.min(item.w, GRID_COLS);
    if (cursorX + w > GRID_COLS) {
      cursorX = 0;
      cursorY += rowMaxH;
      rowMaxH = 0;
    }
    flowed.push({ ...item, x: cursorX, y: cursorY, w });
    cursorX += w;
    rowMaxH = Math.max(rowMaxH, item.h);
  }
  return flowed;
}

// Synthesize a row-flow grid from a plain widget id list. Mirrors the
// previous CSS-grid layout so unmigrated layouts open in the same visual
// arrangement they had before the grid feature shipped.
export function synthesizeGrid(widgetIds) {
  return reflowToOrder(widgetIds.flatMap((id) => {
    const meta = WIDGETS_BY_ID[id];
    if (!meta) return [];
    return [{ id, w: WIDTH_TO_COLS[meta.width] ?? 4, h: meta.defaultH ?? GRID_DEFAULT_H }];
  }));
}

// Reconcile a saved grid against the visible widget list. Adds positions for
// any widgets missing from the grid (auto-placed at the bottom) and drops
// grid entries whose widget is no longer in the layout (gated off, deleted,
// etc.). Keeps the renderer's input always coherent with what should display.
//
// `reorder` makes `visibleIds` authoritative for order as well as membership:
// the reconciled grid is re-flowed to that order. Only pass it when the caller
// KNOWS the list order is the edit (LayoutEditor's Move up/down — #4132).
// Inferring it by comparing `visibleIds` against `readingOrderIds(grid)` would
// be wrong: layouts arranged before `saveGridEdit` started syncing `widgets` to
// reading order can already disagree, so a rename or a widget toggle would
// silently re-pack a carefully arranged desktop layout.
export function reconcileGrid(grid, visibleIds, { reorder = false } = {}) {
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
  return reorder ? reflowToOrder(kept, visibleIds) : kept;
}

// Reading order of a grid — what the mobile stack shows, and what a layout's
// `widgets` array should agree with so LayoutEditor lists them as displayed.
export function readingOrderIds(grid) {
  return [...grid].sort(byReadingOrder).map((it) => it.id);
}

// One dashboard cell. Split out (and memoized) because every indicator tick of
// a drag re-renders the grid, and without this each tick would re-run
// `renderItem` for all ~12 widgets to move one card.
const GridCell = memo(function GridCell({
  item, isMobile, editable, sortable, left, top, width, height, autoHeight, isGridDragging,
  suppressTransition, onStartGridDrag, onClearFixedHeight, onMeasure, renderItem,
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    disabled: !sortable,
  });
  const measureRef = useRef(null);

  // Two sources report this widget's natural height so the parent can pack
  // around it. Both skip the same two cases:
  //  - mobile, where the single-column stack measures at a totally different
  //    width and those numbers would be wrong for the desktop pack;
  //  - pinned, where the measured node is stretched to the declared height, so
  //    all it could publish is that height back — and the pack would then spend
  //    the frame after an unpin laying the cell out at its clipped size.
  //    Skipping leaves the last natural height in place, a far better guess.

  // (1) Post-commit, pre-paint — the AUTHORITATIVE one. It catches whatever
  // React just put in the cell (a lazy chunk resolving out of Suspense, a list
  // arriving) without depending on the observer having noticed. The observer
  // alone was racy: a widget whose content landed without a delivered resize
  // notification kept whatever it measured while it was still a skeleton, so
  // it packed — and clipped — at the wrong height. No dep array, so every
  // render re-measures; `onMeasure` bails on an unchanged value, so a settled
  // cell costs one read and one comparison.
  useLayoutEffect(() => {
    const node = measureRef.current;
    if (node && !isMobile && !item.fixedH) onMeasure(item.id, node.offsetHeight);
  });

  // (2) The observer covers what the commit pass can't see: growth with no
  // render of this cell at all — images and fonts loading, a widget's own
  // async DOM work, or a state change inside the memoized widget subtree.
  //
  // Published straight from the callback, same as `useContainerWidth`. There
  // is no feedback loop to defer around: the measured node's height comes from
  // its content, never from the cell height this publish goes on to set. An
  // rAF here is not just unnecessary, it's harmful — a frame in which the
  // pack is still using the old height is a frame in which this cell is drawn
  // shorter than its content and the one below it sits on top.
  useEffect(() => {
    const node = measureRef.current;
    if (!node || isMobile || item.fixedH) return undefined;
    // 0 is published like any other height — a widget that renders nothing
    // should occupy nothing. `itemHeightPx` keys on presence, so this is what
    // tells it apart from "not measured yet".
    const ro = new ResizeObserver(() => onMeasure(item.id, node.offsetHeight));
    ro.observe(node);
    return () => ro.disconnect();
  }, [isMobile, item.fixedH, item.id, onMeasure]);

  // Memoized so a cell that merely MOVED doesn't re-render its widget: every
  // measurement anywhere in the grid repacks, and without this each repack
  // would re-render the whole subtree of every cell it shifted.
  const content = useMemo(() => renderItem(item), [renderItem, item]);

  // The cell is ALWAYS laid out at exactly the height the pack gave it, even
  // when that height is auto-derived. Letting an auto cell size itself would
  // mean that any moment its content outgrew the last measurement — first
  // paint, a lazy chunk landing, a list arriving — it would overlap whatever
  // was packed beneath it. Clipping for one frame until the observer catches
  // up is the strictly better failure.
  const itemStyle = isMobile
    ? { transform: dndTransformToCss(transform), transition, opacity: isDragging ? 0.4 : undefined }
    : { left, top, width, height };
  const itemClass = isMobile
    ? 'w-full'
    : `absolute ${isGridDragging ? 'opacity-60' : ''} ${suppressTransition ? '' : 'transition-[left,top,width,height] duration-150'}`;
  const innerClass = isMobile
    ? 'relative'
    : `relative w-full h-full overflow-hidden rounded-xl ${editable ? 'ring-1 ring-port-border' : ''}`;

  return (
    <div ref={setNodeRef} data-widget-id={item.id} className={itemClass} style={itemStyle}>
      <div className={innerClass}>
        {/* Free of the cell's height so it reports what the widget WANTS, not
            what it currently gets — that number is the auto height. A pinned
            cell stretches its widget to fill instead (`h-full`), which is the
            one case where the declared height is the answer. `flow-root` keeps
            a widget root's margin from collapsing out of the measurement. */}
        <div ref={measureRef} className={autoHeight ? 'flow-root' : 'h-full flow-root'}>
          {content}
        </div>
        {editable && !isMobile && (
          <>
            <DragHandle kind="move" item={item} onPointerDown={(e) => onStartGridDrag(e, item, 'move')} />
            <DragHandle kind="resize" item={item} onPointerDown={(e) => onStartGridDrag(e, item, 'resize')} />
            {item.fixedH && (
              <DragHandle kind="auto-height" item={item} onClick={() => onClearFixedHeight(item)} />
            )}
          </>
        )}
        {sortable && (
          <DragHandle kind="reorder" item={item} handleProps={{ ...attributes, ...listeners }} />
        )}
      </div>
    </div>
  );
});

export default function DashboardGrid({ items, editable, onChange, onLayoutModeChange, renderItem }) {
  const [containerRef, containerWidth] = useContainerWidth();
  // Drag state lives outside React when active to avoid a setState on every
  // pointermove (would spam re-renders of every widget). React only learns
  // about the new ghost when we call setDrag, throttled by RAF.
  //
  // `drag` is `{ kind, baseline, ghost }`. `baseline` is the layout as it
  // stood when the gesture started, in pack space (see `toPackSpace`):
  // everything the drag reasons about — the ghost, the live preview, the
  // committed grid — is relative to it, not to the stored coordinates, which
  // no longer describe where anything is drawn. `ghost` stays a plain grid
  // item so the commit can spread it straight onto one.
  const dragRef = useRef(null);
  const [drag, setDrag] = useState(null);
  // Measured natural heights, px, keyed by widget id.
  const [heights, setHeights] = useState({});

  const onMeasure = useCallback((id, px) => {
    setHeights((prev) => (prev[id] === px ? prev : { ...prev, [id]: px }));
  }, []);

  const isMobile = containerWidth > 0 && containerWidth < MOBILE_BREAKPOINT_PX;
  // The mobile/desktop seam is measured off the CONTAINER, so a caller that
  // wants to describe the active affordance has to be told — a CSS `sm:`
  // breakpoint reads the viewport and disagrees on a padded page.
  useEffect(() => {
    if (containerWidth > 0) onLayoutModeChange?.(isMobile);
  }, [isMobile, containerWidth, onLayoutModeChange]);

  // Render in reading order always, not grid-array order: the mobile stack
  // depends on it, and on desktop it keeps DOM/tab order matching what the
  // eye sees. Keyed children survive reordering, so widget state is safe.
  const ordered = useMemo(() => [...items].sort(byReadingOrder), [items]);
  const orderedIds = useMemo(() => ordered.map((it) => it.id), [ordered]);

  // What the pack actually sees: the drag baseline with the item under the
  // cursor swapped for its snapped ghost, so every OTHER cell reflows live to
  // where it will land instead of waiting for the drop. A resize ghost packs
  // as a pinned cell — the drag is defining a height, so the preview must
  // show that height and not the content's.
  const previewItems = useMemo(() => {
    if (!drag) return ordered;
    return drag.baseline
      .map((it) => (it.id === drag.ghost.id
        ? { ...it, ...drag.ghost, ...(drag.kind === 'resize' ? { fixedH: true } : {}) }
        : it))
      .sort(byReadingOrder);
  }, [ordered, drag]);

  const rects = useMemo(
    () => (isMobile ? new Map() : packVertically(previewItems, heights, editable ? EDIT_MIN_HEIGHT_PX : 0)),
    [isMobile, previewItems, heights, editable]
  );
  // Read by the drag handlers, which must not re-bind every time a widget
  // re-measures (that would churn every memoized cell mid-gesture).
  const rectsRef = useRef(rects);
  rectsRef.current = rects;

  const containerHeight = useMemo(() => {
    let bottom = 0;
    for (const rect of rects.values()) bottom = Math.max(bottom, rect.top + rect.height);
    return bottom;
  }, [rects]);

  // Until every auto cell has reported a height, the pack is still running on
  // declared-row fallbacks — animating the correction would make every page
  // load open with a 150ms shuffle. Cells snap into place instead, and the
  // transition switches on for genuine edits afterwards.
  const settled = useMemo(
    // Presence again, not truthiness — a legitimately 0-tall widget has
    // reported, and gating on `> 0` would latch the transition off forever.
    () => ordered.every((it) => it.fixedH || it.id in heights),
    [ordered, heights]
  );

  const startDrag = useCallback((e, item, kind) => {
    if (!editable || isMobile) return;
    // Prevent text selection mid-drag. preventDefault on the handle's
    // pointerdown is enough because the listener lives on window and we
    // never let the pointer leave the gesture.
    e.preventDefault();
    e.stopPropagation();
    // Snapshot in pack space so the ghost starts exactly where the card is
    // drawn — grabbing the resize handle on an auto-height cell would
    // otherwise snap it to a stale row count before the pointer has moved.
    const baseline = toPackSpace(items, rectsRef.current);
    const found = baseline.find((it) => it.id === item.id) ?? item;
    // A resize gesture's floor applies to where the drag STARTS too. Without
    // it, a cell measuring under MIN_H rows (a widget rendering little or
    // nothing) has its height "changed" by the clamp alone — so a purely
    // horizontal drag would silently pin it.
    const startItem = kind === 'resize' ? { ...found, h: Math.max(MIN_H, found.h) } : found;
    dragRef.current = {
      id: item.id,
      kind,
      startPointer: { x: e.clientX, y: e.clientY },
      startItem,
      ghost: { ...startItem },
    };
    setDrag({ kind, baseline, ghost: { ...startItem } });
  }, [editable, isMobile, items]);

  useEffect(() => {
    if (!drag) return undefined;
    const colWidth = getColWidth(containerWidth);
    // Both are fixed for the life of the gesture, and this effect re-installs
    // exactly when one starts — so capturing them here can't go stale, and the
    // per-snap `setDrag` doesn't have to re-bind the window listeners.
    const { kind, baseline } = drag;
    let raf = 0;

    const onPointerMove = (e) => {
      const gesture = dragRef.current;
      if (!gesture) return;
      const dx = e.clientX - gesture.startPointer.x;
      const dy = e.clientY - gesture.startPointer.y;
      const colStep = colWidth + GAP_PX;
      const start = gesture.startItem;

      let next;
      if (kind === 'move') {
        const newX = Math.max(0, Math.min(GRID_COLS - start.w, Math.round(start.x + dx / colStep)));
        const newY = Math.max(0, Math.round(start.y + dy / ROW_STEP_PX));
        next = { ...start, x: newX, y: newY };
      } else {
        const newW = Math.max(MIN_W, Math.min(GRID_COLS - start.x, Math.round(start.w + dx / colStep)));
        const newH = Math.max(MIN_H, Math.round(start.h + dy / ROW_STEP_PX));
        next = { ...start, w: newW, h: newH };
      }
      // Snap dedup: pointermove fires at 200+ Hz, but `next` only changes
      // when the cursor crosses a snap boundary. Skip the React update
      // when we're still inside the same snap cell — saves ~60 widget
      // re-renders per drag and keeps the rAF callback a no-op.
      if (sameRect(gesture.ghost, next)) return;
      gesture.ghost = next;
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          const ghost = dragRef.current?.ghost;
          if (ghost) setDrag((prev) => (prev ? { ...prev, ghost: { ...ghost } } : prev));
        });
      }
    };

    const finish = (commit) => {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      const gesture = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!gesture || !commit) return;
      // Skip the write entirely when nothing actually changed — avoids a
      // 200 OK on every accidental click on the drag handle.
      if (sameRect(gesture.startItem, gesture.ghost)) return;
      // A resize that actually changed the HEIGHT is the user declaring one:
      // pin it. A width-only resize (or a move) leaves the cell auto-sized.
      const pins = kind === 'resize' && gesture.ghost.h !== gesture.startItem.h;
      const updated = baseline.map((it) => (it.id === gesture.id
        ? { ...it, ...gesture.ghost, ...(pins ? { fixedH: true } : {}) }
        : it));
      onChange(placeAndCompact(updated, gesture.id));
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
  // The active/idle key re-installs the listeners only when the gesture
  // starts/ends, never on a snap — pointermove writes dragRef.current
  // directly, and the `kind`/`baseline` captured above are gesture-constant.
  }, [drag ? 'active' : 'idle', onChange, containerWidth]);

  // A short activation distance keeps a tap on the handle from registering as
  // a drag; the keyboard sensor is what makes the handle usable without one.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const onSortEnd = useCallback(({ active, over }) => {
    if (!over || active.id === over.id) return;
    const from = orderedIds.indexOf(active.id);
    const to = orderedIds.indexOf(over.id);
    if (from < 0 || to < 0) return;
    onChange(reflowToOrder(items, arrayMove(orderedIds, from, to)));
  }, [orderedIds, items, onChange]);

  // Hand a pinned cell's height back to its content. The cell re-renders
  // unconstrained, the observer reports its natural height, and the pack
  // closes the gap on the next frame.
  const clearFixedHeight = useCallback((item) => {
    const next = toPackSpace(items, rectsRef.current).map((it) => {
      if (it.id !== item.id) return it;
      // Drop the pin by omission rather than whitelisting the fields to keep,
      // so a field added to the grid item later doesn't get eaten here.
      const { fixedH: _pinned, ...rest } = it;
      return rest;
    });
    onChange(placeAndCompact(next, item.id));
  }, [items, onChange]);

  const sortable = editable && isMobile;
  const colWidth = isMobile ? 0 : getColWidth(containerWidth);

  return (
    // DndContext/SortableContext render no DOM of their own, so they can wrap
    // unconditionally — which matters, because a conditional wrapper would
    // remount every widget on a breakpoint cross (see the note below).
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onSortEnd}>
      <SortableContext items={orderedIds} strategy={verticalListSortingStrategy}>
        {/* Single render tree across mobile and desktop — only the
            className/style toggle. If we returned a different JSX shape per
            mode (separate mobile branch with shallower wrappers), React would
            unmount every widget on the breakpoint cross, wiping in-progress
            form input. Rotating an iPhone from portrait (~390px) to landscape
            (~844px) crosses MOBILE_BREAKPOINT_PX, so structural divergence
            here = "my Quick Capture text vanished when I rotated." Keep the
            wrapper depth identical and let CSS handle the rest. */}
        <div
          ref={containerRef}
          className={isMobile ? 'space-y-4' : 'relative w-full'}
          style={isMobile ? undefined : { height: containerWidth ? containerHeight : 'auto', minHeight: '4rem' }}
        >
          {ordered.map((item) => {
            const dragged = drag?.ghost.id === item.id;
            const rect = rects.get(item.id);
            const { left, width } = columnRect(dragged ? drag.ghost : item, colWidth);
            // A cell's height comes from its content unless it is pinned OR is
            // the one currently being resized (where the drag, not the content,
            // is defining the height).
            const pinned = item.fixedH || (dragged && drag.kind === 'resize');
            return (
              <GridCell
                key={item.id}
                item={item}
                isMobile={isMobile}
                editable={editable && containerWidth > 0}
                sortable={sortable}
                left={left}
                top={rect?.top ?? 0}
                width={width}
                height={rect?.height ?? rowsToPx(item.h)}
                autoHeight={!pinned}
                isGridDragging={!isMobile && dragged}
                suppressTransition={Boolean(drag) || !settled}
                onStartGridDrag={startDrag}
                onClearFixedHeight={clearFixedHeight}
                onMeasure={onMeasure}
                renderItem={renderItem}
              />
            );
          })}

          {/* Drop preview during the free-form drag — outline over the packed
              position the item will actually land in. Pointer-events:none so
              it never intercepts the gesture. */}
          {!isMobile && drag && containerWidth > 0 && rects.has(drag.ghost.id) && (
            <div
              className="absolute pointer-events-none border-2 border-dashed border-port-accent rounded-xl bg-port-accent/10 z-30"
              style={{ ...columnRect(drag.ghost, colWidth), ...rects.get(drag.ghost.id) }}
            />
          )}
        </div>
      </SortableContext>
    </DndContext>
  );
}
