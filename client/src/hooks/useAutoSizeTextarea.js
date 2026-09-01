import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/**
 * Grow a <textarea> to fit its content so the field never scrolls or has to be
 * hand-resized. Attach the returned `ref` to the textarea; the height is
 * recomputed before paint whenever `value` changes, AND whenever the element's
 * width changes (responsive grid breakpoint, viewport resize) — a narrower box
 * rewraps the text to more lines without `value` changing, which would
 * otherwise clip the bottom behind `overflow-hidden`. `resize` is also returned
 * for any other programmatic mutation the two triggers can't see.
 *
 * Set a floor with a `min-h-*` class on the textarea (CSS `min-height` floors
 * the inline height this hook sets), and pair it with `resize-none` /
 * `overflow-hidden` so the browser scrollbar never appears.
 */
export default function useAutoSizeTextarea(value, externalRef) {
  const localRef = useRef(null);
  const externalRefRef = useRef(externalRef);
  externalRefRef.current = externalRef;

  const resize = useCallback(() => {
    const el = localRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const style = typeof window !== 'undefined' && window.getComputedStyle ? window.getComputedStyle(el) : null;
    const borderOffset = style && style.boxSizing === 'border-box'
      ? (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0)
      : 0;
    el.style.height = `${el.scrollHeight + borderOffset}px`;
  }, []);

  useLayoutEffect(() => { resize(); }, [value, resize]);

  // Re-fit on width changes only. Gating on width is essential: resize() mutates
  // the element's height, which would otherwise re-trigger the observer into a
  // feedback loop.
  useEffect(() => {
    const el = localRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    let lastWidth = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== lastWidth) {
        lastWidth = el.clientWidth;
        resize();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [resize]);

  const setRef = useCallback((el) => {
    localRef.current = el;
    setRef.current = el;
    const ext = externalRefRef.current;
    if (typeof ext === 'function') {
      ext(el);
    } else if (ext && typeof ext === 'object') {
      ext.current = el;
    }
  }, []);
  setRef.current = localRef.current;

  useEffect(() => {
    if (!externalRef) return;
    if (typeof externalRef === 'function') {
      externalRef(localRef.current);
    } else if (typeof externalRef === 'object') {
      externalRef.current = localRef.current;
    }
  }, [externalRef]);

  return [setRef, resize];
}
