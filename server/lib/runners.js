/**
 * Image-runner family constants (`RUNNER_FAMILIES`, `loraCompatKey`), video LoRA families and MiniMax H3 runtime predicates.
 *
 * Image-runner family constants: single source of truth for the runner ids (`'mflux' | 'flux2' | 'z-image' | 'ernie'`) backing an image-gen model entry (`RUNNER_FAMILIES`, `loraCompatKey`), plus video LoRA families,
 * MiniMax H3 runtime predicates, and the shared `AUDIO_TO_VIDEO_RUNTIMES` / `isAudioToVideoRuntime` gate (LTX plus H3 Ref2VA). Bare-string ids once sprawled across civitai.js, mediaModels.js, ImageGen.jsx and Loras.jsx,
 * where a typo (`'zimage'` vs `'z-image'`) silently broke the LoRA picker's compat filter. `client/src/lib/runnerFamilies.js` re-exports this module directly (no client copy to drift).
 */

export const RUNNER_FAMILIES = Object.freeze({
  MFLUX: 'mflux',
  FLUX2: 'flux2',
  Z_IMAGE: 'z-image',
  ERNIE: 'ernie',
  HIDREAM: 'hidream',
  QWEN: 'qwen',
});

// Video-LoRA families are SEPARATE from the image RUNNER_FAMILIES: Civitai suggestion/search iterates Object.values(RUNNER_FAMILIES) and would 400 on a family with no baseModel mapping, and video LoRAs
// (e.g. fal/ltx2.3-audio-reactive-lora) come from HuggingFace (installFromHuggingface). The compat-key machinery is family-string-agnostic, so `runnerFamily: 'ltx-video'` filters correctly.
export const VIDEO_LORA_FAMILIES = Object.freeze({
  LTX_VIDEO: 'ltx-video',
  MINIMAX_H3: 'minimax-h3',
});

// Is this LoRA family a video family (vs an image RUNNER_FAMILIES one)? Backs the Image/Video filter on /models/loras; anything not in VIDEO_LORA_FAMILIES (incl. null/legacy) is image. Mirrors client/src/lib/runnerFamilies.js.
const VIDEO_LORA_FAMILY_SET = new Set(Object.values(VIDEO_LORA_FAMILIES));
export const isVideoLoraFamily = (family) => VIDEO_LORA_FAMILY_SET.has(family);
// The MiniMax H3 runtimes: PipeNetwork's Apple-Silicon MLX port (`minimax_h3`) and the diffusers + CUDA path (`minimax_h3_cuda`) load the same weights, so every H3-fixed control (24 fps, joint video+audio,
// CFG-distilled so no negative prompt, 17n+5 frame grid, no tiling knob) holds for both. Gates ask this predicate rather than naming one runtime, which would exempt the other. Mirrored to client/src/lib/runnerFamilies.js.
export const MINIMAX_H3_REF2VA_RUNTIME = 'minimax_h3_ref2va';
export const MINIMAX_H3_RUNTIMES = Object.freeze([
  'minimax_h3',
  'minimax_h3_cuda',
  MINIMAX_H3_REF2VA_RUNTIME,
]);
const MINIMAX_H3_RUNTIME_SET = new Set(MINIMAX_H3_RUNTIMES);
export const isMiniMaxH3Runtime = (runtime) => MINIMAX_H3_RUNTIME_SET.has(runtime);
// dgrauet's LTX-2.3 pin (`ltx2`) and the LTX-2.5 fork (`ltx25`) share one pipeline surface (true FFLF, video-conditioned extend, a2v, IC-LoRA), so capability gates ask this predicate. The venvs stay separate (2.5 can't load on the 2.3 pin).
export const LTX2_FAMILY_RUNTIMES = Object.freeze(['ltx2', 'ltx25']);
const LTX2_FAMILY_RUNTIME_SET = new Set(LTX2_FAMILY_RUNTIMES);
export const isLtx2FamilyRuntime = (runtime) => LTX2_FAMILY_RUNTIME_SET.has(runtime);
// Runtimes whose first+last-frame (FFLF) render really anchors the LAST frame: the LTX-2 family (keyframe-interpolation pipeline) and both H3 runtimes (both frames as conditioning rows); others drop one. Re-exported by services/videoGen/runtimes.js.
export const LAST_FRAME_ANCHORED_RUNTIMES = Object.freeze(new Set([...LTX2_FAMILY_RUNTIMES, ...MINIMAX_H3_RUNTIMES]));
export const isLastFrameAnchoredRuntime = (runtime) => LAST_FRAME_ANCHORED_RUNTIMES.has(runtime);
export const AUDIO_TO_VIDEO_RUNTIMES = Object.freeze([
  ...LTX2_FAMILY_RUNTIMES,
  MINIMAX_H3_REF2VA_RUNTIME,
]);
const AUDIO_TO_VIDEO_RUNTIME_SET = new Set(AUDIO_TO_VIDEO_RUNTIMES);
export const isAudioToVideoRuntime = (runtime) => AUDIO_TO_VIDEO_RUNTIME_SET.has(runtime);

