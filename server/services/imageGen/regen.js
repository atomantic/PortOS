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
// Floor is a small POSITIVE value, not 0. Empirically, mflux special-cases
// strength 0.0 as "ignore the init image" — it regenerates a fresh, near-random
// image (~49% pixel change) instead of round-tripping the source, which defeats
// the whole point. 0.02 is the lowest value that still does a faithful pass; in
// the 0.02–0.25 range the change is a flat ~8% (the VAE round-trip's own
// reconstruction error — the irreducible minimum for this approach), so
// "minimal processing" is already reached at the low end. The default stays at
// a known-good 0.25 until a lower value is confirmed to still clear a SynthID
// detector.
export const REGEN_STRENGTH_MIN = 0.02;
export const REGEN_STRENGTH_MAX = 0.6;

// Lighter default for sources that DON'T carry Google's SynthID. The big tools
// tune denoise by generator (remove-ai-watermarks: OpenAI 0.10 / Gemini 0.15)
// rather than using one flat value. We do the same, but conservatively: the
// known-good 0.25 is preserved for SynthID-bearing generators (never lower the
// SynthID path below the value confirmed to clear a detector), while local FLUX
// renders — which have no Google watermark — use a lighter pass for better
// fidelity when regenerated for other reasons.
export const REGEN_LIGHT_STRENGTH_DEFAULT = 0.15;

// Annotation re-render default (issue #2036 phase 2). Unlike a SynthID pass —
// which wants the LOWEST denoise that still overwrites the watermark — an
// annotation re-render exists to let the drawn marks actually reshape the image,
// so it needs a much higher denoise. 0.5 (just under REGEN_STRENGTH_MAX) lets the
// strokes meaningfully redraw while still anchoring on the source composition.
// The API `strength` override and the [MIN, MAX] bounds are unaffected.
export const REGEN_ANNOTATED_STRENGTH_DEFAULT = 0.5;

// Provider-aware denoise default for a regen of `sourceMeta`. SynthID rides on
// gpt-image (codex) / Imagen / Gemini / Nano-Banana output; those keep the
// conservative 0.25. Local FLUX sources (a `modelId` with no external `mode`,
// or `mode: 'local'`) carry no SynthID, so default to the lighter pass.
// Anything unidentified falls back to the conservative 0.25. The API `strength`
// override and the [MIN, MAX] bounds are unaffected — this only sets the
// *default* when the caller doesn't pin a value.
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

// Deliberate resolution shift applied to EVERY regen, not just over-budget
// images. SynthID's invisible carriers live at resolution-dependent FFT bins
// (the key finding from the reverse-SynthID project: a codebook built at one
// resolution can't locate the watermark at another), so a downscale→upscale
// "resize-squeeze" disrupts them at essentially zero cost. The render runs at
// this fraction of the source and is upscaled back to the exact source dims, so
// every regen gets a second, GPU-free disruption vector layered on top of the
// VAE round-trip. 0.9 reliably clears at least one /16 step for typical sizes
// while keeping the upscale-back blur minimal.
export const REGEN_SQUEEZE_FACTOR = 0.9;

