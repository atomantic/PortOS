/**
 * Drag-to-resize split-pane width persisted to `localStorage`.
 *
 * Returns `{ containerRef, width, maxWidth, onMouseDown, onKeyDown, reset }` and caps the drag at `maxFraction`
 * of the measured container. Use when: A desktop sidebar/split pane with a draggable divider
 * (WorkEditor's storyboard sidebar).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { safeReadStorage, safeWriteStorage } from '../../lib/safeStorage';

const KEY_STEP = 24;
const KEY_STEP_LARGE = 64;

// useSidebarResize — drag-to-resize state for a desktop split pane whose width
// is persisted to localStorage.
//
// Extracted from WorkEditor (#3387). The caller renders the drag handle and
// wires `onMouseDown` / `onDoubleClick` (→ `reset`) to it, spreads `width` onto
// the sidebar, and attaches `containerRef` to the flex container the sidebar
// lives in — the container's measured width is what caps the drag, so the
// sidebar can never eat more than `maxFraction` of the split.
//
// The window mousemove/mouseup listeners bind ONCE (empty deps) and read the
// live config out of a ref. Re-binding them mid-drag would run the cleanup,
// which drops `dragStartRef` and strips the body cursor override — i.e. the
// drag would silently die if any option identity changed while the mouse was
// down.
export default function useSidebarResize({
  storageKey,
  defaultWidth,
  minWidth,
  maxFraction = 0.6,
}) {
  const [width, setWidth] = useState(() => {
    const raw = safeReadStorage(storageKey);
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n >= minWidth ? n : defaultWidth;
  });
  const [maxWidth, setMaxWidth] = useState(() => Math.max(minWidth + 1, width));

  const containerRef = useRef(null);
  const widthRef = useRef(width);
  useEffect(() => { widthRef.current = width; }, [width]);
  const dragStartRef = useRef(null);

  // Live mirror of the options so the window listeners can stay bound once.
  const configRef = useRef({ storageKey, minWidth, maxFraction });
  configRef.current = { storageKey, minWidth, maxFraction };

  const persist = useCallback((next) => {
    safeWriteStorage(configRef.current.storageKey, String(Math.round(next)));
  }, []);

  const updateBounds = useCallback(() => {
    const containerWidth = containerRef.current?.getBoundingClientRect().width ?? 0;
    if (!containerWidth) return;
    const max = Math.max(minWidth + 1, containerWidth * maxFraction);
    setMaxWidth(max);
    setWidth((prev) => Math.min(max, Math.max(minWidth, prev)));
  }, [maxFraction, minWidth]);

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !containerRef.current) return undefined;
    const observer = new ResizeObserver(updateBounds);
    observer.observe(containerRef.current);
    updateBounds();
    return () => observer.disconnect();
  }, [updateBounds]);

  const onMouseDown = useCallback((e) => {
    e.preventDefault();
    const containerWidth = containerRef.current?.getBoundingClientRect().width ?? 0;
    const { minWidth: min, maxFraction: frac } = configRef.current;
    const max = Math.max(min + 1, containerWidth * frac);
    const startWidth = Math.min(max, Math.max(min, widthRef.current));
    setMaxWidth(max);
    if (startWidth !== widthRef.current) {
      widthRef.current = startWidth;
      setWidth(startWidth);
    }
    dragStartRef.current = { startX: e.clientX, startWidth, containerWidth };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const onMove = (e) => {
      if (!dragStartRef.current) return;
      const { startX, startWidth, containerWidth } = dragStartRef.current;
      const { minWidth: min, maxFraction: frac } = configRef.current;
      const max = Math.max(min + 1, containerWidth * frac);
      const next = Math.min(max, Math.max(min, startWidth - (e.clientX - startX)));
      setWidth(next);
    };
    const onUp = () => {
      if (!dragStartRef.current) return;
      dragStartRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      safeWriteStorage(configRef.current.storageKey, String(Math.round(widthRef.current)));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (dragStartRef.current) {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        dragStartRef.current = null;
      }
    };
  }, []);

  // Double-click the handle to restore the default width.
  const reset = useCallback(() => {
    setWidth(defaultWidth);
    persist(defaultWidth);
  }, [defaultWidth, persist]);

  // Keyboard-operable splitter (ARIA window-splitter pattern). The sidebar is
  // on the right, so ArrowLeft moves the divider left and WIDENS it.
  const onKeyDown = useCallback((e) => {
    const { minWidth: min, maxFraction: frac } = configRef.current;
    const containerWidth = containerRef.current?.getBoundingClientRect().width ?? 0;
    const max = containerWidth ? Math.max(min + 1, containerWidth * frac) : Math.max(min + 1, widthRef.current);
    const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    let next;
    if (e.key === 'ArrowLeft') next = widthRef.current + step;
    else if (e.key === 'ArrowRight') next = widthRef.current - step;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    else if (e.key === 'Enter' || e.key === ' ') next = defaultWidth;
    else return;
    e.preventDefault();
    next = Math.min(max, Math.max(min, next));
    widthRef.current = next;
    setMaxWidth(max);
    setWidth(next);
    persist(next);
  }, [defaultWidth, persist]);

  return { containerRef, width, maxWidth, onMouseDown, onKeyDown, reset };
}
