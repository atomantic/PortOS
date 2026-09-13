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

// Free-form 12-column grid with snap-to-column drag, resize, and
// content-sized cells that float up into whatever whitespace is above them.
//
// Items: [{ id, x, w, order, h?, fixedH? }]
//   - x:     0..11 (column origin, integer grid units)
//   - w:     1..12 (column span, integer grid units)
//   - order: 0..n  (reading/packing order — the ONLY vertical coordinate)
//   - h:     1..n  (row span, each row ROW_HEIGHT_PX tall — fallback only)
//   - fixedH: the user dragged a height onto this cell; honor `h` exactly
//
// ONE VERTICAL COORDINATE. Horizontal placement is declared (x/w); vertical
// placement is entirely owned by `packVertically`, which lays cells out in
// PIXELS. `order` says which cell packs first, and nothing else — there is no
// stored row position, no rectangle-collision pass, and no y-compaction. A
// gesture therefore never has to reconcile "where the cell says it is" with
// "where the cell is drawn," because only one of those exists.
//
// HEIGHT IS MEASURED, NOT DECLARED. A widget's card is only as tall as its
// content, so `h` is not the rendered height — it's the pre-measurement
// fallback (first paint, and what an older client reads out of a saved
// layout). Cells the user has explicitly resized carry `fixedH: true` and keep
// their declared height, clipping content the way the whole grid used to.
//
// The pack is what reclaims dead whitespace: each cell drops as high as it can
// go without landing on an already-placed cell that shares a column, so an
// 80px-tall card in a 5-row slot no longer reserves 400px and the cards below
// it float up through the gap.
//
// In edit mode each item exposes a top-right move handle and a bottom-right
// resize handle — plus, on a cell that's already pinned, a bottom-left
// auto-fit handle that hands the height back to the content. Pointer events
// power the two drags so the same handlers work for mouse and touch. Pointer
// capture isn't used because the drag math reads window-level coordinates
// regardless of which element the pointer crosses — the listener lives on
// `window` for the duration of the gesture.
//
// KEYBOARD RUNS THE SAME GESTURE (#7263). Both handles are also grab toggles:
// Enter/Space lifts the cell, the arrows step the ghost, Enter/Space drops it
// and Escape puts it back. There is deliberately no second placement path —
// `beginGesture` freezes the identical snapshot the pointer drag freezes,
// `stepGhost` snaps in the same units the pointer rounds to, and the commit
// goes through the same `applyGhost`. What differs is only where the next
// ghost comes from: a pixel delta, or one arrow press. That is what keeps the
// promise above (one vertical coordinate) intact — a keyboard step never
// introduces a coordinate space the pointer path doesn't already have.
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
// Drop policy after a move (`insertAtOrder`): the dragged cell is re-inserted
// into the reading sequence at the rank its dropped pixel position implies,
// and every cell is renumbered 0..n-1 from there. The live preview runs the
// same function on the same inputs, so what the drop lands on is exactly what
// was previewed — no compaction pass, no round-trip between coordinate spaces.

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
// Vertical slack, in pixels, within which two cells count as "the same row"
// when a move drag is deciding where the dragged cell lands in the sequence.
// Half a row: past that the cursor has clearly committed to above/below, and
// inside it the column (x) is what orders them — which is what makes dragging
// a card sideways past its row neighbour reorder the two.
//
// Must stay under EDIT_MIN_HEIGHT_PX + GAP_PX (the closest two stacked cells
// can ever be in edit mode, which is the only mode a drag runs in). Above
// that, two cells in the SAME column could read as "same row," and a cell
// whose column ties would then re-rank itself on a zero-distance click.
const SAME_ROW_PX = ROW_HEIGHT_PX / 2;

