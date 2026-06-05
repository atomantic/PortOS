/**
 * Image Gen — SynthID-defeat regeneration (issue #912).
 *
 * The plain cleaner (`server/lib/imageClean.js`) only strips the C2PA `caBX`
 * chunk and runs median+sharpen — SynthID survives that by design. The only
 * honest defeat path is to round-trip the pixels through a generative model:
 * a short-step img2img pass on a LOCAL FLUX runner at low–moderate denoise
 * (~0.4) so composition holds but the per-pixel watermark signal is overwritten
 * by fresh sampling.
 *
 * Scope (per the issue): post-hoc, history-only — a second action next to
 * "Clean (aggressive)" in the lightbox, never auto-applied and never wired into
 * the active generation flow. Hardware-gated: it only runs when a local FLUX
 * runner is actually installed, so the UI hides the action otherwise.
 *
 * This module owns the backend-availability gate + the pure param assembly.
 * The render itself reuses the existing local img2img path — the route enqueues
 * a normal `kind: 'image'` job through `mediaJobQueue` (the GPU lane already
 * serializes MLX work; a separate "regen lane" would just contend for the same
 * runtime and OOM the box, so reusing the GPU lane is the correct shape). The
 * `regenOf` param threaded into `generateImage` stamps the lineage onto the
 * resulting sidecar (`regenerated`/`regenSteps`/`regenStrength`/`regenModelId`
 * + `cleanedFrom` for variant grouping).
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { getSettings } from '../settings.js';
import { getImageModels, isFlux2 } from '../../lib/mediaModels.js';
import { usesDiffusersRunner } from '../../lib/runners.js';
import { isFlux2VenvHealthy } from '../../lib/pythonSetup.js';
import { IMAGE_GEN_MODE } from './modes.js';

const IS_WIN = process.platform === 'win32';

// img2img denoise strength: lower = closer to the source (less mutation),
// higher = more of the image resampled. With the empty-prompt minimal-mutation
// default, the VAE round-trip already overwrites most of the per-pixel SynthID
// signal, so a low strength is enough — 0.25 is the provisional default and the
// floor is 0.1 so a user can sweep down (via the API `strength` param) to the
// minimum their SynthID detector still clears. Tune the default once that floor
// is known.
export const DEFAULT_REGEN_STRENGTH = 0.25;
export const REGEN_STRENGTH_MIN = 0.1;
export const REGEN_STRENGTH_MAX = 0.6;

// FLUX runs self-attention over latent tokens (~pixels/256) and the cost is
// O(tokens²), so render resolution can't track the source for large images:
// a 12.6 MP (4096×3072) codex render is ~60× the attention compute of a 1.5 MP
// one and will stall or OOM even on a big-memory box, well before producing a
// usable result. Cap the *render* resolution to a FLUX-sane budget; the output
// is then upscaled back to the source's exact dimensions (see generateImage's
// `upscaleTo`). Env-tunable for high-memory machines that want to push it.
export const DEFAULT_MAX_REGEN_MEGAPIXELS = (() => {
  const n = Number(process.env.PORTOS_REGEN_MAX_MP);
  return Number.isFinite(n) && n > 0 ? n : 2.0;
})();

// FLUX latents are /8 spatial and the transformer patchifies 2×2, so render
// dimensions must be multiples of 16. Round DOWN to the nearest multiple (so
// the megapixel budget stays a hard ceiling — rounding up could nudge a
// budget-fitted image back over and reintroduce the OOM risk), floored at 16 so
// a tiny input can't collapse to 0.
const floor16 = (n) => Math.max(16, Math.floor(n / 16) * 16);

/**
 * Resolve the render dimensions for a regen pass: clamp the source to a
 * FLUX-sane megapixel budget (aspect-preserved) and round to multiples of 16.
 * Pure. Returns `{ width, height, scaled }` where `scaled` is true whenever the
 * render dims differ from the source (either because it was downscaled to fit
 * the budget OR because the source wasn't already /16) — i.e. whenever the
 * caller must upscale the result back to the source's exact dimensions.
 */