// The family an INSTALLED LoRA belongs to: `loraCompatKey` is the refined key (e.g. flux2-9b) from the importer; `runnerFamily` is the coarse legacy field a pre-sidecar install may carry alone.
// One helper so the `||` fallback can't drift between pickers, family filters and the deep-link handoff. Mirrored to client/src/lib/runnerFamilies.js.
export const loraFamilyOf = (lora) => lora?.loraCompatKey || lora?.runnerFamily || null;

// A LoRA-quantization marker (`q4` / `q8`) in a model's id/repo/name: leading boundary (not inside `seq4uence`) and trailing non-digit lookahead (matches `-q4`, `q8_0`, `q4bit`, `q8gguf`, not `q40`). Scopes mlx_video LoRA fusion to bf16 models (isMlxVideoLtxLoraCapable).
const QUANTIZED_LTX_RE = /(?:^|[-_/\s])q(?:4|8)(?![0-9])/i;

// True when an mlx_video-runtime model is an LTX-2.x model whose LoRAs PortOS can fuse. notapalindrome's `mlx_video.generate_av` has no `--lora` flag but ships `mlx_video.lora`, so scripts/ml/generate_av_lora.py
// merges deltas into the transformer weights before generation. Scoped to NON-quantized (bf16) models (q4/q8 need a separate dequantize→merge→requantize pass); the CUDA LTX-Video 0.9.5 model
// has no "ltx-2" marker and runs through generate_win.py, so it is excluded.
export const isMlxVideoLtxLoraCapable = (model) => {
  if (model?.runtime !== 'mlx_video') return false;
  const hay = `${model?.id || ''} ${model?.repo || ''} ${model?.name || ''}`;
  if (!/ltx-?2/i.test(hay)) return false;          // must be an LTX-2.x model
  if (QUANTIZED_LTX_RE.test(hay)) return false;    // bf16-only scope (no q4/q8)
  return true;
};

// Map a video-model registry entry (which carries `runtime`, not `runner`) to the LoRA family the picker filters on. Runtimes that can fuse user LoRAs:
//   - `ltx2` / `ltx25`: `ltx_pipelines_mlx` honors a `_pending_loras` hook (scripts/ml/generate_ltx2.py).
//   - `mlx_video` on a non-quantized LTX-2.x model: fused offline into the transformer weights (isMlxVideoLtxLoraCapable + scripts/ml/generate_av_lora.py).
//   - `minimax_h3` / `minimax_h3_cuda`, ONLY when the installed runner plus PortOS's activation-space adapter can apply LoRAs to the quantized DiT at runtime: a property of the installed checkout, so
//     listVideoModels() decorates each model with `runtimeLoraCapable` from services/videoGen/runtimes.js and this reads it (like `lastFrameAnchored`); undecorated reads "not capable" (fails closed).
// wan22 / fastvideo (and quantized mlx_video) have no LoRA path and return null, hiding the VideoGen picker.
export const videoLoraFamily = (model) => {
  if (isLtx2FamilyRuntime(model?.runtime) || isMlxVideoLtxLoraCapable(model)) return VIDEO_LORA_FAMILIES.LTX_VIDEO;
  if (['minimax_h3', 'minimax_h3_cuda'].includes(model?.runtime) && model?.runtimeLoraCapable === true) return VIDEO_LORA_FAMILIES.MINIMAX_H3;
  return null;
};

