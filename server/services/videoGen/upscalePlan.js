/**
 * Video upscale — method contract, alignment math, and the provenance shape.
 *
 * Two upscale methods share one request contract (#6502 / #6509):
 *
 *  - `lanczos` — the historical ffmpeg pass. Pixel-faithful, no model, no
 *    alignment constraint, and the DEFAULT for every existing caller.
 *  - `ltx` — the LTX-2.5 Pixel Spatial Upscaler adapter, which synthesizes
 *    detail on a GPU runtime. Gated on a cached adapter and a supported
 *    backend, and constrained by the model's frame/spatial grid.
 *
 * This module holds only the pure parts (the enum, the grid, the padding math
 * and the provenance field list) so the numbers can be tested without touching
 * ffprobe, the HF cache, or the history file.
 */

export const UPSCALE_METHODS = Object.freeze(['lanczos', 'ltx']);
export const DEFAULT_UPSCALE_METHOD = 'lanczos';

// Both methods double each axis. Declared once because the plan endpoint, the
// Lanczos entry builder and the client disclosure all quote it.
export const UPSCALE_SCALE = 2;

// The registry key of the adapter the generative method fuses (#6508).
export const LTX_UPSCALE_WEIGHT_KEY = 'pixel-upscale';

// The BYOV runtime that carries the generative method on each host class.
// macOS runs the MLX pipeline (#6512); every other platform with a CUDA card
// runs the distilled CUDA runner (#6513). A host with neither has no generative
// backend at all, which the plan reports rather than discovering at render time.
export const LTX_UPSCALE_RUNTIME_BY_PLATFORM = Object.freeze({
  darwin: 'ltx25',
  win32: 'ltx25_cuda',
  linux: 'ltx25_cuda',
});

export const ltxUpscaleRuntimeId = (platform = process.platform) => (
  LTX_UPSCALE_RUNTIME_BY_PLATFORM[platform] || null
);

// The LTX-2.5 two-stage grid, mirrored from `validate_args` in
// `scripts/generate_ltx25_cuda.py`: output dimensions must be divisible by 64
// and the frame count must satisfy `frames % 8 == 1` with a floor of 9. The
// MLX runner (#6512) must establish the same rule from the model card; if it
// turns out to differ, this constant is the single place both read.
export const LTX_GRID = Object.freeze({
  spatialMultiple: 64,
  frameModulus: 8,
  frameRemainder: 1,
  minFrames: 9,
});

const roundUpTo = (value, multiple) => Math.ceil(value / multiple) * multiple;

// The smallest frame count >= `frames` that satisfies the grid. `frames % 8 == 1`
// has a solution every 8 frames, so this never overshoots by more than 7.
export const alignFrameCount = (frames, grid = LTX_GRID) => {
  const floor = Math.max(grid.minFrames, Math.ceil(frames));
  const remainder = ((floor % grid.frameModulus) + grid.frameModulus) % grid.frameModulus;
  const delta = (grid.frameRemainder - remainder + grid.frameModulus) % grid.frameModulus;
  return floor + delta;
};

/**
 * What the generative method would have to do to a source before it fits the
 * model grid, stated as an explicit plan rather than applied silently.
 *
 * #6502 forbids hidden cropping and hidden duration loss, so this ALWAYS pads
 * and never trims: extra pixels on the right/bottom and extra frames on the
 * tail are recoverable (the caller crops the padding back off the output),
 * whereas a crop or a trim destroys source content the user never agreed to
 * lose. `trimFrames` is reported so the contract can carry a trim if a future
 * backend ever needs one, and is 0 on every path today.
 *
 * Padding is computed on the SOURCE axis (so the disclosure can say "848 →
 * 864") and the target is the padded source scaled by `UPSCALE_SCALE`. Because
 * the scale is 2 and the grid multiple is 64, a source axis conforms exactly
 * when it is divisible by 32.
 */
