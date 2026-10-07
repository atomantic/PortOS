/**
 * Whether an excerpt window fits a render of `totalSec` at `fps`. The end may run past the
 * render by up to one frame: scene timings come from the analysed song length while a
 * render's duration is frame-quantized, so the last scene's end (119.943s) can sit a
 * fraction of a frame past a 24 fps document render (119.92s). Callers clamp the end. The
 * start must still fall inside the render, and an unknown fps allows no slack.
 */
export function excerptRangeFits(startSec, endSec, totalSec, fps) {
  const frame = Number.isFinite(fps) && fps > 0 ? 1 / fps : 0;
  return startSec >= 0 && startSec < totalSec && endSec > startSec && endSec <= totalSec + frame + 1e-6;
}
