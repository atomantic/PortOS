import { useEffect, useRef } from 'react';

// DevicePixelRatio-aware canvas sizing shared by the piano-roll renderers
// (<PianoRoll>, <MidiPianoRoll>). Sizes the canvas bitmap to the container
// width × the given CSS height at the device pixel ratio, keeps the CSS size
// in plain px, applies the DPR transform, and redraws — on mount and on every
// container resize (ResizeObserver).
//
// `drawRef` is a ref to the latest draw() (not the function itself) so the
// observer is created once per height and never torn down just because the
// draw closure was recreated.
//
// Returns a ref holding the current CSS width — the draw code reads it
// instead of measuring the DOM per frame.
export default function useCanvasDprSize(wrapRef, canvasRef, height, drawRef) {
  const widthRef = useRef(0);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const resize = () => {
      const w = Math.floor(el.clientWidth);
      if (!w) return;
      widthRef.current = w;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${height}px`;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawRef.current();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    return () => ro.disconnect();
  }, [height, wrapRef, canvasRef, drawRef]);

  return widthRef;
}
