import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { drawStrokes, createStroke, appendPoint } from '../../lib/sketchCanvas';

// Drawing surface for the Sketch & Annotation Canvas (issue #2036, phase 1).
// Renders the target image with a transparent <canvas> stroke layer on top.
// Controlled: the parent owns `strokes` + the active `tool` and receives
// committed strokes via `onStrokesChange`. Pointer events cover mouse, pen, AND
// touch (the canvas sets `touch-action: none` so a drag doesn't scroll the page).
//
// The imperative handle exposes `exportPng()` (flattened image + strokes) and
// `dimensions` so the parent can persist / download without reaching into refs.
const AnnotationCanvas = forwardRef(function AnnotationCanvas(
  { imageSrc, strokes, tool, onStrokesChange, onImageLoad, onImageError },
  ref,
) {
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

  // Redraw the whole layer from the committed strokes plus any in-progress
  // stroke. Full redraw (rather than incremental) keeps undo/erase trivially
  // correct — the layer is a pure function of the stroke list.
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
    // Flatten the image + stroke layer into a single PNG data URL at natural
    // resolution. Same-origin image (/data/images/...) so the canvas isn't
    // tainted and toDataURL succeeds.
    exportPng: () => {
      const canvas = canvasRef.current;
      const img = imgRef.current;
      if (!canvas || !img || !dims) return null;
      const out = document.createElement('canvas');
      out.width = dims.w;
      out.height = dims.h;
      const ctx = out.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, dims.w, dims.h);
      ctx.drawImage(canvas, 0, 0, dims.w, dims.h);
      return out.toDataURL('image/png');
    },
  }), [dims]);

  return (
    <div className="relative inline-block max-w-full bg-port-bg rounded-lg overflow-hidden">
      <img
        ref={imgRef}
        src={imageSrc}
        onLoad={handleImgLoad}
        onError={onImageError}
        alt="Media being annotated"
        className="block max-w-full h-auto select-none"
        draggable={false}
      />
      {dims && (
        <canvas
          ref={canvasRef}
          width={dims.w}
          height={dims.h}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishStroke}
          onPointerCancel={finishStroke}
          className="absolute inset-0 w-full h-full touch-none cursor-crosshair"
        />
      )}
    </div>
  );
});

export default AnnotationCanvas;