export function clampRegenDimensions(srcWidth, srcHeight, maxMegapixels = DEFAULT_MAX_REGEN_MEGAPIXELS) {
  const w = Math.round(Number(srcWidth));
  const h = Math.round(Number(srcHeight));
  if (!(w > 0) || !(h > 0)) {
    // Defensive fallback for a missing/garbage sidecar — render at the FLUX
    // native square and don't claim a scale-back.
    return { width: 1024, height: 1024, scaled: false };
  }
  const budgetPx = Math.max(1, maxMegapixels) * 1_000_000;
  const scale = w * h > budgetPx ? Math.sqrt(budgetPx / (w * h)) : 1;
  const rw = floor16(w * scale);
  const rh = floor16(h * scale);
  return { width: rw, height: rh, scaled: rw !== w || rh !== h };
}

// FLUX.2 + the diffusers-family runners (Z-Image / ERNIE / HiDream / Qwen) all
// share the FLUX.2 venv and implement img2img via `--image-path`.
export const modelUsesFluxVenv = (model) => isFlux2(model) || usesDiffusersRunner(model);

// Whether a model RELIABLY does the img2img round-trip regen needs — i.e. it
// honors the init image rather than silently degrading to txt2img (which would
// make `regenerated: true` a lie). Capability, not installed-state.
//
//   - FLUX.2 (`scripts/flux2_macos.py`) — the intended i2i path; --image-path
//     is forwarded to the pipeline. Regen-capable on every platform.
//   - The broader diffusers family (Z-Image / ERNIE / HiDream / Qwen via
//     `scripts/z_image_turbo.py`) — EXCLUDED: that runner explicitly
//     "falls back to txt2img and ignores the init image" when a model family
//     has no i2i sibling, so JS can't know from here whether the round-trip
//     actually happened. Excluding them keeps the lineage honest.
//   - Legacy mflux — reliable i2i on macOS (`mflux-generate --image-path`);
//     Windows `imagine_win.py` drops the init-image args, so excluded there.
export function modelSupportsRegen(model) {
  if (!model) return false;
  if (isFlux2(model)) return true;
  if (usesDiffusersRunner(model)) return false;
  return !IS_WIN;
}

function mfluxBinaryPresent(pythonPath) {
  if (!pythonPath) return false;
  return existsSync(join(dirname(pythonPath), IS_WIN ? 'mflux-generate.exe' : 'mflux-generate'));
}

// Order regen candidates: the source's own model first (style continuity on
// the round-trip), then prefer fast distilled models (`cfgDisabled` —
// Schnell / Klein / Turbo) for a snappy ~5–15s pass, then everything else.
// Pure — `models`/`sourceModelId` in, ordered list out.
export function orderRegenCandidates(models, sourceModelId) {
  const list = Array.isArray(models) ? models.filter(Boolean) : [];
  return [...list].sort((a, b) => {
    const aSrc = a.id === sourceModelId ? 0 : 1;
    const bSrc = b.id === sourceModelId ? 0 : 1;
    if (aSrc !== bSrc) return aSrc - bSrc;
    const aFast = a.cfgDisabled ? 0 : 1;
    const bFast = b.cfgDisabled ? 0 : 1;
    return aFast - bFast;
  });
}

// Resolve the local FLUX backend regen should use. Returns
// `{ available, model, pythonPath }` on success, or `{ available: false, reason }`
// with an actionable message when nothing runnable is installed (the hardware
// gate). Async because the FLUX.2 venv health probe spawns a process (cached).
export async function resolveRegenBackend({ sourceModelId } = {}) {
  const models = getImageModels();
  if (!models.length) {
    return { available: false, reason: 'No local image models are configured on this machine.' };
  }
  const settings = await getSettings().catch(() => null);
  const pythonPath = settings?.imageGen?.local?.pythonPath || null;
  const fluxVenvHealthy = await isFlux2VenvHealthy().catch(() => false);
  const mfluxReady = mfluxBinaryPresent(pythonPath);
  const candidates = orderRegenCandidates(models, sourceModelId).filter(modelSupportsRegen);
  for (const model of candidates) {
    if (modelUsesFluxVenv(model)) {
      if (fluxVenvHealthy) return { available: true, model, pythonPath };
    } else if (mfluxReady) {
      return { available: true, model, pythonPath };
    }
  }
  const reason = !fluxVenvHealthy && !mfluxReady
    ? 'No local FLUX runner is installed. Set up the FLUX.2 venv in Settings → Image Gen to enable image regeneration.'
    : 'No local FLUX model on this machine supports image-to-image regeneration.';
  return { available: false, reason };
}

