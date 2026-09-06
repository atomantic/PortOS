/**
 * i2v reference-mode contract (#4874) — what a supplied conditioning image
 * PROMISES about the render.
 *
 * PortOS already had an "image strength" slider, but a bare scalar says nothing
 * about the *semantic* the user is buying. Two very different promises hid
 * behind the same dial:
 *
 *   - `anchor`  — the reference IS frame one. The clip animates outward from
 *                 those exact pixels. This is the historical behavior and stays
 *                 the default, so a render that predates this field is
 *                 byte-identical to one that omits it.
 *   - `inspire` — the reference steers subject and style, and frame one is
 *                 GENERATED. It will resemble the image without reproducing it.
 *
 * Only a runtime that can carry a per-image conditioning strength can honor
 * `inspire`; on everything else the pipeline pins frame 0 unconditionally, so
 * accepting the request would silently deliver `anchor` while the UI promised
 * otherwise. That is the whole failure this table exists to prevent — every
 * boundary rejects instead (`i2vReferenceModeViolation` below), and the LTX
 * helper fails loudly rather than downgrading mid-render.
 *
 * A pure leaf re-exported by `client/src/lib/videoReferenceModes.js` — so it
 * must not import `ServerError`, any Node built-in, or anything outside
 * `server/lib`. Callers translate the returned
 * `{ code, message }` into whatever their layer throws:
 * `videoReferenceModeError()` in services/videoGen/modeContract.js does that
 * for the route + render boundaries.
 */

// Ordered — the UI renders the picker in this order and `anchor` is first
// because it is the default.
export const I2V_REFERENCE_MODES = Object.freeze(['anchor', 'inspire']);

export const DEFAULT_I2V_REFERENCE_MODE = 'anchor';

// The promise each mode makes, in the words the UI shows the user. Kept beside
// the rule table rather than in the component so the server's rejection message
// and the panel's helper text can't describe two different contracts.
export const I2V_REFERENCE_MODE_OPTIONS = Object.freeze([
  Object.freeze({
    value: 'anchor',
    label: 'Anchor',
    promise: 'The reference is frame one — the clip animates outward from those exact pixels.',
  }),
  Object.freeze({
    value: 'inspire',
    label: 'Inspire',
    promise: 'The reference guides subject and style. Frame one is generated, so it resembles the image without reproducing it.',
  }),
]);

// Runtimes that can honor each mode. `null` means "every runtime" — `anchor` is
// what an i2v pipeline does by construction. `inspire` needs per-image
// conditioning strength, which today only the LTX-2.5 pin exposes
// (ImageConditioningInput on generate_and_save); the 2.3 pin shares the family
// predicate but not that API, so it is NOT listed.
export const I2V_REFERENCE_MODE_RUNTIMES = Object.freeze({
  anchor: null,
  inspire: Object.freeze(['ltx25']),
});

// Conditioning strength applied to a loose reference when the user leaves the
// Image Strength slider untouched. Low enough that the first frame is visibly
// re-generated rather than reproduced — which is exactly the promise `inspire`
// makes. An explicit slider value always wins.
export const INSPIRE_DEFAULT_IMAGE_STRENGTH = 0.35;

/**
 * `''` / `null` / `undefined` all mean "not set" and resolve to the default.
 * Anything else is returned VERBATIM so an unknown value reaches the gate below
 * and is rejected there — collapsing garbage into `anchor` would turn a typo
 * into a silently different render (AGENTS: sentinel + validate, never let
 * invalid share a value with valid).
 */
export const normalizeI2vReferenceMode = (value) => (
  value == null || value === '' ? DEFAULT_I2V_REFERENCE_MODE : value
);

export const isDefaultI2vReferenceMode = (value) => (
  normalizeI2vReferenceMode(value) === DEFAULT_I2V_REFERENCE_MODE
);

export const isKnownI2vReferenceMode = (value) => (
  I2V_REFERENCE_MODES.includes(normalizeI2vReferenceMode(value))
);

/** Can `runtime` deliver what `value` promises? Unknown modes are never supported. */
export const runtimeSupportsI2vReferenceMode = (runtime, value) => {
  const mode = normalizeI2vReferenceMode(value);
  if (!I2V_REFERENCE_MODES.includes(mode)) return false;
  const allowed = I2V_REFERENCE_MODE_RUNTIMES[mode];
  return allowed === null || allowed.includes(runtime);
};

export const i2vReferenceModeLabel = (value) => (
  I2V_REFERENCE_MODE_OPTIONS.find((o) => o.value === normalizeI2vReferenceMode(value))?.label
    || normalizeI2vReferenceMode(value)
);

/**
 * The effective first-frame conditioning strength for a render, or `null` for
 * "let the pipeline apply its own default".
 *
 * An explicit slider value is honored on BOTH modes — a user who wants a firmer
 * loose reference (or a softer anchor) gets it. Only the *unset* case differs:
 * `inspire` substitutes its own low default, because "no value" there still has
 * to mean "don't reproduce frame one", while `anchor` keeps deferring to the
 * pipeline exactly as it did before this field existed.
 */
export const resolveI2vReferenceStrength = (referenceMode, imageStrength) => {
  if (imageStrength != null && imageStrength !== '') {
    const explicit = Number(imageStrength);
    if (Number.isFinite(explicit)) return explicit;
  }
  return normalizeI2vReferenceMode(referenceMode) === 'inspire'
    ? INSPIRE_DEFAULT_IMAGE_STRENGTH
    : null;
};

/**
 * The one reference-mode rule, as a pure `{ code, message } | null`.
 *
 * `anchor` is always legal, so a request that never touched this field can
 * never be rejected by it. Everything else has to clear three gates: the value
 * is known, the render is actually image-to-video with a source image, and the
 * model's runtime can honor the promise.
 *
 * @param {object} opts
 * @param {object} [opts.model]        - registry entry (`name`, `runtime`)
 * @param {string} [opts.mode]         - RESOLVED semantic mode ('image', 'text', 'fflf', …)
 * @param {string} [opts.referenceMode]- requested reference mode
 * @param {boolean} [opts.hasFirstImage] - a first-frame conditioning image is present
 */
export const i2vReferenceModeViolation = ({ model, mode, referenceMode, hasFirstImage = true } = {}) => {
  const requested = normalizeI2vReferenceMode(referenceMode);
  if (requested === DEFAULT_I2V_REFERENCE_MODE) return null;
  if (!I2V_REFERENCE_MODES.includes(requested)) {
    return {
      code: 'I2V_REFERENCE_MODE_UNKNOWN',
      message: `Unknown reference mode "${requested}" — expected one of ${I2V_REFERENCE_MODES.join(', ')}.`,
    };
  }
  const label = i2vReferenceModeLabel(requested);
  if (mode !== 'image' || !hasFirstImage) {
    return {
      code: 'I2V_REFERENCE_MODE_REQUIRES_IMAGE',
      message: `${label} reference mode applies to image-to-video only — switch to image mode with a source image, or use ${i2vReferenceModeLabel(DEFAULT_I2V_REFERENCE_MODE)}.`,
    };
  }
  if (!runtimeSupportsI2vReferenceMode(model?.runtime, requested)) {
    return {
      code: 'I2V_REFERENCE_MODE_UNSUPPORTED',
      message: `${model?.name || 'This model'} cannot honor the ${label} reference mode — its runtime ("${model?.runtime || 'mlx_video'}") pins the reference as frame one. Choose an LTX-2.5 model, or switch to ${i2vReferenceModeLabel(DEFAULT_I2V_REFERENCE_MODE)}.`,
    };
  }
  return null;
};
