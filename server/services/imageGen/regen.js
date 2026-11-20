/**
 * Image Gen — SynthID-defeat regeneration.
 *
 * The plain cleaner (`server/lib/imageClean.js`) only strips the C2PA `caBX` chunk and runs median+sharpen, which
 * SynthID survives by design. The only honest defeat path is to round-trip the pixels through a generative model:
 * a short-step img2img pass on a LOCAL FLUX runner at low–moderate denoise so composition holds but the
 * per-pixel watermark signal is overwritten by fresh sampling.
 *
 * Scope: post-hoc and history-only, a second action next to "Clean (aggressive)" in the lightbox; never
 * auto-applied or wired into the generation flow. Hardware-gated: it only runs when a local FLUX runner is
 * installed, so the UI hides the action otherwise.
 *
 * This module owns the availability gate + pure param assembly. The render reuses the local img2img path: the
 * route enqueues a normal `kind: 'image'` job through `mediaJobQueue` (a separate "regen lane" would contend for
 * the same runtime and OOM the box). The `regenOf` param threaded into `generateImage` stamps lineage onto the
 * sidecar (`regenerated`/`regenSteps`/`regenStrength`/`regenModelId` + `cleanedFrom` for variant grouping).
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getSettings } from '../settings.js';
import { getImageModels, isFlux2 } from '../../lib/mediaModels.js';
import { usesDiffusersRunner } from '../../lib/runners.js';
import { usesTorchVenv } from '../../lib/imageRuntimeRemedies.js';
import { isFlux2VenvHealthy } from '../../lib/pythonSetup.js';
import { IMAGE_GEN_MODE } from './modes.js';
import { REGEN_STRENGTH_MIN, REGEN_STRENGTH_MAX } from '../../lib/imageGenCapabilities.js';

export { REGEN_STRENGTH_MIN, REGEN_STRENGTH_MAX };

const IS_WIN = process.platform === 'win32';

// img2img denoise strength: lower = closer to the source, higher = more resampled. With the empty-prompt
// minimal-mutation default the VAE round-trip already overwrites most of the SynthID signal, so 0.25 is the
// provisional default and the floor is 0.1 so a user can sweep down (API `strength`) to the minimum their
// detector still clears.
export const DEFAULT_REGEN_STRENGTH = 0.25;
// Floor is a small POSITIVE value, not 0: mflux special-cases strength 0.0 as "ignore the init image" and
// regenerates a near-random image (~49% pixel change) instead of round-tripping the source. 0.02 is the lowest
// value that still does a faithful pass; across 0.02–0.25 the change is a flat ~8% (the VAE round-trip's own
// reconstruction error, the irreducible minimum). The default stays at a known-good 0.25 until a lower value is
// confirmed to still clear a detector.

// Lighter default for sources that DON'T carry Google's SynthID (denoise is tuned by generator). The known-good
// 0.25 is preserved for SynthID-bearing generators (never lower that path below the confirmed value), while local
// FLUX renders, with no Google watermark, use a lighter pass for better fidelity.
export const REGEN_LIGHT_STRENGTH_DEFAULT = 0.15;

// Annotation re-render default. Unlike a SynthID pass (LOWEST denoise that still overwrites the watermark), an
// annotation re-render must let the drawn marks reshape the image, so it needs a much higher denoise. 0.5 (just
// under REGEN_STRENGTH_MAX) lets strokes redraw while anchoring on the source composition.
export const REGEN_ANNOTATED_STRENGTH_DEFAULT = 0.5;

// Provider-aware denoise default for a regen of `sourceMeta`. SynthID rides on gpt-image (codex) / Imagen /
// Gemini / Nano-Banana output, which keep the conservative 0.25. Local FLUX sources (a `modelId` with no external
// `mode`, or `mode: 'local'`) carry no SynthID and get the lighter pass; anything unidentified gets 0.25. Only the
// *default* when the caller doesn't pin a value; the API override and [MIN, MAX] bounds are unaffected.
export function resolveRegenStrengthDefault(sourceMeta = {}) {
  const meta = sourceMeta || {};
  const mode = typeof meta.mode === 'string' ? meta.mode.toLowerCase() : null;
  const model = (typeof meta.modelId === 'string' ? meta.modelId
    : typeof meta.model === 'string' ? meta.model : '').toLowerCase();
  const synthIdBearing = mode === 'codex' || /gpt-image|imagen|gemini|nano-?banana/.test(model);
  if (synthIdBearing) return DEFAULT_REGEN_STRENGTH;
  const isLocalFlux = (!mode || mode === 'local') && !!model;
  return isLocalFlux ? REGEN_LIGHT_STRENGTH_DEFAULT : DEFAULT_REGEN_STRENGTH;
}

// FLUX self-attention cost is O(tokens²) over latent tokens (~pixels/256), so render resolution can't track the
// source for large images: a 12.6 MP render is ~60× the attention compute of a 1.5 MP one and will stall or OOM.
// Cap the *render* resolution to a FLUX-sane budget; the output is upscaled back to the source's exact dimensions
// (`upscaleTo` in generateImage). Env-tunable for high-memory machines.
export const DEFAULT_MAX_REGEN_MEGAPIXELS = (() => {
  const n = Number(process.env.PORTOS_REGEN_MAX_MP);
  return Number.isFinite(n) && n > 0 ? n : 2.0;
})();

// FLUX latents are /8 spatial and the transformer patchifies 2×2, so render dimensions must be multiples of 16.
// Round DOWN so the megapixel budget stays a hard ceiling; floored at 16 so a tiny input can't collapse to 0.
const floor16 = (n) => Math.max(16, Math.floor(n / 16) * 16);

// Deliberate resolution shift applied to EVERY regen. SynthID's invisible carriers live at resolution-dependent
// FFT bins (a codebook built at one resolution can't locate the watermark at another), so a downscale→upscale
// "resize-squeeze" disrupts them at essentially zero cost, layered on the VAE round-trip. 0.9 reliably clears at
// least one /16 step for typical sizes while keeping the upscale-back blur minimal.
export const REGEN_SQUEEZE_FACTOR = 0.9;

/**
 * Resolve the render dimensions for a regen pass. The render runs off native resolution for two reasons, both
 * delivered back at the exact source dims via `upscaleTo`:
 *   1. Over the megapixel budget → downscale (aspect-preserved) to fit FLUX's attention budget (a hard ceiling,
 *      see DEFAULT_MAX_REGEN_MEGAPIXELS).
 *   2. Under budget → still apply `REGEN_SQUEEZE_FACTOR` so the resolution always shifts.
 * Pure. Returns `{ width, height, scaled }`; `scaled` is true whenever render dims differ from the source, i.e.
 * whenever the caller must upscale back (with the universal squeeze, every real image).
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
  // Over budget: downscale to fit. Under budget: apply the universal squeeze.
  const scale = w * h > budgetPx ? Math.sqrt(budgetPx / (w * h)) : REGEN_SQUEEZE_FACTOR;
  const rw = floor16(w * scale);
  const rh = floor16(h * scale);
  return { width: rw, height: rh, scaled: rw !== w || rh !== h };
}

// FLUX.2 + the diffusers-family runners (Z-Image / ERNIE / HiDream / Qwen) all
// share the FLUX.2 venv and implement img2img via `--image-path`.
export { usesTorchVenv as modelUsesFluxVenv };

// Whether a model RELIABLY does the img2img round-trip regen needs, i.e. honors the init image rather than
// silently degrading to txt2img (which would make `regenerated: true` a lie). Capability, not installed-state.
//
//   - FLUX.2 (`scripts/flux2_macos.py`): the intended i2i path; --image-path is forwarded. Regen-capable everywhere.
//   - The diffusers family (Z-Image / ERNIE / HiDream / Qwen via `scripts/z_image_turbo.py`) is EXCLUDED: that
//     runner "falls back to txt2img and ignores the init image" for a family with no i2i sibling, so JS can't know
//     whether the round-trip happened.
//   - Legacy mflux: reliable i2i on macOS (`--image-path`); Windows `imagine_win.py` drops the init-image args, so
//     excluded there.
export function modelSupportsRegen(model) {
  if (!model) return false;
  if (model.supportsImg2Img === false || model.runner === 'moss-swift') return false;
  if (isFlux2(model)) return true;
  if (usesDiffusersRunner(model)) return false;
  return !IS_WIN;
}

function mfluxBinaryPresent(pythonPath) {
  if (!pythonPath) return false;
  return existsSync(join(dirname(pythonPath), IS_WIN ? 'mflux-generate.exe' : 'mflux-generate'));
}

// Order regen candidates: the source's own model first (style continuity), then fast distilled models
// (`cfgDisabled` — Schnell / Klein / Turbo) for a snappy pass, then the rest. Pure.
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

// Resolve the local FLUX backend regen should use: `{ available, model, pythonPath }`, or
// `{ available: false, reason }` with an actionable message when nothing runnable is installed (the hardware
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
    if (usesTorchVenv(model)) {
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

// Slim shape for the UI gate: whether the lightbox shows Regenerate, plus the strength bounds so the slider
// stays in lock-step with server validation.
export async function getRegenAvailability({ sourceModelId } = {}) {
  // Thread the source image's model through so the reported `modelId` is the EXACT backend a regen of that source
    // would run: `resolveRegenBackend` orders candidates by the source's own model, so a source-less call could name
    // a different model than the POST later enqueues, and the annotate dialog must disclose the real model.
  const resolved = await resolveRegenBackend({ sourceModelId });
  return {
    available: resolved.available,
    modelId: resolved.model?.id || null,
    reason: resolved.available ? null : resolved.reason,
    strengthMin: REGEN_STRENGTH_MIN,
    strengthMax: REGEN_STRENGTH_MAX,
    strengthDefault: DEFAULT_REGEN_STRENGTH,
    // CPU-only spatial fallback. Always available (sharp is a hard dependency), so installs without a FLUX runner
        // can still attempt a pass, labeled as less reliable than the GPU round-trip.
    lightAvailable: true,
    lightReason: resolved.available
      ? 'CPU-only spatial pass — faster but less reliable than the FLUX round-trip.'
      : 'No local FLUX runner installed. The light CPU pass is a best-effort, lower-reliability fallback.',
  };
}

// Read an image's pixel dimensions off disk, to size the regen render to the source (img2img resizes the init
// image to width/height; a mismatch distorts composition). Null on read/decode failure so the caller can fall back
// to the sidecar's recorded dimensions.
export async function readImageDimensions(absPath) {
  const { default: sharp } = await import('sharp');
  const meta = await sharp(absPath).metadata().catch(() => null);
  if (meta?.width && meta?.height) return { width: meta.width, height: meta.height };
  return null;
}

// Pure: assemble the mediaJobQueue params for a regen render. `regenOf` stamps the sidecar lineage in
// `generateImage`. The validated `strength` is the img2img denoise; `steps` (optional) pins a low count.
//
// Minimal-mutation default: NO prompt and NO negative prompt. A text prompt steers img2img toward described
// content; an empty one makes the pass a near-pure VAE round-trip + `strength` worth of resample, overwriting the
// SynthID signal with the LEAST visible change. A caller wanting a creative re-roll passes an explicit
// `promptOverride` (the source's negative prompt is then carried along too).
//
// Render dimensions are clamped to a FLUX-sane megapixel budget; when that changes the dims, `upscaleTo` carries
// the source's exact dimensions so `generateImage` resizes the result back up.
export function buildRegenParams({ filename, sourceAbsPath, sourceMeta = {}, sourceDims = null, model, pythonPath, strength, steps, promptOverride, initImageAbsPath, annotated = false, maxMegapixels = DEFAULT_MAX_REGEN_MEGAPIXELS }) {
  // The img2img base pixels normally come from the clicked source, but an annotation re-render points the init
    // image at the flattened source+strokes PNG while STILL reading dimensions/metadata/lineage from the original.
  const initPath = initImageAbsPath || sourceAbsPath;
  const src = sourceDims
    || (sourceMeta.width && sourceMeta.height ? { width: Math.round(sourceMeta.width), height: Math.round(sourceMeta.height) } : null);
  const trimmedPrompt = typeof promptOverride === 'string' ? promptOverride.trim() : '';
  // Anchor the variant-grouping lineage at the ROOT original, not the clicked image: computeImageVariantGroup
    // groups siblings under an item with no `cleanedFrom`, so regenerating a variant must stamp the root's filename
    // as `cleanedFrom` (= `regenOf`) or the render orphans from the family's variant switch. Pixels still come from
    // the clicked image (`sourceAbsPath`).
  const groupRoot = typeof sourceMeta.cleanedFrom === 'string' && sourceMeta.cleanedFrom
    ? sourceMeta.cleanedFrom
    : filename;
  const params = {
    mode: IMAGE_GEN_MODE.LOCAL,
    pythonPath,
    modelId: model.id,
    prompt: trimmedPrompt,
    negativePrompt: trimmedPrompt && typeof sourceMeta.negativePrompt === 'string' ? sourceMeta.negativePrompt : '',
    initImagePath: initPath,
    initImageStrength: strength,
    regenOf: groupRoot,
    ...(annotated ? { annotatedRegen: true } : {}),
  };
  if (src) {
    // `maxMegapixels` lets a caller (e.g. the Image Cleaner's max-render-MP override) move the render budget per
        // run; defaults to the env-tunable DEFAULT_MAX_REGEN_MEGAPIXELS.
    const render = clampRegenDimensions(src.width, src.height, maxMegapixels);
    params.width = render.width;
    params.height = render.height;
    // Clamped or /16-rounded → deliver the cleaned copy at the source's exact
    // resolution by upscaling the render back up.
    if (render.scaled) params.upscaleTo = { width: src.width, height: src.height };
  }
  if (steps != null) params.steps = steps;
  return params;
}

// PSNR (dB) reported for a byte-identical pair: a finite sentinel above any realistic regen PSNR (~30 dB), used
// instead of Infinity so the value survives JSON serialization.
export const PSNR_IDENTICAL = 100;

// Measure how much a regen actually changed the image, source vs. delivered. Turns the *requested* strength into
// a realized number that catches what a blind pass can't see: the mflux strength-0.0 footgun (~49% change), a
// silent txt2img fallback, or over-mutation. Both images are decoded to a small common raster and compared
// per-channel. `a`/`b` are each a file path OR an in-memory Buffer (sharp accepts both; pass buffers to skip a
// disk re-read). Returns `{ pixelDeltaPct, psnr }` (psnr capped at PSNR_IDENTICAL for a byte-identical pair), or
// null on a decode failure so the caller can skip the stamp without failing the render.
export async function computePixelDelta(a, b, sampleSize = 256) {
  const { default: sharp } = await import('sharp');
  const toRaster = (src) => sharp(src)
    .resize(sampleSize, sampleSize, { fit: 'fill', kernel: 'cubic' })
    .removeAlpha()
    .raw()
    .toBuffer()
    .catch(() => null);
  const [ra, rb] = await Promise.all([toRaster(a), toRaster(b)]);
  if (!ra || !rb || ra.length !== rb.length) return null;
  let sumAbs = 0;
  let sumSq = 0;
  for (let i = 0; i < ra.length; i++) {
    const d = ra[i] - rb[i];
    sumAbs += d < 0 ? -d : d;
    sumSq += d * d;
  }
  const pixelDeltaPct = Math.round((sumAbs / ra.length / 255) * 1000) / 10;
  const mse = sumSq / ra.length;
  // Finite cap for the identical case — JSON has no Infinity (it serializes to
  // null), and a real regen never reaches it anyway (the pass always mutates).
  const psnr = mse === 0 ? PSNR_IDENTICAL : Math.round(10 * Math.log10((255 * 255) / mse) * 10) / 10;
  return { pixelDeltaPct, psnr };
}

// CPU-only "light" regen: the no-GPU fallback for installs without a local FLUX runner (Windows mflux, no-GPU
// boxes, diffusers-only setups), since imageClean.js's median+sharpen can't touch SynthID. Layers cheap
// spatial-domain stages:
//   1. resize-squeeze (cubic down → lanczos up): disrupts the resolution-dependent carriers, as
//      clampRegenDimensions does but CPU-side.
//   2. micro color/contrast nudge (modulate + linear): imperceptible, shifts statistics the detector keys on.
//   3. high-frequency perturbation (median + sharpen): perturbs the band the mark rides in.
// HONESTLY less reliable than the VAE round-trip (no FFT phase-subtraction), so the caller MUST label it
// best-effort. Pure-ish: sharp in, `{ data, width, height }` out. `sharpImpl` is injectable for tests.
export async function applyLightRegen(buffer, { sharpImpl } = {}) {
  if (sharpImpl === undefined) sharpImpl = (await import('sharp')).default;
  const meta = await sharpImpl(buffer).metadata().catch(() => null);
  const w = Math.round(Number(meta?.width));
  const h = Math.round(Number(meta?.height));
  if (!(w > 0) || !(h > 0)) return null;
  const sw = floor16(w * REGEN_SQUEEZE_FACTOR);
  const sh = floor16(h * REGEN_SQUEEZE_FACTOR);
  // sharp applies only ONE resize per pipeline (a later .resize() OVERWRITES an earlier one), so the
    // downscale→upscale squeeze MUST be two pipelines: a chained `.resize(sw,sh).resize(w,h)` would silently drop the
    // downscale and skip the resolution shift, the light pass's whole point. No EXIF auto-orient: the gallery is
    // PNG-only, so un-rotated metadata keeps the aspect and upscale-back exact.
  const squeezed = await sharpImpl(buffer).resize(sw, sh, { kernel: 'cubic' }).png().toBuffer();
  const data = await sharpImpl(squeezed)
    .resize(w, h, { fit: 'fill', kernel: 'lanczos3' })
    .modulate({ brightness: 1.01, saturation: 0.99, hue: 1 })
    .linear(1.02, -2)
    .median(2)
    .sharpen()
    .png({ compressionLevel: 6 })
    .toBuffer();
  return { data, width: w, height: h };
}
