/**
 * Lane-agnostic PER-RUN render options for image-to-3D generation (sampler
 * steps / seed / background keying / detail tier / alpha mode). Shared by the
 * route schema, the record layer, and every lane so accepted ranges and CLI
 * flags can't drift between them.
 *
 * Per-run parameters, NOT a stored preference: each generate request says what it
 * wants, the run entry records the concrete values the subprocess received, and
 * nothing merges or persists between runs.
 *
 *  - `steps: null` → the pipeline's own default (12 per flow phase).
 *  - `seed: null`  → roll a fresh random seed so "Re-render" samples a new model
 *    (the upstream CLI default is a fixed 42).
 *  - `detail: 'auto'` → derive the pipeline tier from host capability.
 *  - `alphaMode: null` → don't instruct the exporter; keep the force-opaque normalization.
 *  - `keyBackground: false` → hand the pipeline the untouched source so its own
 *    learned matte runs. Opt in only for a flat chroma backdrop.
 *  - `normalMap: false` → skip the normal-map bake. Opt in to recover shading detail
 *    the decimation discards, accepting the hard-crash risk noted below.
 *  - `subjectScale: 1` → source at its own framing. Below 1, centre the subject on a
 *    square canvas at that fraction so extremities gain margin.
 */

import { randomInt } from 'node:crypto';

/** Sampler steps per flow phase. Runtime scales roughly linearly with steps across
 * all three phases, so the cap keeps a mistyped value from queueing an hours-long render. */
export const RENDER_STEPS_MIN = 1;
export const RENDER_STEPS_MAX = 64;

/** Seeds stay in int32 range — both lanes hand them to torch generators, which reject
 * more (narrower than the unsigned `MAX_SEED` in `client/src/lib/genUtils.js`). */
export const RENDER_SEED_MAX = 2147483647;

/** A fresh random seed for an unpinned run. */
export function randomRenderSeed() {
  return randomInt(0, RENDER_SEED_MAX + 1);
}

/**
 * Abstract detail tiers, mapped by each target to its OWN concrete parameter.
 *
 * Not the raw `--pipeline-type` string: each lane has a different vocabulary (MPS port
 * `512`/`1024`/`1024_cascade`, Pixal3D a 1024/1536 resolution, TRELLIS.2 CUDA nothing), so
 * pass-through would leak one lane's enum into a shared API. The mapping lives on the
 * target descriptor (`detailTiers`).
 *
 * `'auto'` (derive from host capability) is a real value rather than `null` because the
 * user can pick it back deliberately after choosing a tier.
 */
export const DETAIL_TIERS = ['auto', 'fast', 'balanced', 'max'];
export const DEFAULT_DETAIL_TIER = 'auto';

/** Whether a value names a detail tier. */
export const isValidDetailTier = (value) => DETAIL_TIERS.includes(value);

/**
 * glTF alpha modes a caller may request for the exported material.
 *
 * `'auto'` defers to the exporter's heuristic (BLEND only when >1% of valid texels are
 * meaningfully transparent). `null` means "don't ask": exporter default plus PortOS's
 * force-opaque normalization, which exists for older exporters that promoted to BLEND
 * off a single low-alpha texel (see `glbMaterials.js`).
 */
export const ALPHA_MODES = ['OPAQUE', 'auto', 'BLEND', 'MASK'];

/** Whether a value names an alpha mode (null/undefined are "unset"). */
export const isValidAlphaMode = (value) => ALPHA_MODES.includes(value);

const intInRange = (value, min, max) => (
  Number.isInteger(value) && value >= min && value <= max
);

/** Whether a value is a valid steps count (null/undefined are "unset"). */
export const isValidRenderSteps = (value) => intInRange(value, RENDER_STEPS_MIN, RENDER_STEPS_MAX);

/** Whether a value is a valid seed (null/undefined are "unset"). */
export const isValidRenderSeed = (value) => intInRange(value, 0, RENDER_SEED_MAX);

/**
 * Subject framing: the fraction of the square output canvas the source image is
 * scaled to occupy, centered, before the decoder sees it.
 *
 * `1` is the identity (source passes through byte for byte). Below 1 the source's longest
 * side becomes `subjectScale x canvasSize`, composited centered, giving a pose with
 * outstretched limbs the margin its extremities need: a subject running to the frame edge
 * gives the decoder no context past the fingertips, and those come back clipped.
 *
 * Open at zero (0 would erase the subject), closed at one (above 1 would crop it).
 */
export const SUBJECT_SCALE_MIN_EXCLUSIVE = 0;
export const SUBJECT_SCALE_MAX = 1;
export const DEFAULT_SUBJECT_SCALE = 1;

/** Whether a value is a usable subject scale — a finite number in (0, 1]. */
export const isValidSubjectScale = (value) => (
  typeof value === 'number'
  && Number.isFinite(value)
  && value > SUBJECT_SCALE_MIN_EXCLUSIVE
  && value <= SUBJECT_SCALE_MAX
);

/**
 * Normalize a request's options into the per-run shape. Invalid/absent values
 * collapse to the unset sentinel (`null`) rather than throwing — the route
 * schema is the loud gate; this is the internal-caller normalizer.
 * @param {{steps?: number|null, seed?: number|null, keyBackground?: boolean,
 *          detail?: string, alphaMode?: string|null, normalMap?: boolean,
 *          subjectScale?: number}} [input]
 * @returns {{steps: number|null, seed: number|null, keyBackground: boolean,
 *            detail: string, alphaMode: string|null, normalMap: boolean,
 *            subjectScale: number}}
 */
