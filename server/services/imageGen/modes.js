/**
 * Image Gen — mode enum.
 *
 * Standalone so the dispatcher (`index.js`) and the provider modules
 * (`codex.js`, `local.js`, `external.js`) can both import without forming a
 * cycle (index.js already imports from each provider).
 *
 * `IMAGE_GEN_MODE.X` is the preferred form at branching/tagging sites.
 * `IMAGE_GEN_MODES` is the alphabet for Zod / OpenAI tool-spec enums.
 * Single source of truth: derive the array from `Object.values(...)`.
 *
 * The backend alphabets live in `lib/generationModes.js` and the per-backend
 * capability literals in `lib/imageGenCapabilities.js`, both below validation
 * and this service module. They are re-exported here so existing generation
 * callers keep the same service-local import path.
 */

import { ServerError } from '../../lib/errorHandler.js';
import {
  CLOUD_IMAGE_GEN_MODES, GENERATION_MODE_LABELS, IMAGE_GEN_MODE, IMAGE_GEN_MODES, QUEUEABLE_IMAGE_MODES,
} from '../../lib/generationModes.js';
import {
  AGY_ASPECT_RATIOS,
  AGY_IMAGEGEN_DEFAULT_MODEL,
  AGY_IMAGEGEN_IMAGE_MODEL,
  CODEX_IMAGEGEN_DEFAULT_EFFORT,
  CODEX_IMAGEGEN_DEFAULT_MODEL,
  EDIT_INCAPABLE_IMAGE_MODES,
  LOCAL_IMAGEGEN_DEFAULT_MODEL,
  isEditCapableMode,
} from '../../lib/imageGenCapabilities.js';

export {
  CLOUD_IMAGE_GEN_MODES, IMAGE_GEN_MODE, IMAGE_GEN_MODES, QUEUEABLE_IMAGE_MODES,
};

// The per-backend capability literals live in `lib/imageGenCapabilities.js`,
// a dependency-free leaf the browser bundle can import — this module cannot be,
// because `editIncapableModeError` below needs `ServerError` and through it
// Node's `events`. Re-exported here so every existing service-local import site
// keeps its path.
export {
  AGY_ASPECT_RATIOS,
  AGY_IMAGEGEN_DEFAULT_MODEL,
  AGY_IMAGEGEN_IMAGE_MODEL,
  CODEX_IMAGEGEN_DEFAULT_EFFORT,
  CODEX_IMAGEGEN_DEFAULT_MODEL,
  EDIT_INCAPABLE_IMAGE_MODES,
  // The local runner's fallback model id. Re-exported so provenance writers
  // (sprite candidate sidecars, #2896) keep their service-local import path.
  LOCAL_IMAGEGEN_DEFAULT_MODEL,
  isEditCapableMode,
};

// The provider-side image tool each cloud CLI is directed to call. Single source for the
// prompt builders, the fabrication guard and the usage card. Grok has two, picked by
// whether the render has any input image.
export const IMAGE_TOOL_NAMES = Object.freeze({
  [IMAGE_GEN_MODE.AGY]: 'generate_image',
  [IMAGE_GEN_MODE.GROK]: 'image_gen',
  [IMAGE_GEN_MODE.CODEX]: 'image_gen',
});

/**
 * Grok's tool depends on the direction: anything with an input image goes to
 * `image_edit`. Grok's `image_gen` schema has NO image parameter at all (probed
 * 2026-08-09), so a reference-only render must route to `image_edit` too — its
 * `image` parameter is an array of references, not a single source.
 */
export const grokImageTool = (hasInputImage) => (hasInputImage ? 'image_edit' : IMAGE_TOOL_NAMES[IMAGE_GEN_MODE.GROK]);

/**
 * The clause every cloud-CLI prompt uses to say what a reference image is FOR.
 * Shared (like describeFidelity) so the three prompt builders describe
 * reference conditioning identically and agree on singular/plural.
 */
export const visualReferenceRole = (count) => (count === 1
  ? 'a visual reference for style, characters, and subject matter'
  : 'visual references for style, characters, and subject matter');

/**
 * Cloud image backends the user has enabled in Settings → Image Gen, hoisted so callers
 * outside the dispatcher don't re-encode how a backend is enabled.
 */
