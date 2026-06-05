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
