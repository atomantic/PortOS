// Pipeline comic-page image-gen defaults + settings reader.
//
// Mirrors the shape of wrImageDefaults.js but adds the comic-page knobs
// (negativePrompt + extraStyle) and prefers Codex when it's enabled. Cloud
// models render multi-panel pages dramatically better than local diffusion,
// so Codex is the right default whenever the user has it wired up.

import { IMAGE_GEN_MODE } from './imageGenBackends';

// 1024×1536 = 2:3 portrait, the closest preset to a real comic-book trim
// (~0.65 ratio). The "hi-res portrait" entry in imageGenResolutions is
// gated to codex + FLUX2, which lines up with our codex-first default.
export const PIPELINE_IMAGE_DEFAULTS = Object.freeze({
  mode: IMAGE_GEN_MODE.LOCAL,
  modelId: 'flux2-klein-4b',
  width: 1024,
  height: 1536,
  steps: '',
  guidance: '',
  seed: '',
  negativePrompt: '',
  extraStyle: '',
});

// Resolve the per-render config. Codex-enabled systems default to codex
// mode unless the user explicitly stored a different mode on
// `settings.pipeline.imageGen` — that override always wins so the form
// stays sticky.
export function readPipelineImageSettings(settings) {
  const stored = settings?.pipeline?.imageGen || {};
  const codexEnabled = settings?.imageGen?.codex?.enabled === true;
  const defaultMode = codexEnabled ? IMAGE_GEN_MODE.CODEX : PIPELINE_IMAGE_DEFAULTS.mode;
  return {
    mode: stored.mode || defaultMode,
    modelId: stored.modelId || PIPELINE_IMAGE_DEFAULTS.modelId,
    width: Number.isFinite(stored.width) ? stored.width : PIPELINE_IMAGE_DEFAULTS.width,
    height: Number.isFinite(stored.height) ? stored.height : PIPELINE_IMAGE_DEFAULTS.height,
    steps: stored.steps != null && stored.steps !== '' ? String(stored.steps) : '',
    guidance: stored.guidance != null && stored.guidance !== '' ? String(stored.guidance) : '',
    seed: stored.seed != null && stored.seed !== '' ? String(stored.seed) : '',
    negativePrompt: stored.negativePrompt || '',
    extraStyle: stored.extraStyle || '',
  };
}

// Strip empty strings + coerce numerics so the request body only carries
// fields the server should act on. Empty strings would otherwise serialize
// to "" and trip the zod number coercion.
export function pipelineImageCfgToRenderOpts(cfg) {
  const opts = { mode: cfg.mode };
  if (cfg.mode === IMAGE_GEN_MODE.LOCAL && cfg.modelId) opts.modelId = cfg.modelId;
  if (Number.isFinite(cfg.width)) opts.width = cfg.width;
  if (Number.isFinite(cfg.height)) opts.height = cfg.height;
  if (cfg.mode !== IMAGE_GEN_MODE.CODEX) {
    const steps = Number(cfg.steps);
    if (Number.isFinite(steps) && steps > 0) opts.steps = steps;
    const guidance = Number(cfg.guidance);
    if (Number.isFinite(guidance) && guidance >= 0) opts.guidance = guidance;
    const seed = Number(cfg.seed);
    if (Number.isFinite(seed) && seed >= 0) opts.seed = seed;
  }
  const neg = (cfg.negativePrompt || '').trim();
  if (neg) opts.negativePrompt = neg;
  const extra = (cfg.extraStyle || '').trim();
  if (extra) opts.extraStyle = extra;
  return opts;
}
