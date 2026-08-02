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
 * The lone import is the error type — `errorHandler.js` pulls in nothing but
 * node's `events`, so it cannot reintroduce the provider cycle this module was
 * split out to avoid.
 */

import { ServerError } from '../../lib/errorHandler.js';

export const IMAGE_GEN_MODE = Object.freeze({
  EXTERNAL: 'external',
  LOCAL: 'local',
  CODEX: 'codex',
  GROK: 'grok',
  AGY: 'agy',
});

export const IMAGE_GEN_MODES = Object.freeze(Object.values(IMAGE_GEN_MODE));

// Cloud-CLI backends (codex `$imagegen`, grok `image_gen`) — each render
// shells out to an external child that spends remote quota, not local GPU.
// The mediaJobQueue routes these through its parallel cloud lane (they don't
// serialize on the MLX runtime) and async callers treat them like local:
// generateImage returns a job descriptor before the file lands.
export const CLOUD_IMAGE_GEN_MODES = Object.freeze([
  IMAGE_GEN_MODE.CODEX,
  IMAGE_GEN_MODE.GROK,
  IMAGE_GEN_MODE.AGY,
]);

// The provider-side image tool each cloud CLI is directed to call. Single
// source: the prompt builders name it, the fabrication guard names it when it
// rejects a code-drawn stand-in, and the usage card labels its quota row with
// it — six string literals before this existed. Grok is the one backend with
// two, picked by whether the render has a source image.
export const IMAGE_TOOL_NAMES = Object.freeze({
  [IMAGE_GEN_MODE.AGY]: 'generate_image',
  [IMAGE_GEN_MODE.GROK]: 'image_gen',
  [IMAGE_GEN_MODE.CODEX]: 'image_gen',
});

/** Grok's tool depends on the direction: i2i edits go to `image_edit`. */
export const grokImageTool = (initImagePath) => (initImagePath ? 'image_edit' : IMAGE_TOOL_NAMES[IMAGE_GEN_MODE.GROK]);

/**
 * Cloud image backends the user has enabled in Settings → Image Gen. Hoisted
 * here so callers outside the dispatcher (the usage card) don't re-encode how
 * a backend is enabled — `settings.imageGen[mode].enabled` was already spelled
 * out at a dozen sites and drifts the moment enablement grows a nuance.
 */
export const enabledCloudImageModes = (settings) =>
  CLOUD_IMAGE_GEN_MODES.filter((mode) => settings?.imageGen?.[mode]?.enabled === true);

// Modes the mediaJobQueue can run (external SD-API stays synchronous — a
// remote HTTP call with no local single-flight constraint to absorb). Single
// source for the pipeline routes' Zod enums and batch-render guards, so a
// future backend is one edit here instead of a sweep of enum literals.
export const QUEUEABLE_IMAGE_MODES = Object.freeze([IMAGE_GEN_MODE.LOCAL, ...CLOUD_IMAGE_GEN_MODES]);

// Backends that cannot take an input image at all (#3243). Agy's `generate_image`
// tool accepts prompt / image name / aspect ratio / reference paths and exposes
// no edit mode, so `agy.js` throws AGY_IMAGE_EDIT_UNSUPPORTED the moment an
// initImagePath or referenceImagePaths arrives.
//
// This is the SINGLE source for that fact. It was previously encoded implicitly,
// by `resolveQueueImageEditMode` simply never listing AGY — which is invisible to
// any other ladder, and is why the pipeline's `pickUsableMode` ladder could route
// an i2i redraw to Agy and fail asynchronously in the queue. A future
// edit-incapable backend belongs here and nowhere else.
export const EDIT_INCAPABLE_IMAGE_MODES = Object.freeze([IMAGE_GEN_MODE.AGY]);

/** Can `mode` accept an input image (i2i / edit)? */
export const isEditCapableMode = (mode) => !EDIT_INCAPABLE_IMAGE_MODES.includes(mode);

/**
 * The one 400 for "this backend was handed an input image and cannot take one".
 *
 * Four verbatim copies of this throw existed — `agy.js`, the dispatcher,
 * `prepareParams.js` and the imageGen route — before the sprite reference paths
 * needed a fifth (#3331), so it now lives beside the predicate that decides it.
 * Every caller gates on `isEditCapableMode`, so adding a backend to
 * EDIT_INCAPABLE_IMAGE_MODES still stays a one-line change.
 *
 * The `AGY_IMAGE_EDIT_UNSUPPORTED` code keeps the name it shipped under (it is
 * the only edit-incapable backend today) so existing clients and docs still
 * match; the message names whichever backend was actually asked for.
 */
