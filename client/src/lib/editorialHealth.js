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

// Order an open-finding-count map (`{ bucket: count }`) into rows sorted by
// count desc then a string tiebreak, dropping zero/empty buckets. `makeRow`
// shapes each `[bucket, count]` pair; `tieBreak` picks the secondary sort key.
// Shared by the per-category and per-check (#1597) breakdowns so the two can't
// drift on filtering/sort semantics.
function orderedBuckets(map, makeRow, tieBreak) {
  return Object.entries(map || {})
    .filter(([, count]) => Number.isFinite(count) && count > 0)
    .map(([bucket, count]) => makeRow(bucket, count))
    .sort((a, b) => b.count - a.count || tieBreak(a).localeCompare(tieBreak(b)));
}

// Order an openByCategory map into `[{ category, count }]` sorted by count desc
// then name, dropping zero/empty buckets. Used for the per-category breakdown.
export function orderedCategories(openByCategory = {}) {
  return orderedBuckets(openByCategory, (category, count) => ({ category, count }), (r) => r.category);
}

/**
 * Order an openByCheck map into `[{ checkId, label, count }]` sorted by count
 * desc then label (#1597). Drops zero/empty buckets. `labelFor` resolves a
 * checkId to its human label (the catalog row's `label`); it falls back to the
 * raw checkId so a finding from a since-deleted custom check still renders.
 */
export function orderedChecks(openByCheck = {}, labelFor = (id) => id) {
  const label = typeof labelFor === 'function' ? labelFor : (id) => id;
  return orderedBuckets(
    openByCheck,
    (checkId, count) => ({ checkId, count, label: label(checkId) || checkId }),
    (r) => r.label,
  );
}

/**
 * Extract a single check's open-finding count across the trend points (#1597),
 * oldest→newest, as a plain number array. Points with NO per-check telemetry
 * (`openByCheck` is null/absent — a snapshot recorded before per-check tracking
 * shipped) are OMITTED, not counted as 0: coercing them to zero would draw a
 * false spike out of nowhere on the first post-upgrade run. Within a
 * telemetry-bearing point, a check absent from the map legitimately contributes
 * 0 (it found nothing that revision).
 */
export function checkCountSeries(points = [], checkId) {
  const list = Array.isArray(points) ? points : [];
  return list
    .filter((p) => p?.openByCheck && typeof p.openByCheck === 'object')
    .map((p) => {
      const c = p.openByCheck[checkId];
      return Number.isFinite(c) ? c : 0;
    });
}

/**
 * Diff two open-finding-count maps (`{ bucket: count }`) into a sorted list of
 * CHANGED buckets (#1630). A bucket absent from one side counts as 0 there, so a
 * newly-opened bucket reads `from: 0` and a fully-resolved one reads `to: 0`.
 * Only buckets whose count actually changed are returned — an unchanged bucket
 * carries no signal. Sorted by the magnitude of the change (largest first), then
 * bucket name, so the biggest regressions/fixes lead. Returns
 * `[{ key, from, to, delta }]` where `delta < 0` is an improvement (fewer
 * findings) and `delta > 0` a regression.
 */
export function diffCountMaps(current = {}, previous = {}) {
  const cur = current && typeof current === 'object' ? current : {};
  const prev = previous && typeof previous === 'object' ? previous : {};
  const keys = new Set([...Object.keys(cur), ...Object.keys(prev)]);
  const rows = [];
  for (const key of keys) {
    const to = Number.isFinite(cur[key]) ? cur[key] : 0;
    const from = Number.isFinite(prev[key]) ? prev[key] : 0;
    if (to === from) continue;
    rows.push({ key, from, to, delta: to - from });
  }
  return rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.key.localeCompare(b.key));
}

/**
 * Build the drill-down view for a single trend snapshot (#1630): its own
 * open-finding breakdown plus a per-dimension diff against the PREVIOUS
 * snapshot, so clicking a sparkline point can answer "what changed since the
 * prior run?". `previous` is null for the first recorded revision (nothing to
 * compare — `hasPrevious: false`, all deltas null/empty).
 *
 * Per-check telemetry is null-aware (mirrors `checkCountSeries`/`computeTrend`):
 * if EITHER snapshot lacks the `openByCheck` map (recorded before per-check
 * tracking shipped), `byCheck` is `null` ("no telemetry to diff") rather than a
 * misleading all-zero baseline that would flag every open check as new.
 *
 * @param {object} point — the selected snapshot (a `trend.points[i]`)
 * @param {object|null} previous — the snapshot one revision earlier, or null
 * @returns {{ hasPrevious, scoreDelta, openDelta, bySeverity, byCategory, byCheck }|null}
 */
export function snapshotDiff(point, previous = null) {
  if (!point || typeof point !== 'object') return null;
  const prev = previous && typeof previous === 'object' ? previous : null;
  const numDelta = (cur, old) =>
    prev && Number.isFinite(cur) && Number.isFinite(old) ? cur - old : null;
  const canDiffChecks = point.openByCheck && typeof point.openByCheck === 'object'
    && (!prev || (prev.openByCheck && typeof prev.openByCheck === 'object'));
  return {
    hasPrevious: !!prev,
    scoreDelta: numDelta(point.score, prev?.score),
    openDelta: numDelta(point.open, prev?.open),
    bySeverity: diffCountMaps(point.openBySeverity, prev?.openBySeverity),
    byCategory: diffCountMaps(point.openByCategory, prev?.openByCategory),
    byCheck: canDiffChecks ? diffCountMaps(point.openByCheck, prev?.openByCheck) : null,
  };
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
