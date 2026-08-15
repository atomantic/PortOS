import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// Stub @dnd-kit/core's DndContext so drag-end can be fired imperatively. The
// real implementation needs DOM measurement + pointer sensors, which jsdom
// doesn't provide reliably — and the behavior under test is "what does the
// grid do when onDragEnd reports these ids," which is all driven through the
// callback captured here. Same shape as InfluenceChipsInput.test.jsx.
const dndState = { onDragEnd: null };

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, onDragEnd }) => {
    dndState.onDragEnd = onDragEnd;
    return <>{children}</>;
  },
  KeyboardSensor: function KeyboardSensorStub() {},
  PointerSensor: function PointerSensorStub() {},
  closestCenter: () => null,
  useSensor: () => null,
  useSensors: () => [],
}));

// Keep arrayMove real (the ordering invariant is the point) but stub the
// hook + provider, which need a live DndContext.
vi.mock('@dnd-kit/sortable', async () => {
  const actual = await vi.importActual('@dnd-kit/sortable');
  return {
    ...actual,
    SortableContext: ({ children }) => <>{children}</>,
    sortableKeyboardCoordinates: () => null,
    verticalListSortingStrategy: null,
    useSortable: ({ disabled }) => ({
      attributes: { 'data-sortable-disabled': String(Boolean(disabled)) },
      listeners: {},
      setNodeRef: () => {},
      transform: null,
      transition: null,
      isDragging: false,
    }),
  };
});

const DashboardGrid = (await import('./DashboardGrid.jsx')).default;
const {
  reflowToOrder, synthesizeGrid, reconcileGrid, readingOrderIds,
  packVertically, itemHeightPx, rowsToPx, pxToRows,
} = await import('./DashboardGrid.jsx');

// jsdom has no ResizeObserver, and useContainerWidth (which decides mobile vs
// desktop) depends on one. Stand in a fake reporting whatever width the test
// asked for.
let mockWidth = 1200;

class FakeResizeObserver {
  constructor(callback) { this.callback = callback; }
  observe() { this.callback([{ contentRect: { width: mockWidth } }]); }
  disconnect() {}
}

// jsdom does no layout, so every element reports offsetHeight 0 — and the grid
// now believes that ("renders nothing, so occupy nothing"). Give cells a
// height so the packing assertions below exercise the measured path instead of
// a collapsed one.
const MEASURED_PX = 100;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() { return MEASURED_PX; },
  });
  dndState.onDragEnd = null;
});

afterEach(() => {
  delete HTMLElement.prototype.offsetHeight;
});

const THREE = [
  { id: 'a', x: 0, y: 0, w: 12, h: 2 },
  { id: 'b', x: 0, y: 2, w: 12, h: 2 },
  { id: 'c', x: 0, y: 4, w: 12, h: 2 },
];

function renderGrid(items = THREE) {
  const onChange = vi.fn();
  render(
    <DashboardGrid
      items={items}
      editable
      onChange={onChange}
      renderItem={(item) => <div data-testid={`widget-${item.id}`}>{item.id}</div>}
    />
  );
  return onChange;
}

const cellFor = (id) => document.querySelector(`[data-widget-id="${id}"]`);

describe('reflowToOrder', () => {
  it('renumbers coordinates to match the requested order, keeping w/h', () => {
    const flowed = reflowToOrder(THREE, ['c', 'a', 'b']);
    expect(flowed.map((it) => it.id)).toEqual(['c', 'a', 'b']);
    expect(flowed.map((it) => it.y)).toEqual([0, 2, 4]);
    expect(flowed.every((it) => it.w === 12 && it.h === 2)).toBe(true);
  });

  it('packs items that fit side by side into the same row', () => {
    const items = [
      { id: 'a', x: 0, y: 0, w: 6, h: 3 },
      { id: 'b', x: 6, y: 0, w: 6, h: 2 },
      { id: 'c', x: 0, y: 3, w: 6, h: 2 },
    ];
    expect(reflowToOrder(items, ['b', 'a', 'c'])).toEqual([
      { id: 'b', x: 0, y: 0, w: 6, h: 2 },
      { id: 'a', x: 6, y: 0, w: 6, h: 3 },
      { id: 'c', x: 0, y: 3, w: 6, h: 2 },
    ]);
  });

  it('leaves an already-in-flow layout untouched, and defaults to the given order', () => {
    expect(reflowToOrder(THREE, ['a', 'b', 'c'])).toEqual(THREE);
    expect(reflowToOrder(THREE)).toEqual(THREE);
  });

  it('drops ids with no matching item and ignores items absent from the order', () => {
    expect(reflowToOrder(THREE, ['b', 'ghost'])).toEqual([{ id: 'b', x: 0, y: 0, w: 12, h: 2 }]);
  });

  it('still flows a widget whose stored width exceeds the grid', () => {
    expect(reflowToOrder([{ id: 'a', x: 0, y: 0, w: 20, h: 2 }], ['a']))
      .toEqual([{ id: 'a', x: 0, y: 0, w: 12, h: 2 }]);
  });
});

