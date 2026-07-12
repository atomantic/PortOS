import { useEffect, useRef } from 'react';
import { rollPalette } from '../lib/canvasRoll.js';

// Resolves the piano-roll canvas palette (theme-following accent + roll bg)
// once, then re-resolves on theme switch and triggers a redraw. Canvas
// `fillStyle` can't read CSS custom properties, so the imperative roll draws
// read the resolved strings from the returned ref inside draw() instead of
// hardcoding hex. Mirrors `useChartColors`'s `data-port-theme` MutationObserver
// (set by `useTheme` on <html>), but hands back a ref — not React state — so a
// theme switch repaints the canvas without forcing a component re-render.
export default function useCanvasRollPalette(drawRef) {
  // Lazy one-time init — `useRef(rollPalette())` would re-run the getComputedStyle
  // read on every render (hover repaints re-render this component), defeating the
  // point of caching the palette.
  const paletteRef = useRef(null);
  if (paletteRef.current === null) paletteRef.current = rollPalette();
  useEffect(() => {
    const apply = () => { paletteRef.current = rollPalette(); drawRef.current?.(); };
    apply();
    if (typeof MutationObserver !== 'function') return undefined;
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-port-theme'] });
    return () => observer.disconnect();
  }, [drawRef]);
  return paletteRef;
}
