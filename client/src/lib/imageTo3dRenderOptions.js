/**
 * Pure helpers for the image-to-3D per-run render options (steps / seed /
 * background keying / subject framing) — the client mirror of the server's accepted
 * bounds.
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

/**
 * Subject framing — the client mirror of the server's `subjectScale` bounds, pinned
 * by the same parity suite.
 *
 * `SUBJECT_SCALE_DEFAULT` is the identity: the source goes to the decoder at its own
 * framing, which is what every render did before this control existed. Below it, the
 * server centres the source on a square canvas at that fraction, leaving margin for
 * the extremities that otherwise reach the decoder flush with the edge and come back
 * clipped.
 *
 * The slider FLOOR is deliberately tighter than the server's open-at-zero bound: the
 * server accepts anything in (0, 1] because an API caller may have a reason to, but a
 * subject shrunk below a third of the frame is throwing away resolution the decoder
 * needs more than it needs margin, so the UI doesn't offer it.
 */
export const SUBJECT_SCALE_DEFAULT = 1;
export const SUBJECT_SCALE_SLIDER_MIN = 0.35;
export const SUBJECT_SCALE_SLIDER_STEP = 0.05;

/** The steps presets: the pipeline's own default, and two slower/higher-detail
 * tiers. Values stay strings because they live in <select> state. */
export const STEPS_PRESETS = [
  { value: '', label: 'Standard (12 steps)' },
  { value: '24', label: 'High (24 steps — ~2× slower)' },
  { value: '48', label: 'Max (48 steps — ~4× slower)' },
];

/**
 * Detail tiers, mirroring the server's `DETAIL_TIERS`. The labels name the concrete
 * TRELLIS.2 pipeline each tier maps to, because "fast/balanced/max" alone gives no
 * sense of the time cost — and the cost is large (upstream benchmarks ~3m20s of
 * generate+bake for 512, against 13-20 minutes measured for 1024_cascade).
 *
 * `auto` stays first and default: it derives the tier from unified memory, which is
 * what every render did before the control existed.
 */
export const DETAIL_PRESETS = [
  { value: 'auto', label: 'Auto (match this machine)' },
  { value: 'fast', label: 'Fast preview (512)' },
  { value: 'balanced', label: 'Balanced (1024)' },
  { value: 'max', label: 'Max detail (1024 cascade — slowest)' },
];

/**
 * Transparency options, mirroring the server's `ALPHA_MODES` plus the unset case.
 *
 * `''` (unset) is NOT the same as `OPAQUE`: unset leaves PortOS's force-opaque
 * normalization in place, which is the historical default and what keeps ordinary
 * objects from developing holes where the model predicted stray low alpha. Choosing
 * a mode explicitly turns that normalization off, which is the only way a genuinely
 * transparent subject (glass, liquid) can render as anything but solid.
 */
export const ALPHA_MODE_PRESETS = [
  { value: '', label: 'Solid (recommended)' },
  { value: 'auto', label: 'Detect transparency' },
  { value: 'BLEND', label: 'Force transparent (glass, liquid)' },
  { value: 'MASK', label: 'Cut-out (hard alpha edges)' },
  { value: 'OPAQUE', label: 'Opaque (no normalization)' },
];

/**
 * Convert the option fields' string state into the API's per-run body. Unset
 * fields are OMITTED (not null): absent steps → the pipeline default, absent
 * seed → the server rolls a fresh random one for that run. Range/int validation
 * is the server's job — the route 400s with a readable message.
 */
export function renderOptionsBody({
  steps, seed, keyBackground, detail, alphaMode, normalMap, subjectScale,
}) {
  return {
    ...(steps !== '' && { steps: Number(steps) }),
    ...(seed !== '' && { seed: Number(seed) }),
    keyBackground,
    // 'auto' is the server default, so omitting it keeps the body minimal and makes
    // "the user didn't choose" and "the user chose auto" the same request — which
    // they are, unlike alphaMode below.
    ...(detail && detail !== 'auto' && { detail }),
    ...(alphaMode !== '' && alphaMode != null && { alphaMode }),
    // Sent always rather than omitted-when-default. The server default is `false`, so
    // omitting it would happen to work today — but the whole point of this mapping is
    // that the wire body states what the run asked for, and a future default flip
    // must not silently change what an existing client means.
    normalMap,
    // Sent always, for the same reason as `normalMap`. Guarded rather than trusted:
    // the server's range is open at zero, so a NaN or 0 out of a mis-parsed slider
    // would 400 the render instead of quietly meaning "don't reframe".
    subjectScale: typeof subjectScale === 'number' && subjectScale > 0 && subjectScale <= 1
      ? subjectScale
      : SUBJECT_SCALE_DEFAULT,
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
    // A run predating the field has none; default to OFF, matching the server. Such a
    // run DID key (the default was on then), but this seeds a NEW render's form, which
    // should agree with the server default it will actually get.
    keyBackground: typeof run?.keyBackground === 'boolean' ? run.keyBackground : false,
    // Both carry over like `steps` does — they are deliberate quality choices, not
    // per-run randomness. A run predating these fields has neither, so fall back to
    // the same defaults a fresh form starts at.
    detail: DETAIL_PRESETS.some((p) => p.value === run?.detail) ? run.detail : 'auto',
    alphaMode: typeof run?.alphaMode === 'string' ? run.alphaMode : '',
    // A run predating the field has none; default to OFF, matching the server.
    normalMap: typeof run?.normalMap === 'boolean' ? run.normalMap : false,
    // Carries over like `steps` — a deliberate framing choice, not per-run randomness.
    // A run predating the field falls back to the identity, matching the server.
    subjectScale: typeof run?.subjectScale === 'number'
      && run.subjectScale > 0 && run.subjectScale <= 1
      ? run.subjectScale
      : SUBJECT_SCALE_DEFAULT,
  };
}

/**
 * Whether a run asked the exporter for a transparent material.
 *
 * The viewer's own force-opaque pass has to agree with the server's: with three
 * layers able to flatten alpha (the exporter's `alpha_mode`, PortOS's GLB rewrite,
 * and the viewer's `forceOpaque` prop), a run that requested BLEND would still
 * render solid if the viewer kept flattening it — a silent no-op that reads as a
 * broken exporter. `null`/absent (the historical default) stays opaque.
 */
export function runWantsTransparency(run) {
  return typeof run?.alphaMode === 'string'
    && run.alphaMode !== ''
    && run.alphaMode !== 'OPAQUE';
}
