/**
 * Image/video render-backend constants + pure helpers — the NODE-SAFE half of
 * `imageGenBackends.js`, split out (#3231 Phase 4) because the server-side
 * parity suite (`server/lib/renderTargets.parity.test.js`) and the server CI
 * job import this module directly, where client-only packages (lucide-react)
 * are not installed. Nothing here may import React, icons, or any package —
 * keep this file dependency-free. Icon metadata and settings-driven backend
 * derivation stay in `imageGenBackends.js`, which re-exports everything below
 * so client consumers keep a single import site.
 */

export const IMAGE_GEN_MODE = Object.freeze({
  LOCAL: 'local',
  CODEX: 'codex',
  GROK: 'grok',
  AGY: 'agy',
  EXTERNAL: 'external',
});

// Shipped default Codex reasoning-effort level — the client mirror of the
// server's CODEX_IMAGEGEN_DEFAULT_EFFORT (server/services/imageGen/modes.js).
// A Codex job with no explicit effort renders at this level, so any UI that
// displays or pre-fills "the effort a job used" must resolve an absent value to
// this default rather than showing a blank.
export const CODEX_IMAGEGEN_DEFAULT_EFFORT = 'low';

// Client mirror of the server's AGY_IMAGEGEN_DEFAULT_MODEL
// (server/services/imageGen/modes.js, #3231) — the cheap-tier agent/session
// model an unpinned agy render runs on. Any UI naming "the model an agy job
// used" must resolve an absent value to this, not to "agy's own default"
// (which stopped being true when the pin shipped).
export const AGY_IMAGEGEN_DEFAULT_MODEL = 'gemini-3.5-flash-low';

// Client mirror of AGY_IMAGEGEN_IMAGE_MODEL — the image model behind agy's
// generate_image tool, fixed server-side by Antigravity and NOT selectable by
// PortOS (all three channels probed and closed — see the server constant's
// comment). Surfaced read-only in Settings so the agent-model field can't be
// mistaken for an image-model picker.
export const AGY_IMAGEGEN_IMAGE_MODEL = 'imagen-3.0-generate-002';

// Client mirror of the server's render-target alphabet
// (server/lib/renderTargets.js, #3231) — the surfaces whose default backend +
// model are pinnable via settings.renderDefaults. Only targets whose resolver
// is LIVE are listed here — showing a pin no resolver reads would be a control
// that silently does nothing. Labels are the Settings-UI display names.
// `video: true` marks the targets whose VIDEO lane also consults
// `renderDefaults[target].videoMode` (#3231 Phase 4): music-video (scene clips
// + new-project backend seeding) and creative-agent (commission video steps).
// Video pins are backend-only — grok video has no model knob
// (supportsModelOverride: false) and local video models are picked on the
// surface itself, so no video-model control is offered anywhere.
export const RENDER_TARGET_BACKEND_AUTO = 'auto';
// Named ids for the targets the CLIENT resolves itself (via `renderTargetPin`),
// so a call site names the surface instead of retyping the string. The ids are
// bound to the server's RENDER_TARGETS by renderTargets.parity.test.js.
export const RENDER_TARGET = Object.freeze({
  UNIVERSE_BIBLE: 'universe-bible',
  PIPELINE_VISUAL: 'pipeline-visual',
});
export const RENDER_TARGET_OPTIONS = Object.freeze([
  { id: 'universe-bible', label: 'Universe Bible & canon renders' },
  { id: 'universe-character-sheet', label: 'Universe character sheets' },
  { id: 'series-first-pass', label: 'Series first-pass portraits & frames' },
  { id: 'sprite-reference', label: 'Sprite references & anchors' },
  { id: 'pipeline-visual', label: 'Pipeline visuals (storyboards, comics, covers)' },
  { id: 'music-video', label: 'Music Video scene frames & clips', video: true },
  { id: 'lora-dataset', label: 'LoRA training datasets' },
  { id: 'creative-agent', label: 'Creative agent renders', video: true },
]);

