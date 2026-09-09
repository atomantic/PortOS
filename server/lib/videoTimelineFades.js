/**
 * Shrink a fade pair that no longer fits `duration`, scaling both
 * proportionally so the author's balance survives. Non-throwing twin of
 * `clampFades` in services/videoTimeline/segments.js: that one rejects an
 * over-long pair at persist time, this one repairs a pair that a later change
 * made too long (a probe-shortened bed, a
 * legacy trim). ffmpeg's `fade` renders the whole segment black when its start
 * time goes negative, so an unfitted pair is not a cosmetic problem.
 */
export function fitFades(fadeInSec, fadeOutSec, duration) {
  const fin = Math.max(0, Number(fadeInSec) || 0);
  const fout = Math.max(0, Number(fadeOutSec) || 0);
  const span = fin + fout;
  if (span <= duration || span === 0) return { fadeInSec: fin, fadeOutSec: fout };
  const scale = Math.max(0, duration) / span;
  return { fadeInSec: fin * scale, fadeOutSec: fout * scale };
}
