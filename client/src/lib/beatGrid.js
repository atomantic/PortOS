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
