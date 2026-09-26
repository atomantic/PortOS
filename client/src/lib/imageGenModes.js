/**
 * Image/video render-backend constants + pure helpers — the NODE-SAFE half of
 * `imageGenBackends.js`, split out (#3231 Phase 4) because the server-side
 * parity suite (`server/lib/renderTargets.parity.test.js`) and the server CI
 * job import this module directly, where client-only packages (lucide-react)
 * are not installed. Nothing here may import React, icons, or any package —
 * the only imports allowed are the three dependency-free server leaves below,
 * the same way `Layout.jsx` reads `server/lib/navManifest.js`. Icon metadata
 * and settings-driven backend derivation stay in `imageGenBackends.js`, which
 * re-exports everything below so client consumers keep a single import site.
 *
 * NOTHING here is a hand-copied server fact. The backend / render-target /
 * execution-lane ALPHABETS re-export from `server/lib/generationModes.js` and
 * `server/lib/renderTargets.js`, and the per-backend CAPABILITY literals —
 * input-image caps, the prompt rule, model-override support, the shipped
 * default models/effort, the aspect-ratio alphabets — from
 * `server/lib/imageGenCapabilities.js` (#6590). So a backend added or re-probed
 * server-side reaches every client picker in the same commit. A hand-copied
 * alphabet is how fal.ai and Reactor video renders came to be filed under
 * "Local machine" (#6292), and the shipped defaults were free to drift
 * silently until the capability leaf existed. What stays local to this module
 * is only what the CLIENT owns: display labels, the Settings row list, and the
 * form's own slot/strength predicates.
 */

import {
  CLOUD_IMAGE_GEN_MODES,
  CLOUD_VIDEO_GEN_MODES,
  IMAGE_GEN_MODE,
  MEDIA_JOB_EXECUTION_LANES,
  VIDEO_GEN_MODE,
  VIDEO_GEN_MODES,
  mediaJobExecutionLane,
} from '../../../server/lib/generationModes.js';
import {
  RENDER_TARGET,
  RENDER_TARGET_BACKEND_AUTO,
  normalizeRenderPinValue,
} from '../../../server/lib/renderTargets.js';
import {
  resolveRenderPins,
  resolveRenderTargetPins,
  imageModeCandidates,
  isModeUsable,
  pickUsableMode,
  renderTargetDefaults,
} from '../../../server/lib/renderModeLadder.js';
import {
  AGY_IMAGEGEN_DEFAULT_MODEL,
  AGY_IMAGEGEN_IMAGE_MODEL,
  CODEX_IMAGEGEN_DEFAULT_EFFORT,
  CODEX_IMAGEGEN_DEFAULT_MODEL,
  GROK_ASPECT_RATIOS,
  I2I_CAPABLE_MODES,
  LOCAL_IMAGEGEN_DEFAULT_MODEL,
  MODEL_OVERRIDE_CAPABLE_MODES,
  cloudPromptRequired,
  maxInputImages,
  supportsCloudModelOverride,
} from '../../../server/lib/imageGenCapabilities.js';
import {
  IMAGE_RUNTIME_READINESS,
  IMAGE_RUNTIME_REMEDY,
} from '../../../server/lib/imageRuntimeRemedies.js';

