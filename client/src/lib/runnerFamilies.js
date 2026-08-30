// Mirror of server/lib/runners.js — keep byte-for-byte in sync.
// Vite's fs.allow doesn't cross the server/ boundary, so the client carries
// its own copy of the canonical runner-family ids. The shape-invariant test
// in server/lib/runners.test.js is the contract.

export const RUNNER_FAMILIES = Object.freeze({
  MFLUX: 'mflux',
  FLUX2: 'flux2',
  Z_IMAGE: 'z-image',
  ERNIE: 'ernie',
  HIDREAM: 'hidream',
  QWEN: 'qwen',
});

// Video-LoRA families — kept separate from the image RUNNER_FAMILIES so the
// Civitai iteration (which only knows image baseModels) never sees them. Video
// LoRAs are imported from HuggingFace. Mirror of server/lib/runners.js.
export const VIDEO_LORA_FAMILIES = Object.freeze({
  LTX_VIDEO: 'ltx-video',
  MINIMAX_H3: 'minimax-h3',
});

// Predicate: is this LoRA family a video family (vs. an image RUNNER_FAMILIES
// one)? Backs the Image/Video filter on /models/loras. Anything not in
// VIDEO_LORA_FAMILIES (including null/legacy) is treated as image. Mirror of
// server/lib/runners.js.
const VIDEO_LORA_FAMILY_SET = new Set(Object.values(VIDEO_LORA_FAMILIES));
export const isVideoLoraFamily = (family) => VIDEO_LORA_FAMILY_SET.has(family);
// The MiniMax H3 runtimes: PipeNetwork's Apple-Silicon MLX port (`minimax_h3`)
// and the diffusers + CUDA path Windows/Linux NVIDIA boxes run
// (`minimax_h3_cuda`). They load the same weights family, so every control H3
// fixes in the model itself — 24 fps, joint video+audio, CFG-distilled (no
// negative prompt), the 17n+5 frame grid, no tiling knob — is true of both.
// Gates asserting one of those facts ask this predicate instead of naming a
// single runtime, which is what would silently exempt the other one.
// Mirror of server/lib/runners.js.
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
// Mirror of server/lib/runners.js.
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
// deep-link handoff. Mirror of server/lib/runners.js#loraFamilyOf.
export const loraFamilyOf = (lora) => lora?.loraCompatKey || lora?.runnerFamily || null;

// A LoRA-quantization marker (`q4` / `q8`) in a model's id/repo/name. Leading
// boundary + trailing non-digit lookahead catches delimited (`-q4`, `q8_0`) and
// suffixed (`q4bit`) forms while not matching `q40`. Mirror of server/lib/runners.js.
const QUANTIZED_LTX_RE = /(?:^|[-_/\s])q(?:4|8)(?![0-9])/i;

// True when an mlx_video-runtime model is a non-quantized LTX-2.x model whose
// LoRAs PortOS can fuse offline (scripts/generate_av_lora.py merges the deltas
// into the transformer before generation). Excludes quantized q4/q8 variants
// (bf16-only scope) and the Windows LTX-Video 0.9.5 model. Mirror of
// server/lib/runners.js#isMlxVideoLtxLoraCapable.
export const isMlxVideoLtxLoraCapable = (model) => {
  if (model?.runtime !== 'mlx_video') return false;
  const hay = `${model?.id || ''} ${model?.repo || ''} ${model?.name || ''}`;
  if (!/ltx-?2/i.test(hay)) return false;
  if (QUANTIZED_LTX_RE.test(hay)) return false;
  return true;
};

// Map a video model (carries `runtime`, not `runner`) to its LoRA family. Both
// the dgrauet `ltx2` runtime and non-quantized LTX-2.x `mlx_video` models fuse
// user LoRAs. `minimax_h3` can take them only when the *installed* runner can
// apply them to the quantized DiT at runtime — a property of the pinned
// checkout that the client can't derive, so the server decorates each model
// with `runtimeLoraCapable` and this reads it off the payload. Everything else
// returns null so the VideoGen picker hides itself.
// Mirror of server/lib/runners.js#videoLoraFamily.
export const videoLoraFamily = (model) => {
  if (isLtx2FamilyRuntime(model?.runtime) || isMlxVideoLtxLoraCapable(model)) return VIDEO_LORA_FAMILIES.LTX_VIDEO;
  if (model?.runtime === 'minimax_h3' && model?.runtimeLoraCapable === true) return VIDEO_LORA_FAMILIES.MINIMAX_H3;
  return null;
};

// FLUX.2 Klein ships in two sizes with different transformer hidden dims (4B =
// 3072, 9B = 4096), so a LoRA trained for one can't load on the other. The
// size is encoded in the model id/repo. Returns '4b' | '9b' | null. Mirror of
// the same helper in server/lib/runners.js.
export const flux2VariantFromModel = (model) => {
  for (const s of [model?.id, model?.repo]) {
    if (typeof s !== 'string') continue;
    const m = s.match(/(?:^|[-_/])(?:klein-?)?([49])b(?:[-_./]|$)/i);
    if (m) return `${m[1]}b`;
  }
  return null;
};

// Encode a (runner family, size variant) pair into the compat-key string the
// LoRA picker matches on. The ONE place the `<family>-<variant>` convention is
// written client-side (LoraPicker.familyOf decodes it). Mirror of
// server/lib/runners.js.
export const composeCompatKey = (family, variant) =>
  family === RUNNER_FAMILIES.FLUX2 && variant ? `${family}-${variant}` : family;

// Fine-grained LoRA compatibility key for a model. FLUX.2 → `flux2-4b` /
// `flux2-9b` (or bare `flux2` when size is unknown); every other family → its
// runner id.
export const loraCompatKey = (model) =>
  composeCompatKey(
    model?.runner || RUNNER_FAMILIES.MFLUX,
    model?.runner === RUNNER_FAMILIES.FLUX2 ? flux2VariantFromModel(model) : null,
  );
