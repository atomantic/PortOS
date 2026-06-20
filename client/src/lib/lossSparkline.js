/**
 * Pure geometry for an unbounded-value (training-loss) sparkline.
 *
 * Unlike `sparklineGeometry` in `editorialHealth.js` — which maps a fixed
 * 0–100 `score` axis — a training loss curve has no known bound, so this
 * normalizes each series to its own min/max. Used by the Render Queue's
 * training-row treatment to draw a `<polyline>` over a run's per-checkpoint
 * loss. Kept pure (no React) so the projection is unit-testable.
 *
 * @param {Array<{step?:number, loss:number}>} series — points with finite `loss`
 * @param {object} [opts]
 * @param {number} [opts.width=240]
 * @param {number} [opts.height=36]
 * @returns {{ points: string, coords: Array<{x:number,y:number,loss:number}>, last: number|null, min: number|null, max: number|null }}
 *   `points` is the SVG `points=""` string ('' when fewer than 2 valid points);
 *   `last` is the most recent loss (or null).
 */
export function lossSparklineGeometry(series = [], { width = 240, height = 36 } = {}) {
  const list = Array.isArray(series)
    ? series.filter((p) => p && Number.isFinite(p.loss))
    : [];
  if (list.length < 2) {
    return {
      points: '',
      coords: [],
      last: list.length ? list[list.length - 1].loss : null,
      min: null,
      max: null,
    };
  }
  const losses = list.map((p) => p.loss);
  const min = Math.min(...losses);
  const max = Math.max(...losses);
  const span = max - min;
  const coords = list.map((p, i) => {
    const x = (i / (list.length - 1)) * width;
    // Higher loss → higher on screen (smaller y); a flat series sits mid-height.
    const y = span === 0 ? height / 2 : height - ((p.loss - min) / span) * height;
    return {
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      loss: p.loss,
    };
  });
  return {
    points: coords.map((c) => `${c.x},${c.y}`).join(' '),
    coords,
    last: losses[losses.length - 1],
    min,
    max,
  };
}
