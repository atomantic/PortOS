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
  CLOUD_IMAGE_GEN_MODES, IMAGE_GEN_MODE, IMAGE_GEN_MODES, QUEUEABLE_IMAGE_MODES,
} from '../../lib/generationModes.js';
import {
  AGY_ASPECT_RATIOS,
  AGY_IMAGEGEN_DEFAULT_MODEL,
  AGY_IMAGEGEN_IMAGE_MODEL,
  CODEX_IMAGEGEN_DEFAULT_EFFORT,
  CODEX_IMAGEGEN_DEFAULT_MODEL,
  EDIT_INCAPABLE_IMAGE_MODES,
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
  isEditCapableMode,
};

// The provider-side image tool each cloud CLI is directed to call. Single
// source: the prompt builders name it, the fabrication guard names it when it
// rejects a code-drawn stand-in, and the usage card labels its quota row with
// it — six string literals before this existed. Grok is the one backend with
// two, picked by whether the render has any input image.
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
 * Cloud image backends the user has enabled in Settings → Image Gen. Hoisted
 * here so callers outside the dispatcher (the usage card) don't re-encode how
 * a backend is enabled — `settings.imageGen[mode].enabled` was already spelled
 * out at a dozen sites and drifts the moment enablement grows a nuance.
 */
export const enabledCloudImageModes = (settings) =>
  CLOUD_IMAGE_GEN_MODES.filter((mode) => settings?.imageGen?.[mode]?.enabled === true);

/**
 * Human-facing backend names — the server half of the client's MODE_LABELS
 * (client/src/lib/imageGenModes.js). A map rather than a capitalization of the
 * mode id, so a backend whose id isn't a single lowercase word ('lm-studio')
 * still gets a real name instead of 'Lm-studio'.
 */
const MODE_LABELS = Object.freeze({
  [IMAGE_GEN_MODE.LOCAL]: 'Local',
  [IMAGE_GEN_MODE.CODEX]: 'Codex',
  [IMAGE_GEN_MODE.GROK]: 'Grok',
  [IMAGE_GEN_MODE.AGY]: 'Agy',
  [IMAGE_GEN_MODE.EXTERNAL]: 'External',
});

/**
 * Sentence-case backend name for user-facing messages ('Codex', 'Agy', …).
 * Shared so error messages don't grow a per-backend ternary ladder each time a
 * backend is added, and so one backend never appears under two names across
 * the UI. Falls back to 'This' for an absent mode, which reads correctly in
 * `editIncapableModeError`'s sentence.
 */
export const modeLabel = (mode) => MODE_LABELS[mode] || mode || 'This';

/**
 * The one 400 for "this backend was handed an input image and cannot take one".
 *
 * Four verbatim copies of this throw existed — `agy.js`, the dispatcher,
 * `prepareParams.js` and the imageGen route — before the sprite reference paths
 * needed a fifth (#3331), so it now lives beside the predicate that decides it.
 * Every caller gates on `isEditCapableMode`, so adding a backend to
 * EDIT_INCAPABLE_IMAGE_MODES still stays a one-line change.
 */
export const editIncapableModeError = (mode) => new ServerError(
  `${modeLabel(mode)} image generation supports text-to-image only`,
  { status: 400, code: 'IMAGE_EDIT_UNSUPPORTED_MODE' },
);

// Cloud-CLI providers expose no numeric i2i denoise knob, so map the
// local-runner-style strength (0..1, lower = more faithful to the source)
// onto a phrase the model reliably honors. Mirrors
// PROOF_AS_BASE_DEFAULT_STRENGTH (0.25) defaulting toward
// composition-preserving edits. Lives here (the shared no-dependency module)
// so codex.js and grok.js both import it without a provider→provider import.
export const describeFidelity = (strength) => {
  const n = Number.isFinite(strength) ? Math.max(0, Math.min(1, Number(strength))) : 0.25;
  if (n <= 0.2) return 'preserve composition, characters, and layout exactly — only refine detail and resolution';
  if (n <= 0.4) return 'preserve composition and characters while adding rendered detail at higher fidelity';
  if (n <= 0.7) return 'use the attached image as a strong reference while refining art and detail';
  return 'use the attached image as a loose reference; you may reinterpret freely';
};

/**
 * Map a pixel width/height onto the closest ratio in `ratios` ('W:H' strings).
 * Returns null when either dimension is missing or non-positive, so the caller
 * omits its ratio directive entirely rather than asserting one the user never
 * chose (each tool then applies its own documented default).
 *
 * Lives here rather than in a provider module because every cloud CLI needs the
 * same mapping against its own alphabet — grok's `deriveAspectRatio` delegates
 * to it, and agy's prompt builder calls it with AGY_ASPECT_RATIOS.
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

// The local runner's fallback model id when neither the request nor
// settings.imageGen.local.modelId names one (local.js's parameter default).
// Exported so provenance writers (sprite candidate sidecars, #2896) can
// record the model that actually ran without hardcoding a second copy.
export const LOCAL_IMAGEGEN_DEFAULT_MODEL = 'dev';

/**
 * Resolve the queue-capable image mode for a render request: the per-request
 * override (honored only when that backend is enabled/available), else the
 * saved dispatcher default, else codex → grok → agy → local. External never
 * queues. Hoisted from the pipeline visual stages (#2896) so sprite renders and
 * any future queued surface share one enable-gating ladder — see issue #2881
 * for the wider param-assembly consolidation.
 *
 * There is no separate edit-mode ladder: every queueable backend accepts input
 * images (see EDIT_INCAPABLE_IMAGE_MODES), so an i2i render resolves through
 * this exact same ladder.
 */
export function resolveQueueImageMode(requested, settings) {
  const codexEnabled = settings?.imageGen?.codex?.enabled === true;
  const grokEnabled = settings?.imageGen?.grok?.enabled === true;
  const agyEnabled = settings?.imageGen?.agy?.enabled === true;
  if (requested === IMAGE_GEN_MODE.CODEX && codexEnabled) return IMAGE_GEN_MODE.CODEX;
  if (requested === IMAGE_GEN_MODE.GROK && grokEnabled) return IMAGE_GEN_MODE.GROK;
  if (requested === IMAGE_GEN_MODE.AGY && agyEnabled) return IMAGE_GEN_MODE.AGY;
  if (requested === IMAGE_GEN_MODE.LOCAL) return IMAGE_GEN_MODE.LOCAL;
  const settingsMode = settings?.imageGen?.mode;
  if (settingsMode === IMAGE_GEN_MODE.CODEX && codexEnabled) return IMAGE_GEN_MODE.CODEX;
  if (settingsMode === IMAGE_GEN_MODE.GROK && grokEnabled) return IMAGE_GEN_MODE.GROK;
  if (settingsMode === IMAGE_GEN_MODE.AGY && agyEnabled) return IMAGE_GEN_MODE.AGY;
  if (settingsMode === IMAGE_GEN_MODE.LOCAL) return IMAGE_GEN_MODE.LOCAL;
  if (codexEnabled) return IMAGE_GEN_MODE.CODEX;
  if (grokEnabled) return IMAGE_GEN_MODE.GROK;
  if (agyEnabled) return IMAGE_GEN_MODE.AGY;
  return IMAGE_GEN_MODE.LOCAL;
}
