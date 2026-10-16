import { useLayoutEffect, useMemo, useRef, useState } from 'react';

const OVERSCAN_ROWS = 2;
const GAP = 12;

/** A measured row window: loaded records stay in the page, cards stay near the viewport. */
export default function MediaHistoryGrid({ items, children }) {
  const rootRef = useRef(null);
  const heights = useRef(new Map());
  const previousGeometry = useRef(null);
  const restoreFocus = useRef(null);
  const scrollerRef = useRef(null);
  const [layout, setLayout] = useState({ columns: 2, width: 0, top: 0, height: 800, revision: 0 });
  const [focusedKey, setFocusedKey] = useState(null);
  const rows = Math.ceil(items.length / layout.columns);
  const estimate = layout.width ? (layout.width - GAP * (layout.columns - 1)) / layout.columns + 270 : 460;
  const rowKeys = useMemo(() => Array.from({ length: rows }, (_, row) => items.slice(row * layout.columns, (row + 1) * layout.columns).map(item => item.key)), [items, rows, layout.columns]);
  const offsets = useMemo(() => {
    const values = [0];
    for (let row = 0; row < rows; row++) values.push(values[row] + Math.max(...rowKeys[row].map(key => heights.current.get(key) ?? estimate)) + GAP);
    return values;
  }, [rows, rowKeys, estimate, layout.revision]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    let scroller = root.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    scrollerRef.current = scroller;
    const scrollTarget = scroller || window;
    let frame;
    const measure = () => {
      const rect = root.getBoundingClientRect();
      const view = scroller?.getBoundingClientRect();
      const columns = getComputedStyle(root).gridTemplateColumns.split(' ').filter(Boolean).length || 2;
      const width = rect.width;
      setLayout(previous => {
        const resized = previous.width !== width || previous.columns !== columns;
        if (resized) heights.current.clear();
        const next = { columns, width, top: (view?.top || 0) - rect.top, height: scroller?.clientHeight || window.innerHeight,
          revision: previous.revision + (resized ? 1 : 0) };
        return Object.keys(next).every(key => next[key] === previous[key]) ? previous : next;
      });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    if (scroller) observer.observe(scroller);
    scrollTarget.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    measure();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      scrollTarget.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, []);

  useLayoutEffect(() => {
    const keys = new Set(items.map(item => item.key));
    for (const key of heights.current.keys()) if (!keys.has(key)) heights.current.delete(key);
    const observer = new ResizeObserver(entries => {
      let changed = false;
      for (const { target } of entries) {
        const height = target.getBoundingClientRect().height;
        if (height > 0 && heights.current.get(target.dataset.mediaKey) !== height) {
          heights.current.set(target.dataset.mediaKey, height);
          changed = true;
        }
      }
      if (changed) setLayout(previous => ({ ...previous, revision: previous.revision + 1 }));
    });
    for (const row of rootRef.current.querySelectorAll('[data-media-key]')) observer.observe(row);
    return () => observer.disconnect();
  });

  useLayoutEffect(() => {
    const previous = previousGeometry.current;
    if (previous && previous.top === layout.top) {
      let row = 0;
      while (row < previous.offsets.length - 2 && previous.offsets[row + 1] < Math.max(0, previous.top)) row++;
      const anchor = previous.items[row * previous.columns]?.key;
      const index = items.findIndex(item => item.key === anchor);
      if (index !== -1) {
        const delta = offsets[Math.floor(index / layout.columns)] - previous.offsets[row];
        if (delta) {
          if (scrollerRef.current) scrollerRef.current.scrollTop += delta;
          else window.scrollBy(0, delta);
          setLayout(value => ({ ...value, top: value.top + delta }));
        }
      }
    }
    previousGeometry.current = { items, offsets, top: layout.top, columns: layout.columns };
    const focus = restoreFocus.current;
    if (focus && !focus.element.isConnected && [document.body, rootRef.current].includes(document.activeElement)) {
      const card = [...rootRef.current.querySelectorAll('[data-media-key]')].find(element => element.dataset.mediaKey === focus.key);
      const control = card?.querySelectorAll('button, a, input, select, textarea')[focus.control];
      restoreFocus.current = null;
      (control || rootRef.current).focus({ preventScroll: true });
    }
  }, [items, offsets, layout.top, layout.columns]);

  let first = 0;
  while (first < rows - 1 && offsets[first + 1] < layout.top) first++;
  let last = first;
  while (last < rows - 1 && offsets[last] < layout.top + layout.height) last++;
  const mounted = new Set();
  for (let row = Math.max(0, first - OVERSCAN_ROWS); row <= Math.min(rows - 1, last + OVERSCAN_ROWS); row++) mounted.add(row);
  const focusedIndex = items.findIndex(item => item.key === focusedKey);
  if (focusedIndex !== -1) {
    const focusedRow = Math.floor(focusedIndex / layout.columns);
    // Neighbors let native Tab / Shift+Tab enter the next row even after scrolling away.
    for (let row = Math.max(0, focusedRow - 1); row <= Math.min(rows - 1, focusedRow + 1); row++) mounted.add(row);
  }
  const cardWidth = Math.max(0, (layout.width - GAP * (layout.columns - 1)) / layout.columns);
  return <div ref={rootRef} tabIndex={-1} data-media-history-grid data-loaded-items={items.length} data-window-start={first} data-columns={layout.columns} data-overscan-rows={OVERSCAN_ROWS}
    className="relative grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5"
    style={{ columnGap: GAP, height: Math.max(0, offsets[rows] - GAP), overflowAnchor: 'none' }}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) { setFocusedKey(null); restoreFocus.current = null; } }}>
    {items.flatMap((item, index) => {
      const row = Math.floor(index / layout.columns);
      if (!mounted.has(row)) return [];
      return <div key={item.key} data-media-key={item.key} data-media-row={row} className="absolute min-w-0"
        style={{ top: offsets[row], left: (index % layout.columns) * (cardWidth + GAP), width: cardWidth || '100%' }}
        onFocusCapture={event => {
          setFocusedKey(item.key);
          restoreFocus.current = { element: event.target, key: item.key, control: [...event.currentTarget.querySelectorAll('button, a, input, select, textarea')].indexOf(event.target) };
        }}>{children(item)}</div>;
    })}
  </div>;
}
