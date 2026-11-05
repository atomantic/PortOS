import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/**
 * Grow a <textarea> to fit its content so the field never scrolls or has to be
 * hand-resized. Attach the returned `ref` to the textarea; the height is
 * recomputed before paint whenever `value` changes, AND whenever the element's
 * width or theme font changes, or a font finishes loading. Any of these can
 * rewrap text without `value` changing and otherwise clip it behind
 * `overflow-hidden`. `resize` is also returned for other programmatic changes.
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

  // Ignore height-only observations: resize() itself changes the height.
  useEffect(() => {
    const el = localRef.current;
    if (!el) return undefined;
    let active = true;
    let lastWidth = el.clientWidth;
    let frame = null;
    // Batch theme changes and avoid writing height during ResizeObserver delivery.
    const scheduleResize = () => {
      if (frame === null) frame = requestAnimationFrame(() => { frame = null; resize(); });
    };
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      if (el.clientWidth !== lastWidth) {
        lastWidth = el.clientWidth;
        scheduleResize();
      }
    });
    ro?.observe(el);
    const root = el.ownerDocument.documentElement;
    const themeObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(scheduleResize);
    themeObserver?.observe(root, { attributes: true, attributeFilter: ['class', 'style', 'data-port-theme'] });
    const fonts = el.ownerDocument.fonts;
    fonts?.addEventListener?.('loadingdone', scheduleResize);
    fonts?.ready?.then(() => { if (active) scheduleResize(); });
    return () => {
      active = false;
      ro?.disconnect();
      themeObserver?.disconnect();
      fonts?.removeEventListener?.('loadingdone', scheduleResize);
      if (frame !== null) cancelAnimationFrame(frame);
    };
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
