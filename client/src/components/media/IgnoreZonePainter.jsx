import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

// Ignore-zone (preserve-region) mask painter for the Image Cleaner diffusion
// step (issue #1763). The user paints WHITE regions over the source image to
// mark pixels the diffusion pass must NOT alter — comic dialog, faces, fine
// text that img2img garbles. The parent exports the painted mask as a 1-channel
// PNG Blob (white = preserve, black = diffuse) and sends it alongside the raw
// image bytes; the server composites the original pixels back into the white
// regions with a feathered edge.
//
// Two tools: freehand brush and rectangle. Clear wipes the mask; undo pops the
// last committed shape (brush stroke or rectangle) — the mask is a pure
// function of the committed shape list, so both are trivially correct via full
// redraw. Pointer events cover mouse, pen, and touch (touch-action: none so a
// drag doesn't scroll the page).
const IgnoreZonePainter = forwardRef(function IgnoreZonePainter(
  { imageSrc, tool = 'brush', brushSize = 40, onHasMaskChange },
  ref,
) {
  const canvasRef = useRef(null);
  const imgRef = useRef(null);
  const activePointerIdRef = useRef(null);
  const drawingRef = useRef(null); // in-progress shape (uncommitted)
  const [dims, setDims] = useState(null); // { w, h } natural pixels
  const [shapes, setShapes] = useState([]); // committed shapes
  const [inProgress, setInProgress] = useState(null);

  const handleImgLoad = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    setDims({ w: img.naturalWidth || img.width || 1, h: img.naturalHeight || img.height || 1 });
  }, []);

  // Report whether any mask exists so the parent can gate the "apply mask" wiring
  // (an empty mask means "preserve nothing" — pointless to send).
  useEffect(() => {
    onHasMaskChange?.(shapes.length > 0);
  }, [shapes.length, onHasMaskChange]);

  // Full redraw from the committed shapes + the in-progress shape. The visible
  // canvas paints WHITE at 40% alpha over the image so the operator can see both
  // the preserved region AND the underlying pixels; the exported mask (below) is
  // opaque white-on-black so the server reads a clean binary mask.
  const paintShape = useCallback((ctx, shape, { alpha }) => {
    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
    if (shape.type === 'rect') {
      const x = Math.min(shape.x0, shape.x1);
      const y = Math.min(shape.y0, shape.y1);
      ctx.fillRect(x, y, Math.abs(shape.x1 - shape.x0), Math.abs(shape.y1 - shape.y0));
    } else {
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.lineWidth = shape.size;
      ctx.beginPath();
      shape.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      // A single-point tap draws a dot.
      if (shape.points.length === 1) {
        ctx.arc(shape.points[0].x, shape.points[0].y, shape.size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.stroke();
      }
    }
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !dims) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const all = inProgress ? [...shapes, inProgress] : shapes;
    all.forEach((s) => paintShape(ctx, s, { alpha: 0.4 }));
  }, [shapes, inProgress, dims, paintShape]);

  const toNatural = useCallback((e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / (rect.width || 1)),
      y: (e.clientY - rect.top) * (canvas.height / (rect.height || 1)),
    };
  }, []);

  const handlePointerDown = useCallback((e) => {
    if (!dims || activePointerIdRef.current !== null) return;
    e.preventDefault();
    activePointerIdRef.current = e.pointerId;
    canvasRef.current?.setPointerCapture?.(e.pointerId);
    const { x, y } = toNatural(e);
    const shape = tool === 'rect'
      ? { type: 'rect', x0: x, y0: y, x1: x, y1: y }
      : { type: 'brush', size: brushSize, points: [{ x, y }] };
    drawingRef.current = shape;
    setInProgress(shape);
  }, [dims, tool, brushSize, toNatural]);

  const handlePointerMove = useCallback((e) => {
    if (e.pointerId !== activePointerIdRef.current || !drawingRef.current) return;
    e.preventDefault();
    const { x, y } = toNatural(e);
    const cur = drawingRef.current;
    const next = cur.type === 'rect'
      ? { ...cur, x1: x, y1: y }
      : { ...cur, points: [...cur.points, { x, y }] };
    drawingRef.current = next;
    setInProgress(next);
  }, [toNatural]);

  const finishShape = useCallback((e) => {
    if (e && e.pointerId !== activePointerIdRef.current) return;
    activePointerIdRef.current = null;
    const shape = drawingRef.current;
    if (!shape) return;
    drawingRef.current = null;
    setInProgress(null);
    setShapes((prev) => [...prev, shape]);
  }, []);

  useImperativeHandle(ref, () => ({
    hasMask: shapes.length > 0,
    clear: () => setShapes([]),
    undo: () => setShapes((prev) => prev.slice(0, -1)),
    // Export the mask as an opaque 1-bit-ish PNG (white = preserve, black =
    // diffuse) at natural resolution. Returns a Promise<Blob|null>. The server
    // greyscales + resizes it to the cleaned image dims, so exact resolution
    // parity isn't required — but matching the source keeps the edge crisp.
    exportMaskBlob: () => new Promise((resolve) => {
      if (!dims || shapes.length === 0) return resolve(null);
      const out = document.createElement('canvas');
      out.width = dims.w;
      out.height = dims.h;
      const ctx = out.getContext('2d');
      if (!ctx) return resolve(null);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, dims.w, dims.h);
      shapes.forEach((s) => paintShape(ctx, s, { alpha: 1 }));
      out.toBlob((blob) => resolve(blob), 'image/png');
    }),
  }), [dims, shapes, paintShape]);

  return (
    <div className="relative inline-block max-w-full bg-port-bg rounded-lg overflow-hidden">
      <img
        ref={imgRef}
        src={imageSrc}
        onLoad={handleImgLoad}
        alt="Paint an ignore zone to preserve"
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
          onPointerUp={finishShape}
          onPointerCancel={finishShape}
          className="absolute inset-0 w-full h-full touch-none cursor-crosshair"
        />
      )}
    </div>
  );
});

export default IgnoreZonePainter;
