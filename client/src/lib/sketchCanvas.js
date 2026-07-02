// Pure stroke model + 2D-context renderer for the media Sketch & Annotation
// Canvas (issue #2036, phase 1). Kept free of React/DOM lookups so the drawing
// and undo logic is unit-testable with a mock 2D context.
//
// Points are stored in the image's NATURAL-pixel space (the canvas element is
// sized to naturalWidth x naturalHeight and CSS-scaled to fit). Storing natural
// coordinates makes strokes restore identically at any display size — the phone
// (360px) and desktop render the same persisted vectors.

export const DEFAULT_COLOR = '#ef4444';
export const DEFAULT_SIZE = 6;
export const MIN_SIZE = 1;
export const MAX_SIZE = 64;

export const clampSize = (n) => {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return DEFAULT_SIZE;
  return Math.max(MIN_SIZE, Math.min(MAX_SIZE, v));
};

export const createStroke = ({ mode = 'draw', color = DEFAULT_COLOR, size = DEFAULT_SIZE, x, y }) => ({
  mode: mode === 'erase' ? 'erase' : 'draw',
  color,
  size: clampSize(size),
  points: [{ x, y }],
});

// Immutable append — returns a new stroke so React state updates re-render.
export const appendPoint = (stroke, x, y) => ({
  ...stroke,
  points: [...stroke.points, { x, y }],
});

// Pop the most recent committed stroke. Returns the same array reference when
// empty so callers can no-op cheaply.
export const undoStrokes = (strokes) => (strokes.length ? strokes.slice(0, -1) : strokes);

// Render every stroke onto a 2D context sized `width` x `height`. Erase strokes
// use destination-out so they cut transparent holes in earlier draw strokes
// (revealing the underlying image when the layer is composited over it).
export function drawStrokes(ctx, strokes, width, height) {
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  for (const stroke of strokes) {
    if (!stroke || !Array.isArray(stroke.points) || stroke.points.length === 0) continue;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = stroke.size;
    const erase = stroke.mode === 'erase';
    ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    const paint = erase ? 'rgba(0,0,0,1)' : stroke.color;
    ctx.strokeStyle = paint;
    ctx.fillStyle = paint;
    const pts = stroke.points;
    if (pts.length === 1) {
      // A single tap draws a dot rather than a zero-length line.
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, Math.max(stroke.size / 2, 0.5), 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
    ctx.restore();
  }
}
