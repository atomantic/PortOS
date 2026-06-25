// Pure presentation helpers for the editorial health panel (#1316) — score
// banding, trend sparkline geometry, and severity/category ordering. No React,
// no window: the panel component and its unit tests both consume these.

export const SEVERITY_ORDER = Object.freeze(['high', 'medium', 'low']);
export const SEVERITY_LABELS = Object.freeze({ high: 'High', medium: 'Medium', low: 'Low' });

// Readiness-gate display labels (mirrors the server READINESS_GATES enum).
export const READINESS_GATE_LABELS = Object.freeze({
  noOpenHigh: 'No open high findings',
  noOpenHighOrMedium: 'No open high or medium findings',
  none: 'No gate (always ready)',
});
export const READINESS_GATE_ORDER = Object.freeze(['noOpenHigh', 'noOpenHighOrMedium', 'none']);

// Band a 0..100 health score into a label + Tailwind token class. The cutoffs
// are presentation-only (the score itself is the authority): a draft with no
// open high findings lands ≥ ~88 under the default weights, so the bands read
// as "clean / minor nits / needs work / rough".
export function scoreBand(score) {
  const s = Number.isFinite(score) ? score : 0;
  if (s >= 90) return { label: 'Clean', tone: 'text-port-success', bar: 'bg-port-success' };
  if (s >= 70) return { label: 'Minor', tone: 'text-port-success', bar: 'bg-port-success' };
  if (s >= 40) return { label: 'Needs work', tone: 'text-port-warning', bar: 'bg-port-warning' };
  return { label: 'Rough', tone: 'text-port-error', bar: 'bg-port-error' };
}

// A delta's display: sign, arrow, and tone. Positive = improving (score went up
// between the two most recent revisions). Zero is neutral.
export function deltaDisplay(delta) {
  const d = Number.isFinite(delta) ? delta : 0;
  if (d > 0) return { text: `+${d}`, arrow: '▲', tone: 'text-port-success' };
  if (d < 0) return { text: `${d}`, arrow: '▼', tone: 'text-port-error' };
  return { text: '0', arrow: '→', tone: 'text-gray-400' };
}

/**
 * Project a trend's score points into SVG polyline coordinates within a
 * `width × height` box. Returns `{ points: "x,y x,y …", coords: [{x,y,score}] }`.
 * Scores are mapped 0..100 → bottom..top. A single point sits at the right edge;
 * an empty series yields empty geometry (the caller renders a placeholder).
 */
export function sparklineGeometry(points = [], { width = 120, height = 28, pad = 2 } = {}) {
  const list = Array.isArray(points) ? points.filter((p) => Number.isFinite(p?.score)) : [];
  if (!list.length) return { points: '', coords: [] };
  const innerW = Math.max(1, width - pad * 2);
  const innerH = Math.max(1, height - pad * 2);
  const span = Math.max(1, list.length - 1);
  const coords = list.map((p, i) => {
    const x = pad + (list.length === 1 ? innerW : (i / span) * innerW);
    // Score 0 → bottom (height-pad), 100 → top (pad).
    const y = pad + (1 - Math.max(0, Math.min(100, p.score)) / 100) * innerH;
    return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, score: p.score };
  });
  return { points: coords.map((c) => `${c.x},${c.y}`).join(' '), coords };
}

// Order an openByCategory map into `[{ category, count }]` sorted by count desc
// then name, dropping zero/empty buckets. Used for the per-category breakdown.
export function orderedCategories(openByCategory = {}) {
  return Object.entries(openByCategory || {})
    .filter(([, count]) => Number.isFinite(count) && count > 0)
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

/**
 * Order an openByCheck map into `[{ checkId, label, count }]` sorted by count
 * desc then label (#1597). Drops zero/empty buckets. `labelFor` resolves a
 * checkId to its human label (the catalog row's `label`); it falls back to the
 * raw checkId so a finding from a since-deleted custom check still renders.
 */
export function orderedChecks(openByCheck = {}, labelFor = (id) => id) {
  const label = typeof labelFor === 'function' ? labelFor : (id) => id;
  return Object.entries(openByCheck || {})
    .filter(([, count]) => Number.isFinite(count) && count > 0)
    .map(([checkId, count]) => ({ checkId, count, label: label(checkId) || checkId }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * Extract a single check's open-finding count across the trend points (#1597),
 * oldest→newest, as a plain number array. A point with no entry for the check
 * contributes 0 (the check found nothing that revision), so the series length
 * always matches the point count — the sparkline shows the check climbing from /
 * settling to zero rather than dropping points.
 */
export function checkCountSeries(points = [], checkId) {
  const list = Array.isArray(points) ? points : [];
  return list.map((p) => {
    const c = p?.openByCheck?.[checkId];
    return Number.isFinite(c) ? c : 0;
  });
}

/**
 * Project a non-negative count series into SVG polyline coordinates within a
 * `width × height` box, normalized to the series' own max (unlike
 * `sparklineGeometry`'s fixed 0–100 axis): the largest count sits at the top,
 * 0 at the bottom, so a per-check finding count reads as "spiked then dropped".
 * A flat or all-zero series renders as a baseline. Returns
 * `{ points: "x,y …", coords: [{x,y,count}], last, max }`; an empty series
 * yields empty geometry (the caller renders a placeholder).
 */
export function countSparklineGeometry(values = [], { width = 80, height = 20, pad = 2 } = {}) {
  const list = Array.isArray(values) ? values.filter((v) => Number.isFinite(v)) : [];
  if (!list.length) return { points: '', coords: [], last: null, max: 0 };
  const innerW = Math.max(1, width - pad * 2);
  const innerH = Math.max(1, height - pad * 2);
  const span = Math.max(1, list.length - 1);
  const max = Math.max(0, ...list);
  const coords = list.map((count, i) => {
    const x = pad + (list.length === 1 ? innerW : (i / span) * innerW);
    // count=max → top (pad); count=0 (or all-zero series) → bottom (height-pad).
    const y = pad + (max > 0 ? 1 - count / max : 1) * innerH;
    return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, count };
  });
  return {
    points: coords.map((c) => `${c.x},${c.y}`).join(' '),
    coords,
    last: coords[coords.length - 1],
    max,
  };
}
