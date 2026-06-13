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
});

// Predicate: is this LoRA family a video family (vs. an image RUNNER_FAMILIES
// one)? Backs the Image/Video filter on /media/loras. Anything not in
// VIDEO_LORA_FAMILIES (including null/legacy) is treated as image. Mirror of
// server/lib/runners.js.
const VIDEO_LORA_FAMILY_SET = new Set(Object.values(VIDEO_LORA_FAMILIES));
export const isVideoLoraFamily = (family) => VIDEO_LORA_FAMILY_SET.has(family);

// Map a video model (carries `runtime`, not `runner`) to its LoRA family. Only
// the dgrauet `ltx2` runtime fuses arbitrary user LoRAs today; everything else
// returns null so the VideoGen picker hides itself. Mirror of
// server/lib/runners.js#videoLoraFamily.
export const videoLoraFamily = (model) =>
  model?.runtime === 'ltx2' ? VIDEO_LORA_FAMILIES.LTX_VIDEO : null;

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