describe('row ↔ pixel conversion', () => {
  it('round-trips a row count through pixels', () => {
    for (const h of [1, 2, 5, 11]) expect(pxToRows(rowsToPx(h))).toBe(h);
  });

  it('never reports less than one row, even for a collapsed cell', () => {
    expect(pxToRows(0)).toBe(1);
    expect(pxToRows(-500)).toBe(1);
  });
});

describe('itemHeightPx', () => {
  const item = { id: 'a', x: 0, y: 0, w: 6, h: 4 };

  it('prefers the measured height so a short card stops reserving its whole slot', () => {
    expect(itemHeightPx(item, { a: 90 })).toBe(90);
  });

  it('falls back to the declared rows until a measurement lands', () => {
    expect(itemHeightPx(item, {})).toBe(rowsToPx(4));
  });

  // Several widgets render nothing on empty data. Treating that 0 as "not
  // measured yet" would hand the widget back its whole declared slot — the
  // dead band this grid exists to reclaim, in the case where the reclaim is
  // total. So the sentinel is presence, not truthiness.
  it('honors a measured zero instead of reading it as "not measured yet"', () => {
    expect(itemHeightPx(item, { a: 0 })).toBe(0);
  });

  it('ignores the measurement for a cell whose height the user pinned', () => {
    expect(itemHeightPx({ ...item, fixedH: true }, { a: 90 })).toBe(rowsToPx(4));
  });
});

describe('packVertically', () => {
  it('floats a cell up into the space a shorter neighbour left behind', () => {
    // b is declared 4 rows tall but only measures 100px — c must rise to just
    // under b rather than sitting at b's declared bottom edge.
    const rects = packVertically(
      [
        { id: 'b', x: 0, y: 0, w: 12, h: 4 },
        { id: 'c', x: 0, y: 4, w: 12, h: 2 },
      ],
      { b: 100, c: 100 }
    );
    expect(rects.get('b')).toEqual({ top: 0, height: 100 });
    expect(rects.get('c')).toEqual({ top: 116, height: 100 });
  });

  it('only stacks cells that share a column', () => {
    const rects = packVertically([
      { id: 'left', x: 0, y: 0, w: 6, h: 2 },
      { id: 'right', x: 6, y: 0, w: 6, h: 2 },
      { id: 'under', x: 6, y: 2, w: 6, h: 2 },
    ], { left: 400, right: 100, under: 100 });
    // `right` is beside `left`, not below it — a tall left column must not
    // push the whole right-hand stack down.
    expect(rects.get('right').top).toBe(0);
    expect(rects.get('under').top).toBe(116);
  });

  it('lets a widget that renders nothing occupy nothing, and closes over it', () => {
    const rects = packVertically([
      { id: 'empty', x: 0, y: 0, w: 12, h: 5 },
      { id: 'below', x: 0, y: 5, w: 12, h: 2 },
    ], { empty: 0, below: 100 });
    expect(rects.get('empty').height).toBe(0);
    expect(rects.get('below').top).toBe(16);
  });

  it('floors cells to a grabbable height when edit mode asks for one', () => {
    const rects = packVertically(
      [{ id: 'empty', x: 0, y: 0, w: 12, h: 5 }, { id: 'below', x: 0, y: 5, w: 12, h: 2 }],
      { empty: 0, below: 100 },
      48
    );
    expect(rects.get('empty').height).toBe(48);
    expect(rects.get('below').top).toBe(64);
  });

  it('clears every cell it overlaps, not just the last one placed', () => {
    const rects = packVertically([
      { id: 'a', x: 0, y: 0, w: 4, h: 2 },
      { id: 'b', x: 4, y: 0, w: 4, h: 2 },
      { id: 'wide', x: 0, y: 2, w: 8, h: 2 },
    ], { a: 300, b: 100, wide: 100 });
    expect(rects.get('wide').top).toBe(316);
  });
});

describe('readingOrderIds', () => {
  it('sorts top-to-bottom then left-to-right without mutating the input', () => {
    const grid = [
      { id: 'c', x: 0, y: 4, w: 6, h: 2 },
      { id: 'b', x: 6, y: 0, w: 6, h: 2 },
      { id: 'a', x: 0, y: 0, w: 6, h: 2 },
    ];
    expect(readingOrderIds(grid)).toEqual(['a', 'b', 'c']);
    expect(grid[0].id).toBe('c');
  });
});