export const enabledCloudImageModes = (settings) =>
  CLOUD_IMAGE_GEN_MODES.filter((mode) => settings?.imageGen?.[mode]?.enabled === true);

/**
 * Sentence-case backend name for user-facing messages ('Codex', 'Agy', …); falls back to
 * 'This' for an absent mode, which reads correctly in `editIncapableModeError`.
 */
export const modeLabel = (mode) => GENERATION_MODE_LABELS[mode] || mode || 'This';

/**
 * The one 400 for "this backend was handed an input image and cannot take one" (#3331),
 * beside the predicate that decides it. Callers gate on `isEditCapableMode`.
 */
export const editIncapableModeError = (mode) => new ServerError(
  `${modeLabel(mode)} image generation supports text-to-image only`,
  { status: 400, code: 'IMAGE_EDIT_UNSUPPORTED_MODE' },
);

// Cloud-CLI providers expose no numeric i2i denoise knob, so map the local-runner-style
// strength (0..1, lower = more faithful) onto a phrase the model honors. Lives here so
// codex.js and grok.js share it without a provider→provider import.
export const describeFidelity = (strength) => {
  const n = Number.isFinite(strength) ? Math.max(0, Math.min(1, Number(strength))) : 0.25;
  if (n <= 0.2) return 'preserve composition, characters, and layout exactly — only refine detail and resolution';
  if (n <= 0.4) return 'preserve composition and characters while adding rendered detail at higher fidelity';
  if (n <= 0.7) return 'use the attached image as a strong reference while refining art and detail';
  return 'use the attached image as a loose reference; you may reinterpret freely';
};

// The prose a hosted edit model (fal.ai, Higgsfield, Google) gets about the images
// attached in order, or '' when none.
export function attachedImageRoles({ hasInitImage, initImageStrength, referenceCount }) {
  if (hasInitImage) {
    return [`The first attached image is the source image to edit — ${describeFidelity(initImageStrength)}.`,
      ...(referenceCount ? [`The remaining attached ${referenceCount === 1 ? 'image is' : 'images are'} ${visualReferenceRole(referenceCount)}.`] : [])].join('\n\n');
  }
  return referenceCount ? `Use the attached ${referenceCount === 1 ? 'image' : 'images'} as ${visualReferenceRole(referenceCount)}.` : '';
}

/**
 * Map a pixel width/height onto the closest ratio in `ratios` ('W:H' strings). Null when a
 * dimension is missing or non-positive, so the caller omits its ratio directive rather than
 * assert one the user never chose. Shared by grok's `deriveAspectRatio` and agy's prompt builder.
 */
export function nearestAspectRatio(width, height, ratios) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const target = w / h;
  let best = null;
  let bestDelta = Infinity;
  for (const ratio of ratios) {
    const [rw, rh] = ratio.split(':').map(Number);
    const delta = Math.abs((rw / rh) - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = ratio;
    }
  }
  return best;
}

/** `nearestAspectRatio` bound to agy's alphabet. */
export const nearestAgyAspectRatio = (width, height) => nearestAspectRatio(width, height, AGY_ASPECT_RATIOS);

/**
 * Resolve the queue-capable image mode for a render request: the per-request override
 * (only when that backend is enabled), else the saved dispatcher default, else the first
 * enabled cloud backend in CLOUD_IMAGE_GEN_MODES order → local. External never queues.
 * No separate edit-mode ladder: every queueable backend accepts input images.
 */
export function resolveQueueImageMode(requested, settings) {
  const cloudEnabled = (mode) => CLOUD_IMAGE_GEN_MODES.includes(mode) && settings?.imageGen?.[mode]?.enabled === true;
  if (cloudEnabled(requested)) return requested;
  if (requested === IMAGE_GEN_MODE.LOCAL) return IMAGE_GEN_MODE.LOCAL;
  const settingsMode = settings?.imageGen?.mode;
  if (cloudEnabled(settingsMode)) return settingsMode;
  if (settingsMode === IMAGE_GEN_MODE.LOCAL) return IMAGE_GEN_MODE.LOCAL;
  return CLOUD_IMAGE_GEN_MODES.find(cloudEnabled) || IMAGE_GEN_MODE.LOCAL;
}
