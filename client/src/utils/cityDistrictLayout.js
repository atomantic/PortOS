// Shared, pure layout primitives for CyberCity districts. Several district modules had
// converged on the same three computations — column-wrapped grid placement, count-into-buckets
// tallies, and log-scaled clamped heights — each rolling its own copy. These helpers are the
// single source of truth they now delegate to. No three.js / React imports so every district
// stays headless-testable (mirrors cityJiraDistrict.js / cityMemoryDistrict.js / cityTaskQueue.js).

// ---------------------------------------------------------------------------
// Grid placement: index → world position, wrapping into columns and X-centered.
// ---------------------------------------------------------------------------

// Auto-pick a roughly-square column count for `count` items (downtown/warehouse grow both ways
// as apps are added). Floors at 1 so an empty or single-item grid still has a valid column.
export function autoColumns(count) {
  const n = Number.isFinite(count) ? count : 0;
  return Math.max(1, Math.ceil(Math.sqrt(Math.max(0, n))));
}

// Column-wrapped grid position for the `index`-th cell, returned as `[x, y, z]`.
//   - columns:  cells per row before wrapping (use autoColumns(n) for the sqrt-auto mode).
//   - spacing:  distance between adjacent cells (applied on both axes).
//   - base:     [x, y, z] origin of the grid (default origin).
//   - rowDir:   +1 lays successive rows toward +Z, -1 toward -Z.
//   - rowCount: when provided, rows are *centered* on Z (offset by half the grid depth) — the
//               downtown behavior; omit it to have rows extend outward from the base (jira yard,
//               warehouse). Columns are always X-centered regardless.
export function gridIndexToPosition(index, opts = {}) {
  const { columns = 1, spacing = 1, base = [0, 0, 0], rowDir = 1, rowCount = null } = opts;
  const cols = Math.max(1, columns);
  const col = index % cols;
  const row = Math.floor(index / cols);
  const offsetX = ((cols - 1) * spacing) / 2;
  const offsetZ = rowCount != null ? ((Math.max(1, rowCount) - 1) * spacing) / 2 : 0;
  return [
    base[0] + col * spacing - offsetX,
    base[1],
    base[2] + rowDir * (row * spacing - offsetZ),
  ];
}

// ---------------------------------------------------------------------------
// Bucketing: count (and optionally weight) items by a categorical field.
// ---------------------------------------------------------------------------

// Count items into buckets keyed by `keyFn(item)`, returned as a plain `{ key: count }` object.
// `seed` pre-creates zeroed buckets so a caller that depends on a fixed set of keys (e.g. a status
// breakdown where `other` must always be present) always gets them; unknown keys are added on
// demand. Tolerates a non-array input (returns just the seeded zeros).
export function tallyByKey(items, keyFn, seed = []) {
  const counts = {};
  for (const key of seed) counts[key] = 0;
  for (const item of Array.isArray(items) ? items : []) {
    const key = keyFn(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

// Group items into buckets keyed by `keyFn`, each carrying a `count` and a summed `weight`
// (`weightFn` defaults to 1 per item — i.e. weight == count). Returns an array of
// `{ key, count, weight }` sorted by count desc, then key asc — the stable order districts render
// in. Use when a district needs both a population and an accumulated magnitude per bucket.
export function groupByFieldValue(items, keyFn, { weightFn = () => 1, seed = [] } = {}) {
  const buckets = new Map();
  for (const key of seed) buckets.set(key, { key, count: 0, weight: 0 });
  for (const item of Array.isArray(items) ? items : []) {
    const key = keyFn(item);
    const entry = buckets.get(key) || { key, count: 0, weight: 0 };
    const w = weightFn(item);
    entry.count += 1;
    entry.weight += Number.isFinite(w) ? w : 0;
    buckets.set(key, entry);
  }
  return [...buckets.values()].sort(
    (a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)),
  );
}

// ---------------------------------------------------------------------------
// Height: log-scale a metric into a clamped band so big values don't dwarf the skyline.
// ---------------------------------------------------------------------------

// height = base + log2(1 + value) * k, clamped to [min, max]. `value` is floored at 0 (a zero or
// missing metric yields exactly `base`). Districts use this so a chunky ticket / heavy memory
// cluster reads as taller while staying within a legible band.
export function scaleMetricToHeight(value, { min = 0, max = Infinity, k = 1, base = 0 } = {}) {
  const v = Math.max(0, Number.isFinite(value) ? value : 0);
  const scaled = base + Math.log2(1 + v) * k;
  return Math.min(max, Math.max(min, scaled));
}
