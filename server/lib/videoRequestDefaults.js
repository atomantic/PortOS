/**
 * Video Gen "no override" sentinels and the speed-profile mode gate that both the render form and the server decline check read.
 *
 * ONE definition, imported by `videoTextEncoders.js` and `videoSpeedProfiles.js` (which re-export it) and by `client/src/lib/videoGenParams.js`. The client's submit builder DROPS a field holding its sentinel and the server treats an absent field and the sentinel identically, so two spellings would make the client post `textEncoderId: 'stock'` / `speedProfileId: 'quality'` to a server that reads it as a real id (a 400 on every H3 render, or a split ETA bucket). The mode gate is shared for the same reason: a picker that offers a profile the server then declines is a dead speed affordance. No imports, so the browser bundle can load it.
 */

/** The text-conditioner id meaning "the runtime's built-in one": every runtime's built-in option carries it. */
export const STOCK_TEXT_ENCODER_ID = 'stock';

/**
 * `true` when `id` is absent or names the runtime's built-in conditioner — i.e. the render needs no override
 * plumbing at all. A model with no substitutions accepts only the stock id (and absence).
 */
export const isStockTextEncoder = (id) => !id || id === STOCK_TEXT_ENCODER_ID;

/** The implicit "unchanged" speed profile. Never resolves to an override. */
export const SPEED_PROFILE_DEFAULT_ID = 'quality';

/**
 * Absence and the default id are the same request — so a client that always
 * submits its picker value doesn't create a second spelling of "unchanged".
 */
export const isDefaultSpeedProfile = (id) => id == null || id === '' || id === SPEED_PROFILE_DEFAULT_ID;

/**
 * Modes that route through the LTX two-stage pipeline (`run_two_stage` in
 * scripts/generate_ltx2.py), which is the only pipeline the shipped schedules
 * were measured on. Declared once so a new profile can't quietly widen
 * itself past what was validated.
 */
export const TWO_STAGE_SPEED_PROFILE_MODES = Object.freeze(['text', 'image']);

/**
 * The profiles a model declares, or `[]`. Deliberately does NOT prepend the
 * implicit default entry: that is a PRESENTATION rule (the picker owns it, the
 * same way `TextEncoderPicker` owns hide-when-there-is-no-real-choice), and
 * folding it in here would make every model look like it has a profile.
 */
export const videoSpeedProfiles = (model) => (
  Array.isArray(model?.speedProfiles) ? model.speedProfiles.filter((p) => typeof p?.id === 'string') : []
);

/** The modes a profile declares; one declaring none falls back to the two-stage set, NOT to "unrestricted". */
export const speedProfileModes = (profile) => (Array.isArray(profile?.modes) ? profile.modes : TWO_STAGE_SPEED_PROFILE_MODES);

/**
 * The mode a render is gated on: an absent mode is the plain text render. Only SAFE because server callers resolve
 * the runner's own inference first (`inferEffectiveVideoMode`).
 */
export const effectiveSpeedProfileMode = (mode) => (mode == null || mode === '' ? 'text' : mode);

/**
 * Does `profile` apply to a render in `mode`? `fflf`/`extend`/`a2v`/`ic` run different pipelines than the
 * two-stage one every shipped schedule was measured on, so a profile is declined there rather than silently
 * applying numbers that mean nothing.
 */
export const speedProfileAcceptsMode = (profile, mode) => speedProfileModes(profile).includes(effectiveSpeedProfileMode(mode));