export {
  // Shipped per-backend defaults, so a UI that displays "the model/effort a job
  // used" resolves an absent value to what actually renders rather than to a
  // blank or to the CLI's own default (which stopped being true when the pins
  // shipped).
  AGY_IMAGEGEN_DEFAULT_MODEL,
  // The image model behind agy's generate_image tool — fixed by Antigravity and
  // NOT selectable by PortOS, surfaced read-only in Settings so the
  // agent-model field can't be mistaken for an image-model picker.
  AGY_IMAGEGEN_IMAGE_MODEL,
  CLOUD_IMAGE_GEN_MODES,
  CODEX_IMAGEGEN_DEFAULT_EFFORT,
  CODEX_IMAGEGEN_DEFAULT_MODEL,
  // The ratios grok's image tools accept — the Settings default-ratio picker.
  GROK_ASPECT_RATIOS,
  // Backends that support image-to-image, ordered best-first: what the i2i-only
  // pickers filter through and what `pickI2iMode` walks.
  I2I_CAPABLE_MODES,
  IMAGE_GEN_MODE,
  // The local image-runtime vocabulary the status probe, the renderer's
  // pre-flight refusal and every blocked surface share. A component branches on
  // `IMAGE_RUNTIME_REMEDY.X`, never on the literal string — a hand-copied
  // remedy kind is a button that silently stops matching the server.
  IMAGE_RUNTIME_READINESS,
  IMAGE_RUNTIME_REMEDY,
  // The local model a blank `imageGen.local.modelId` resolves to, so the
  // Settings Local tab can name the install default instead of showing a blank
  // select whose meaning the user has to guess.
  LOCAL_IMAGEGEN_DEFAULT_MODEL,
  // Cloud CLIs that accept a per-render model override. Use
  // `supportsCloudModelOverride` at branch sites rather than a hand-rolled
  // `mode === CODEX || mode === AGY` disjunction.
  MODEL_OVERRIDE_CAPABLE_MODES,
  RENDER_TARGET,
  RENDER_TARGET_BACKEND_AUTO,
  // The backend alphabet for the video pin controls and the install-wide
  // `settings.videoGen.mode` pin, under the name the pickers already use.
  VIDEO_GEN_MODES as VIDEO_RENDER_MODES,
  // Text-to-image always needs a prompt; with an input image it depends on
  // whether the backend's tool lists the prompt as required. Gating the
  // Generate button on the server's own predicate keeps the button from
  // enabling a render `prepareParams` then 400s.
  cloudPromptRequired,
  // How many input images (init image + reference slots, combined) a backend's
  // tool accepts — null when its schema declares no maximum.
  maxInputImages,
  normalizeRenderPinValue,
  supportsCloudModelOverride,
  // The image-gen mode resolution ladder (#6815) — the SAME resolver every
  // server surface dispatches through, so a client display of "what will Auto
  // resolve to" can't hand-copy the ladder and drift from it. See
  // `server/lib/renderModeLadder.js` for the fall-through semantics (a pin is
  // a preference, not a guarantee) and the candidate-order contract.
  imageModeCandidates,
  resolveRenderTargetPins,
  isModeUsable,
  pickUsableMode,
  renderTargetDefaults,
};

// The Settings → Image Gen → Defaults rows for the server's render-target
// alphabet (`RENDER_TARGET`, #3231) — the surfaces whose default backend +
// model are pinnable via settings.renderDefaults. Only targets whose resolver
// is LIVE are listed here — showing a pin no resolver reads would be a control
// that silently does nothing; the parity suite fails on a server target that
// is neither listed nor explicitly allowlisted as unlisted. Labels are the
// Settings-UI display names. `video: true` marks the targets whose VIDEO lane
// also consults `renderDefaults[target].videoMode` (#3231 Phase 4):
// music-video (scene clips + new-project backend seeding) and creative-agent
// (commission video steps). Video pins are backend-only — grok video has no
// model knob (supportsModelOverride: false) and local video models are picked
// on the surface itself, so no video-model control is offered anywhere.
export const RENDER_TARGET_OPTIONS = Object.freeze([
  { id: RENDER_TARGET.UNIVERSE_BIBLE, label: 'Universe Bible & canon renders' },
  { id: RENDER_TARGET.UNIVERSE_CHARACTER_SHEET, label: 'Universe character sheets' },
  { id: RENDER_TARGET.SERIES_FIRST_PASS, label: 'Series first-pass portraits & frames' },
  { id: RENDER_TARGET.SPRITE_REFERENCE, label: 'Sprite references & anchors' },
  { id: RENDER_TARGET.PIPELINE_VISUAL, label: 'Pipeline visuals (storyboards, comics, covers)' },
  { id: RENDER_TARGET.MUSIC_VIDEO, label: 'Music Video scene frames & clips', video: true },
  { id: RENDER_TARGET.LORA_DATASET, label: 'LoRA training datasets' },
  { id: RENDER_TARGET.CREATIVE_AGENT, label: 'Creative agent renders', video: true },
  { id: RENDER_TARGET.DECK, label: 'Deck card renders (playing cards & tarot)' },
]);

