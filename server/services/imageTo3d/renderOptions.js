/**
 * Lane-agnostic PER-RUN render options for image-to-3D generation (sampler
 * steps / seed / background keying / detail tier / alpha mode). Shared by the
 * route schema, the record layer, and every lane so the accepted ranges and CLI
 * flags can't drift between them.
 *
 * These are deliberately per-run parameters, NOT a stored record preference:
 * each generate request says what it wants, the run entry records the concrete
 * values the subprocess received (the truthful, reproducible record), and
 * nothing merges or persists between runs.
 *
 *  - `steps: null` → the pipeline's own default (12 per flow phase).
 *  - `seed: null`  → roll a fresh random seed for this run, so "Re-render"
 *    actually samples a new model instead of deterministically reproducing the
 *    last one (the upstream CLI default is a fixed 42).
 *  - `detail: 'auto'` → derive the pipeline tier from host capability, which is
 *    what every lane did before the knob existed.
 *  - `alphaMode: null` → don't instruct the exporter, and keep PortOS's
 *    force-opaque normalization.
 *  - `keyBackground: false` (the default) → hand the pipeline the untouched source
 *    so its own learned matte runs. Opt in only for a flat chroma backdrop.
 *  - `normalMap: false` (the default) → skip the normal-map bake. Opt in to recover
 *    shading detail the decimation discards, accepting the hard-crash risk noted
 *    below.
 *  - `subjectScale: 1` (the default) → hand the pipeline the source at its own
 *    framing. Below 1, centre the subject on a square canvas at that fraction so a
 *    pose that runs to the edge gains margin around its extremities.
 */

import { randomInt } from 'node:crypto';

/** Sampler steps per flow phase. The pipeline default is 12; runtime scales
 * roughly linearly with steps across all three phases, so the cap keeps a
 * mistyped value from queueing an hours-long render. */
export const RENDER_STEPS_MIN = 1;
export const RENDER_STEPS_MAX = 64;

/** Seeds stay in int32 range — both lanes hand them to torch generators.
 * (Deliberately narrower than the 32-bit unsigned `MAX_SEED` the image/video
 * gen lanes use in `client/src/lib/genUtils.js` — torch rejects > int32.) */
export const RENDER_SEED_MAX = 2147483647;

/** A fresh random seed for an unpinned run. */
export function randomRenderSeed() {
  return randomInt(0, RENDER_SEED_MAX + 1);
}

/**
 * Abstract detail tiers, mapped by each target to its OWN concrete parameter.
 *
 * Deliberately not the raw `--pipeline-type` string. Each lane has a different
 * vocabulary for the same idea — the MPS port takes `512` / `1024` /
 * `1024_cascade`, Pixal3D takes a 1024/1536 resolution, the TRELLIS.2 CUDA lane
 * takes nothing at all — so a raw pass-through would leak one lane's enum into a
 * shared API and render a control that is wrong for the others. The mapping lives
 * on the target descriptor (`detailTiers`), so a lane that gains a tier is a
 * registry edit rather than a change here.
 *
 * `'auto'` is the default and means "derive from host capability", which is the
 * behaviour every lane had before this option existed. It is a real value rather
 * than `null` because the user can pick it back deliberately after choosing a tier.
 */
export const DETAIL_TIERS = ['auto', 'fast', 'balanced', 'max'];
export const DEFAULT_DETAIL_TIER = 'auto';

/** Whether a value names a detail tier. */
export const isValidDetailTier = (value) => DETAIL_TIERS.includes(value);