/**
 * Resolve the render dimensions for a regen pass. Two reasons the render runs
 * off the source's native resolution, both delivered back at the exact source
 * dims via `upscaleTo`:
 *   1. Over the megapixel budget → downscale (aspect-preserved) to fit FLUX's
 *      O(tokens²) attention budget (a hard ceiling — see DEFAULT_MAX_REGEN_MEGAPIXELS).
 *   2. Under budget → still apply the deliberate `REGEN_SQUEEZE_FACTOR` resize-
 *      squeeze so the resolution always shifts, disrupting SynthID's
 *      resolution-dependent frequency carriers.
 * Pure. Returns `{ width, height, scaled }`; `scaled` is true whenever the
 * render dims differ from the source — i.e. whenever the caller must upscale
 * the result back to the source's exact dimensions (which, with the universal
 * squeeze, is every real image).
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
// Regenerate action, and carries the strength bounds so the in-lightbox slider
// stays in lock-step with server validation (one place to tune the floor).
export async function getRegenAvailability({ sourceModelId } = {}) {
  // Thread the source image's model through so the reported `modelId` is the
  // EXACT backend a regen of that source would run — `resolveRegenBackend`
  // orders candidates by the source's own model, so a generic (source-less)
  // call can name a different model than the POST later enqueues on a
  // multi-model install (issue #2036: the annotate dialog must disclose the
  // real model before the render).
  const resolved = await resolveRegenBackend({ sourceModelId });
  return {
    available: resolved.available,
    modelId: resolved.model?.id || null,
    reason: resolved.available ? null : resolved.reason,
    strengthMin: REGEN_STRENGTH_MIN,
    strengthMax: REGEN_STRENGTH_MAX,
    strengthDefault: DEFAULT_REGEN_STRENGTH,
    // CPU-only spatial fallback. Always available (sharp is a hard dependency),
    // so installs without a FLUX runner can still attempt a SynthID-disrupting
    // pass — clearly labeled as less reliable than the GPU round-trip.
    lightAvailable: true,
    lightReason: resolved.available
      ? 'CPU-only spatial pass — faster but less reliable than the FLUX round-trip.'
      : 'No local FLUX runner installed. The light CPU pass is a best-effort, lower-reliability fallback.',
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
export function buildRegenParams({ filename, sourceAbsPath, sourceMeta = {}, sourceDims = null, model, pythonPath, strength, steps, promptOverride, initImageAbsPath, annotated = false, maxMegapixels = DEFAULT_MAX_REGEN_MEGAPIXELS }) {
  // The img2img base pixels normally come from the clicked source, but an
  // annotation re-render (issue #2036 phase 2) points the init image at the
  // flattened source+strokes PNG while STILL reading dimensions/metadata/lineage
  // from the original source below.
  const initPath = initImageAbsPath || sourceAbsPath;
  const src = sourceDims
    || (sourceMeta.width && sourceMeta.height ? { width: Math.round(sourceMeta.width), height: Math.round(sourceMeta.height) } : null);
  const trimmedPrompt = typeof promptOverride === 'string' ? promptOverride.trim() : '';
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
    prompt: trimmedPrompt,
    negativePrompt: trimmedPrompt && typeof sourceMeta.negativePrompt === 'string' ? sourceMeta.negativePrompt : '',
    initImagePath: initPath,
    initImageStrength: strength,
    regenOf: groupRoot,
    ...(annotated ? { annotatedRegen: true } : {}),
  };
  if (src) {
    // `maxMegapixels` lets a caller (e.g. the Image Cleaner's optional
    // max-render-MP override) push or pull the render budget per-run; defaults
    // to the env-tunable DEFAULT_MAX_REGEN_MEGAPIXELS the lightbox uses.
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

// PSNR (dB) reported for a byte-identical pair — a finite sentinel above any
// realistic regen PSNR (an 8% VAE-floor change lands near 30 dB), used instead
// of Infinity so the value survives JSON serialization.
export const PSNR_IDENTICAL = 100;

// Measure how much a regen actually changed the image — source vs. delivered.
// Every serious watermark tool gates on a fidelity metric (reverse-SynthID
// PSNR-gates each stage); we only stamped the *requested* strength, never the
// realized delta. This turns "trust me" into a number that catches the failure
// modes a blind pass can't see: the mflux strength-0.0 footgun (~49% change), a
// silent txt2img fallback, or plain over-mutation. Both images are decoded to a
// small common raster (cheap, resolution-independent) and compared per-channel.
// `a`/`b` are each a file path OR an in-memory Buffer (sharp accepts both) — the
// caller passes buffers when it already has the bytes to skip a disk re-read.
// Returns `{ pixelDeltaPct, psnr }` (psnr in dB; capped at PSNR_IDENTICAL for a
// byte-identical pair so the value always survives JSON serialization — a raw
// Infinity would round-trip to null through res.json/JSON.stringify), or null on
// a decode failure so the caller can skip the stamp without failing the render.
export async function computePixelDelta(a, b, sampleSize = 256) {
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

// CPU-only "light" regen — the no-GPU fallback for installs without a local
// FLUX runner (Windows mflux, no-GPU boxes, diffusers-only setups), which today
// get NOTHING: imageClean.js's median+sharpen explicitly can't touch SynthID.
// This layers the cheap spatial-domain stages the research tools use when no
// diffusion model is available (reverse-SynthID's resize-squeeze + color nudge,
// Synthid-Bypass's recompress):
//   1. resize-squeeze (cubic down → lanczos up) — disrupts the resolution-
//      dependent SynthID carriers, same idea as clampRegenDimensions but CPU-side.
//   2. micro color/contrast nudge (modulate + linear) — imperceptible, shifts
//      pixel statistics the watermark detector keys on.
//   3. high-frequency perturbation (median + sharpen) — perturbs the band the
//      invisible mark rides in.
// HONESTLY less reliable than the VAE round-trip — spatial transforms can't do
// the FFT phase-subtraction the GPU tools layer on top, so the caller MUST
// label this as best-effort. Pure-ish: sharp in, `{ data, width, height }` out.
// `sharpImpl` is injectable for tests.
export async function applyLightRegen(buffer, { sharpImpl = sharp } = {}) {
  const meta = await sharpImpl(buffer).metadata().catch(() => null);
  const w = Math.round(Number(meta?.width));
  const h = Math.round(Number(meta?.height));
  if (!(w > 0) || !(h > 0)) return null;
  const sw = floor16(w * REGEN_SQUEEZE_FACTOR);
  const sh = floor16(h * REGEN_SQUEEZE_FACTOR);
  // sharp applies only ONE resize per pipeline (a later .resize() OVERWRITES an
  // earlier one — they don't chain), so the downscale→upscale squeeze MUST be
  // two separate pipelines: render the squeezed buffer first, then upscale THAT
  // back to the source dims. A single chained `.resize(sw,sh).resize(w,h)` would
  // silently drop the downscale and skip the resolution shift that disrupts
  // SynthID's resolution-dependent carriers — i.e. the light pass's whole point.
  // No EXIF auto-orient: the gallery is PNG-only (no orientation tag), so the
  // squeeze targets from un-rotated metadata keep the aspect and upscale-back exact.
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
