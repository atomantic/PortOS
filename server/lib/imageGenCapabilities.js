/**
 * Dependency-free per-backend image-gen capability literals: `EDIT_INCAPABLE_IMAGE_MODES`,
 * `isEditCapableMode`, and the derived `I2I_CAPABLE_MODES`.
 */

import { getRunwayImageModel } from './runwayImageModels.js';
// Shared by server and browser: import only dependency-free catalogs (a service module pulls
// `lib/errorHandler.js` and Node's `events`, which the client cannot load).

import { CLOUD_IMAGE_GEN_MODES, IMAGE_GEN_MODE, IMAGE_GEN_MODES } from './generationModes.js';
import { FAL_IMAGE_MIN_INPUT_IMAGES, falImageFamily } from './falImageModels.js';
import { HIGGSFIELD_IMAGE_MAX_INPUT_IMAGES, higgsfieldImageFamily } from './higgsfieldImageModels.js';
import { GOOGLE_IMAGE_MAX_INPUT_IMAGES, googleImageFamily } from './googleImageModels.js';

// Defined in the dependency-free leaf so schema-only callers skip this module.
export { IMAGE_REFERENCE_REQUEST_LIMIT } from './referenceLimits.js';

export const REGEN_STRENGTH_MIN = 0.02;
export const REGEN_STRENGTH_MAX = 0.6;

// Backends that cannot take an input image at all (#3243); the SINGLE source for the fact.
export const EDIT_INCAPABLE_IMAGE_MODES = Object.freeze([IMAGE_GEN_MODE.EXTERNAL]);

/** Can `mode` accept an input image (i2i / edit / reference)? */
export const isEditCapableMode = (mode) => !EDIT_INCAPABLE_IMAGE_MODES.includes(mode);

// Complement of the list above, in `IMAGE_GEN_MODES` order (best backend first), as walked by `pickI2iMode`.
export const I2I_CAPABLE_MODES = Object.freeze(IMAGE_GEN_MODES.filter(isEditCapableMode));

// Shipped Codex imagegen defaults (image_gen otherwise runs the session's often-heaviest model); a
// code-level default so it reaches every install and peer; explicit settings still win.
export const CODEX_IMAGEGEN_DEFAULT_MODEL = 'gpt-6-luna';
export const CODEX_IMAGEGEN_DEFAULT_EFFORT = 'low';

// The Agy mirror of the Codex pin (#3231): the cheapest flash tier that reliably issues the
// generate_image tool call. Agy bakes effort into the model id, so there is no effort pin; an
// explicit `imageGen.agy.model` still wins. If this tier proves flaky, escalate one rung
// (gemini-3.8-flash-medium) and record why here.
//
// BOTH pins guard against vendors retiring model ids (migration 335 dropped gemini-3.5 from the
// Antigravity catalog while this still named it, so every unpinned agy render failed on `--effort`):
//  - `imageGenCapabilities.test.js` pins both to ids `data.reference/providers.json` still seeds;
//  - agy self-heals at render time (`imageGen/agy.js#resolveAgyDriverModel`) for the PortOS-chosen pin
//    only; Codex checks its local model cache likewise, for the shipped default only.
export const AGY_IMAGEGEN_DEFAULT_MODEL = 'gemini-3.8-flash-low';

// Local runner's fallback model id when neither the request nor settings.imageGen.local.modelId
// names one; here (not services/imageGen/modes.js) because the Settings Local tab labels its
// "install default" option with it.
export const LOCAL_IMAGEGEN_DEFAULT_MODEL = 'qwen-image-2.1';

// The image model behind agy's generate_image is fixed server-side and NOT selectable (re-probed
// 2026-07-30, agy 1.1.8): the tool schema has no model parameter, `agy --model` selects the AGENT
// model, and a prompt directive naming one gets concatenated into the image `Prompt`. agy
// CONFIDENTLY names whichever model you asked for; probe the pixels, not its word.
export const AGY_IMAGEGEN_IMAGE_MODEL = 'imagen-3.0-generate-002';

// Aspect ratios agy's generate_image accepts via `AspectRatio`, verbatim from the tool schema. A real
// knob: a run naming no ratio renders at the tool's '1:1' default regardless of requested pixels.
export const AGY_ASPECT_RATIOS = Object.freeze(['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9']);

