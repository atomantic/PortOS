import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { drawStrokes, createStroke, appendPoint } from '../../lib/sketchCanvas';

// Drawing surface for the Sketch & Annotation Canvas (issue #2036).
// Two modes:
//   - Overlay (phases 1–2): pass `imageSrc` — the target image renders with a
//     transparent <canvas> stroke layer on top; export flattens image + strokes.
//   - Blank canvas (phase 3): omit `imageSrc` and pass `blankWidth`/`blankHeight`
//     (+ optional `backgroundColor`) — a solid-fill canvas the user draws on from
//     scratch; export paints the background then the strokes.
// Controlled: the parent owns `strokes` + the active `tool` and receives
// committed strokes via `onStrokesChange`. Pointer events cover mouse, pen, AND
// touch (the canvas sets `touch-action: none` so a drag doesn't scroll the page).
//
// The imperative handle exposes `exportPng()` (flattened output) and
// `dimensions` so the parent can persist / download without reaching into refs.
const DEFAULT_BLANK_BG = '#ffffff';

const AnnotationCanvas = forwardRef(function AnnotationCanvas(
  {
    imageSrc,
    strokes,
    tool,
    onStrokesChange,
    onImageLoad,
    onImageError,
    blankWidth = 1024,
    blankHeight = 1024,
    backgroundColor = DEFAULT_BLANK_BG,
  },
  ref,
) {
  const isBlank = !imageSrc;
  const canvasRef = useRef(null);
  const imgRef = useRef(null);
  const drawingRef = useRef(null); // in-progress (uncommitted) stroke
  const activePointerIdRef = useRef(null); // the single pointer we're tracking
  const [dims, setDims] = useState(null); // { w, h } in natural pixels
  const [inProgress, setInProgress] = useState(null);

  const handleImgLoad = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    const w = img.naturalWidth || img.width || 1;
    const h = img.naturalHeight || img.height || 1;
    setDims({ w, h });
    onImageLoad?.({ w, h });
  }, [onImageLoad]);

  // Blank mode has no <img> to fire onLoad — derive dims straight from the
  // requested canvas size (clamped to a sane positive integer) and report them.
  useEffect(() => {
    if (!isBlank) return;
    const w = Math.max(1, Math.round(blankWidth) || 1);
    const h = Math.max(1, Math.round(blankHeight) || 1);
    setDims({ w, h });
    onImageLoad?.({ w, h });
  }, [isBlank, blankWidth, blankHeight, onImageLoad]);

  // Redraw the whole layer from the committed strokes plus any in-progress
  // stroke. Full redraw (rather than incremental) keeps undo/erase trivially
  // correct — the layer is a pure function of the stroke list. The stroke layer
  // itself always stays transparent (drawStrokes clears it, and erase uses
  // destination-out to cut holes); in blank mode the "paper" is a CSS background
  // on the <canvas> element so an erased hole reveals white, not the dark page.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !dims) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const all = inProgress ? [...strokes, inProgress] : strokes;
    drawStrokes(ctx, all, canvas.width, canvas.height);
  }, [strokes, inProgress, dims]);

  // Map a pointer event to natural-pixel canvas coordinates, accounting for the
  // CSS scale between the displayed size and the canvas's internal resolution.
  const toNatural = useCallback((e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / (rect.width || 1);
    const scaleY = canvas.height / (rect.height || 1);
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }, []);

  const handlePointerDown = useCallback((e) => {
    // Track exactly one pointer — a second finger/palm mid-draw is ignored so
    // it can't hijack or garble the in-progress stroke on touch devices.
    if (!dims || activePointerIdRef.current !== null) return;
    e.preventDefault();
    activePointerIdRef.current = e.pointerId;
    // Capture so strokes continue smoothly even when the pointer leaves the
    // canvas bounds mid-draw. Auto-releases on pointerup/cancel.
    canvasRef.current?.setPointerCapture?.(e.pointerId);
    const { x, y } = toNatural(e);
    const stroke = createStroke({ mode: tool.mode, color: tool.color, size: tool.size, x, y });
    drawingRef.current = stroke;
    setInProgress(stroke);
  }, [dims, tool, toNatural]);

  const handlePointerMove = useCallback((e) => {
    if (e.pointerId !== activePointerIdRef.current || !drawingRef.current) return;
    e.preventDefault();
    const { x, y } = toNatural(e);
    const next = appendPoint(drawingRef.current, x, y);
    drawingRef.current = next;
    setInProgress(next);
  }, [toNatural]);

  const finishStroke = useCallback((e) => {
    if (e && e.pointerId !== activePointerIdRef.current) return;
    activePointerIdRef.current = null;
    const stroke = drawingRef.current;
    if (!stroke) return;
    drawingRef.current = null;
    setInProgress(null);
    onStrokesChange([...strokes, stroke]);
  }, [strokes, onStrokesChange]);

  useImperativeHandle(ref, () => ({
    dimensions: dims,
    // Flatten to a single opaque PNG data URL at natural resolution. Overlay
    // mode composites the same-origin image (/data/images/...) under the strokes
    // (so the canvas isn't tainted and toDataURL succeeds); blank mode fills the
    // background color instead so the export is never transparent.
    exportPng: () => {
      const canvas = canvasRef.current;
      if (!canvas || !dims) return null;
      const out = document.createElement('canvas');
      out.width = dims.w;
      out.height = dims.h;
      const ctx = out.getContext('2d');
      if (!ctx) return null;
      if (isBlank) {
        ctx.fillStyle = backgroundColor;
        ctx.fillRect(0, 0, dims.w, dims.h);
      } else {
        const img = imgRef.current;
        if (!img) return null;
        ctx.drawImage(img, 0, 0, dims.w, dims.h);
      }
      ctx.drawImage(canvas, 0, 0, dims.w, dims.h);
      return out.toDataURL('image/png');
    },
  }), [dims, isBlank, backgroundColor]);

  return (
    <div className="relative inline-block max-w-full bg-port-bg rounded-lg overflow-hidden">
      {isBlank ? (
        // A sized spacer establishes the natural aspect ratio so the absolutely
        // positioned canvas below scales to it (matches the <img> layout in
        // overlay mode). No <img> element exists in blank mode.
        <div style={{ aspectRatio: `${dims?.w || blankWidth} / ${dims?.h || blankHeight}` }} className="w-full max-w-full" />
      ) : (
        <img
          ref={imgRef}
          src={imageSrc}
          onLoad={handleImgLoad}
          onError={onImageError}
          alt="Media being annotated"
          className="block max-w-full h-auto select-none"
          draggable={false}
        />
      )}
      {dims && (
        <canvas
          ref={canvasRef}
          width={dims.w}
          height={dims.h}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishStroke}
          onPointerCancel={finishStroke}
          // Blank mode paints the "paper" as a CSS background so the transparent
          // stroke layer sits over it and an erased hole reveals white, not the
          // dark page behind the canvas.
          style={isBlank ? { backgroundColor } : undefined}
          className="absolute inset-0 w-full h-full touch-none cursor-crosshair"
        />
      )}
    </div>
  );
});

export default AnnotationCanvas;