// One arrow press, in the units the gesture already snaps to: a column on the
// horizontal axis, and on the vertical axis one sequence rank (move) or one
// row step (resize). Signs follow the pointer drag rather than the visual
// metaphor — dragging DOWN grows a cell and pushes it later in the sequence,
// so ArrowDown does both too.
const ARROW_STEPS = {
  ArrowLeft: { axis: 'x', delta: -1 },
  ArrowRight: { axis: 'x', delta: 1 },
  ArrowUp: { axis: 'y', delta: -1 },
  ArrowDown: { axis: 'y', delta: 1 },
};

// Keys that lift and drop a handle. ' ' is what every browser still in scope
// reports; 'Spacebar' is legacy IE/Edge and costs one array entry.
const GRAB_KEYS = ['Enter', ' ', 'Spacebar'];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getColWidth(containerWidth) {
  return (containerWidth - GAP_PX * (GRID_COLS - 1)) / GRID_COLS;
}

// Reading order: `order`, then column as a tiebreak. This is the order the
// single-column mobile stack renders in, the order `packVertically` consumes,
// and the order `reflowToOrder` renumbers. The x tiebreak only matters while a
// layout is momentarily sparse/duplicated (a widget appended by
// `reconcileGrid` before the next resequence) — a settled grid is dense.
function byReadingOrder(a, b) {
  return (a.order ?? 0) - (b.order ?? 0) || a.x - b.x;
}

