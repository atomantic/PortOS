/**
 * Sprite walk-cycle authoring bounds, gait phases and pure label and clamp helpers.
 *
 * A dependency-free leaf (NO sharp/ffmpeg) so the packer (walkPostprocess.js)
 * and request validation (server/lib/spriteValidation.js) share one definition of the
 * frame-count / fps range without dragging the native image graph into
 * validation. The numbers live in the per-track registry (`spriteAnimationTracks.js`,
 * #3015); the exports here are the WALK view of that registry.
 */

import {
  WALK_TRACK, getAnimationTrack, clampTrackFrameCount, clampTrackFps,
} from './spriteAnimationTracks.js';

const WALK = getAnimationTrack(WALK_TRACK);

// Source-pipeline gait phases (the historical 8-frame packing). Part of the
// cross-install artifact contract: imported manifests carry these exact labels.
export const WALK_PHASES = [
  'left-contact', 'left-down', 'left-passing', 'left-up',
  'right-contact', 'right-down', 'right-passing', 'right-up',
];

// Fallback frame count for manifests (or clients) that omit it.
export const WALK_FRAME_COUNT = 8;

// Legacy compiled-grid column names, kept so readers can describe imported and
// pre-#2986 atlases; the compiler (atlas.js `atlasColumns`) and the layout
// sidecar (atlasLayout.js) share them so a column's identity never diverges.
// `scanner` is READ-ONLY: no longer emitted (#2986), but imported grids carry it.
export const ATLAS_IDLE_COLUMN = 'idle';
export const ATLAS_SCANNER_COLUMN = 'scanner';

// Authoring range (#sprite-walk-variable-frames) read from the walk registry row.
// The packer resamples DOWN to `frameCount` frames (never upsamples); fps is metadata.
export const WALK_DEFAULT_FRAME_COUNT = WALK.defaultFrameCount;
export const WALK_DEFAULT_FPS = WALK.defaultFps;
export const WALK_MIN_FRAME_COUNT = WALK.minFrameCount;
export const WALK_MAX_FRAME_COUNT = WALK.maxFrameCount;
export const WALK_MIN_FPS = WALK.minFps;
export const WALK_MAX_FPS = WALK.maxFps;

/**
 * Column/phase labels for an N-frame packed strip. The 8-frame packing keeps its
 * named gait phases (existing atlases round-trip byte-identically); other lengths
 * use `frame-NN`. Writers and atlas.js MUST derive labels through this helper.
 */
export function walkPhaseLabels(n) {
  if (n === WALK_PHASES.length) return [...WALK_PHASES];
  return Array.from({ length: n }, (_, i) => `frame-${String(i).padStart(2, '0')}`);
}

/** Clamp a requested frame count into the WALK track's authoring range. */
export function clampFrameCount(n) {
  return clampTrackFrameCount(n, WALK_TRACK);
}

/** Clamp a requested playback fps into the WALK track's authoring range. */
export function clampFps(n) {
  return clampTrackFps(n, WALK_TRACK);
}