// True when a video backend renders in a provider's cloud rather than on the
// local accelerator.
export const isCloudVideoMode = (mode) => CLOUD_VIDEO_GEN_MODES.includes(mode);

// Human-facing backend names — the pure half of imageGenBackends' per-mode
// metadata (its icon half stays there with the lucide import).
export const MODE_LABELS = Object.freeze({
  [IMAGE_GEN_MODE.LOCAL]: 'Local',
  [IMAGE_GEN_MODE.CODEX]: 'Codex',
  [IMAGE_GEN_MODE.GROK]: 'Grok',
  [IMAGE_GEN_MODE.AGY]: 'Agy',
  [IMAGE_GEN_MODE.EXTERNAL]: 'External',
  [VIDEO_GEN_MODE.FAL]: 'fal.ai',
  [VIDEO_GEN_MODE.REACTOR]: 'Reactor.inc',
});

// True for a cloud-CLI backend: one that picks model/steps/seed internally,
// runs through the media queue's parallel cloud lane, and needs a prompt for
// text-to-image. Use this instead of hand-rolled `mode === CODEX || mode ===
// GROK` disjunctions.
export const isCloudCliMode = (mode) => CLOUD_IMAGE_GEN_MODES.includes(mode);

/**
 * The client-side counterpart of the server's `renderTargetDefaults`
 * (`lib/renderModeLadder.js`, re-exported above) — one surface's saved
 * `settings.renderDefaults` pin, re-keyed to the flat `imageMode`/`imageModelId`
 * shape `renderPinLadder` consumes so a target pin and a record pin are the
 * same kind of thing. Its input is the settings payload the client already
 * holds, so this reads that object directly rather than calling
 * `renderTargetDefaults` itself, which returns the fuller
 * `{imageMode, imageModel, videoMode, videoModel}` shape `pickUsableMode` /
 * `imageModeCandidates` consume — not `renderPinLadder`'s pin-source shape.
 */
export const renderTargetPin = (settings, target) => ({
  imageMode: settings?.renderDefaults?.[target]?.imageMode ?? null,
  imageModelId: settings?.renderDefaults?.[target]?.imageModel ?? null,
});

/**
 * The local model a render resolves to when nothing else names one — the
 * client mirror of the tail of the server's `selectLocalImageModel`
 * (`settings.imageGen.local.modelId`, then `LOCAL_IMAGEGEN_DEFAULT_MODEL`).
 *
 * Every surface that is not the Pipeline visual form has to read THIS rather
 * than `settings.pipeline.imageGen.modelId`: that key is the Pipeline form's
 * own sticky state, so a model picked once on a comic page followed the Decks
 * "Renders on Local · …" summary around and named a model a deck render would
 * never actually use — the server has always read the install pin here.
 */
export const installLocalModelId = (settings) => (
  normalizeRenderPinValue(settings?.imageGen?.local?.modelId) || LOCAL_IMAGEGEN_DEFAULT_MODEL
);

/**
 * The option list + blank-option label a local-image-model `<select>` needs.
 *
 * A pin the live catalog no longer lists (model rotated out, or this machine
 * stopped being compatible) still has to render as the selected option —
 * otherwise the select paints blank, reads as "use the default", and the next
 * save silently drops a pin the server is still honouring.
 *
 * @param {Array<{id:string,name?:string}>|null} models - Catalog; `null` while it loads.
 * @param {string|null} pinned - Currently selected id ('' / null = no pin).
 * @param {string} [fallbackId] - What a blank pin resolves to on this surface.
 * @returns {{options: Array<{id:string,name?:string}>, fallbackLabel: string}}
 */
export function localModelSelectOptions(models, pinned, fallbackId = LOCAL_IMAGEGEN_DEFAULT_MODEL) {
  const orphaned = pinned && models !== null && !models.some((m) => m.id === pinned);
  return {
    options: orphaned
      ? [{ id: pinned, name: `${pinned} (unavailable on this machine)` }, ...models]
      : models ?? [],
    fallbackLabel: models?.find((m) => m.id === fallbackId)?.name || fallbackId,
  };
}

