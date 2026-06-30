// Pure helpers for the music-video beat-quantized timeline arranger (#1854).
// Consumed by client/src/components/musicVideo/BeatTimeline.jsx. Mirrors the
// spirit of the server's shorten-only `beatSnapClips` (server/services/
// musicVideo/render.js) but for INTERACTIVE drag, where a dragged edge can
// move either direction — only the server's at-render safety net is
// shorten-only.

const DEFAULT_TOLERANCE_SEC = 0.15;
const DEFAULT_SCENE_DURATION_SEC = 3;
const KIND_RANK = { beat: 0, downbeat: 1, section: 2 };

// Merge an audioAnalysis record's beats, downbeats, and section start/end
// times into one sorted list of snap points. Section boundaries and
// downbeats are stronger landmarks than plain beats, so near-coincident
// points (within 10ms — e.g. a downbeat landing on a section edge) collapse
// to the single strongest kind rather than offering two near-identical targets.
export function buildBeatGridPoints(audioAnalysis) {
  if (!audioAnalysis) return [];
  const points = [];
  for (const t of audioAnalysis.beats || []) {
    if (typeof t === 'number') points.push({ t, kind: 'beat' });
  }
  for (const t of audioAnalysis.downbeats || []) {
    if (typeof t === 'number') points.push({ t, kind: 'downbeat' });
  }
  for (const s of audioAnalysis.sections || []) {
    if (typeof s?.startSec === 'number') points.push({ t: s.startSec, kind: 'section' });
    if (typeof s?.endSec === 'number') points.push({ t: s.endSec, kind: 'section' });
  }
  const sorted = points.slice().sort((a, b) => a.t - b.t || KIND_RANK[b.kind] - KIND_RANK[a.kind]);
  const merged = [];
  for (const p of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && Math.abs(prev.t - p.t) < 0.01) {
      if (KIND_RANK[p.kind] > KIND_RANK[prev.kind]) merged[merged.length - 1] = p;
      continue;
    }
    merged.push(p);
  }
  return merged;
}

// Snap `timeSec` to the nearest grid point within toleranceSec. Returns the
// snapped { t, kind } point, or null when nothing is close enough (free
// placement — the caller keeps the raw dragged value and beatAligned=false).
export function snapTimeToGrid(timeSec, gridPoints, toleranceSec = DEFAULT_TOLERANCE_SEC) {
  if (!Array.isArray(gridPoints) || gridPoints.length === 0) return null;
  let nearest = null;
  let nearestDist = Infinity;
  for (const p of gridPoints) {
    const dist = Math.abs(p.t - timeSec);
    if (dist < nearestDist) { nearest = p; nearestDist = dist; }
  }
  return nearest && nearestDist <= toleranceSec ? nearest : null;
}

// Scenes without a persisted startSec/endSec need SOME position to render at
// before the user has ever dragged them. Lay those out contiguously after
// the last persisted/placed scene, each defaulting to a few seconds (clamped
// to the analyzed track length when known). Scenes that already carry an
// explicit, valid startSec/endSec keep them untouched. This is a display-only
// fallback — nothing here is persisted until the user actually drags an edge.
export function computeSceneSpans(scenes, durationSec) {
  const ordered = (Array.isArray(scenes) ? scenes : []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  let cursor = 0;
  return ordered.map((scene) => {
    if (typeof scene.startSec === 'number' && typeof scene.endSec === 'number' && scene.endSec > scene.startSec) {
      cursor = Math.max(cursor, scene.endSec);
      return { sceneId: scene.sceneId, startSec: scene.startSec, endSec: scene.endSec, persisted: true };
    }
    const startSec = cursor;
    const naturalEnd = startSec + DEFAULT_SCENE_DURATION_SEC;
    const endSec = typeof durationSec === 'number' && durationSec > startSec
      ? Math.min(naturalEnd, durationSec)
      : naturalEnd;
    cursor = endSec;
    return { sceneId: scene.sceneId, startSec, endSec, persisted: false };
  });
}

const DEFAULT_MIN_SCENE_SEC = 0.5;
const round3 = (n) => Number(n.toFixed(3));

// Allocate `total` whole items across `weights` (non-negative) using the
// largest-remainder method, so the per-bucket counts sum to EXACTLY `total`
// and a heavier weight gets proportionally more. All-zero weights fall back to
// an even split. Returns an integer array the same length as `weights`.
function allocateByWeight(weights, total) {
  const positive = weights.map((w) => (typeof w === 'number' && w > 0 ? w : 0));
  const sum = positive.reduce((a, b) => a + b, 0);
  // No usable weight signal → split evenly across the buckets.
  const eff = sum > 0 ? positive : weights.map(() => 1);
  const effSum = sum > 0 ? sum : weights.length;
  const raw = eff.map((w) => (w / effSum) * total);
  const counts = raw.map((r) => Math.floor(r));
  let remaining = total - counts.reduce((a, b) => a + b, 0);
  // Hand out the leftover units to the buckets with the largest fractional part.
  const byFrac = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; remaining > 0 && k < byFrac.length; k++) {
    counts[byFrac[k].i] += 1;
    remaining -= 1;
  }
  return counts;
}

