/**
 * Lane-agnostic PER-RUN render options for image-to-3D generation, shared by the route schema,
 * record layer and every lane so ranges and CLI flags can't drift. Not a stored preference: the
 * run entry records the concrete values the subprocess received.
 *
 * Unset sentinels: `steps: null` → pipeline default; `seed: null` → fresh random seed (upstream's
 * fixed 42 would make "Re-render" repeat); `detail: 'auto'` → from host capability;
 * `alphaMode: null` → don't instruct the exporter.
 */

import { randomInt } from 'node:crypto';
import { RENDER_STEPS_MIN, RENDER_STEPS_MAX, RENDER_SEED_MAX, DETAIL_TIERS, ALPHA_MODES, SUBJECT_SCALE_MIN_EXCLUSIVE, SUBJECT_SCALE_MAX } from '../../lib/imageTo3dRenderLimits.js';
export { RENDER_STEPS_MIN, RENDER_STEPS_MAX, RENDER_SEED_MAX, DETAIL_TIERS, ALPHA_MODES, SUBJECT_SCALE_MIN_EXCLUSIVE, SUBJECT_SCALE_MAX } from '../../lib/imageTo3dRenderLimits.js';

/** A fresh random seed for an unpinned run. */
export function randomRenderSeed() {
  return randomInt(0, RENDER_SEED_MAX + 1);
}

export const DEFAULT_DETAIL_TIER = 'auto';

export const isValidDetailTier = (value) => DETAIL_TIERS.includes(value);

export const isValidAlphaMode = (value) => ALPHA_MODES.includes(value);

const intInRange = (value, min, max) => (
  Number.isInteger(value) && value >= min && value <= max
);

export const isValidRenderSteps = (value) => intInRange(value, RENDER_STEPS_MIN, RENDER_STEPS_MAX);

export const isValidRenderSeed = (value) => intInRange(value, 0, RENDER_SEED_MAX);

export const DEFAULT_SUBJECT_SCALE = 1;

export const isValidSubjectScale = (value) => (
  typeof value === 'number'
  && Number.isFinite(value)
  && value > SUBJECT_SCALE_MIN_EXCLUSIVE
  && value <= SUBJECT_SCALE_MAX
);

/**
 * Normalize options to the per-run shape; invalid/absent values collapse to the unset sentinel
 * (the route schema is the loud gate).
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
    // Opt-IN: an alpha channel REPLACES the learned matte (TRELLIS.2's `preprocess_image` skips
    // RMBG-2.0 for any non-opaque alpha), leaving a border flood fill that can't remove a cast
    // shadow. Use `keySolidBackground` only for a flat chroma backdrop.
    keyBackground: input.keyBackground === true,
    // 'auto' (not null): a choosable value, and the run entry records what happened.
    detail: isValidDetailTier(input.detail) ? input.detail : DEFAULT_DETAIL_TIER,
    // null = "don't ask the exporter", distinct from every concrete mode.
    alphaMode: isValidAlphaMode(input.alphaMode) ? input.alphaMode : null,
    // Opt-IN: the bake runs INSIDE `to_glb` over a very large mesh. Its Python guard catches a
    // raise but NOT a segfault, OOM kill or the macOS GPU watchdog (`isMpsWatchdogError`), any of
    // which loses a 13-20 minute render that already had a correct mesh.
    normalMap: input.normalMap === true,
    subjectScale: isValidSubjectScale(input.subjectScale)
      ? input.subjectScale
      : DEFAULT_SUBJECT_SCALE,
  };
}

/**
 * The per-run option keys, so the `supportsRenderOptions` registry invariant derives from here.
 */
export const RENDER_OPTION_KEYS = Object.freeze(Object.keys(normalizeRenderOptions()));

/**
 * Validate steps/seed and emit their CLI flags; `null` omits a flag. Throws with the caller's label.
 */
export function renderOptionArgs(label, { steps = null, seed = null } = {}) {
  validateRenderOptions(label, { steps, seed });
  return [
    ...(seed !== null ? ['--seed', String(seed)] : []),
    ...(steps !== null ? ['--steps', String(steps)] : []),
  ];
}

/**
 * The bounds half of `renderOptionArgs`, for a lane that can't emit an option (Pixal3D has no
 * `--steps`). Throws with the caller's label.
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
 * Drop options a target's runner won't honor so the run entry records what the subprocess
 * ACTUALLY received. `support` is the descriptor's `supportsRenderOptions`; absent = all honored.
 *
 * @param {object} options
 * @param {{steps?: boolean, detail?: boolean, alphaMode?: boolean,
 *          normalMap?: boolean}} [support]
 * @returns {object}
 */
export function honorTargetRenderSupport(options, support) {
  if (!support) return options;
  // Derived from the unset shape so every `RENDER_OPTION_KEYS` entry is covered.
  const unset = normalizeRenderOptions();
  const dropped = Object.fromEntries(
    Object.entries(support)
      .filter(([key, supported]) => supported === false && key in unset)
      .map(([key]) => [key, unset[key]]),
  );
  return { ...options, ...dropped };
}
