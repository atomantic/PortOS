/**
 * Creative Director presets — locked-at-creation aspect ratio + quality
 * settings that map onto the render-API params the LTX/mlx_video pipeline
 * actually consumes.
 *
 * The contract: a project picks an aspectRatio + quality + modelId once;
 * every scene render uses these. Tweaking is intentionally not allowed
 * mid-project — segment-to-segment continuity needs identical resolution
 * and frame budgets.
 */

// Width/height pairs are 64-aligned (videoGen rounds down to multiples of
// 64 anyway) and chosen for sensible LTX defaults.
export const ASPECT_PRESETS = Object.freeze({
  '16:9': { width: 768, height: 432 },
  '9:16': { width: 432, height: 768 },
  '1:1':  { width: 512, height: 512 },
});

// `steps` and `guidance` are mlx_video knobs. `fps` is the render frame
// rate. Higher quality = more denoising steps + slightly higher guidance,
// trading wall-clock time for fidelity.
export const QUALITY_PRESETS = Object.freeze({
  draft:    { steps: 8,  guidance: 2.5, fps: 24 },
  standard: { steps: 20, guidance: 3.0, fps: 24 },
  high:     { steps: 30, guidance: 3.5, fps: 30 },
});

export const ASPECT_RATIOS = Object.freeze(['16:9', '9:16', '1:1']);
export const QUALITIES = Object.freeze(['draft', 'standard', 'high']);

/**
 * Map a project's aspectRatio + quality + scene durationSeconds to the
 * concrete render-API body.
 *
 * numFrames is rounded to a multiple of 8 because LTX latent compression
 * is `1 + (frames - 1) / 8` — non-multiples silently break the
 * conditioning shape check on i2v renders. Floor to 8 frames minimum so
 * a 0.3s scene still produces something coherent.
 */
export function presetToRenderParams({ aspectRatio, quality, durationSeconds }) {
  const aspect = ASPECT_PRESETS[aspectRatio];
  if (!aspect) throw new Error(`Unknown aspectRatio '${aspectRatio}'`);
  const q = QUALITY_PRESETS[quality];
  if (!q) throw new Error(`Unknown quality '${quality}'`);
  const requested = Math.max(0.1, Number(durationSeconds) || 1) * q.fps;
  // Round to nearest multiple of 8, with an 8-frame floor.
  const numFrames = Math.max(8, Math.round(requested / 8) * 8);
  return {
    width: aspect.width,
    height: aspect.height,
    fps: q.fps,
    steps: q.steps,
    guidanceScale: q.guidance,
    numFrames,
  };
}