// Renumber `order` densely from the current reading order. Every function that
// hands a grid back to the caller ends here, so the persisted sequence is
// always 0..n-1 with no gaps and no duplicates.
function resequence(items) {
  return [...items].sort(byReadingOrder).map((it, i) => ({ ...it, order: i }));
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
// why every commit refreshes it (see `withMeasuredHeights`).
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

// Refresh each item's `h` from the height the pack actually gave it. `h` is
// only a fallback now (first paint, and what a client too old to know about
// `fixedH` renders), so it would rot without this — every commit goes through
// here to keep the next cold load opening at roughly the right size. It is
// also what makes a resize gesture start where the card is DRAWN: grabbing the
// handle on an auto-height cell would otherwise snap it to a stale row count
// before the pointer had moved.
function withMeasuredHeights(items, rects) {
  return items.map((it) => {
    const rect = rects.get(it.id);
    if (!rect) return { ...it };
    return { ...it, h: pxToRows(rect.height) };
  });
}

// Where a cell dragged to pixel `top` in column `x` lands in the reading
// sequence: the number of other cells that sort before it. Cells clearly above
// or below (more than half a row away) are ordered by pixel position; cells on
// the same row are ordered by column.
function rankAtPixel(items, rects, movedId, top, x) {
  let rank = 0;
  for (const it of items) {
    if (it.id === movedId) continue;
    const otherTop = rects.get(it.id)?.top ?? 0;
    const before = otherTop < top - SAME_ROW_PX
      || (otherTop <= top + SAME_ROW_PX && it.x < x);
    if (before) rank += 1;
  }
  return rank;
}

// Re-insert `movedId` into the reading sequence at `rank`, then renumber.
// Both the live drag preview and the drop commit call this with the same
// inputs, so the preview is the outcome rather than an approximation of it.
function insertAtOrder(items, movedId, rank) {
  const moved = items.find((it) => it.id === movedId);
  if (!moved) return resequence(items);
  const rest = [...items].filter((it) => it.id !== movedId).sort(byReadingOrder);
  const next = [...rest.slice(0, rank), moved, ...rest.slice(rank)];
  return next.map((it, i) => ({ ...it, order: i }));
}

// Has the gesture actually moved the cell? Compares everything a drag can
// change — the column pair, the fallback height, and the sequence position.
function samePlacement(a, b) {
  return a.x === b.x && a.w === b.w && a.h === b.h && a.order === b.order;
}

// Fold the in-flight ghost back into the baseline. A move re-inserts at the
// ghost's rank and renumbers; a resize touches only that cell's w/h, so the
// sequence is left alone. `pin` marks the cell `fixedH` — always true while a
// resize is in flight (the drag, not the content, defines the height for the
// duration of the gesture) but only true on drop if the height really changed.
function applyGhost(baseline, kind, ghost, pin) {
  const swapped = baseline.map((it) => (it.id === ghost.id
    ? { ...it, ...ghost, ...(pin ? { fixedH: true } : {}) }
    : it));
  return kind === 'resize'
    ? resequence(swapped)
    : insertAtOrder(swapped, ghost.id, ghost.order);
}

// Advance a keyboard gesture's ghost by one arrow press. The clamps are the
// SAME ones the pointer path applies to its rounded pixel delta — a move stays
// inside the 12 columns and inside the sequence, a resize keeps MIN_W/MIN_H
// and cannot run off the right edge — so the two gestures can never reach a
// placement the other couldn't.
//
// `count` is how many cells are in the sequence; the last rank is count-1
// because a move re-INSERTS the cell rather than adding one.
//
// A step that would leave the grid comes back as the same values, so the
// caller can compare placements and skip both the re-render and the
// announcement rather than narrating a press that did nothing.
//
// The one deliberate divergence from the drag: a horizontal move step leaves
// `order` alone, where the pointer path re-derives it from `rankAtPixel` on
// every frame (which is what makes dragging a card sideways past its row
// neighbour swap the two). Here ↑/↓ owns the sequence outright, so "change
// columns, keep my place in the reading order" is expressible — and a press
// never has a second, unasked-for effect the user can't see coming.
export function stepGhost(kind, ghost, key, count) {
  const step = ARROW_STEPS[key];
  if (!step) return ghost;
  if (kind === 'move') {
    return step.axis === 'x'
      ? { ...ghost, x: clamp(ghost.x + step.delta, 0, GRID_COLS - ghost.w) }
      : { ...ghost, order: clamp(ghost.order + step.delta, 0, Math.max(0, count - 1)) };
  }
  return step.axis === 'x'
    ? { ...ghost, w: clamp(ghost.w + step.delta, MIN_W, GRID_COLS - ghost.x) }
    // No ceiling, same as the drag: the pack owns vertical space, so a tall
    // cell costs page height and nothing else.
    : { ...ghost, h: Math.max(MIN_H, ghost.h + step.delta) };
}

// What a screen reader hears. The registry label, not the raw id, and 1-based
// numbers because they're read aloud to a human counting columns.
function widgetLabel(item) {
  return WIDGETS_BY_ID[item.id]?.label ?? item.id;
}

function describePlacement(kind, ghost, count) {
  return kind === 'move'
    ? `column ${ghost.x + 1} of ${GRID_COLS}, position ${ghost.order + 1} of ${count}`
    : `${ghost.w} of ${GRID_COLS} columns wide, ${ghost.h} rows tall`;
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
//
// The two grid handles additionally pass `onKeyDown`/`grabbed`, which is what
// makes them toggle buttons rather than pointer-only affordances: `aria-pressed`
// is the idle/grabbed state, and the grid's live region narrates each step.
// `grabbed` stays undefined on the handles that are plain buttons (auto-fit) or
// already announce themselves through dnd-kit (reorder), so those keep their
// unpressed semantics.
function DragHandle({ kind, item, onPointerDown, onClick, onKeyDown, onBlur, grabbed, handleProps }) {
  const { label, Icon, size, className } = HANDLE_KINDS[kind];
  // The two states SWAP their surface/border/ink rather than layering a
  // grabbed set on top of the idle one: Tailwind emits utilities in its own
  // order, so `border-port-accent` and `border-port-border` in one class
  // string are decided by the stylesheet, not by which came last here — the
  // same trap `client/src/AGENTS.md` records for `inline-flex`.
  const stateClass = grabbed
    ? 'bg-port-accent/20 border-port-accent text-white ring-1 ring-port-accent'
    : 'bg-port-bg/90 border-port-border text-gray-300 hover:text-white hover:border-port-accent';
  return (
    <button
      type="button"
      onPointerDown={onPointerDown}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      aria-pressed={grabbed}
      // The registry label, not the raw id — this is read aloud.
      aria-label={`${label} ${widgetLabel(item)}`}
      className={`absolute z-20 border rounded ${stateClass} ${className}`}
      style={{ touchAction: 'none' }}
      {...handleProps}
    >
      <Icon size={size} aria-hidden="true" />
    </button>
  );
}

// Auto-place a new widget at the end of the reading sequence, left-aligned.
// Used when LayoutEditor adds a widget to a layout without specifying a
// position. The pack decides where "the end" actually renders.
function placeNewWidget(items, widgetId) {
  const meta = WIDGETS_BY_ID[widgetId];
  const w = WIDTH_TO_COLS[meta?.width] ?? 4;
  const h = meta?.defaultH ?? GRID_DEFAULT_H;
  const last = items.reduce((max, it) => Math.max(max, (it.order ?? 0) + 1), 0);
  return [...items, { id: widgetId, x: 0, w, h, order: last }];
}

// Row-flow items into the 12 columns following `orderedIds`, preserving
// each item's w/h and dropping anything not in the order. This is how a mobile
// reorder becomes a grid: the single-column stack has no columns to drop onto,
// so the new stack order is re-flowed into fresh x positions and a fresh
// sequence. Items that already sit in flow order (the common case) come back
// unchanged.
export function reflowToOrder(items, orderedIds = items.map((it) => it.id)) {
  const byId = new Map(items.map((it) => [it.id, it]));
  const flowed = [];
  let cursorX = 0;
  for (const id of orderedIds) {
    const item = byId.get(id);
    if (!item) continue;
    const w = Math.min(item.w, GRID_COLS);
    // Wrap to a fresh row when the widget no longer fits beside its
    // predecessor. There is no row COORDINATE to advance — the pack derives
    // the row from the sequence — only the column cursor to reset.
    if (cursorX + w > GRID_COLS) cursorX = 0;
    flowed.push({ ...item, x: cursorX, w, order: flowed.length });
    cursorX += w;
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
  // Either way the sequence comes back dense — `reflowToOrder` renumbers from
  // the list, and `resequence` closes the gaps that dropping entries leaves
  // (appending can also duplicate the last index) — so callers never have to
  // care.
  return reorder ? reflowToOrder(kept, visibleIds) : resequence(kept);
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
  suppressTransition, onStartGridDrag, onHandleKeyDown, onHandleBlur, grabbedKind,
  onClearFixedHeight, onMeasure, renderItem,
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
            <DragHandle
              kind="move"
              item={item}
              onPointerDown={(e) => onStartGridDrag(e, item, 'move')}
              onKeyDown={(e) => onHandleKeyDown(e, item, 'move')}
              onBlur={() => onHandleBlur(item, 'move')}
              grabbed={grabbedKind === 'move'}
            />
            <DragHandle
              kind="resize"
              item={item}
              onPointerDown={(e) => onStartGridDrag(e, item, 'resize')}
              onKeyDown={(e) => onHandleKeyDown(e, item, 'resize')}
              onBlur={() => onHandleBlur(item, 'resize')}
              grabbed={grabbedKind === 'resize'}
            />
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
  // `drag` is `{ kind, baseline, baseRects, ghost }`. `baseline` is the layout
  // as it stood when the gesture started with its `h` refreshed from the
  // measurement (see `withMeasuredHeights`), and `baseRects` the pixel rects
  // the pack had produced for it. Everything the drag reasons about — the
  // ghost's rank, the live preview, the committed grid — is relative to that
  // frozen snapshot, never to the live rects, which the preview itself moves.
  // `ghost` stays a plain grid item so the commit can spread it straight on.
  const dragRef = useRef(null);
  const [drag, setDrag] = useState(null);
  // Measured natural heights, px, keyed by widget id.
  const [heights, setHeights] = useState({});
  // What the grid's live region currently says. Only the keyboard gesture
  // writes it: a pointer drag is already visible to the person doing it, and
  // narrating 60 snaps a second would flood the speech queue.
  const [announcement, setAnnouncement] = useState('');

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
  // show that height and not the content's. `applyGhost` is shared with the
  // drop commit, so the preview IS the outcome rather than a lookalike of it.
  const previewItems = useMemo(() => {
    if (!drag) return ordered;
    return applyGhost(drag.baseline, drag.kind, drag.ghost, drag.kind === 'resize');
  }, [ordered, drag]);

  const rects = useMemo(
    () => (isMobile ? new Map() : packVertically(previewItems, heights, editable ? EDIT_MIN_HEIGHT_PX : 0)),
    [isMobile, previewItems, heights, editable]
  );
  // Read by the drag handlers, which must not re-bind every time a widget
  // re-measures (that would churn every memoized cell mid-gesture).
  //
  // Held at the SETTLED pack while a gesture is live: `rects` packs
  // `previewItems`, which folds the ghost in. Both readers below want where the
  // cards really are, not where the preview is drawing them. A keyboard grab is
  // modal and stays open indefinitely, so a pointer drag on a sibling handle
  // (or a pin release) can land mid-gesture and would otherwise compute its
  // rank against displaced tops and commit a card to the wrong slot.
  const rectsRef = useRef(rects);
  if (!drag) rectsRef.current = rects;

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

  // Freeze everything a gesture reasons about, whatever started it. The ghost
  // has to begin exactly where the card is DRAWN (grabbing the resize handle
  // on an auto-height cell would otherwise snap it to a stale row count before
  // the first step), and the rank math has to compare against positions the
  // preview isn't simultaneously shifting.
  const beginGesture = useCallback((item, kind) => {
    const baseRects = rectsRef.current;
    const baseline = withMeasuredHeights(items, baseRects);
    const found = baseline.find((it) => it.id === item.id) ?? item;
    // A resize gesture's floor applies to where it STARTS too. Without it, a
    // cell measuring under MIN_H rows (a widget rendering little or nothing)
    // has its height "changed" by the clamp alone — so a purely horizontal
    // drag would silently pin it.
    //
    // A move's start is expressed as the rank the cell ALREADY reads at, not
    // its stored `order`. The two can differ: the pack places in sequence, but
    // a cell sharing no column with any predecessor lands at the top anyway,
    // so a later `order` can be DRAWN above an earlier one. Comparing a
    // pixel-derived rank against a stored one there would "reorder" a card on
    // a plain click of the handle — a write with nothing behind it.
    const startTop = baseRects.get(item.id)?.top ?? 0;
    const startItem = kind === 'resize'
      ? { ...found, h: Math.max(MIN_H, found.h) }
      : { ...found, order: rankAtPixel(baseline, baseRects, item.id, startTop, found.x) };
    return { id: item.id, kind, baseline, baseRects, startTop, startItem, ghost: { ...startItem } };
  }, [items]);

  // Fold the gesture in `dragRef` back into the layout, then clear it. Shared
  // by the pointer drop and the keyboard commit so "what a gesture writes" has
  // exactly one definition; returns whether anything was actually written.
  const finishGesture = useCallback((commit) => {
    const gesture = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!gesture || !commit) return false;
    // Skip the write entirely when nothing actually changed — avoids a 200 OK
    // on every accidental click of the drag handle.
    if (samePlacement(gesture.startItem, gesture.ghost)) return false;
    // A resize that actually changed the HEIGHT is the user declaring one:
    // pin it. A width-only resize (or a move) leaves the cell auto-sized.
    const pins = gesture.kind === 'resize' && gesture.ghost.h !== gesture.startItem.h;
    onChange(applyGhost(gesture.baseline, gesture.kind, gesture.ghost, pins));
    return true;
  }, [onChange]);

  const startDrag = useCallback((e, item, kind) => {
    if (!editable || isMobile) return;
    // Prevent text selection mid-drag. preventDefault on the handle's
    // pointerdown is enough because the listener lives on window and we
    // never let the pointer leave the gesture.
    e.preventDefault();
    e.stopPropagation();
    const gesture = beginGesture(item, kind);
    dragRef.current = { ...gesture, startPointer: { x: e.clientX, y: e.clientY } };
    setDrag({ kind, baseline: gesture.baseline, baseRects: gesture.baseRects, ghost: { ...gesture.startItem } });
  }, [editable, isMobile, beginGesture]);

  // Enter/Space lifts a handle, the arrows step it, Enter/Space drops it and
  // Escape puts it back — the same state machine dnd-kit gives the mobile
  // reorder handle, so the two gestures feel like one feature.
  const handleKeyDown = useCallback((e, item, kind) => {
    if (!editable || isMobile) return;
    // A chord belongs to the browser or the app, not to this handle — ⌘←
    // navigates back, ⌥↑ jumps a paragraph. Only the bare key is a gesture.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const gesture = dragRef.current;
    const grabbed = Boolean(gesture?.keyboard) && gesture.id === item.id && gesture.kind === kind;
    const count = items.length;

    if (GRAB_KEYS.includes(e.key)) {
      // Suppress the button's own activation: Enter/Space on a <button> would
      // otherwise fire a click straight after this, and the grab toggle would
      // cancel itself.
      e.preventDefault();
      e.stopPropagation();
      if (!grabbed) {
        const next = beginGesture(item, kind);
        dragRef.current = { ...next, keyboard: true };
        setDrag({ kind, keyboard: true, baseline: next.baseline, baseRects: next.baseRects, ghost: { ...next.startItem } });
        setAnnouncement(`${widgetLabel(item)} grabbed. ${describePlacement(kind, next.startItem, count)}. Use the arrow keys, then Enter to place or Escape to cancel.`);
        return;
      }
      const placed = finishGesture(true);
      setAnnouncement(`${widgetLabel(item)} ${kind === 'resize' ? 'resized' : 'placed'}. ${placed ? describePlacement(kind, gesture.ghost, count) : 'Unchanged'}.`);
      return;
    }

    if (!grabbed) return;

    if (e.key === 'Escape') {
      // Nothing was written, so dropping the gesture IS the restore — and the
      // stop keeps Escape from also leaving Arrange mode behind our back.
      e.preventDefault();
      e.stopPropagation();
      finishGesture(false);
      setAnnouncement(`${widgetLabel(item)} returned to its original position.`);
      return;
    }

    if (!ARROW_STEPS[e.key]) return;
    // Claim the arrow before the page scrolls under the grabbed cell.
    e.preventDefault();
    e.stopPropagation();
    const next = stepGhost(kind, gesture.ghost, e.key, count);
    // A step clamped at an edge changes nothing — say nothing and re-render
    // nothing rather than repeating the last position back at the user.
    if (samePlacement(gesture.ghost, next)) return;
    gesture.ghost = next;
    setDrag((prev) => (prev ? { ...prev, ghost: { ...next } } : prev));
    setAnnouncement(`${describePlacement(kind, next, count)}.`);
  }, [editable, isMobile, items, beginGesture, finishGesture]);

  // Tabbing (or clicking) away from a grabbed handle abandons the gesture
  // rather than leaving a ghost the user can no longer steer. Scoped to the
  // handle that actually holds the grab, so starting a POINTER drag on a
  // sibling handle — whose pointerdown lands before this blur — isn't undone
  // by it.
  const handleBlur = useCallback((item, kind) => {
    const gesture = dragRef.current;
    if (!gesture?.keyboard || gesture.id !== item.id || gesture.kind !== kind) return;
    finishGesture(false);
    setAnnouncement(`${widgetLabel(item)} returned to its original position.`);
  }, [finishGesture]);

  // A keyboard grab is modal, so it can still be open when the grid leaves the
  // mode that offers it — Save/Cancel on the Arrange toolbar, or a rotation
  // crossing the mobile breakpoint. The handles simply unmount, which fires no
  // blur, so without this the abandoned ghost keeps overriding the preview and
  // the grid goes on drawing a placement the user already cancelled.
  useEffect(() => {
    if (editable && !isMobile) return;
    if (dragRef.current) finishGesture(false);
  }, [editable, isMobile, finishGesture]);

  // The handle keeps focus while the cell travels under it, so the browser has
  // no focus change to scroll to — stepping a widget down a tall dashboard
  // would otherwise walk it past the fold with nothing to look at. `nearest`
  // is a no-op while the cell is already on screen. Keyboard only: a pointer
  // drag is anchored to a cursor the user can already see.
  useEffect(() => {
    if (!drag?.keyboard) return;
    containerRef.current
      ?.querySelector(`[data-widget-id="${drag.ghost.id}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [drag, containerRef]);

  useEffect(() => {
    // A keyboard grab drives itself from the handle's own keydown — installing
    // the window pointer listeners for it would let a click anywhere on the
    // page drop the cell.
    if (!drag || drag.keyboard) return undefined;
    const colWidth = getColWidth(containerWidth);
    // Both are fixed for the life of the gesture, and this effect re-installs
    // exactly when one starts — so capturing them here can't go stale, and the
    // per-snap `setDrag` doesn't have to re-bind the window listeners.
    const { kind, baseline, baseRects } = drag;
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
        // Vertical is read straight off the pointer in pixels and turned into
        // a rank — there is no row coordinate to snap to, and the cursor and
        // the card therefore travel at the same speed.
        const top = gesture.startTop + dy;
        const order = rankAtPixel(baseline, baseRects, gesture.id, top, newX);
        next = { ...start, x: newX, order };
      } else {
        const newW = Math.max(MIN_W, Math.min(GRID_COLS - start.x, Math.round(start.w + dx / colStep)));
        const newH = Math.max(MIN_H, Math.round(start.h + dy / ROW_STEP_PX));
        next = { ...start, w: newW, h: newH };
      }
      // Snap dedup: pointermove fires at 200+ Hz, but `next` only changes
      // when the cursor crosses a snap boundary. Skip the React update
      // when we're still inside the same snap cell — saves ~60 widget
      // re-renders per drag and keeps the rAF callback a no-op.
      if (samePlacement(gesture.ghost, next)) return;
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
      finishGesture(commit);
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
  // The mode key re-installs the listeners only when a POINTER gesture
  // starts/ends, never on a snap — pointermove writes dragRef.current
  // directly, and the `kind`/`baseline` captured above are gesture-constant.
  // A keyboard grab is its own mode, so switching between the two re-runs
  // this instead of leaving the wrong listeners bound.
  }, [drag ? (drag.keyboard ? 'keyboard' : 'pointer') : 'idle', finishGesture, containerWidth]);

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
    const next = withMeasuredHeights(items, rectsRef.current).map((it) => {
      if (it.id !== item.id) return it;
      // Drop the pin by omission rather than whitelisting the fields to keep,
      // so a field added to the grid item later doesn't get eaten here.
      const { fixedH: _pinned, ...rest } = it;
      return rest;
    });
    onChange(resequence(next));
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
                onHandleKeyDown={handleKeyDown}
                onHandleBlur={handleBlur}
                grabbedKind={drag?.keyboard && drag.ghost.id === item.id ? drag.kind : null}
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

          {/* Where a keyboard gesture narrates itself. The pointer drag is
              already visible to whoever is doing it; an arrow step is not, so
              this is the only feedback that says a press landed. `polite` so
              a fast run of arrow presses queues behind the current utterance
              instead of cutting it off. */}
          <div role="status" aria-live="polite" className="sr-only">{announcement}</div>
        </div>
      </SortableContext>
    </DndContext>
  );
}