export const planLtxAlignment = ({ width, height, frameCount } = {}, grid = LTX_GRID) => {
  const sourceMultiple = grid.spatialMultiple / UPSCALE_SCALE;
  const knownWidth = Number.isFinite(width) && width > 0 ? Math.round(width) : null;
  const knownHeight = Number.isFinite(height) && height > 0 ? Math.round(height) : null;
  const knownFrames = Number.isFinite(frameCount) && frameCount > 0 ? Math.round(frameCount) : null;

  const paddedWidth = knownWidth === null ? null : roundUpTo(knownWidth, sourceMultiple);
  const paddedHeight = knownHeight === null ? null : roundUpTo(knownHeight, sourceMultiple);
  const paddedFrames = knownFrames === null ? null : alignFrameCount(knownFrames, grid);

  const padWidth = knownWidth === null ? null : paddedWidth - knownWidth;
  const padHeight = knownHeight === null ? null : paddedHeight - knownHeight;
  const padFrames = knownFrames === null ? null : paddedFrames - knownFrames;

  // "Conforming" is only assertable when every axis was measurable. An
  // unmeasured axis is `null` (unknown), never a silent 0 — a caller must not
  // read "no padding needed" out of a probe that failed.
  const measured = [padWidth, padHeight, padFrames];
  const conforming = measured.every((n) => n !== null) ? measured.every((n) => n === 0) : null;

  return {
    ...grid,
    sourceMultiple,
    padWidth,
    padHeight,
    padFrames,
    trimFrames: 0,
    paddedSource: { width: paddedWidth, height: paddedHeight, frameCount: paddedFrames },
    conforming,
  };
};

// Target dimensions the method produces. Lanczos scales the source verbatim;
// the generative method scales the PADDED source, because that is what the
// model actually renders.
export const planTargetDimensions = ({ method, width, height, frameCount, alignment }) => {
  const scaleAxis = (n) => (Number.isFinite(n) && n > 0 ? Math.round(n) * UPSCALE_SCALE : null);
  if (method !== 'ltx') {
    return {
      width: scaleAxis(width),
      height: scaleAxis(height),
      frameCount: Number.isFinite(frameCount) && frameCount > 0 ? Math.round(frameCount) : null,
    };
  }
  return {
    width: scaleAxis(alignment?.paddedSource?.width),
    height: scaleAxis(alignment?.paddedSource?.height),
    frameCount: alignment?.paddedSource?.frameCount ?? null,
  };
};

/**
 * Provenance an upscaled history entry records (#6509 item 4).
 *
 * A video-history row is a plain JSON object with no sanitizer, so these are a
 * documented contract rather than a schema. Every upscale method writes the
 * full list; the generative dispatch slice (#6511) fills the model-specific
 * ones that Lanczos leaves null:
 *
 *  - `upscaledFrom`   — source history id. Also the ALREADY_UPSCALED guard.
 *  - `upscaleMethod`  — `'lanczos' | 'ltx'`.
 *  - `width`/`height` — the ACTUAL output dimensions, measured from the file
 *                       where the method can produce something other than 2x
 *                       the source (a padded generative render).
 *  - `fps`            — output frame rate.
 *  - `numFrames`      — output frame count.
 *  - `duration`       — output duration in seconds.
 *  - `seed`           — the generative render's seed, so the pass is
 *                       reproducible. Lanczos is deterministic and has no seed
 *                       of its own, so it writes none; read `upscaleMethod`
 *                       rather than the presence of this key to tell the two
 *                       apart, because an upscaled row also inherits the SOURCE
 *                       render's fields.
 *  - `upscaleRuntime` — BYOV runtime id that rendered it (`ltx25` /
 *                       `ltx25_cuda`), or `'ffmpeg'` for Lanczos.
 *  - `renderStartedAt`/`renderMs` — measured wall-clock render time (#5878).
 */
export const UPSCALE_PROVENANCE_FIELDS = Object.freeze([
  'upscaledFrom',
  'upscaleMethod',
  'width',
  'height',
  'fps',
  'numFrames',
  'duration',
  'seed',
  'upscaleRuntime',
  'renderStartedAt',
  'renderMs',
]);

// The subset of the contract the Lanczos pass writes ITSELF, rather than
// inheriting from the source row it spreads. Asserted against a real Lanczos
// entry, so dropping one of these from the row builder fails a test instead of
// quietly producing a row #6511's readers cannot tell apart from a legacy one.
export const LANCZOS_PROVENANCE_FIELDS = Object.freeze([
  'upscaledFrom',
  'upscaleMethod',
  'upscaleRuntime',
  'width',
  'height',
  'renderStartedAt',
  'renderMs',
]);

// The runtime id Lanczos records — it is an ffmpeg filter pass, not a BYOV
// runtime, and naming it explicitly keeps `upscaleRuntime` non-null on every
// upscaled row.
export const LANCZOS_RUNTIME_ID = 'ffmpeg';