/**
 * Resolve the effective render pin from an ordered ladder of pin sources — the
 * client-side counterpart of the server's `resolveRenderTargetConfig` (#3231), minus the
 * explicit-per-request rung the caller owns. Pass sources highest-priority
 * first, which for every surface is: the record's own pin (`recordRenderPin`'s
 * `imageMode`/`imageModelId`), then the target's `renderTargetPin(settings, target)`.
 *
 * This is a compatibility wrapper over the shared pure pin resolver. Model
 * inheritance follows lower pins on the same usable backend. The optional
 * backend list gates previews; null means the list has not loaded yet.
 *
 * @param {Array<object|null>} sources - Pin sources, highest priority first.
 * @param {Array<{id:string}>|null} [availableBackends] - Enabled backends, or null.
 * @returns {{mode: string|null, modelId: string|null}} The first usable pin.
 */
export function renderPinLadder(sources, availableBackends = null) {
  const { mode, modelId } = resolveRenderPins(sources, {
    usable: (candidate) => !Array.isArray(availableBackends)
      || availableBackends.some((backend) => backend.id === candidate),
  });
  return { mode, modelId };
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

// True when a mode can run image-to-image.
export const isI2iCapableMode = (mode) => I2I_CAPABLE_MODES.includes(mode);

// THE one lane read for a projected media job: the server's classification
// when it is there, and otherwise the scheduler's own `mediaJobExecutionLane`
// re-run over the projection — the only client-side work is reading
// "federated" off the projected `renderer` field. The fallback is not routine
// version skew (the bundle is served by the install whose API it calls): it
// covers the window where a rebuilt client is already being served by a server
// process that has not restarted yet, and a replayed/hand-edited response.
export const mediaJobLane = (job) => (
  MEDIA_JOB_EXECUTION_LANES.includes(job?.executionLane)
    ? job.executionLane
    : mediaJobExecutionLane({ kind: job?.kind, mode: job?.params?.mode, remote: job?.renderer === 'remote' })
);

// Pick the best available i2i backend from a list of `{ id }` backends,
// preferring local (its form exposes strength + LoRAs), then codex, grok, agy.
// Returns null when none is installed.
export function pickI2iMode(backends) {
  for (const mode of I2I_CAPABLE_MODES) {
    if (backends.some((b) => b.id === mode)) return mode;
  }
  return null;
}

/**
 * How many reference slots the form should offer for `mode`.
 *
 * The client half of the server's input-image cap: a cloud CLI's tool caps the
 * COMBINED count, so an init image eats one of its slots — the same "init image
 * leads" rule `resolveInputImages` applies server-side, predicted here so the
 * form never offers a slot the backend would drop. A backend that declares no
 * cap gets the form's full slot count. Local FLUX.2 takes all of them (its
 * references ride a separate runner flag from the init image). Qwen 2.1 shares
 * its ten-input cap with the init image. Unsupported models take none.
 */
export function referenceSlotsFor(mode, { hasInitImage = false, maxSlots = 4, localSupportsReferences = false, localInputCap = null } = {}) {
  if (mode === IMAGE_GEN_MODE.LOCAL) {
    if (!localSupportsReferences) return 0;
    return Math.min(maxSlots, (localInputCap ?? Infinity) - (hasInitImage ? 1 : 0));
  }
  if (!isCloudCliMode(mode)) return 0;
  const cap = maxInputImages(mode) ?? Infinity;
  return Math.min(maxSlots, cap - (hasInitImage ? 1 : 0));
}

// Backends that honor a NUMERIC per-reference strength. Only the local FLUX.2
// runner does (its K/V reference-attention scales each reference's V slice by
// its weight); the cloud CLIs expose no such knob, so their forms must not show
// a slider that does nothing. The single init image is the exception — its
// strength maps to a fidelity PHRASE in the cloud prompts (describeFidelity),
// so that slider stays meaningful everywhere.
export const supportsReferenceStrength = (mode) => mode === IMAGE_GEN_MODE.LOCAL;
