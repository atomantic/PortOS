/**
 * Per-backend image-gen capability literals.
 *
 * A dependency-free leaf beside `generationModes.js`, for the same reason that
 * module exists: these are FACTS about each render backend (what its image tool
 * accepts, what PortOS ships as its default model/effort), and both the server
 * services and the browser bundle need them. They used to live in
 * `services/imageGen/{modes,cloudProviderConfig,grok}.js`, which the client
 * cannot import — those modules pull `lib/errorHandler.js`, and through it
 * Node's `events` — so `client/src/lib/imageGenModes.js` hand-copied them and
 * a server-side parity suite bound three of the copies. The shipped defaults
 * and the aspect-ratio alphabets were unbound and could drift silently.
 *
 * Nothing here may import anything but `generationModes.js`: the moment this
 * file reaches a service module, the client copies come back.
 *
 * The three service modules re-export their old bindings, so every existing
 * server import site is untouched — the same compatibility pattern `modes.js`
 * already uses for the backend alphabets.
 */

import { CLOUD_IMAGE_GEN_MODES, IMAGE_GEN_MODE, IMAGE_GEN_MODES } from './generationModes.js';

// Backends that cannot take an input image at all (#3243). Every *queueable*
// backend now can: local (mflux/diffusers `--image-path` + FLUX.2 references),
// codex (`image_gen.referenced_image_paths`), grok (`image_edit.image`) and agy
// (`generate_image.ImagePaths`) all accept an init image and/or reference
// images — see `maxInputImages` below for the probed per-backend limits. Agy
// was listed here until its tool schema was probed directly and turned out to
// document ImagePaths as "images to use in generation… edit, combine, or use as
// references".
//
// The external SD-API backend is the one that genuinely has no input-image
// wiring in this codebase, so it inherits the slot. This is the SINGLE source
// for the fact — a future edit-incapable backend belongs here and nowhere else.
export const EDIT_INCAPABLE_IMAGE_MODES = Object.freeze([IMAGE_GEN_MODE.EXTERNAL]);

/** Can `mode` accept an input image (i2i / edit / reference)? */
export const isEditCapableMode = (mode) => !EDIT_INCAPABLE_IMAGE_MODES.includes(mode);

// The complement of the list above, derived rather than restated — this is what
// the i2i-only pickers (the sprite fork modal, #3331) filter their backend
// options through, and what `pickI2iMode` walks in order. That walk wants the
// best backend first (local's form exposes strength + LoRAs, then the cloud
// CLIs), which is the order `IMAGE_GEN_MODES` already has once external — its
// one edit-incapable member — is filtered out.
export const I2I_CAPABLE_MODES = Object.freeze(IMAGE_GEN_MODES.filter(isEditCapableMode));

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
// (distinct from the agent/session model above) without a second copy, and so
// Settings can surface it read-only next to the agent-model field.
export const AGY_IMAGEGEN_IMAGE_MODEL = 'imagen-3.0-generate-002';

// Aspect ratios agy's generate_image tool accepts via its `AspectRatio`
// parameter — verbatim from the tool schema above. This IS a real knob: a run
// that names no ratio renders at the tool's documented '1:1' default (measured
// 1024×1024) no matter what pixel dimensions the prompt asks for, so a PortOS
// render requesting a wide comic page silently came back square before the
// prompt builders started naming a ratio.
export const AGY_ASPECT_RATIOS = Object.freeze(['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9']);

