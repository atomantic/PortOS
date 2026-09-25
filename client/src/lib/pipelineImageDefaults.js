// Pipeline comic-page image-gen defaults + settings reader.
//
// Mirrors the shape of wrImageDefaults.js but adds the comic-page knobs
// (negativePrompt + extraStyle) and prefers Codex when it's enabled. Cloud
// models render multi-panel pages dramatically better than local diffusion,
// so Codex is the right default whenever the user has it wired up.

import {
  installLocalModelId, isCloudCliMode, IMAGE_GEN_MODE, LOCAL_IMAGEGEN_DEFAULT_MODEL,
  pickUsableMode, renderPinLadder, renderTargetPin, supportsCloudModelOverride,
} from './imageGenBackends';

// The geometry + prompt knobs of a render config, with no backend or model —
// the half that is NOT install-wide state. `settings.pipeline.imageGen` is the
// Pipeline visual form's own sticky buffer, so a surface that is not that form
// starts from these shipped values instead of inheriting whatever a comic page
// was last rendered with (see `useImageRenderSettings`).
//
// 1024×1536 = 2:3 portrait, the closest preset to a real comic-book trim
// (~0.65 ratio). The "hi-res portrait" entry in imageGenResolutions is
// gated to codex + FLUX2, which lines up with our codex-first default.
export const IMAGE_RENDER_KNOB_DEFAULTS = Object.freeze({
  width: 1024,
  height: 1536,
  steps: '',
  guidance: '',
  seed: '',
  negativePrompt: '',
  extraStyle: '',
});

export const PIPELINE_IMAGE_DEFAULTS = Object.freeze({
  mode: IMAGE_GEN_MODE.LOCAL,
  modelId: LOCAL_IMAGEGEN_DEFAULT_MODEL,
  ...IMAGE_RENDER_KNOB_DEFAULTS,
});

// The config a surface with NO settings blob yet reports — the shipped knobs on
// the backend that is always usable. Frozen and module-level so an unresolved
// caller hands every consumer the same identity rather than a fresh object.
export const UNRESOLVED_RENDER_CFG = Object.freeze({
  ...IMAGE_RENDER_KNOB_DEFAULTS,
  mode: IMAGE_GEN_MODE.LOCAL,
  modelId: LOCAL_IMAGEGEN_DEFAULT_MODEL,
  cloudModel: null,
});

/**
 * Resolve "what will a render on this surface actually run on" — the client
 * mirror of the server's own ladder, and the ONE place a non-Pipeline surface
 * derives a render config.
 *
 * The backend walks `renderPinLadder` (the record's own `imageMode`, then the
 * target's `renderDefaults` pin, both gated on backends this install actually
 * has) and falls through to the install-wide `imageGen.mode` via the shared
 * `pickUsableMode`. The model then follows the backend it belongs to: local
 * takes the pin, else `imageGen.local.modelId`, else the shipped default; an
 * override-capable cloud CLI takes the pin as `cloudModel` and nothing else, so
 * a cloud mode can never be advertised beside a local model.
 *
 * Nothing here reads `settings.pipeline.imageGen`. That slice is the Pipeline
 * visual FORM's sticky buffer, and using it as a general base is what made a
 * deck claim it would render on the model a comic page was last rendered with
 * while the server used the install pin the whole time.
 *
 * @param {object|null} settings - The settings blob, or null when unresolved.
 * @param {object}   [opts]
 * @param {object|null} [opts.record]  - Record whose `imageMode`/`imageModelId` pin wins.
 * @param {string|null} [opts.target]  - RENDER_TARGET id whose `renderDefaults` pin is next.
 * @param {Array<{id:string}>|null} [opts.backends] - Enabled backends a pin is gated on;
 *   `null` while the list isn't loaded (`[]` means "loaded, nothing enabled").
 */
export function resolveRenderCfg(settings, { record = null, target = null, backends = null } = {}) {
  if (!settings) return UNRESOLVED_RENDER_CFG;
  const pin = renderPinLadder([record, renderTargetPin(settings, target)], backends);
  const mode = pin.mode || pickUsableMode(settings, [settings.imageGen?.mode]);
  const isLocal = mode === IMAGE_GEN_MODE.LOCAL;
  return {
    ...IMAGE_RENDER_KNOB_DEFAULTS,
    mode,
    modelId: isLocal ? (pin.modelId || installLocalModelId(settings)) : null,
    cloudModel: !isLocal && supportsCloudModelOverride(mode) ? pin.modelId : null,
  };
}

