import { STILL_PAN_TRAVEL, STILL_PUSH_ZOOM } from '../../../server/lib/musicVideoLayers.js';
import { stillMoveForCamera } from '../../../server/lib/cameraMovements.js';

/**
 * Music Video per-scene visual layers (#8985) — re-export of
 * `server/lib/musicVideoLayers.js`, so the board's layer picker and Render
 * readiness follow the same rules as the server's render preflight.
 */
export {
  MUSIC_VIDEO_VISUAL_LAYERS,
  MUSIC_VIDEO_STILL_MOVES,
  MUSIC_VIDEO_FRAME_FITS,
  MUSIC_VIDEO_TEXT_ZONES,
  MUSIC_VIDEO_LYRIC_ROLES,
  MUSIC_VIDEO_LYRIC_SIZES,
  composedDrawsLyrics,
  isSelfDrawnLayer,
  sceneVisualLayer,
  sceneHasAuthoredSpan,
  sceneUsesAuthoredTiming,
  sceneRenderReady,
  isLayeredComposition,
  LAYERED_COMPOSITION_MODES,
  CLIP_TIMING_FPS,
  CLIP_SPEED_FPS_RANGE,
  CLIP_OFFSET_FRAMES_RANGE,
  clipSpeedRate,
  clipOffsetSec,
  clipReversed,
  COVERAGE_TOLERANCE_SEC,
  clipCanLoop,
  clipLoops,
  clipPlaybackWindow,
  clipNeedsMoreFootage,
} from '../../../server/lib/musicVideoLayers.js';

/** The composed render's cover-fitted still move at a song time, clamped to its last frame. */
export function stillFrameTransform(scene, time, { fps = 24, startSec = scene.startSec, endSec = scene.endSec } = {}) {
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) return 'none';
  const frames = Math.max(1, Math.round(endSec * fps) - Math.round(startSec * fps));
  const frame = Math.min(frames - 1, Math.max(0, Math.floor(time * fps) - Math.round(startSec * fps)));
  const move = scene.stillMove || stillMoveForCamera(scene.camera) || 'hold';
  // zoompan divides by the frame count; crop's pan reaches the far edge on the last frame.
  if (move === 'push') return `scale(${1 + STILL_PUSH_ZOOM * frame / frames})`;
  if (move === 'pan') {
    const travel = STILL_PAN_TRAVEL * (0.5 - frame / Math.max(1, frames - 1));
    return `translateX(${Number((100 * travel).toFixed(6))}%) scale(${1 + STILL_PAN_TRAVEL})`;
  }
  return 'none';
}
