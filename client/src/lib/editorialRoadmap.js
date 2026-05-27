// Pure helpers for the editorial reader-emotion roadmap — shared by the
// EditorialRoadmapPanel (Series page) and the Reader Map detail page so the
// chart math and dominant-emotion logic live in exactly one place.

// Most frequent non-empty string in a list (e.g. the dominant reader emotion
// across analyzed issues). Tie-break is first-to-reach-the-max by insertion
// order, so the result is deterministic for a given input order.
export function dominant(values = []) {
  const counts = new Map();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  let best = '';
  let bestN = 0;
  for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
  return best;
}

// Project the aggregate roadmap into the analyzed-only points the chart draws.
// Each point's `frac` (0..1) is its position within the FULL ordered issue list
// so the x-axis reflects arc position; unanalyzed gaps are skipped and the line
// simply bridges them. `plot != null` (not truthiness) keeps a legitimate 0.
export function projectAnalyzedPoints(roadmap = []) {
  const total = roadmap.length;
  return roadmap
    .map((r, i) => ({ ...r, frac: total > 1 ? i / (total - 1) : 1 }))
    .filter((r) => r.analyzed && r.plot != null);
}