/**
 * glTF alpha modes a caller may request for the exported material.
 *
 * `'auto'` defers to the exporter's own heuristic (BLEND only when >1% of valid
 * texels are meaningfully transparent). `null` means "don't ask", which keeps the
 * historical behaviour: exporter default plus PortOS's force-opaque normalization.
 * That normalization exists for older exporters that promoted to BLEND off a
 * single low-alpha texel — see `glbMaterials.js`.
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
 * `1` is the identity — no canvas, no resize, the source passes through byte for
 * byte — and it is the default, so no existing render changes behaviour. Below 1
 * the source is resized so its longest side is `subjectScale x canvasSize` and
 * composited centered on the square canvas, which is what buys a full-body pose
 * with outstretched limbs the empty margin its extremities need to survive
 * reconstruction: a subject running to the edge of the frame hands the decoder
 * zero context beyond the fingertips, and fingertips are what come back clipped.
 *
 * The range is open at zero and closed at one: 0 would scale the subject out of
 * existence, and above 1 would crop it, which is the failure this option exists
 * to avoid rather than a framing anyone wants.
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
    // Opt-IN. Writing an alpha channel is not a free head start for the pipeline:
    // TRELLIS.2's `preprocess_image` treats any non-opaque alpha as "already matted"
    // and skips RMBG-2.0 entirely. So keying does not augment the learned matte, it
    // REPLACES it with a border flood fill — which structurally cannot remove anything
    // that isn't near the border color. A subject casting a shadow onto a surface keeps
    // that shadow opaque, and the decoder reconstructs it as its own disconnected mass.
    // `keySolidBackground` stays available for a synthetic image on a flat chroma
    // backdrop, where the caller genuinely knows better than a segmentation model.
    keyBackground: input.keyBackground === true,
    // `detail` collapses to the explicit 'auto' sentinel rather than null: it is a
    // choosable value, and a run entry recording 'auto' is what actually happened.
    detail: isValidDetailTier(input.detail) ? input.detail : DEFAULT_DETAIL_TIER,
    // `alphaMode` stays null-when-unset, because "don't ask the exporter" is a
    // genuinely different instruction from any of the concrete modes.
    alphaMode: isValidAlphaMode(input.alphaMode) ? input.alphaMode : null,
    // Opt-IN, for the same reason `--fill-holes` is. The bake builds a BVH over a
    // mesh far larger than anything mtlbvh's regression tests cover, and it runs
    // INSIDE `to_glb` — i.e. before generate.py has exported the GLB. Its Python
    // guard catches a raise, but NOT a segfault, an abort, an OOM kill, or the macOS
    // GPU watchdog killing a long Metal dispatch (the failure this branch's own
    // `isMpsWatchdogError` exists for). Any of those loses a 13-20 minute render that
    // had already produced a correct mesh and texture.
    //
    // An earlier revision defaulted this ON and claimed it "cannot fail a render".
    // That was false as written, and it was the claim the opt-out decision rested on.
    normalMap: input.normalMap === true,
    // Defaults to the identity (`1` = no reframing), so every render that predates
    // this knob keeps handing the decoder its untouched source. Collapses to the
    // default rather than null for the same reason `detail` collapses to 'auto': it
    // is a real, choosable value, and a run entry recording `1` is what happened.
    subjectScale: isValidSubjectScale(input.subjectScale)
      ? input.subjectScale
      : DEFAULT_SUBJECT_SCALE,
  };
}

/**
 * The per-run option keys — i.e. exactly the keys `normalizeRenderOptions` returns.
 *
 * Exported so the registry invariant that validates a target's
 * `supportsRenderOptions` can derive the legal knob names from here instead of
 * restating them. That list had already drifted once: it still read
 * `['steps','seed','keyBackground']` after `detail` and `alphaMode` were added, so a
 * descriptor declaring support for a real knob failed the invariant while a typo'd
 * knob name would have passed.
 */
export const RENDER_OPTION_KEYS = Object.freeze(Object.keys(normalizeRenderOptions()));

/**
 * Validate steps/seed and emit their CLI flags — the single owner of both the
 * bounds check and the flag names, shared by the MPS and CUDA arg builders so
 * neither the ranges nor the CLI contract can drift between lanes. `null`
 * omits a flag (the subprocess default applies). Throws with the caller's
 * label so the error reads like the builder that rejected it.
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
 * The bounds half of `renderOptionArgs`, for a lane that must validate an option it
 * cannot emit. Pixal3D is the case: upstream's `inference.py` has no per-phase step
 * override, so its builder has to reject an out-of-range `steps` at the same boundary
 * as the other lanes while emitting no `--steps` flag. Calling `renderOptionArgs` and
 * discarding the result would work, but it reads like a dropped return value AND
 * tempts the caller into re-spelling `--seed` locally — which is exactly the flag-name
 * drift this module exists to prevent. Throws with the caller's label.
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
 * Drop the options a target's runner will not honor, so the persisted run entry
 * records what the subprocess ACTUALLY received rather than what the user asked for.
 *
 * This module's contract is that a run entry holds "the concrete values the subprocess
 * received (the truthful, reproducible record)" — a target whose runner silently drops
 * an option would otherwise break that invariant and log a quality setting that never
 * applied. `support` is the target descriptor's `supportsRenderOptions`; absent means
 * everything is honored, so existing targets need no entry.
 *
 * @param {object} options
 * @param {{steps?: boolean, detail?: boolean, alphaMode?: boolean,
 *          normalMap?: boolean}} [support]
 * @returns {object}
 */
export function honorTargetRenderSupport(options, support) {
  if (!support) return options;
  // Derived from the unset shape rather than an enumerated list of keys. The previous
  // per-key version handled 4 of the 6 keys `RENDER_OPTION_KEYS` accepts, so a
  // descriptor declaring `seed: false` or `keyBackground: false` passed the registry
  // invariant and was then silently ignored here — recording a value the subprocess
  // never received, the exact thing this function exists to prevent. Reset to the same
  // sentinel `normalizeRenderOptions` produces for "unset", whatever that key's
  // sentinel happens to be (`null`, `'auto'`, or `false`).
  const unset = normalizeRenderOptions();
  const dropped = Object.fromEntries(
    Object.entries(support)
      .filter(([key, supported]) => supported === false && key in unset)
      .map(([key]) => [key, unset[key]]),
  );
  return { ...options, ...dropped };
}
