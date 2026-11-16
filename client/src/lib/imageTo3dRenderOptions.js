/**
 * Pure helpers for the image-to-3D per-run render options (steps / seed / background keying / subject framing), the client mirror of the server's accepted bounds.
 *
 * Covers `SEED_MAX`, the `STEPS_PRESETS` / `DETAIL_PRESETS` / `ALPHA_MODE_PRESETS` select options, `renderOptionsBody` (fields → API body), `fieldsFromRun`
 * (carry-over from the last run) and `runWantsTransparency` (mirrors the server's alpha gating). Pinned by `renderOptions.parity.test.js`.
 *
 * `SEED_MAX` mirrors the server's `RENDER_SEED_MAX` (`server/services/imageTo3d/renderOptions.js`, pinned by its parity test) and is narrower than
 * `MAX_SEED` in `genUtils.js`: TRELLIS.2 hands seeds to torch generators, which reject values above int32.
 *
 * Kept free of React so the server-side parity suite (node runner, no JSX) can import it.
 */

export const SEED_MAX = 2147483647;

/**
 * Subject framing, the client mirror of the server's `subjectScale` bounds (same parity suite). `SUBJECT_SCALE_DEFAULT` is the identity (source framed as-is);
 * below it the server centres the source on a square canvas at that fraction, leaving margin for extremities that would otherwise come back clipped.
 * The slider FLOOR is tighter than the server's open-at-zero (0, 1] bound: a subject below a third of the frame loses more resolution than it gains margin.
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
 * Detail tiers, mirroring the server's `DETAIL_TIERS`. Labels name the concrete TRELLIS.2 pipeline because the time cost is large (~3m20s for 512 vs 13-20 minutes for 1024_cascade).
 * `auto` stays first and default: it derives the tier from unified memory.
 */
export const DETAIL_PRESETS = [
  { value: 'auto', label: 'Auto (match this machine)' },
  { value: 'fast', label: 'Fast preview (512)' },
  { value: 'balanced', label: 'Balanced (1024)' },
  { value: 'max', label: 'Max detail (1024 cascade — slowest)' },
];

/**
 * Transparency options, mirroring the server's `ALPHA_MODES` plus the unset case. `''` is NOT `OPAQUE`: unset keeps PortOS's force-opaque normalization
 * (so stray low alpha doesn't punch holes), while choosing a mode turns it off, the only way a transparent subject (glass, liquid) renders as anything but solid.
 */
export const ALPHA_MODE_PRESETS = [
  { value: '', label: 'Solid (recommended)' },
  { value: 'auto', label: 'Detect transparency' },
  { value: 'BLEND', label: 'Force transparent (glass, liquid)' },
  { value: 'MASK', label: 'Cut-out (hard alpha edges)' },
  { value: 'OPAQUE', label: 'Opaque (no normalization)' },
];

/**
 * Convert the option fields' string state into the API's per-run body. Unset fields are OMITTED (absent steps → pipeline default, absent seed → a fresh
 * random one); range/int validation is the server's job.
 */
export function renderOptionsBody({
  steps, seed, keyBackground, detail, alphaMode, normalMap, subjectScale,
}) {
  return {
    ...(steps !== '' && { steps: Number(steps) }),
    ...(seed !== '' && { seed: Number(seed) }),
    keyBackground,
    // 'auto' is the server default; omitting it makes "didn't choose" and "chose auto" the same request, unlike alphaMode below.
    ...(detail && detail !== 'auto' && { detail }),
    ...(alphaMode !== '' && alphaMode != null && { alphaMode }),
    // Sent always: the wire body states what the run asked for, so a future server default flip can't change what an existing client means.
    normalMap,
    // Sent always. Guarded: the server's range is open at zero, so a NaN or 0 from a mis-parsed slider would 400 instead of meaning "don't reframe".
    subjectScale: typeof subjectScale === 'number' && subjectScale > 0 && subjectScale <= 1
      ? subjectScale
      : SUBJECT_SCALE_DEFAULT,
  };
}

/**
 * Derive the option fields' initial state from a record's latest run entry. `steps` and `keyBackground` carry over; `seed` is ALWAYS blank, since the run's
 * randomly rolled seed would silently pin it (reintroducing the deterministic-re-render trap). A user pins one by typing it.
 */
export function fieldsFromRun(run) {
  return {
    steps: Number.isInteger(run?.steps) ? String(run.steps) : '',
    seed: '',
    // A run predating the field has none; default to OFF, matching the server default a NEW render will get.
    keyBackground: typeof run?.keyBackground === 'boolean' ? run.keyBackground : false,
    // Deliberate quality choices, so they carry over like `steps`; runs predating them fall back to a fresh form's defaults.
    detail: DETAIL_PRESETS.some((p) => p.value === run?.detail) ? run.detail : 'auto',
    alphaMode: typeof run?.alphaMode === 'string' ? run.alphaMode : '',
    // A run predating the field has none; default to OFF, matching the server.
    normalMap: typeof run?.normalMap === 'boolean' ? run.normalMap : false,
    // Carries over like `steps`; a run predating the field falls back to the identity, matching the server.
    subjectScale: typeof run?.subjectScale === 'number'
      && run.subjectScale > 0 && run.subjectScale <= 1
      ? run.subjectScale
      : SUBJECT_SCALE_DEFAULT,
  };
}

/**
 * Whether a run asked the exporter for a transparent material. The viewer's force-opaque pass must agree with the server's: with three layers able to
 * flatten alpha (exporter `alpha_mode`, PortOS's GLB rewrite, viewer `forceOpaque`), a BLEND run would still render solid. `null`/absent stays opaque.
 */
export function runWantsTransparency(run) {
  return typeof run?.alphaMode === 'string'
    && run.alphaMode !== ''
    && run.alphaMode !== 'OPAQUE';
}
