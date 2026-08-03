import { useCallback, useEffect, useRef, useState } from 'react';
import { safeReadStorage, safeWriteStorage } from '../lib/safeStorage';

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

  const onMouseDown = useCallback((e) => {
    e.preventDefault();
    const containerWidth = containerRef.current?.getBoundingClientRect().width ?? 0;
    dragStartRef.current = { startX: e.clientX, startWidth: widthRef.current, containerWidth };
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

  return { containerRef, width, onMouseDown, reset };
}