// Convenience predicates matching the `isFlux2()` / `isZImage()` / `isErnie()` exports in `mediaModels.js` (kept for back-compat); new code can import either.
export const isMflux = (model) => model?.runner === RUNNER_FAMILIES.MFLUX;
export const isFlux2 = (model) => model?.runner === RUNNER_FAMILIES.FLUX2;
export const isZImage = (model) => model?.runner === RUNNER_FAMILIES.Z_IMAGE;
export const isErnie = (model) => model?.runner === RUNNER_FAMILIES.ERNIE;
export const isHiDream = (model) => model?.runner === RUNNER_FAMILIES.HIDREAM;
export const isQwen = (model) => model?.runner === RUNNER_FAMILIES.QWEN;

// Model runs through the generic diffusers runner script (`scripts/ml/z_image_turbo.py`): Z-Image, ERNIE, HiDream and Qwen share one entry point that branches on `--pipeline-class` / `--text-encoder-repo`.
// Keep aligned with the dispatch in `server/services/imageGen/localArgs.js`.
export const usesDiffusersRunner = (model) =>
  isZImage(model) || isErnie(model) || isHiDream(model) || isQwen(model);

// FLUX.2 Klein ships in two sizes with DIFFERENT transformer hidden dims (4B = 3072, 9B = 4096), so a LoRA for one can't load on the other (diffusers throws a shape mismatch the runner swallows into a silent base render).
// `runner === 'flux2'` can't tell them apart, so refine from the size already in the model id (`flux2-klein-4b`) and repo (`FLUX.2-klein-9B`); no migration needed. Returns '4b' | '9b' | null.
export const flux2VariantFromModel = (model) => {
  for (const s of [model?.id, model?.repo]) {
    if (typeof s !== 'string') continue;
    const m = s.match(/(?:^|[-_/])(?:klein-?)?([49])b(?:[-_./]|$)/i);
    if (m) return `${m[1]}b`;
  }
  return null;
};

// The gated bf16 base repo per FLUX.2 Klein size: what a LoRA is trained against AND the only runtime that can load one at render time (PEFT can't inject adapters into SDNQ/int8-quantized Linear layers,
// so a LoRA on a quantized klein silently no-ops, see scripts/lora_utils.apply_loras). The image runner routes LoRA renders onto it. Single source of truth: LoRA training (FLUX2_TRAIN_REPOS) re-exports it.
export const FLUX2_BF16_BASE_REPOS = Object.freeze({
  '4b': 'black-forest-labs/FLUX.2-klein-4B',
  '9b': 'black-forest-labs/FLUX.2-klein-9B',
});

