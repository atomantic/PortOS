/**
 * Sprites — walk-cycle authoring bounds + pure label/clamp helpers.
 *
 * A dependency-free leaf module (NO sharp/ffmpeg) so both the deterministic
 * packer (walkPostprocess.js, which imports sharp) AND the request-validation
 * layer (server/lib/validation.js) can share ONE definition of the frame-count
 * / playback-fps range. Keeping these in walkPostprocess would drag its native
 * image graph into the validation graph; duplicating them as literals in the
 * Zod schema let the schema and the server-side clamp silently diverge. This
 * module is the single source of truth for both — see the recordsLogic.js
 * sharp-free split for the same pattern.
 */

// Source-pipeline gait phases (the historical 8-frame packing). Part of the
// cross-install artifact contract — imported manifests carry these exact labels.
export const WALK_PHASES = [
  'left-contact', 'left-down', 'left-passing', 'left-up',
  'right-contact', 'right-down', 'right-passing', 'right-up',
];

// Legacy default / fallback frame count for manifests (or clients) that omit it.
export const WALK_FRAME_COUNT = 8;

// Configurable authoring range (#sprite-walk-variable-frames). The packer
// resamples the detected gait window DOWN to `frameCount` distinct source frames
// (never upsamples), and playback fps is metadata — so a slower/smoother walk
// needs no regeneration, only a reprocess of the on-disk clip at a new count/fps.
export const WALK_DEFAULT_FRAME_COUNT = 12;
export const WALK_DEFAULT_FPS = 10;
export const WALK_MIN_FRAME_COUNT = 6;
export const WALK_MAX_FRAME_COUNT = 16;
export const WALK_MIN_FPS = 4;
export const WALK_MAX_FPS = 24;

/**
 * Column/phase labels for an N-frame packed strip. The historical 8-frame
 * packing keeps its named 2-beat gait phases (so existing atlases and imported
 * manifests round-trip byte-identically); any other length uses positional
 * `frame-NN` labels. Postprocess (which writes them) and atlas.js (which
 * asserts them) MUST derive labels through this one helper so they can never
 * disagree on a column's identity.
 */
export function walkPhaseLabels(n) {
  if (n === WALK_PHASES.length) return [...WALK_PHASES];
  return Array.from({ length: n }, (_, i) => `frame-${String(i).padStart(2, '0')}`);
}

/** Clamp a requested frame count into the supported authoring range. */
export function clampFrameCount(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return WALK_DEFAULT_FRAME_COUNT;
  return Math.max(WALK_MIN_FRAME_COUNT, Math.min(WALK_MAX_FRAME_COUNT, v));
}

/** Clamp a requested playback fps into the supported authoring range. */
export function clampFps(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return WALK_DEFAULT_FPS;
  return Math.max(WALK_MIN_FPS, Math.min(WALK_MAX_FPS, v));
}