export function normalizeRenderOptions(input = {}) {
  return {
    steps: isValidRenderSteps(input.steps) ? input.steps : null,
    seed: isValidRenderSeed(input.seed) ? input.seed : null,
    // Opt-IN. Writing an alpha channel REPLACES the learned matte rather than augmenting it:
    // TRELLIS.2's `preprocess_image` treats any non-opaque alpha as "already matted" and skips
    // RMBG-2.0, leaving a border flood fill that cannot remove anything not near the border
    // color (a cast shadow stays opaque and is reconstructed as a disconnected mass).
    // `keySolidBackground` remains for a synthetic image on a flat chroma backdrop.
    keyBackground: input.keyBackground === true,
    // `detail` collapses to the explicit 'auto' sentinel rather than null: it is a
    // choosable value, and a run entry recording 'auto' is what actually happened.
    detail: isValidDetailTier(input.detail) ? input.detail : DEFAULT_DETAIL_TIER,
    // `alphaMode` stays null-when-unset, because "don't ask the exporter" is a
    // genuinely different instruction from any of the concrete modes.
    alphaMode: isValidAlphaMode(input.alphaMode) ? input.alphaMode : null,
    // Opt-IN, like `--fill-holes`. The bake builds a BVH over a mesh far larger than mtlbvh's
    // regression tests cover and runs INSIDE `to_glb`, before generate.py exports the GLB. Its
    // Python guard catches a raise, but NOT a segfault, abort, OOM kill, or the macOS GPU
    // watchdog (see `isMpsWatchdogError`), any of which loses a 13-20 minute render that had
    // already produced a correct mesh and texture. So it cannot be claimed to never fail a render.
    normalMap: input.normalMap === true,
    // Defaults to the identity (`1`); collapses to the default rather than null for the same
    // reason `detail` collapses to 'auto': it is a real value and the run entry records what happened.
    subjectScale: isValidSubjectScale(input.subjectScale)
      ? input.subjectScale
      : DEFAULT_SUBJECT_SCALE,
  };
}

/**
 * The per-run option keys — exactly the keys `normalizeRenderOptions` returns. Exported so
 * the registry invariant validating a target's `supportsRenderOptions` derives the legal
 * knob names from here instead of restating (and drifting from) them.
 */
export const RENDER_OPTION_KEYS = Object.freeze(Object.keys(normalizeRenderOptions()));

/**
 * Validate steps/seed and emit their CLI flags — the single owner of the bounds check and
 * flag names, shared by the MPS and CUDA arg builders. `null` omits a flag (subprocess
 * default applies). Throws with the caller's label.
 * @param {string} label
 * @param {{steps?: number|null, seed?: number|null}} [opts]
 * @returns {string[]}
 */
export function renderOptionArgs(label, { steps = null, seed = null } = {}) {
  validateRenderOptions(label, { steps, seed });
  return [
    ...(seed !== null ? ['--seed', String(seed)] : []),
    ...(steps !== null ? ['--steps', String(steps)] : []),
  ];
}

/**
 * The bounds half of `renderOptionArgs`, for a lane that must validate an option it cannot
 * emit. Pixal3D: upstream's `inference.py` has no per-phase step override, so its builder
 * rejects an out-of-range `steps` at the same boundary while emitting no `--steps` flag.
 * Discarding `renderOptionArgs`' result would tempt re-spelling `--seed` locally, the
 * flag-name drift this module prevents. Throws with the caller's label.
 * @param {string} label
 * @param {{steps?: number|null, seed?: number|null}} [opts]
 */
export function validateRenderOptions(label, { steps = null, seed = null } = {}) {
  if (steps !== null && !isValidRenderSteps(steps)) {
    throw new Error(`${label}: steps must be an integer in [${RENDER_STEPS_MIN}, ${RENDER_STEPS_MAX}]`);
  }
  if (seed !== null && !isValidRenderSeed(seed)) {
    throw new Error(`${label}: seed must be an integer in [0, ${RENDER_SEED_MAX}]`);
  }
}

/**
 * Drop the options a target's runner will not honor, so the persisted run entry records
 * what the subprocess ACTUALLY received. `support` is the target descriptor's
 * `supportsRenderOptions`; absent means everything is honored.
 *
 * @param {object} options
 * @param {{steps?: boolean, detail?: boolean, alphaMode?: boolean,
 *          normalMap?: boolean}} [support]
 * @returns {object}
 */
export function honorTargetRenderSupport(options, support) {
  if (!support) return options;
  // Derived from the unset shape, not an enumerated key list, so every key in
  // `RENDER_OPTION_KEYS` is honored; resets to the same sentinel `normalizeRenderOptions`
  // produces for "unset" (`null`, `'auto'`, or `false`).
  const unset = normalizeRenderOptions();
  const dropped = Object.fromEntries(
    Object.entries(support)
      .filter(([key, supported]) => supported === false && key in unset)
      .map(([key]) => [key, unset[key]]),
  );
  return { ...options, ...dropped };
}
