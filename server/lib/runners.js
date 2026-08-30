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
  HIDREAM: 'hidream',
  QWEN: 'qwen',
});

// Video-LoRA families are tracked SEPARATELY from the image RUNNER_FAMILIES
// above. The Civitai suggestion/search code iterates Object.values(
// RUNNER_FAMILIES) and would 400 on any family Civitai has no baseModel
// mapping for — and video LoRAs (e.g. fal/ltx2.3-audio-reactive-lora) are
// imported from HuggingFace, not Civitai (see installFromHuggingface), so they
// must never enter that iteration. The compat-key machinery
// (composeCompatKey / the picker's familyOf) is family-string-agnostic, so a
// LoRA tagged `runnerFamily: 'ltx-video'` filters correctly against an
// `ltx-video` video model without any change there.
export const VIDEO_LORA_FAMILIES = Object.freeze({
  LTX_VIDEO: 'ltx-video',
  MINIMAX_H3: 'minimax-h3',
});

// Predicate: is this LoRA family a video family (vs. an image RUNNER_FAMILIES
// one)? Backs the Image/Video filter on /models/loras — both the installed-list
// filter and the suggestion-panel section gating. Anything not in
// VIDEO_LORA_FAMILIES (including null/legacy) is treated as image. Mirror of
// client/src/lib/runnerFamilies.js.
const VIDEO_LORA_FAMILY_SET = new Set(Object.values(VIDEO_LORA_FAMILIES));
export const isVideoLoraFamily = (family) => VIDEO_LORA_FAMILY_SET.has(family);
// The MiniMax H3 runtimes: PipeNetwork's Apple-Silicon MLX port (`minimax_h3`)
// and the diffusers + CUDA path Windows/Linux NVIDIA boxes run
// (`minimax_h3_cuda`). They load the same weights family, so every control H3
// fixes in the model itself — 24 fps, joint video+audio, CFG-distilled (no
// negative prompt), the 17n+5 frame grid, no tiling knob — is true of both.
// Gates asserting one of those facts ask this predicate instead of naming a
// single runtime, which is what would silently exempt the other one.
// Mirrored to client/src/lib/runnerFamilies.js.
export const MINIMAX_H3_REF2VA_RUNTIME = 'minimax_h3_ref2va';
export const MINIMAX_H3_RUNTIMES = Object.freeze([
  'minimax_h3',
  'minimax_h3_cuda',
  MINIMAX_H3_REF2VA_RUNTIME,
]);
const MINIMAX_H3_RUNTIME_SET = new Set(MINIMAX_H3_RUNTIMES);
export const isMiniMaxH3Runtime = (runtime) => MINIMAX_H3_RUNTIME_SET.has(runtime);
// dgrauet's LTX-2.3 pin (`ltx2`) and the LTX-2.5 fork (`ltx25`) share the
// same pipeline surface — true FFLF, video-conditioned extend, a2v, IC-LoRA —
// so capability gates ask this predicate instead of naming one id. The venvs
// stay separate: 2.5 is a different checkout and cannot load on the 2.3 pin.
export const LTX2_FAMILY_RUNTIMES = Object.freeze(['ltx2', 'ltx25']);
const LTX2_FAMILY_RUNTIME_SET = new Set(LTX2_FAMILY_RUNTIMES);
export const isLtx2FamilyRuntime = (runtime) => LTX2_FAMILY_RUNTIME_SET.has(runtime);
export const AUDIO_TO_VIDEO_RUNTIMES = Object.freeze([
  ...LTX2_FAMILY_RUNTIMES,
  MINIMAX_H3_REF2VA_RUNTIME,
]);
const AUDIO_TO_VIDEO_RUNTIME_SET = new Set(AUDIO_TO_VIDEO_RUNTIMES);
export const isAudioToVideoRuntime = (runtime) => AUDIO_TO_VIDEO_RUNTIME_SET.has(runtime);

