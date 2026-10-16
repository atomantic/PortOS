/**
 * Music Video — choosing the video frames worth a YouTube thumbnail.
 *
 * The publishing kit cuts candidate frames from the final render, scores each
 * from the image alone, and keeps the best frame of each shot, best first.
 * Pure apart from reading the frames; `sharp` is loaded lazily.
 */

const MAX_THUMBNAILS = 6;
// Frames looked at to find those six: two per shot, spread across the song.
const THUMBNAIL_CANDIDATES = 24;

/** The longest stretch of [from, to] with no lyric on screen, or null when lyrics cover all of it. */
function longestLyricFreeStretch(from, to, cues) {
  let best = null;
  let cursor = from;
  const covering = cues.filter((c) => c.endSec > from && c.startSec < to).sort((a, b) => a.startSec - b.startSec);
  for (const c of [...covering, { startSec: to, endSec: to }]) {
    const gapEnd = Math.min(c.startSec, to);
    if (gapEnd - cursor > (best ? best.to - best.from : 0)) best = { from: cursor, to: gapEnd };
    cursor = Math.max(cursor, c.endSec);
  }
  return best;
}

/**
 * Frame times worth judging for a thumbnail: two per shot, inside the shot's
 * middle so a transition or a cut never lands on one, and where the shot has
 * a moment with no lyric on screen, inside that moment (a render can draw the
 * lyrics over the picture). Without shots, even steps across the song. Each
 * candidate names its shot, so the pick can keep to one frame per shot.
 */
export function thumbnailCandidates(project, durationSec, max = THUMBNAIL_CANDIDATES) {
  const cues = (project.lyricCues || []).filter((c) => Number.isFinite(c?.startSec) && Number.isFinite(c?.endSec) && c.endSec > c.startSec);
  const shots = (project.scenes || [])
    .filter((s) => Number.isFinite(s?.startSec) && Number.isFinite(s?.endSec) && s.endSec > s.startSec && s.startSec < durationSec)
    .map((s, i) => ({ key: s.sceneId || `shot-${i}`, from: s.startSec, to: Math.min(s.endSec, durationSec), performance: s.shotMode === 'performance' }));
  const steps = Math.max(1, Math.ceil(max / 2));
  const pool = shots.length ? shots : Array.from({ length: steps }, (_, i) => ({ key: `step-${i}`, from: (i / steps) * durationSec, to: ((i + 1) / steps) * durationSec, performance: false }));
  const round = (t) => Math.round(t * 1000) / 1000;
  const all = pool.flatMap((shot) => {
    const len = shot.to - shot.from;
    const middle = { from: shot.from + len * 0.15, to: shot.to - len * 0.15 };
    const free = longestLyricFreeStretch(middle.from, middle.to, cues);
    const span = free && free.to - free.from >= 0.25 ? free : middle;
    const lyric = span === middle && cues.some((c) => c.endSec > middle.from && c.startSec < middle.to);
    return [0.35, 0.7].map((f) => ({ t: round(span.from + (span.to - span.from) * f), shot: shot.key, performance: shot.performance, lyric }));
  });
  if (all.length <= max) return all;
  return Array.from({ length: max }, (_, i) => all[Math.floor((i * all.length) / max)]);
}

/**
 * How good a frame looks as a thumbnail, from the image alone: how much crisp
 * detail it holds (a frame mid-motion-blur or mid-dissolve holds little), how
 * much contrast, and whether it is close to black or blown out. Relative: it
 * only ranks one video's frames against each other.
 */
export async function scoreThumbnailFrame(path, deps = {}) {
  const sharp = deps.sharp || (await import('sharp')).default;
  const grey = sharp(path).resize(320, 180, { fit: 'fill' }).greyscale();
  const [{ channels: [tone] }, { channels: [edges] }] = await Promise.all([
    grey.clone().stats(),
    grey.clone().convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0], offset: 128 }).stats(),
  ]);
  const exposure = tone.mean < 28 || tone.mean > 228 ? 0.3 : 1;
  const contrast = Math.min(1, Math.max(0.3, tone.stdev / 45));
  return edges.stdev * contrast * exposure;
}

/**
 * The thumbnails to keep: the best-scoring frame of each shot, best first,
 * at most `max`. The singer sells a thumbnail, so a performance shot's frame
 * counts a little more; a frame a lyric may be drawn over counts less.
 */
export function pickThumbnailFrames(scored, max = MAX_THUMBNAILS) {
  const weight = (c) => c.score * (c.performance ? 1.15 : 1) * (c.lyric ? 0.75 : 1);
  const bestPerShot = new Map();
  for (const c of scored) {
    if (!Number.isFinite(c.score)) continue;
    const held = bestPerShot.get(c.shot);
    if (!held || weight(c) > weight(held)) bestPerShot.set(c.shot, c);
  }
  return [...bestPerShot.values()].sort((a, b) => weight(b) - weight(a)).slice(0, max);
}
