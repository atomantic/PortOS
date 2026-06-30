// Pure helpers for the music-video beat-quantized timeline arranger (#1854).
// Consumed by client/src/components/musicVideo/BeatTimeline.jsx. Mirrors the
// spirit of the server's shorten-only `beatSnapClips` (server/services/
// musicVideo/render.js) but for INTERACTIVE drag, where a dragged edge can
// move either direction — only the server's at-render safety net is
// shorten-only.

const DEFAULT_TOLERANCE_SEC = 0.15;
const DEFAULT_SCENE_DURATION_SEC = 3;
const MIN_SCENE_SEC = 0.3;
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

// Hand out `total` whole units across `weights` by the largest-remainder method.
// Returns an integer array summing to EXACTLY `total`. All-zero weights fall back
// to an even split. (Shared by both the base-floor pass and the remainder pass.)
function distributeByWeight(weights, total) {
  const counts = weights.map(() => 0);
  if (total <= 0 || weights.length === 0) return counts;
  const positive = weights.map((w) => (typeof w === 'number' && w > 0 ? w : 0));
  const sum = positive.reduce((a, b) => a + b, 0);
  const eff = sum > 0 ? positive : weights.map(() => 1);
  const effSum = sum > 0 ? sum : weights.length;
  const raw = eff.map((w) => (w / effSum) * total);
  for (let i = 0; i < raw.length; i++) counts[i] = Math.floor(raw[i]);
  let remaining = total - counts.reduce((a, b) => a + b, 0);
  const byFrac = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; remaining > 0 && k < byFrac.length; k++) {
    counts[byFrac[k].i] += 1;
    remaining -= 1;
  }
  return counts;
}

// Allocate `total` scenes across the weighted sections, guaranteeing each section
// `minEach` scenes WHEN there are enough to go round (so no section is silently
// skipped and the arrangement covers the whole track). When `total` can't even
// satisfy the floor, the scarce scenes go to the heaviest sections — coverage is
// impossible with fewer scenes than sections, so weight decides who gets one.
function allocateByWeight(weights, total, minEach = 0) {
  const n = weights.length;
  const base = total >= n * minEach ? minEach : 0;
  const counts = weights.map(() => base);
  const extra = distributeByWeight(weights, total - base * n);
  for (let i = 0; i < n; i++) counts[i] += extra[i];
  return counts;
}

