/** Numeric axes, series paths and stacked offsets for the client SVG charts. */
export function chartValue(row, key) {
  if (row == null || key == null) return undefined;
  if (Object.hasOwn(row, key)) return row[key];
  return String(key).replace(/\[(\d+)\]/g, '.$1').split('.').reduce((value, part) => value?.[part], row);
}

function tickStep(span, count = 5) {
  const base = 10 ** Math.floor(Math.log10(span / count));
  const fraction = span / count / base;
  return base * (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10);
}

function bound(spec, edge, fallback) {
  if (typeof spec === 'function') spec = spec(edge);
  if (Number.isFinite(spec)) return spec;
  const match = /^data(?:Min|Max)(?:\s*([+-])\s*([\d.]+))?$/.exec(spec);
  return match ? edge + (match[1] === '-' ? -1 : 1) * Number(match[2] || 0) : fallback;
}

export function numericAxis({ domain = [0, 'auto'], scale, ticks }, values) {
  const log = scale === 'log';
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (!Number.isFinite(value) || (log && value <= 0)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  if (min === Infinity) [min, max] = log ? [1, 10] : [0, 1];
  const step = tickStep(max - min || Math.abs(max) || 1);
  let lo = bound(domain[0], min, Math.floor(min / step) * step);
  let hi = bound(domain[1], max, Math.ceil(max / step) * step);
  if (log && lo <= 0) lo = min;
  if (hi <= lo) hi = log ? lo * 10 : lo + step;
  const spacing = tickStep(hi - lo);
  const generated = [];
  if (log) {
    for (let power = Math.ceil(Math.log10(lo)); power <= Math.floor(Math.log10(hi)); power++) generated.push(10 ** power);
    if (generated.length < 2) generated.splice(0, generated.length, lo, hi);
  } else {
    const first = Math.ceil(lo / spacing);
    const last = Math.floor(hi / spacing);
    for (let i = 0; i <= last - first; i++) generated.push(Number(((first + i) * spacing).toPrecision(12)));
  }
  return {
    domain: [lo, hi], ticks: ticks ?? generated,
    project: value => log
      ? Math.log(Math.max(lo, value) / lo) / Math.log(hi / lo)
      : (value - lo) / (hi - lo),
  };
}

export function stackBars(rows, bars) {
  return rows.map(row => {
    const totals = new Map();
    return bars.map(bar => {
      const value = chartValue(row, bar.dataKey);
      if (!Number.isFinite(value)) return null;
      const key = JSON.stringify([bar.yAxisId, bar.stackId, value < 0]);
      const start = bar.stackId == null ? 0 : totals.get(key) ?? 0;
      totals.set(key, start + value);
      return [start, start + value];
    });
  });
}

function segmentPath(points, type) {
  const slope = i => (points[i + 1][1] - points[i][1]) / (points[i + 1][0] - points[i][0] || 1);
  const tangent = i => {
    if (i === 0) return slope(0);
    if (i === points.length - 1) return slope(i - 1);
    const before = slope(i - 1);
    const after = slope(i);
    return before * after <= 0 ? 0 : 2 / (1 / before + 1 / after);
  };
  return points.map(([x, y], i) => {
    if (!i) return `M${x},${y}`;
    if (type === 'stepAfter') return `H${x}V${y}`;
    if (type !== 'monotone') return `L${x},${y}`;
    const [lastX, lastY] = points[i - 1];
    const third = (x - lastX) / 3;
    return `C${lastX + third},${lastY + third * tangent(i - 1)} ${x - third},${y - third * tangent(i)} ${x},${y}`;
  }).join(' ');
}

export function linePath(points, type, connectNulls) {
  const segments = [[]];
  for (const point of points) {
    if (point) segments.at(-1).push(point);
    else if (!connectNulls && segments.at(-1).length) segments.push([]);
  }
  return segments.map(segment => segmentPath(segment, type)).join(' ').trim();
}
