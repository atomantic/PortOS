/**
 * Lane-agnostic PER-RUN render options for image-to-3D generation (sampler
 * steps / seed / background keying). Shared by the route schema, the record
 * layer, and both TRELLIS.2 lanes so the accepted ranges and CLI flags can't
 * drift between them.
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

const intInRange = (value, min, max) => (
  Number.isInteger(value) && value >= min && value <= max
);

/** Whether a value is a valid steps count (null/undefined are "unset"). */
export const isValidRenderSteps = (value) => intInRange(value, RENDER_STEPS_MIN, RENDER_STEPS_MAX);

/** Whether a value is a valid seed (null/undefined are "unset"). */
export const isValidRenderSeed = (value) => intInRange(value, 0, RENDER_SEED_MAX);

/**
 * Normalize a request's options into the per-run shape. Invalid/absent values
 * collapse to the unset sentinel (`null`) rather than throwing — the route
 * schema is the loud gate; this is the internal-caller normalizer.
 * @param {{steps?: number|null, seed?: number|null, keyBackground?: boolean}} [input]
 * @returns {{steps: number|null, seed: number|null, keyBackground: boolean}}
 */
export function normalizeRenderOptions(input = {}) {
  return {
    steps: isValidRenderSteps(input.steps) ? input.steps : null,
    seed: isValidRenderSeed(input.seed) ? input.seed : null,
    keyBackground: input.keyBackground !== false,
  };
}

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
  if (steps !== null && !isValidRenderSteps(steps)) {
    throw new Error(`${label}: steps must be an integer in [${RENDER_STEPS_MIN}, ${RENDER_STEPS_MAX}]`);
  }
  if (seed !== null && !isValidRenderSeed(seed)) {
    throw new Error(`${label}: seed must be an integer in [0, ${RENDER_SEED_MAX}]`);
  }
  return [
    ...(seed !== null ? ['--seed', String(seed)] : []),
    ...(steps !== null ? ['--steps', String(steps)] : []),
  ];
}