// Split one section's [startSec, endSec] span into `count` contiguous cut
// boundaries (length `count + 1`). Interior cuts snap to the nearest grid point
// when one keeps the run monotonic AND leaves both adjacent spans at least
// `minSceneSec` long; otherwise the raw even-division time is kept. The
// section's own outer edges are never moved (they're already section grid lines).
function sectionCutBoundaries(startSec, endSec, count, gridPoints, minSceneSec) {
  const boundaries = [startSec];
  for (let k = 1; k < count; k++) {
    const raw = startSec + ((endSec - startSec) * k) / count;
    const snap = snapTimeToGrid(raw, gridPoints, Infinity);
    let b = snap ? snap.t : raw;
    const prev = boundaries[boundaries.length - 1];
    if (b < prev + minSceneSec || b > endSec - minSceneSec) b = raw;
    if (b < prev) b = prev; // keep strictly non-decreasing on a tiny section
    boundaries.push(b);
  }
  boundaries.push(endSec);
  return boundaries;
}

// Auto-arrange a project's scenes across the analyzed song sections, weighted by
// each section's energy (#1915). Higher-energy sections receive MORE scenes
// (hence shorter, snappier cuts); lower-energy sections receive fewer, longer
// ones. Within each section the allotted scenes tile its time span contiguously,
// with interior cuts snapped to the beat grid. Returns a proposed arrangement —
// `[{ sceneId, startSec, endSec, beatAligned }]` in scene order — written with
// the SAME persisted fields the manual drag-snap arranger (#1854) writes, so the
// result is a director-tunable starting point honored exactly at render time by
// the server's `beatSnapClips`.
//
// Pure + side-effect-free, so it's unit-tested in isolation before the UI button.
// Edge cases return a sensible no-op:
//   - no scenes → []
//   - no usable `sections` AND no `durationSec` → [] (nothing to arrange against)
//   - no `sections` but a `durationSec` → treat the whole track as one section
//   - missing per-section `energy` (older analyses) → equal weights (even spread)
export function autoArrangeScenes(scenes, audioAnalysis, { minSceneSec = DEFAULT_MIN_SCENE_SEC } = {}) {
  const ordered = (Array.isArray(scenes) ? scenes : [])
    .filter((s) => s && typeof s.sceneId === 'string')
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (ordered.length === 0) return [];

  const durationSec = typeof audioAnalysis?.durationSec === 'number' && audioAnalysis.durationSec > 0
    ? audioAnalysis.durationSec
    : null;

  let sections = (Array.isArray(audioAnalysis?.sections) ? audioAnalysis.sections : [])
    .filter((s) => typeof s?.startSec === 'number' && typeof s?.endSec === 'number' && s.endSec > s.startSec)
    .map((s) => ({
      startSec: s.startSec,
      endSec: s.endSec,
      energy: typeof s.energy === 'number' && s.energy > 0 ? s.energy : null,
    }));

  if (sections.length === 0) {
    if (!durationSec) return [];
    sections = [{ startSec: 0, endSec: durationSec, energy: null }];
  }

  // Energy is the cut-density weight. When no section carries energy (legacy
  // analyses, or the single synthetic fallback section), weigh every section
  // equally so scenes still spread across the whole track.
  const haveEnergy = sections.some((s) => s.energy != null);
  const weights = sections.map((s) => (haveEnergy ? (s.energy ?? 0) : 1));
  const counts = allocateByWeight(weights, ordered.length);

  const gridPoints = buildBeatGridPoints(audioAnalysis);
  // A grid (beats/downbeats/section edges) means the cuts are genuinely
  // beat-aligned; mark every produced span aligned so the render honors these
  // computed durations exactly (the director can then drag to fine-tune). With
  // no grid at all the spans are still intentional, but not beat-locked.
  const beatAligned = gridPoints.length > 0;

  const result = [];
  let sceneIdx = 0;
  for (let si = 0; si < sections.length; si++) {
    const count = counts[si];
    if (count <= 0) continue;
    const boundaries = sectionCutBoundaries(sections[si].startSec, sections[si].endSec, count, gridPoints, minSceneSec);
    for (let k = 0; k < count; k++) {
      const scene = ordered[sceneIdx];
      sceneIdx += 1;
      result.push({
        sceneId: scene.sceneId,
        startSec: round3(boundaries[k]),
        endSec: round3(boundaries[k + 1]),
        beatAligned,
      });
    }
  }
  return result;
}