// Slim shape for the UI gate — drives whether the lightbox shows the
// Regenerate action at all.
export async function getRegenAvailability() {
  const resolved = await resolveRegenBackend();
  return {
    available: resolved.available,
    modelId: resolved.model?.id || null,
    reason: resolved.available ? null : resolved.reason,
  };
}

// Read an image's pixel dimensions off disk. Used to size the regen render to
// match the source (img2img resizes the init image to width/height; a mismatch
// would distort composition). Returns null on a read/decode failure so the
// caller can fall back to the sidecar's recorded dimensions.
export async function readImageDimensions(absPath) {
  const meta = await sharp(absPath).metadata().catch(() => null);
  if (meta?.width && meta?.height) return { width: meta.width, height: meta.height };
  return null;
}

// Pure: assemble the mediaJobQueue params for a regen render. `regenOf` is what
// stamps the sidecar lineage in `generateImage`. The validated `strength` is the
// img2img denoise; `steps` (optional) pins a low count, else the model default.
//
// Minimal-mutation default: NO prompt and NO negative prompt. With img2img a
// text prompt steers the output toward described content; an empty prompt makes
// the pass a near-pure VAE round-trip + `strength` worth of resample — which is
// what overwrites the per-pixel SynthID signal with the LEAST visible change to
// the image. A caller that wants a creative re-roll instead can pass an explicit
// `promptOverride` (then the source's negative prompt is carried along too).
//
// Render dimensions are clamped to a FLUX-sane megapixel budget (large codex
// renders — up to 12.6 MP — would otherwise stall/OOM the attention pass). When
// clamping changes the dims, `upscaleTo` carries the source's exact dimensions
// so `generateImage` resizes the result back up, delivering a watermark-free
// copy at the original resolution.
export function buildRegenParams({ filename, sourceAbsPath, sourceMeta = {}, sourceDims = null, model, pythonPath, strength, steps, promptOverride }) {
  const src = sourceDims
    || (sourceMeta.width && sourceMeta.height ? { width: Math.round(sourceMeta.width), height: Math.round(sourceMeta.height) } : null);
  const hasPrompt = typeof promptOverride === 'string' && promptOverride.trim();
  // Anchor the variant-grouping lineage at the ROOT original, not the clicked
  // image. computeImageVariantGroup groups siblings under a single original
  // (an item with no `cleanedFrom`); regenerating a cleaned/regenerated variant
  // must therefore stamp the root's filename as `cleanedFrom` (= `regenOf`),
  // or the new render orphans from the family's variant switch. Pixels still
  // come from the clicked image (`sourceAbsPath`).
  const groupRoot = typeof sourceMeta.cleanedFrom === 'string' && sourceMeta.cleanedFrom
    ? sourceMeta.cleanedFrom
    : filename;
  const params = {
    mode: IMAGE_GEN_MODE.LOCAL,
    pythonPath,
    modelId: model.id,
    prompt: hasPrompt ? promptOverride : '',
    negativePrompt: hasPrompt && typeof sourceMeta.negativePrompt === 'string' ? sourceMeta.negativePrompt : '',
    initImagePath: sourceAbsPath,
    initImageStrength: strength,
    regenOf: groupRoot,
  };
  if (src) {
    const render = clampRegenDimensions(src.width, src.height);
    params.width = render.width;
    params.height = render.height;
    // Clamped or /16-rounded → deliver the cleaned copy at the source's exact
    // resolution by upscaling the render back up.
    if (render.scaled) params.upscaleTo = { width: src.width, height: src.height };
  }
  if (steps != null) params.steps = steps;
  return params;
}