// Aspect ratios grok's image_gen/image_edit tools accept. Width/height from
// PortOS callers are mapped to the closest of these; a configured default
// (`imageGen.grok.aspectRatio`) applies when the caller sent no dimensions, and
// Settings → Image Gen → Grok offers this list as the default-ratio picker.
export const GROK_ASPECT_RATIOS = Object.freeze(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']);

/**
 * The pure per-provider capability flags, keyed by `IMAGE_GEN_MODE`. Spread
 * into `CLOUD_PROVIDER_SPECS` (services/imageGen/cloudProviderConfig.js), which
 * adds the impure half — labels, error codes, and the settings-reading
 * `modelId`/`params` resolvers.
 *
 *  - `supportsModelOverride` — whether a per-render `cloudModel` may replace the
 *      saved default for one queue item. Grok is `false`: its `image_gen` tool
 *      runs on a fixed xAI backend with no model knob at all, so accepting an
 *      override there would be a lie.
 *  - `maxInputImages` — how many input images (init image + reference images,
 *      combined) the provider's image tool accepts, or `null` when its schema
 *      declares no maximum (PortOS's own form ceiling — MAX_REFERENCE_IMAGES in
 *      routes/imageGen.js — is then the only bound, expressed once where it is
 *      defined rather than restated here as a fake capability). Probed from the
 *      live tool schemas on 2026-08-09 — do NOT raise one on a provider's word,
 *      re-probe the schema. Applied server-side in exactly one place,
 *      `resolveInputImages` (inputImages.js), and predicted client-side by
 *      `referenceSlotsFor` so the form never offers a slot the backend drops.
 *  - `promptRequiredWithInputImage` — whether the provider still needs a text
 *      prompt when the render already carries an input image. `false` for the
 *      tools where the attached image is the whole instruction; `true` where the
 *      tool schema lists the prompt as required.
 */
export const IMAGE_GEN_PROVIDER_CAPABILITIES = Object.freeze({
  [IMAGE_GEN_MODE.CODEX]: Object.freeze({
    supportsModelOverride: true,
    // `image_gen.referenced_image_paths` is a string[] with no declared maximum.
    maxInputImages: null,
    promptRequiredWithInputImage: false,
  }),
  [IMAGE_GEN_MODE.GROK]: Object.freeze({
    // Grok's image tools run on xAI's fixed image backend — no model knob.
    supportsModelOverride: false,
    // `image_edit.image` is a string[] with no declared maximum — like codex.
    maxInputImages: null,
    promptRequiredWithInputImage: false,
  }),
  [IMAGE_GEN_MODE.AGY]: Object.freeze({
    supportsModelOverride: true,
    // `generate_image.ImagePaths`: "you cannot pass in more than 3 images".
    maxInputImages: 3,
    // …and `Prompt` is in that tool's `required` list, so an image-only agy
    // render has nothing to send.
    promptRequiredWithInputImage: true,
  }),
});

// Cloud CLIs that accept a per-render `cloudModel` override. Kept as data so a
// new backend is one capability entry rather than a hand-rolled
// `mode === CODEX || mode === AGY` disjunction at every call site.
export const MODEL_OVERRIDE_CAPABLE_MODES = Object.freeze(
  CLOUD_IMAGE_GEN_MODES.filter((mode) => IMAGE_GEN_PROVIDER_CAPABILITIES[mode]?.supportsModelOverride === true),
);

/** Can a per-render `cloudModel` replace `mode`'s saved default model? */
export const supportsCloudModelOverride = (mode) => MODEL_OVERRIDE_CAPABLE_MODES.includes(mode);

/**
 * How many input images (init image + reference images, combined) `mode`'s
 * image tool accepts. `null` for a non-cloud mode: the local runner's ceiling
 * is the form's own slot count, and external takes none at all (it never
 * reaches the resolver — `isEditCapableMode` rejects it first).
 */
export const maxInputImages = (mode) => IMAGE_GEN_PROVIDER_CAPABILITIES[mode]?.maxInputImages ?? null;

/**
 * Does a cloud-CLI render need a text prompt, given whether it carries an input
 * image? Text-to-image always does; with an input image it depends on whether
 * the provider's tool lists the prompt as required
 * (`promptRequiredWithInputImage`). Non-cloud modes return `false` — local and
 * external both accept an empty prompt. Rejecting up front keeps the failure a
 * 400 instead of a queued job that dies asynchronously.
 */
export const cloudPromptRequired = (mode, hasInputImage) => {
  const caps = IMAGE_GEN_PROVIDER_CAPABILITIES[mode];
  if (!caps) return false;
  return !hasInputImage || caps.promptRequiredWithInputImage === true;
};
