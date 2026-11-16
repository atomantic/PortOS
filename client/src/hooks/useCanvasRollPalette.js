/**
 * Hook resolving a canvas palette into a ref and re-resolving it on theme switch so canvases repaint.
 *
 * Resolves a canvas palette into a ref (`rollPalette` by default, or a resolver passed as the second argument, e.g. the Core Assembly avatar's `--port-accent-2`), re-resolving on theme switch (`data-port-theme` MutationObserver) and repainting through a `drawRef`. A ref, not state, so a theme swap redraws the imperative canvas without a React re-render. Both piano-roll canvases need it because canvas `fillStyle` can't read CSS vars.
 */

import { useEffect, useRef } from 'react';
import { rollPalette } from '../lib/canvasRoll.js';

// Resolves the piano-roll canvas palette (theme-following accent + roll bg) once, then re-resolves on theme switch and redraws: canvas `fillStyle` can't read CSS custom properties, so imperative draws read resolved strings from the returned ref. Mirrors `useChartColors`'s `data-port-theme` MutationObserver (set by `useTheme`) but hands back a ref, not state.
// `resolve` is the token reader (`rollPalette` for the piano rolls; the Core Assembly avatar passes its own) so the observer lifecycle lives in one place.
export default function useCanvasRollPalette(drawRef, resolve = rollPalette) {
  // Lazy one-time init — `useRef(rollPalette())` would re-run the getComputedStyle
  // read on every render (hover repaints re-render this component), defeating the
  // point of caching the palette.
  const paletteRef = useRef(null);
  if (paletteRef.current === null) paletteRef.current = resolve();
  useEffect(() => {
    const apply = () => { paletteRef.current = resolve(); drawRef.current?.(); };
    apply();
    if (typeof MutationObserver !== 'function') return undefined;
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-port-theme'] });
    return () => observer.disconnect();
  }, [drawRef, resolve]);
  return paletteRef;
}
