// LTX 2.5 References (mode `ic-ingredients-25`) clip sizing shared by the Music Video
// board hook and the production run's clip dispatch, so both send the same request.
import { normalizePreMusic } from './musicVideoColdOpen.js';

export const LTX_REFERENCES_MIN_FRAMES = 121;
// The largest clip the LTX 2.5 models accept in one render.
export const LTX_REFERENCES_MAX_FRAMES = 1017;

/**
 * Frames for a reference clip: at least 121, covering the shot at 24 fps on LTX's 8n+1
 * grid (or the card's chosen `requestedFrames`). Null when one clip cannot cover it.
 */
export function ltxReferenceClipFrames(scene, requestedFrames = null) {
  const shotSeconds = normalizePreMusic(scene.preMusic)?.durationSec ?? (scene.endSec - scene.startSec);
  const covering = Number.isFinite(shotSeconds) && shotSeconds > 0 ? 1 + 8 * Math.ceil(shotSeconds * 24 / 8) : LTX_REFERENCES_MIN_FRAMES;
  const frames = Math.max(LTX_REFERENCES_MIN_FRAMES, 1 + 8 * Math.ceil(((requestedFrames || covering) - 1) / 8));
  return frames <= LTX_REFERENCES_MAX_FRAMES ? frames : null;
}