// Resolve the per-render config. Codex-enabled systems default to codex
// mode unless the user explicitly stored a different mode on
// `settings.pipeline.imageGen` — that override always wins so the form
// stays sticky.
export function readPipelineImageSettings(settings) {
  const stored = settings?.pipeline?.imageGen || {};
  const codexEnabled = settings?.imageGen?.codex?.enabled === true;
  const grokEnabled = settings?.imageGen?.grok?.enabled === true;
  const agyEnabled = settings?.imageGen?.agy?.enabled === true;
  // Prefer an enabled cloud backend (codex first, then grok — the same order
  // as the server's visual-stage resolver) so a cloud-only install doesn't
  // default pipeline renders to an unconfigured local diffusion.
  const defaultMode = codexEnabled ? IMAGE_GEN_MODE.CODEX
    : grokEnabled ? IMAGE_GEN_MODE.GROK
      : agyEnabled ? IMAGE_GEN_MODE.AGY : PIPELINE_IMAGE_DEFAULTS.mode;
  return {
    mode: stored.mode || defaultMode,
    modelId: stored.modelId || installLocalModelId(settings),
    width: Number.isFinite(stored.width) ? stored.width : PIPELINE_IMAGE_DEFAULTS.width,
    height: Number.isFinite(stored.height) ? stored.height : PIPELINE_IMAGE_DEFAULTS.height,
    steps: stored.steps != null && stored.steps !== '' ? String(stored.steps) : '',
    guidance: stored.guidance != null && stored.guidance !== '' ? String(stored.guidance) : '',
    seed: stored.seed != null && stored.seed !== '' ? String(stored.seed) : '',
    negativePrompt: stored.negativePrompt || '',
    extraStyle: stored.extraStyle || '',
  };
}

// "Unset" for the numeric knobs is the empty string. `Number('')` (and
// `Number(null)`) is 0, not NaN, so a plain coercion turns an unset knob into a
// HARD ZERO the server honors: `seed: 0` pins a fixed seed, making repeat
// renders of one prompt identical. Blank must reach the `Number.isFinite` gates
// below as NaN so they drop it.
const numericOrNaN = (v) => (String(v ?? '').trim() === '' ? NaN : Number(v));

// Strip empty strings + coerce numerics so the request body only carries
// fields the server should act on. Empty strings would otherwise serialize
// to "" and trip the zod number coercion.
export function pipelineImageCfgToRenderOpts(cfg) {
  const opts = { mode: cfg.mode };
  if (cfg.mode === IMAGE_GEN_MODE.LOCAL && cfg.modelId) opts.modelId = cfg.modelId;
  // A record render pin can name the cloud CLI's model too (`applyRecordRenderPin`
  // routes it here); the dispatcher folds `cloudModel` into the provider's own
  // model for that one job. Local reads `modelId` above instead.
  if (isCloudCliMode(cfg.mode) && cfg.cloudModel) opts.cloudModel = cfg.cloudModel;
  if (Number.isFinite(cfg.width)) opts.width = cfg.width;
  if (Number.isFinite(cfg.height)) opts.height = cfg.height;
  if (!isCloudCliMode(cfg.mode)) {
    const steps = numericOrNaN(cfg.steps);
    if (Number.isFinite(steps) && steps > 0) opts.steps = steps;
    const guidance = numericOrNaN(cfg.guidance);
    if (Number.isFinite(guidance) && guidance >= 0) opts.guidance = guidance;
    const seed = numericOrNaN(cfg.seed);
    if (Number.isFinite(seed) && seed >= 0) opts.seed = seed;
  }
  const neg = (cfg.negativePrompt || '').trim();
  if (neg) opts.negativePrompt = neg;
  const extra = (cfg.extraStyle || '').trim();
  if (extra) opts.extraStyle = extra;
  return opts;
}