describe('synthesizeGrid', () => {
  it('skips ids that are not registered widgets', () => {
    expect(synthesizeGrid(['not-a-widget'])).toEqual([]);
  });
});

describe('reconcileGrid', () => {
  it('drops hidden widgets and appends newly visible ones', () => {
    expect(reconcileGrid(THREE, ['a', 'c']).map((it) => it.id)).toEqual(['a', 'c']);
  });

  // The arranged layout below deliberately disagrees with its widget list: `b`
  // sits above `a` in the grid while the list still says `['a','b','c']`, which
  // is exactly the pre-`saveGridEdit` state #4132 warns about.
  const ARRANGED = [
    { id: 'b', x: 0, y: 0, w: 6, h: 3 },
    { id: 'a', x: 6, y: 0, w: 6, h: 2 },
    { id: 'c', x: 0, y: 3, w: 12, h: 2 },
  ];

  it('leaves an arranged grid alone when the save is not a reorder', () => {
    expect(reconcileGrid(ARRANGED, ['a', 'b', 'c'])).toEqual(ARRANGED);
    expect(reconcileGrid(ARRANGED, ['a', 'b', 'c'], {})).toEqual(ARRANGED);
    // A caller forwarding a `reordered` it never received must not re-flow.
    expect(reconcileGrid(ARRANGED, ['a', 'b', 'c'], { reorder: undefined })).toEqual(ARRANGED);
    expect(reconcileGrid(ARRANGED, ['a', 'b', 'c'], { reorder: false })).toEqual(ARRANGED);
  });

  it('re-flows to the widget order when the caller says the save IS a reorder', () => {
    const next = reconcileGrid(THREE, ['b', 'a', 'c'], { reorder: true });
    expect(readingOrderIds(next)).toEqual(['b', 'a', 'c']);
    expect(next.map((it) => it.h)).toEqual([2, 2, 2]);
  });

  it('re-flows a widget added in the same reorder save', () => {
    const next = reconcileGrid(THREE, ['c', 'a', 'apps', 'b'], { reorder: true });
    expect(readingOrderIds(next)).toEqual(['c', 'a', 'apps', 'b']);
  });
});