// Split one section's [startSec, endSec] span into `count` contiguous cut
// boundaries (length `count + 1`). Each interior cut snaps to the nearest grid
// point WITHIN `toleranceSec` (a finite tolerance, like the manual arranger — an
// unbounded snap would collapse a beatless section's interior cuts onto its own
// outer edges); when nothing is close enough the even-division time is kept. The
// result is then clamped into [prev + minSceneSec, endSec - remainingCuts *
// minSceneSec] so every produced span is at least `minSceneSec` long AND enough
// room is reserved for the cuts still to come. When the section is too short to
// honor minSceneSec for `count` cuts, fall back to plain even division (best
// effort — the render clamps clips to its own floor anyway). Outer edges never move.
function sectionCutBoundaries(startSec, endSec, count, gridPoints, minSceneSec, toleranceSec) {
  const span = endSec - startSec;
  const even = (k) => startSec + (span * k) / count;
  if (span < count * minSceneSec) {
    return Array.from({ length: count + 1 }, (_, k) => even(k));
  }
  const boundaries = [startSec];
  for (let k = 1; k < count; k++) {
    const raw = even(k);
    const snap = snapTimeToGrid(raw, gridPoints, toleranceSec);
    const candidate = snap ? snap.t : raw;
    const minB = boundaries[boundaries.length - 1] + minSceneSec;
    const maxB = endSec - (count - k) * minSceneSec; // leave room for remaining cuts
    boundaries.push(Math.min(Math.max(candidate, minB), maxB));
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
//   - missing per-section `energy` (older analyses) → weight by duration only
//     (an even, energy-agnostic spread across the track)
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

  // Weight = energy × duration, so a section's scene COUNT scales with both its
  // loudness and its length — making cut DENSITY (cuts per second) track energy.
  // Weighting by energy alone would give an 80s calm section and an 8s loud one
  // similar counts, leaving the long section sparsely cut. When no section
  // carries energy (legacy analyses, or the single synthetic fallback section),
  // weight by duration alone so scenes still spread evenly across the track.
  // Every section is guaranteed at least one scene when scenes ≥ sections, so a
  // near-silent section still gets a single long cut rather than a coverage gap.
  const haveEnergy = sections.some((s) => s.energy != null);
  const weights = sections.map((s) => (s.endSec - s.startSec) * (haveEnergy ? (s.energy ?? 0) : 1));
  const counts = allocateByWeight(weights, ordered.length, 1);

  // Build the snap grid from the EFFECTIVE sections (filtered/synthesized above),
  // not the raw analysis — so the single-section fallback still contributes its
  // edges and real beats/downbeats are honored when present.
  const gridPoints = buildBeatGridPoints({
    beats: audioAnalysis?.beats,
    downbeats: audioAnalysis?.downbeats,
    sections,
  });

  const result = [];
  let sceneIdx = 0;
  for (let si = 0; si < sections.length; si++) {
    const count = counts[si];
    if (count <= 0) continue;
    const boundaries = sectionCutBoundaries(
      sections[si].startSec, sections[si].endSec, count, gridPoints, minSceneSec, DEFAULT_TOLERANCE_SEC,
    );
    for (let k = 0; k < count; k++) {
      const scene = ordered[sceneIdx];
      sceneIdx += 1;
      result.push({
        sceneId: scene.sceneId,
        startSec: round3(boundaries[k]),
        endSec: round3(boundaries[k + 1]),
        // Auto-arrange always marks its spans beat-aligned: the computed per-scene
        // duration IS the director's intentional starting point, which the render
        // (`beatSnapClips`) then honors exactly rather than re-deriving its own cut.
        // The director can drag any scene afterward to fine-tune (a non-snapped
        // drag will clear this per the manual arranger).
        beatAligned: true,
      });
    }
  }
  return result;
}

// Resolve a BeatTimeline drag gesture (pointer delta in seconds) into a new
// span, snapping to the grid when the result lands within tolerance. `kind`
// is `'move'` (reposition the whole block, duration unchanged) or `'right'`
// (drag the out-point — the render can only ever shorten/lengthen a clip
// from its own frame 0, so there is no `'left'`/in-point equivalent; see
// `server/services/musicVideo/render.js` `beatSnapClips`, which always trims
// from `inSec: 0`).
export function computeDragSpan({ kind, startSpan, deltaSec, gridPoints, toleranceSec = DEFAULT_TOLERANCE_SEC, minSceneSec = MIN_SCENE_SEC }) {
  let nextStart = startSpan.startSec;
  let nextEnd = startSpan.endSec;
  if (kind === 'move') {
    const duration = startSpan.endSec - startSpan.startSec;
    nextStart = Math.max(0, startSpan.startSec + deltaSec);
    nextEnd = nextStart + duration;
  } else {
    nextEnd = Math.max(startSpan.startSec + minSceneSec, startSpan.endSec + deltaSec);
  }
  let snapped = false;
  if (kind === 'move') {
    const snap = snapTimeToGrid(nextStart, gridPoints, toleranceSec);
    if (snap) { nextEnd = snap.t + (nextEnd - nextStart); nextStart = snap.t; snapped = true; }
  } else {
    const snap = snapTimeToGrid(nextEnd, gridPoints, toleranceSec);
    if (snap) { nextEnd = snap.t; snapped = true; }
  }
  return { startSec: Number(nextStart.toFixed(3)), endSec: Number(nextEnd.toFixed(3)), snapped };
}

// A snapped drag earns the `beatAligned` flag (render honors the saved
// duration exactly — see `beatSnapClips`) only when the resulting DURATION is
// trustworthy. A `'right'` resize is always an explicit, intentional
// duration-setting action, so it always qualifies. A `'move'` never touches
// duration — it only repositions the block — so confirming it must NOT
// silently promote an unpersisted scene's synthetic `computeSceneSpans`
// fallback span (3s, unrelated to the scene's real generated clip length)
// into a "saved exactly" render duration. Only a move on an already-persisted
// span (a real duration the user previously set) can mark beatAligned.
export function shouldMarkBeatAligned({ kind, snapped, wasPersisted }) {
  if (!snapped) return false;
  return kind !== 'move' || !!wasPersisted;
}
