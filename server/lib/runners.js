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
});

// Predicate: is this LoRA family a video family (vs. an image RUNNER_FAMILIES
// one)? Backs the Image/Video filter on /media/loras — both the installed-list
// filter and the suggestion-panel section gating. Anything not in
// VIDEO_LORA_FAMILIES (including null/legacy) is treated as image. Mirror of
// client/src/lib/runnerFamilies.js.
const VIDEO_LORA_FAMILY_SET = new Set(Object.values(VIDEO_LORA_FAMILIES));
export const isVideoLoraFamily = (family) => VIDEO_LORA_FAMILY_SET.has(family);

// Map a video-model registry entry (which carries `runtime`, not `runner`) to
// the LoRA family the picker filters on. Only dgrauet's `ltx2` runtime can
// fuse arbitrary user LoRAs today — its `ltx_pipelines_mlx` pipelines honor a
// `_pending_loras` hook (see scripts/generate_ltx2.py). The legacy mlx_video /
// wan22 / hunyuan runtimes have no general LoRA path, so they return null
// ("no LoRA support") and the VideoGen picker hides itself.
export const videoLoraFamily = (model) =>
  model?.runtime === 'ltx2' ? VIDEO_LORA_FAMILIES.LTX_VIDEO : null;

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