describe('DashboardGrid mobile reorder', () => {
  beforeEach(() => { mockWidth = 400; });

  it('exposes a reorder handle per widget, and no grid move/resize handles', () => {
    renderGrid();
    expect(screen.getByLabelText('Reorder a')).toBeInTheDocument();
    expect(screen.getByLabelText('Reorder c')).toBeInTheDocument();
    expect(screen.queryByLabelText('Move a')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Resize a')).not.toBeInTheDocument();
  });

  it('enables the sortable so the handle can actually start a drag', () => {
    renderGrid();
    expect(screen.getByLabelText('Reorder a')).toHaveAttribute('data-sortable-disabled', 'false');
  });

  it('reflows the grid to the new order when a widget is dropped on another', () => {
    const onChange = renderGrid();
    dndState.onDragEnd({ active: { id: 'a' }, over: { id: 'c' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next.map((it) => it.id)).toEqual(['b', 'c', 'a']);
    expect(next.map((it) => it.y)).toEqual([0, 2, 4]);
  });

  it('reads the drag against reading order, not grid-array order', () => {
    // placeAndCompact hoists the moved item to the front of the array, so a
    // saved grid routinely arrives out of visual order.
    const onChange = renderGrid([
      { id: 'c', x: 0, y: 4, w: 12, h: 2 },
      { id: 'a', x: 0, y: 0, w: 12, h: 2 },
      { id: 'b', x: 0, y: 2, w: 12, h: 2 },
    ]);
    expect(screen.getAllByTestId(/^widget-/).map((el) => el.textContent)).toEqual(['a', 'b', 'c']);

    dndState.onDragEnd({ active: { id: 'c' }, over: { id: 'a' } });
    expect(onChange.mock.calls[0][0].map((it) => it.id)).toEqual(['c', 'a', 'b']);
  });

  it('does not write when the drag ends on itself or outside the list', () => {
    const onChange = renderGrid();
    dndState.onDragEnd({ active: { id: 'a' }, over: { id: 'a' } });
    dndState.onDragEnd({ active: { id: 'a' }, over: null });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('DashboardGrid desktop', () => {
  beforeEach(() => { mockWidth = 1200; });

  it('keeps the move/resize handles and hides the reorder handle', () => {
    renderGrid();
    expect(screen.getByLabelText('Move a')).toBeInTheDocument();
    expect(screen.getByLabelText('Resize a')).toBeInTheDocument();
    expect(screen.queryByLabelText('Reorder a')).not.toBeInTheDocument();
  });
});

describe('DashboardGrid cell sizing', () => {
  beforeEach(() => { mockWidth = 1200; });

  // Every cell is laid out at exactly the height the pack assigned it — an
  // auto cell that sized itself would overlap its neighbours for every frame
  // its content was taller than the last measurement.
  it('lays every cell out at its MEASURED height, not its declared rows', () => {
    // All three declare h:2 (176px) but measure 100px.
    renderGrid();
    expect(cellFor('a').style.height).toBe(`${MEASURED_PX}px`);
    expect(cellFor('a').style.top).toBe('0px');
    expect(cellFor('b').style.top).toBe(`${MEASURED_PX + 16}px`);
    expect(cellFor('c').style.top).toBe(`${(MEASURED_PX + 16) * 2}px`);
  });

  it('measures the widget free of the cell height, and stretches it when pinned', () => {
    renderGrid([
      { id: 'a', x: 0, y: 0, w: 12, h: 3 },
      { id: 'b', x: 0, y: 3, w: 12, h: 3, fixedH: true },
    ]);
    const measured = (id) => screen.getByTestId(`widget-${id}`).parentElement;
    expect(measured('a').className).toBe('flow-root');
    expect(measured('b').className).toBe('h-full flow-root');
  });

  it('honors an explicit height on a cell the user pinned', () => {
    renderGrid([{ id: 'a', x: 0, y: 0, w: 12, h: 3, fixedH: true }]);
    expect(cellFor('a').style.height).toBe(`${rowsToPx(3)}px`);
  });

  it('offers the auto-fit handle only on pinned cells', () => {
    renderGrid([
      { id: 'a', x: 0, y: 0, w: 12, h: 3, fixedH: true },
      { id: 'b', x: 0, y: 3, w: 12, h: 3 },
    ]);
    expect(screen.getByLabelText('Auto-fit height a')).toBeInTheDocument();
    expect(screen.queryByLabelText('Auto-fit height b')).not.toBeInTheDocument();
  });

  it('drops the pin — and keeps the last height as the new starting size — on auto-fit', () => {
    const onChange = renderGrid([
      { id: 'a', x: 0, y: 0, w: 12, h: 3, fixedH: true },
      { id: 'b', x: 0, y: 3, w: 12, h: 3 },
    ]);
    fireEvent.click(screen.getByLabelText('Auto-fit height a'));
    const next = onChange.mock.calls[0][0];
    expect(next.find((it) => it.id === 'a')).toEqual({ id: 'a', x: 0, y: 0, w: 12, h: 3 });
    expect(next.find((it) => it.id === 'b').fixedH).toBeUndefined();
  });
});

describe('DashboardGrid resize pins the height', () => {
  beforeEach(() => { mockWidth = 1200; });

  // One row step is ROW_HEIGHT_PX + GAP_PX; the drag rounds to it.
  const ROW_STEP = rowsToPx(2) - rowsToPx(1);

  const dragHandle = (label, { dx = 0, dy = 0 }) => {
    fireEvent.pointerDown(screen.getByLabelText(label), { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: dx, clientY: dy });
    fireEvent.pointerUp(window);
  };

  it('marks a cell fixedH once the user drags a height onto it', () => {
    const onChange = renderGrid();
    dragHandle('Resize a', { dy: ROW_STEP * 2 });
    const moved = onChange.mock.calls[0][0].find((it) => it.id === 'a');
    expect(moved.h).toBe(4);
    expect(moved.fixedH).toBe(true);
  });

  it('leaves a width-only resize auto-sized', () => {
    const onChange = renderGrid([{ id: 'a', x: 0, y: 0, w: 12, h: 2 }]);
    // Narrow by four columns; the height never moves.
    dragHandle('Resize a', { dx: -4 * (1200 - 16 * 11) / 12 - 4 * 16 });
    const moved = onChange.mock.calls[0][0].find((it) => it.id === 'a');
    expect(moved.w).toBe(8);
    expect(moved.fixedH).toBeUndefined();
  });

  it('leaves a move auto-sized', () => {
    const onChange = renderGrid();
    dragHandle('Move c', { dy: -ROW_STEP * 4 });
    expect(onChange).toHaveBeenCalled();
    for (const it of onChange.mock.calls[0][0]) expect(it.fixedH).toBeUndefined();
  });
});

describe('DashboardGrid scroll target', () => {
  beforeEach(() => { mockWidth = 1200; });

  // The Dashboard scrolls a just-added widget into view by querying
  // [data-widget-id="…"]; that attribute is the scroll-target contract.
  it('tags each cell with its widget id', () => {
    renderGrid();
    expect(document.querySelector('[data-widget-id="a"]')).not.toBeNull();
    expect(document.querySelector('[data-widget-id="b"]')).not.toBeNull();
    expect(document.querySelector('[data-widget-id="c"]')).not.toBeNull();
  });
});
