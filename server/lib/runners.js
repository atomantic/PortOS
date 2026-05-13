/**
 * Image-runner family constants — single source of truth for the runner ids
 * (`'mflux' | 'flux2' | 'z-image' | 'ernie'`) that distinguish which Python
 * runner backs an image-gen model entry.
 *
 * Bare-string runner ids previously sprawled across `server/lib/civitai.js`,
 * `server/lib/mediaModels.js`, `client/src/pages/ImageGen.jsx`, and the
 * `RUNNER_LABEL` / `RUNNER_BADGE_CLASS` maps in `client/src/pages/Loras.jsx`.
 * A typo in any one of those sites silently broke the LoRA picker's compat
 * filter, since `runnerFamily === 'zimage'` (wrong) just doesn't match
 * `runner === 'z-image'` (right). Importing from this module locks the
 * canonical strings in place.
 *
 * The client mirrors this list at `client/src/lib/runnerFamilies.js` —
 * Vite's fs.allow doesn't cross the server/ boundary, so we keep the two
 * files manually in sync (same convention as `scenePrompt.js`).
 */

export const RUNNER_FAMILIES = Object.freeze({
  MFLUX: 'mflux',
  FLUX2: 'flux2',
  Z_IMAGE: 'z-image',
  ERNIE: 'ernie',
});

// Convenience predicate helpers — match the semantics of the existing
// `isFlux2()` / `isZImage()` / `isErnie()` exports in `mediaModels.js`
// (which still exist for back-compat with their many call sites). New code
// can import either; same result.
export const isMflux = (model) => model?.runner === RUNNER_FAMILIES.MFLUX;
export const isFlux2 = (model) => model?.runner === RUNNER_FAMILIES.FLUX2;
export const isZImage = (model) => model?.runner === RUNNER_FAMILIES.Z_IMAGE;
export const isErnie = (model) => model?.runner === RUNNER_FAMILIES.ERNIE;