// The family an INSTALLED LoRA belongs to. `loraCompatKey` is the refined key
// (e.g. flux2-9b) written by the importer; `runnerFamily` is the coarse legacy
// field a pre-sidecar install may be the only thing carrying. One helper so the
// `||` fallback can't drift between the pickers, the family filters, and the
// deep-link handoff. Mirrored to client/src/lib/runnerFamilies.js.
export const loraFamilyOf = (lora) => lora?.loraCompatKey || lora?.runnerFamily || null;

// A LoRA-quantization marker (`q4` / `q8`) in a model's id/repo/name. Anchored
// on a leading boundary (so it doesn't match inside `seq4uence`) and a trailing
// non-digit lookahead, which catches both delimited (`-q4`, `q8_0`) AND suffixed
// (`q4bit`, `q8gguf`) forms while not matching `q40`. Used to scope mlx_video
// LoRA fusion to the bf16 unified models (see isMlxVideoLtxLoraCapable).
const QUANTIZED_LTX_RE = /(?:^|[-_/\s])q(?:4|8)(?![0-9])/i;

// True when an mlx_video-runtime model is an LTX-2.x model whose LoRAs PortOS
// can fuse. notapalindrome's `mlx_video.generate_av` CLI has no `--lora` flag,
// but the package ships an LTX-aware LoRA subsystem (`mlx_video.lora`) — so
// scripts/generate_av_lora.py drives generate_av and merges the LoRA deltas into
// the transformer weights before generation. Scoped to NON-quantized (bf16)
// LTX-2.x models for now: the quantized q4/q8 variants need a separate
// dequantize→merge→requantize validation pass. The CUDA LTX-Video 0.9.5
// model ("ltx_video" / "LTX-Video 0.9.5") is excluded — it has no "ltx-2"
// marker and runs through generate_win.py, not generate_av.
export const isMlxVideoLtxLoraCapable = (model) => {
  if (model?.runtime !== 'mlx_video') return false;
  const hay = `${model?.id || ''} ${model?.repo || ''} ${model?.name || ''}`;
  if (!/ltx-?2/i.test(hay)) return false;          // must be an LTX-2.x model
  if (QUANTIZED_LTX_RE.test(hay)) return false;    // bf16-only scope (no q4/q8)
  return true;
};

// Map a video-model registry entry (which carries `runtime`, not `runner`) to
// the LoRA family the picker filters on. Two runtimes can fuse user LoRAs:
//   - dgrauet's `ltx2` / MrMofer's `ltx25` — `ltx_pipelines_mlx` honors a
//     `_pending_loras` hook (see scripts/generate_ltx2.py).
//   - notapalindrome's `mlx_video` on a non-quantized LTX-2.x model — fused
//     offline into the transformer weights (see isMlxVideoLtxLoraCapable +
//     scripts/generate_av_lora.py).
//   - `minimax_h3`, but ONLY when the installed runner plus PortOS's
//     activation-space adapter can apply LoRAs to the quantized DiT at runtime.
//     That is a property of the installed checkout, not of the model entry, so
//     it can't be derived here: listVideoModels()
//     decorates each model with `runtimeLoraCapable` from the probe in
//     services/videoGen/runtimes.js and this reads it off the payload (the same
//     shape as `lastFrameAnchored`). An undecorated model therefore reads as
//     "not capable" — the gate fails closed.
// The wan22 / fastvideo runtimes (and quantized mlx_video models) have no LoRA
// path, so they return null ("no LoRA support") and the VideoGen picker hides.
export const videoLoraFamily = (model) => {
  if (isLtx2FamilyRuntime(model?.runtime) || isMlxVideoLtxLoraCapable(model)) return VIDEO_LORA_FAMILIES.LTX_VIDEO;
  if (model?.runtime === 'minimax_h3' && model?.runtimeLoraCapable === true) return VIDEO_LORA_FAMILIES.MINIMAX_H3;
  return null;
};