// Immutable Hugging Face commit SHAs for every shipped FLUX.2 repo. A floating `main` would let a compromised or silently re-pushed repo (three are personal community accounts) swap tokenizer/config/quantization maps/weights under every install. Keyed by repo so model entries, the LoRA bf16 reroute and the load-time backfill share one table; bump a SHA only after reviewing the upstream diff.
export const FLUX2_REPO_REVISIONS = Object.freeze({
  'Disty0/FLUX.2-klein-4B-SDNQ-4bit-dynamic': '45e9cc76cb70f84473ce5c6c2e2282d0ef3c6ecd',
  'Disty0/FLUX.2-klein-9B-SDNQ-4bit-dynamic-svd-r32': '94ef5985edc982fa93f87df6e1c0faf94d9e9004',
  'aydin99/FLUX.2-klein-4B-int8': 'f38839c94b597211dea83b1326f1bb4ce4142524',
  'black-forest-labs/FLUX.2-klein-4B': 'e7b7dc27f91deacad38e78976d1f2b499d76a294',
  'black-forest-labs/FLUX.2-klein-9B': '1498bcb8aaebb230bae82c34b02ecc4087beebac',
  'black-forest-labs/FLUX.2-klein-9B-kv': '6c882f3fd7da58b360c43079d32affdc953d8670',
});

// Immutable Hugging Face commit SHAs for every shipped diffusers-runner repo (HiDream, Qwen-Image, Z-Image, ERNIE, plus HiDream's gated Llama text encoder), for the same reason as FLUX2_REPO_REVISIONS: floating `main` lets a re-pushed upstream swap weights/config under every install. Shared by model entries and the load-time backfill; bump a SHA only after reviewing the upstream diff.
export const DIFFUSERS_REPO_REVISIONS = Object.freeze({
  'HiDream-ai/HiDream-I1-Full': '8ccbbfb270ccdae26d6bb0081df67dc81e4033bf',
  'HiDream-ai/HiDream-I1-Fast': '4856a5d8cd6fbd194780ed9f289bdf696d3afc10',
  'meta-llama/Meta-Llama-3.1-8B-Instruct': '0e9e39f249a16976918f6564b8830bc894c89659',
  'Qwen/Qwen-Image': '75e0b4be04f60ec59a75f475837eced720f823b6',
  'Qwen/Qwen-Image-Edit': 'ac7f9318f633fc4b5778c59367c8128225f1e3de',
  'Qwen/Qwen-Image-2.1': 'd26bb61231c349cf6b7896fa83353113880e1ba3',
  'Tongyi-MAI/Z-Image-Turbo': 'f332072aa78be7aecdf3ee76d5c247082da564a6',
  'baidu/ERNIE-Image': '5346b31d68c9c23758ba56ef8be5e9dc174c7f99',
  'baidu/ERNIE-Image-Turbo': 'bc68c81e2a1730a394d5fc9fae70713dee940140',
});

// Pinned commit for a shipped diffusers-runner repo; null for a user fork / unknown repo (those float unless the entry sets its own revision).
export const diffusersRepoRevision = (repo) => DIFFUSERS_REPO_REVISIONS[repo] || null;

// The bf16 base repo to render a LoRA against for a (quantized or not) FLUX.2 model, from its size variant; null when unknown.
export const flux2Bf16BaseRepo = (model) => FLUX2_BF16_BASE_REPOS[flux2VariantFromModel(model)] || null;

// Pinned commit for a shipped FLUX.2 repo; null for a user fork / unknown repo (those float unless the entry sets its own revision).
export const flux2RepoRevision = (repo) => FLUX2_REPO_REVISIONS[repo] || null;

// Encode a (runner family, size variant) pair into the compat-key string the LoRA picker matches on: FLUX.2 with a known size → `flux2-4b` / `flux2-9b`, any family without a variant → the bare family.
// The ONE place the `<family>-<variant>` convention is written, so the model-side key (loraCompatKey) and LoRA-side key (server/services/loras.js) can't drift; `LoraPicker.familyOf` decodes.
export const composeCompatKey = (family, variant) =>
  family === RUNNER_FAMILIES.FLUX2 && variant ? `${family}-${variant}` : family;

// Fine-grained LoRA compatibility key: FLUX.2 refines to a size-specific key (bare `flux2` when unknown); every other family is just the runner id.
export const loraCompatKey = (model) =>
  composeCompatKey(
    model?.runner || RUNNER_FAMILIES.MFLUX,
    isFlux2(model) ? flux2VariantFromModel(model) : null,
  );