// Client mirror of the server's VIDEO_GEN_MODES (services/videoGen/modes.js) —
// the backend alphabet for the video pin controls above and the install-wide
// `settings.videoGen.mode` pin.
export const VIDEO_RENDER_MODES = Object.freeze(['local', 'grok']);

// Client mirror of the server's normalizeRenderPinValue
// (server/lib/renderTargets.js) — THE one render-pin normalization rule: trim;
// the 'auto' sentinel and blank strings collapse to null ("no pin").
export const normalizeRenderPinValue = (v) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s && s !== RENDER_TARGET_BACKEND_AUTO ? s : null;
};

// Client mirror of the server's GROK_ASPECT_RATIOS (imageGen/grok.js) — the
// aspect ratios grok's image_gen/image_edit tools accept, offered as the
// default-ratio picker in Settings → Image Gen → Grok.
export const GROK_ASPECT_RATIOS = Object.freeze(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']);

// Human-facing backend names — the pure half of imageGenBackends' per-mode
// metadata (its icon half stays there with the lucide import).
export const MODE_LABELS = Object.freeze({
  [IMAGE_GEN_MODE.LOCAL]: 'Local',
  [IMAGE_GEN_MODE.CODEX]: 'Codex',
  [IMAGE_GEN_MODE.GROK]: 'Grok',
  [IMAGE_GEN_MODE.AGY]: 'Agy',
  [IMAGE_GEN_MODE.EXTERNAL]: 'External',
});

// Client mirror of the server's CLOUD_IMAGE_GEN_MODES (imageGen/modes.js) —
// cloud-CLI backends that pick model/steps/seed internally,
// run through the media queue's parallel cloud lane, and need a prompt for
// text-to-image. Use `isCloudCliMode` instead of hand-rolled
// `mode === CODEX || mode === GROK` disjunctions.
export const CLOUD_IMAGE_GEN_MODES = Object.freeze([
  IMAGE_GEN_MODE.CODEX,
  IMAGE_GEN_MODE.GROK,
  IMAGE_GEN_MODE.AGY,
]);
export const isCloudCliMode = (mode) => CLOUD_IMAGE_GEN_MODES.includes(mode);

// Client mirror of the server's `supportsModelOverride` spec flag
// (imageGen/cloudProviderConfig.js) — cloud CLIs that accept a per-render
// `cloudModel` replacing the saved `settings.imageGen.<mode>.model` for one
// queue item. Grok is absent because its image tools run on a fixed xAI backend
// with no model knob, so offering the control there would be a lie.
// Use `supportsCloudModelOverride` instead of hand-rolled
// `mode === CODEX || mode === AGY` disjunctions — the two must stay in lock-step
// with the server spec, and a new CLI backend should be one entry here.
export const MODEL_OVERRIDE_CAPABLE_MODES = Object.freeze([
  IMAGE_GEN_MODE.CODEX,
  IMAGE_GEN_MODE.AGY,
]);
export const supportsCloudModelOverride = (mode) => MODEL_OVERRIDE_CAPABLE_MODES.includes(mode);

/**
 * Client mirror of the server's `renderTargetDefaults`
 * (imageGen/cloudProviderConfig.js) — one surface's saved `settings.renderDefaults`
 * pin, re-keyed to the flat `imageMode`/`imageModelId` shape `renderPinLadder`
 * consumes so a target pin and a record pin are the same kind of thing.
 */
export const renderTargetPin = (settings, target) => ({
  imageMode: settings?.renderDefaults?.[target]?.imageMode ?? null,
  imageModelId: settings?.renderDefaults?.[target]?.imageModel ?? null,
});

/**
 * Resolve the effective render pin from an ordered ladder of pin sources — the
 * client mirror of the server's `resolveRenderTargetConfig` (#3231), minus the
 * explicit-per-request rung the caller owns. Pass sources highest-priority
 * first, which for every surface is: the record's own pin (`recordRenderPin`'s
 * `imageMode`/`imageModelId`), then the target's `renderTargetPin(settings, target)`.
 *
 * Why the client resolves this at all: single-image render call sites (a
 * universe cast reference, the base-style probe) send `mode` EXPLICITLY, and an
 * explicit mode outranks every pin on the server ladder — so a universe pinned
 * to agy rendered its cast on whatever the install-wide default resolved to
 * (codex, on a codex-enabled install) until the client folded the pin in itself.
 *
 * `availableBackends` (the `deriveAvailableBackends` shape) is a client-side
 * usability gate with no server counterpart: a pin naming a backend this install
 * no longer has enabled falls through to the next rung rather than queueing a
 * job that can only 400. Pass `null` when the backend list isn't loaded yet —
 * an empty array means "loaded, nothing enabled" and suppresses every pin.
 *
 * @param {Array<object|null>} sources - Pin sources, highest priority first.
 * @param {Array<{id:string}>|null} [availableBackends] - Enabled backends, or null.
 * @returns {{mode: string|null, modelId: string|null}} The first usable pin.
 */
export function renderPinLadder(sources, availableBackends = null) {
  for (const source of sources) {
    const mode = normalizeRenderPinValue(source?.imageMode);
    if (!mode) continue;
    if (Array.isArray(availableBackends) && !availableBackends.some((b) => b.id === mode)) continue;
    return { mode, modelId: normalizeRenderPinValue(source?.imageModelId) };
  }
  return { mode: null, modelId: null };
}

/**
 * Fold `renderPinLadder`'s result over a settings-derived per-render config.
 *
 * Returns `cfg` BY IDENTITY when no pin applies — every consumer passes this
 * cfg down as a prop, so an unconditional spread would churn a re-render for
 * every unpinned record.
 *
 * @param {object} cfg - Settings-derived config (`readPipelineImageSettings` shape).
 * @param {Array<object|null>} sources - Pin sources, highest priority first.
 * @param {Array<{id:string}>|null} [availableBackends] - Enabled backends, or null.
 * @returns {object} `cfg` unchanged when there's no usable pin, else a pinned copy.
 */
export function applyRecordRenderPin(cfg, sources, availableBackends = null) {
  const { mode, modelId } = renderPinLadder(sources, availableBackends);
  if (!mode) return cfg;
  const isLocal = mode === IMAGE_GEN_MODE.LOCAL;
  return {
    ...cfg,
    mode,
    // The pinned model lands on the knob that backend actually reads: local
    // diffusion takes `modelId`, an override-capable cloud CLI takes
    // `cloudModel`. The other is nulled rather than omitted — `cfg` arrives
    // spread in with a settings-derived local `modelId`, which would otherwise
    // ride along into a cloud render.
    modelId: isLocal ? (modelId || cfg?.modelId) : null,
    cloudModel: !isLocal && supportsCloudModelOverride(mode) ? modelId : null,
  };
}

// Human-facing name for a backend ('Local', 'Codex', 'Grok', 'Agy', 'External').
// Shared so label ladders (`isCodex ? 'Codex model' : …`) don't re-type what
// MODE_LABELS already holds and grow a branch per backend.
export const modeLabel = (mode) => MODE_LABELS[mode] || mode || '';

// Backends that support image-to-image (init image / reference conditioning).
// The external SD-API path does not. Client mirror of the server's
// EDIT_INCAPABLE_IMAGE_MODES complement (imageGen/modes.js), bound to it by
// server/lib/renderTargets.parity.test.js. Ordered best-first — pickI2iMode
// walks this list.
export const I2I_CAPABLE_MODES = Object.freeze([
  IMAGE_GEN_MODE.LOCAL, IMAGE_GEN_MODE.CODEX, IMAGE_GEN_MODE.GROK, IMAGE_GEN_MODE.AGY,
]);

// True when a mode can run image-to-image.
export const isI2iCapableMode = (mode) => I2I_CAPABLE_MODES.includes(mode);

// Pick the best available i2i backend from a list of `{ id }` backends,
// preferring local (its form exposes strength + LoRAs), then codex, grok, agy.
// Returns null when none is installed.
export function pickI2iMode(backends) {
  for (const mode of I2I_CAPABLE_MODES) {
    if (backends.some((b) => b.id === mode)) return mode;
  }
  return null;
}

// Client mirror of the `maxInputImages` field on the server's
// CLOUD_PROVIDER_SPECS (imageGen/cloudProviderConfig.js) — how many input
// images (init image + reference slots, combined) each cloud CLI's image tool
// accepts. The form uses this to cap the reference slots it offers, so a user
// never fills a slot the backend would silently drop. Only agy declares a
// maximum; codex and grok are absent because their tool schemas declare none,
// so the form's own slot count is their only bound. Local is absent for the
// same reason: FLUX.2 takes the init image plus all 4 reference slots.
// Bound to the server values by server/lib/renderTargets.parity.test.js.
export const MAX_INPUT_IMAGES = Object.freeze({
  [IMAGE_GEN_MODE.AGY]: 3,
});

// Client mirror of the server's `promptRequiredWithInputImage` spec flag
// (imageGen/cloudProviderConfig.js) — cloud CLIs whose image tool lists the
// prompt in its `required` parameters, so an image-only render still needs one.
// Codex and grok are absent: their tools render from an input image alone.
// Kept as data (like MODEL_OVERRIDE_CAPABLE_MODES) rather than a hand-rolled
// `mode === AGY` comparison, so a new CLI backend is one entry here.
export const PROMPT_REQUIRED_WITH_INPUT_IMAGE_MODES = Object.freeze([IMAGE_GEN_MODE.AGY]);

// Client mirror of the server's cloudPromptRequired (imageGen/cloudProviderConfig.js).
// Text-to-image always needs a prompt; with an input image it depends on the
// backend. Bound to the server predicate by server/lib/renderTargets.parity.test.js.
export const cloudPromptRequired = (mode, hasInputImage) => isCloudCliMode(mode)
  && (!hasInputImage || PROMPT_REQUIRED_WITH_INPUT_IMAGE_MODES.includes(mode));

/**
 * How many reference slots the form should offer for `mode`.
 *
 * The client half of the server's input-image cap: a cloud CLI's tool caps the
 * COMBINED count, so an init image eats one of its slots — the same "init image
 * leads" rule `resolveInputImages` applies server-side, predicted here so the
 * form never offers a slot the backend would drop. A backend that declares no
 * cap gets the form's full slot count. Local FLUX.2 takes all of them (its
 * references ride a separate runner flag from the init image); a non-FLUX.2
 * local model and external take none.
 */
export function referenceSlotsFor(mode, { hasInitImage = false, maxSlots = 4, localSupportsReferences = false } = {}) {
  if (mode === IMAGE_GEN_MODE.LOCAL) return localSupportsReferences ? maxSlots : 0;
  if (!isCloudCliMode(mode)) return 0;
  const cap = MAX_INPUT_IMAGES[mode] ?? Infinity;
  return Math.min(maxSlots, cap - (hasInitImage ? 1 : 0));
}

// Backends that honor a NUMERIC per-reference strength. Only the local FLUX.2
// runner does (its K/V reference-attention scales each reference's V slice by
// its weight); the cloud CLIs expose no such knob, so their forms must not show
// a slider that does nothing. The single init image is the exception — its
// strength maps to a fidelity PHRASE in the cloud prompts (describeFidelity),
// so that slider stays meaningful everywhere.
export const supportsReferenceStrength = (mode) => mode === IMAGE_GEN_MODE.LOCAL;