// Convenience predicate helpers — match the semantics of the existing
// `isFlux2()` / `isZImage()` / `isErnie()` exports in `mediaModels.js`
// (which still exist for back-compat with their many call sites). New code
// can import either; same result.
export const isMflux = (model) => model?.runner === RUNNER_FAMILIES.MFLUX;
export const isFlux2 = (model) => model?.runner === RUNNER_FAMILIES.FLUX2;
export const isZImage = (model) => model?.runner === RUNNER_FAMILIES.Z_IMAGE;
export const isErnie = (model) => model?.runner === RUNNER_FAMILIES.ERNIE;
export const isHiDream = (model) => model?.runner === RUNNER_FAMILIES.HIDREAM;
export const isQwen = (model) => model?.runner === RUNNER_FAMILIES.QWEN;

// Predicate: model runs through the generic diffusers runner script
// (`scripts/z_image_turbo.py`). Z-Image, ERNIE, HiDream, and Qwen all
// dispatch through the same Python entry point — the runner script branches
// on `--pipeline-class` and `--text-encoder-repo` rather than having a
// dedicated script per family. Keep this list aligned with the dispatch in
// `server/services/imageGen/local.js`.
export const usesDiffusersRunner = (model) =>
  isZImage(model) || isErnie(model) || isHiDream(model) || isQwen(model);

// FLUX.2 Klein ships in two sizes with DIFFERENT transformer hidden dims —
// 4B = 3072, 9B = 4096 — so a LoRA trained for one physically can't load on
// the other (diffusers throws a tensor shape-mismatch, which the runner
// swallows into a silent base render). `runner === 'flux2'` alone can't tell
// them apart, so we refine it. The size is already encoded in the model id
// (`flux2-klein-4b`, `flux2-klein-9b-bf16`) and repo (`FLUX.2-klein-9B`), so
// no data migration is needed. Returns '4b' | '9b' | null.
export const flux2VariantFromModel = (model) => {
  for (const s of [model?.id, model?.repo]) {
    if (typeof s !== 'string') continue;
    const m = s.match(/(?:^|[-_/])(?:klein-?)?([49])b(?:[-_./]|$)/i);
    if (m) return `${m[1]}b`;
  }
  return null;
};

// The gated bf16 base repo per FLUX.2 Klein size variant. This is BOTH what a
// trained LoRA is trained against AND the only runtime that can load a LoRA at
// render time: PEFT can't inject adapters into SDNQ/int8-quantized Linear
// layers, so a LoRA on a quantized klein pipeline silently no-ops into a base
// render (see scripts/lora_utils.apply_loras). The image runner routes LoRA
// renders off the quantized repo onto this. Single source of truth — LoRA
// training (FLUX2_TRAIN_REPOS) re-exports it so the two can't drift.
export const FLUX2_BF16_BASE_REPOS = Object.freeze({
  '4b': 'black-forest-labs/FLUX.2-klein-4B',
  '9b': 'black-forest-labs/FLUX.2-klein-9B',
});

// The bf16 base repo to render a LoRA against for a given (quantized or not)
// FLUX.2 model — resolved from its size variant. null when the size is unknown.
export const flux2Bf16BaseRepo = (model) => FLUX2_BF16_BASE_REPOS[flux2VariantFromModel(model)] || null;

// Encode a (runner family, size variant) pair into the single compat-key
// string the LoRA picker matches on: FLUX.2 with a known size → `flux2-4b` /
// `flux2-9b`; any family without a variant → the bare family. This is the ONE
// place the `<family>-<variant>` convention is written, so the model-side key
// (loraCompatKey below) and the LoRA-side key (server/services/loras.js) can't
// drift. `LoraPicker.familyOf` is the decode side.
export const composeCompatKey = (family, variant) =>
  family === RUNNER_FAMILIES.FLUX2 && variant ? `${family}-${variant}` : family;

// Fine-grained LoRA compatibility key for a model. For FLUX.2 it refines the
// runner family into a size-specific key (or bare `flux2` when the size can't
// be determined); for every other family it's just the runner id.
export const loraCompatKey = (model) =>
  composeCompatKey(
    model?.runner || RUNNER_FAMILIES.MFLUX,
    isFlux2(model) ? flux2VariantFromModel(model) : null,
  );
