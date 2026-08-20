/**
 * Pure helpers for the image-to-3D per-run render options (steps / seed /
 * background keying) — the client mirror of the server's accepted bounds.
 *
 * `SEED_MAX` is a hand-maintained mirror of the server's `RENDER_SEED_MAX`
 * (`server/services/imageTo3d/renderOptions.js`) pinned by
 * `server/services/imageTo3d/renderOptions.parity.test.js` — same mechanism as
 * `imageTo3dReasons.js`. It is deliberately narrower than the image/video-gen
 * `MAX_SEED` in `genUtils.js`: TRELLIS.2 hands seeds to torch generators, which
 * reject values above int32.
 *
 * Kept free of React so the server-side parity suite (node runner, no JSX) can
 * import it directly.
 */

export const SEED_MAX = 2147483647;

/** The steps presets: the pipeline's own default, and two slower/higher-detail
 * tiers. Values stay strings because they live in <select> state. */
export const STEPS_PRESETS = [
  { value: '', label: 'Standard (12 steps)' },
  { value: '24', label: 'High (24 steps — ~2× slower)' },
  { value: '48', label: 'Max (48 steps — ~4× slower)' },
];

/**
 * Convert the option fields' string state into the API's per-run body. Unset
 * fields are OMITTED (not null): absent steps → the pipeline default, absent
 * seed → the server rolls a fresh random one for that run. Range/int validation
 * is the server's job — the route 400s with a readable message.
 */
export function renderOptionsBody({ steps, seed, keyBackground }) {
  return {
    ...(steps !== '' && { steps: Number(steps) }),
    ...(seed !== '' && { seed: Number(seed) }),
    keyBackground,
  };
}

/**
 * Derive the option fields' initial state from a record's latest run entry.
 * `steps` and `keyBackground` carry over (they're safe to inherit); `seed` is
 * ALWAYS blank — seeding the field from the run's concrete (randomly rolled)
 * seed would silently pin it, reintroducing the deterministic-re-render trap
 * this feature exists to fix. A user pins a seed by typing one deliberately
 * (the run's seed is displayed in the meta line to copy from).
 */
export function fieldsFromRun(run) {
  return {
    steps: Number.isInteger(run?.steps) ? String(run.steps) : '',
    seed: '',
    keyBackground: typeof run?.keyBackground === 'boolean' ? run.keyBackground : true,
  };
}