// Aspect ratios grok's image_gen/image_edit tools accept; PortOS width/height map to the closest, and
// `imageGen.grok.aspectRatio` applies when the caller sent no dimensions.
export const GROK_ASPECT_RATIOS = Object.freeze(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']);

/**
 * Pure per-provider capability flags, keyed by `IMAGE_GEN_MODE`; spread into `CLOUD_PROVIDER_SPECS`
 * (services/imageGen/cloudProviderConfig.js).
 *
 *  - `supportsModelOverride` — a per-render `cloudModel` may replace the saved default (Grok: `false`,
 *      fixed xAI backend).
 *  - `maxInputImages` — input images (init + reference) the tool accepts, or `null` when its schema
 *      declares no maximum. Probed from live tool schemas 2026-08-09; re-probe, never raise on a
 *      provider's word. Applied in `resolveInputImages`, predicted client-side by `referenceSlotsFor`.
 *  - `promptRequiredWithInputImage` — a text prompt is still required with an input image.
 */
export const IMAGE_GEN_PROVIDER_CAPABILITIES = Object.freeze({
  [IMAGE_GEN_MODE.CODEX]: Object.freeze({
    supportsModelOverride: true,
    // `image_gen.referenced_image_paths` declares no maximum, but the tool
    // refuses more than five attached images per request (#14381).
    maxInputImages: 5,
    promptRequiredWithInputImage: false,
  }),
  [IMAGE_GEN_MODE.GROK]: Object.freeze({
    // Grok's image tools run on xAI's fixed image backend — no model knob.
    supportsModelOverride: false,
    // `image_edit.image` is a string[] with no declared maximum.
    maxInputImages: null,
    promptRequiredWithInputImage: false,
  }),
  [IMAGE_GEN_MODE.AGY]: Object.freeze({
    supportsModelOverride: true,
    // `generate_image.ImagePaths`: "you cannot pass in more than 3 images".
    maxInputImages: 3,
    // …and `Prompt` is in that tool's `required` list.
    promptRequiredWithInputImage: true,
  }),
  [IMAGE_GEN_MODE.RUNWAY]: Object.freeze({
    supportsModelOverride: true, maxInputImages: 3, maxReferences: 3,
    multiCharacterPreservation: true, promptRequiredWithInputImage: true,
  }),
  [IMAGE_GEN_MODE.FAL]: Object.freeze({
    // The model IS the product (each family differs in price and look); overrides are validated against the catalog.
    supportsModelOverride: true,
    // Cap is per MODEL (14 / 10 / 9), read via `maxInputImages(mode, modelId)`; this is the smallest.
    maxInputImages: FAL_IMAGE_MIN_INPUT_IMAGES,
    // Every catalog edit endpoint requires `prompt`.
    promptRequiredWithInputImage: true,
  }),
  [IMAGE_GEN_MODE.HIGGSFIELD]: Object.freeze({
    supportsModelOverride: true,
    // Per model (0 for text-only families); read via `maxInputImages(mode, modelId)`.
    maxInputImages: HIGGSFIELD_IMAGE_MAX_INPUT_IMAGES,
    promptRequiredWithInputImage: true,
  }),
  [IMAGE_GEN_MODE.GOOGLE]: Object.freeze({
    supportsModelOverride: true,
    // Per model (0 for Imagen); read via `maxInputImages(mode, modelId)`.
    maxInputImages: GOOGLE_IMAGE_MAX_INPUT_IMAGES,
    promptRequiredWithInputImage: true,
  }),
});

// Kept as data so a new backend is one capability entry, not a `mode === CODEX || ...` disjunction per call site.
export const MODEL_OVERRIDE_CAPABLE_MODES = Object.freeze(
  CLOUD_IMAGE_GEN_MODES.filter((mode) => IMAGE_GEN_PROVIDER_CAPABILITIES[mode]?.supportsModelOverride === true),
);

/** Can a per-render `cloudModel` replace `mode`'s saved default model? */
export const supportsCloudModelOverride = (mode) => MODEL_OVERRIDE_CAPABLE_MODES.includes(mode);

/**
 * How many input images (init + reference, combined) `mode`'s image tool accepts; `null` for a
 * non-cloud mode (local is bounded by the form's slot count, external is rejected earlier by
 * `isEditCapableMode`). `modelId` refines the answer for backends whose cap is per model; an
 * unknown or absent model falls back to the mode-level value.
 */
export const maxInputImages = (mode, modelId = null) => {
  if (mode === IMAGE_GEN_MODE.RUNWAY) return getRunwayImageModel(modelId)?.maxReferences ?? 3;
  if (mode === IMAGE_GEN_MODE.FAL) {
    const family = falImageFamily(modelId);
    if (family) return family.maxInputImages;
  }
  if (mode === IMAGE_GEN_MODE.HIGGSFIELD) {
    const family = higgsfieldImageFamily(modelId);
    if (family) return family.maxInputImages;
  }
  if (mode === IMAGE_GEN_MODE.GOOGLE) {
    const family = googleImageFamily(modelId);
    if (family) return family.maxInputImages;
  }
  return IMAGE_GEN_PROVIDER_CAPABILITIES[mode]?.maxInputImages ?? null;
};

/**
 * Does a cloud-CLI render need a text prompt, given whether it carries an input image? Text-to-image
 * always does; with one it depends on `promptRequiredWithInputImage`. Non-cloud modes return `false`.
 * Rejecting up front keeps the failure a 400 instead of an async queued-job death.
 */
export const cloudPromptRequired = (mode, hasInputImage) => {
  const caps = IMAGE_GEN_PROVIDER_CAPABILITIES[mode];
  if (!caps) return false;
  return !hasInputImage || caps.promptRequiredWithInputImage === true;
};