export const editIncapableModeError = (mode) => new ServerError(
  `${mode ? mode[0].toUpperCase() + mode.slice(1) : 'This'} Imagegen supports text-to-image only`,
  { status: 400, code: 'AGY_IMAGE_EDIT_UNSUPPORTED' },
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

// Shipped defaults for the Codex imagegen backend. Codex's built-in image_gen
// tool otherwise runs whatever model its logged-in session defaults to — often
// the heaviest, most expensive tier — at default reasoning effort. Pin the cheap
// `gpt-5.6-luna` model at `low` reasoning effort so every media-pipeline render
// pays the light path by default. Applied as a code-level default (not a
// settings migration) so it reaches every install and federated peer with no
// per-install bookkeeping; an explicit `imageGen.codex.model` / `.effort` in
// Settings still wins. Effort is one of providerModels' CODEX_EFFORT_LEVELS.
export const CODEX_IMAGEGEN_DEFAULT_MODEL = 'gpt-5.6-luna';
export const CODEX_IMAGEGEN_DEFAULT_EFFORT = 'low';

// The Agy mirror of the Codex pin above (#3231). An unpinned agy render used to
// resolve to the ANTIGRAVITY_CONFIGURED_DEFAULT sentinel, which resolveCliModel
// maps to null — no `--model` flag at all — so agy ran the session on whatever
// its own config selected, potentially a reasoning-heavy tier
// (claude-opus-4-6-thinking) just to relay one generate_image tool call. The
// driving agent does no creative work on the image, so the cheapest flash tier
// that reliably issues the tool call is the correct shipped default
// (empirically verified to complete a render). Agy bakes the effort ladder into
// the model id (-low/-medium/-high), so there is no separate effort pin. Same
// code-level-default rationale as Codex: reaches every install and peer with no
// migration; an explicit `imageGen.agy.model` in Settings still wins. If this
// tier ever proves flaky at issuing generate_image, escalate exactly one rung
// (gemini-3.5-flash-medium) and record why here.
export const AGY_IMAGEGEN_DEFAULT_MODEL = 'gemini-3.5-flash-low';

// The image model behind agy's generate_image tool — fixed server-side by
// Antigravity and NOT selectable by PortOS. Re-probed 2026-07-30 against agy
// 1.1.8 and still closed; the decisive evidence is now the tool's own schema,
// dumped from a live session:
//
//   { Prompt, ImageName, AspectRatio, ImagePaths, toolAction, toolSummary }
//
// There is no model parameter, so the driving agent has nothing to route a
// model choice through. `agy --model imagen-3-fast` selects the AGENT/session
// model and rejects image-model ids ("invalid model selection"). A prompt
// directive naming a model is worse than a no-op: three runs directing
// imagen-3-fast / gemini-3.5-flash / gemini-2.0-flash all produced identical
// 1376×768 output from the same backend, and the directive text got
// concatenated into the tool's `Prompt` ("…spider web (macro lens) using the
// imagen-3-fast model"), polluting the image prompt itself.
//
// Beware: agy CONFIDENTLY names whichever model you asked for when questioned
// afterward — it reported "gemini-2.0-flash" for a render that came out at
// Imagen's 16:9 geometry. Do not re-probe on its word; probe the pixels.
// Exported so sidecars can record the image model that actually rendered
// (distinct from the agent/session model above) without a second copy.
export const AGY_IMAGEGEN_IMAGE_MODEL = 'imagen-3.0-generate-002';

// Aspect ratios agy's generate_image tool accepts via its `AspectRatio`
// parameter — verbatim from the tool schema above. This IS a real knob: a run
// that names no ratio renders at the tool's documented '1:1' default (measured
// 1024×1024) no matter what pixel dimensions the prompt asks for, so a PortOS
// render requesting a wide comic page silently came back square before the
// directive below started naming a ratio.
export const AGY_ASPECT_RATIOS = Object.freeze(['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9']);

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
 * saved dispatcher default, else codex → grok → local. External never queues.
 * Hoisted from the pipeline visual stages (#2896) so sprite renders and any
 * future queued surface share one enable-gating ladder — see issue #2881 for
 * the wider param-assembly consolidation.
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

export function resolveQueueImageEditMode(requested, settings) {
  const codexEnabled = settings?.imageGen?.codex?.enabled === true;
  const grokEnabled = settings?.imageGen?.grok?.enabled === true;
  if (requested === IMAGE_GEN_MODE.CODEX && codexEnabled) return IMAGE_GEN_MODE.CODEX;
  if (requested === IMAGE_GEN_MODE.GROK && grokEnabled) return IMAGE_GEN_MODE.GROK;
  if (requested === IMAGE_GEN_MODE.LOCAL) return IMAGE_GEN_MODE.LOCAL;
  const saved = settings?.imageGen?.mode;
  if (saved === IMAGE_GEN_MODE.CODEX && codexEnabled) return IMAGE_GEN_MODE.CODEX;
  if (saved === IMAGE_GEN_MODE.GROK && grokEnabled) return IMAGE_GEN_MODE.GROK;
  if (saved === IMAGE_GEN_MODE.LOCAL) return IMAGE_GEN_MODE.LOCAL;
  if (codexEnabled) return IMAGE_GEN_MODE.CODEX;
  if (grokEnabled) return IMAGE_GEN_MODE.GROK;
  return IMAGE_GEN_MODE.LOCAL;
}
