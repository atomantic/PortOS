// Pure video-generation parameter helpers extracted from VideoGen.jsx (#2834).
// Side-effect-free — the model-memory calc, the FFLF/ltx2 frame-budget
// back-solve, the per-edge resolution bounds, and the mode-compatibility
// predicate. Kept in lib/ (not hooks/) because none touch React state; the
// page and any future consumer import them directly.

import { isLtx2FamilyRuntime } from './runnerFamilies';

// Values follow LTX-2's 8k+1 latent boundary so the model doesn't silently
// snap. 241 = 10s @ 24fps is the comfortable single-pass ceiling on 48 GB
// at standard widths; the higher options (265–481) push past that and may
// swap or OOM at 1280×704. For reliable clips longer than ~10s, use Extend
// mode (renders past a source video, conditioning on its full latent) —
// see the hint under the Frames dropdown.
export const FRAME_OPTIONS = [25, 49, 73, 97, 121, 145, 169, 193, 217, 241, 265, 313, 361, 481];
export const FPS_OPTIONS = [16, 24, 30];
// Chain ceiling — mirrors the route's own 1..8 cap on `chunks` (and on the
// per-chunk prompt list), which bounds worst-case wall time at 8 × ~5min.
// Exported so the Chunks picker and the Remix restore can't drift from it.
export const MAX_CHUNKS = 8;
export const CHUNK_OPTIONS = Array.from({ length: MAX_CHUNKS }, (_, i) => i + 1);

// Continuation context window — how many of the prior chunk's frames each
// subsequent chunk conditions on. Display-side mirror of
// `server/lib/videoContinuity.js` (which stays the authority: it defaults,
// clamps, and picks the strategy). Pinned against drift by
// `server/lib/videoContinuity.parity.test.js`.
//
// `0` is a real option, not "unset" — it opts back into seeding the next chunk
// from a single extracted last frame, which is what every runtime without an
// extend pipeline does anyway.
export const DEFAULT_CONTEXT_FRAMES = 22;
export const CONTEXT_FRAME_OPTIONS = [0, 11, 22, 45, 73];
// Only a runtime with a video-conditioned extend pipeline can use a window;
// elsewhere the server ignores the value, so the control stays hidden rather
// than offering a knob that does nothing.
export const supportsContextWindow = (model) => isLtx2FamilyRuntime(model?.runtime);
export const WAN_FRAME_OPTIONS = [...new Set([
  ...FRAME_OPTIONS,
  41, 61, 81, 101, 161, 201, 321,
])].sort((a, b) => a - b);

export const isValidFrameCountForModel = (value, model) => {
  const frames = Number(value);
  if (Array.isArray(model?.frameOptions) && model.frameOptions.length > 0) {
    return Number.isInteger(frames) && model.frameOptions.includes(frames);
  }
  const stride = Number(model?.frameStride);
  return Number.isInteger(frames) && frames > 0
    && Number.isFinite(stride) && stride > 0
    && (frames - 1) % stride === 0;
};
export const frameOptionsForModel = (model, currentValue = null) => {
  const options = Array.isArray(model?.frameOptions) && model.frameOptions.length > 0
    ? model.frameOptions
    : Number(model?.frameStride) === 4 ? WAN_FRAME_OPTIONS : FRAME_OPTIONS;
  const frames = Number(currentValue);
  return isValidFrameCountForModel(frames, model) && !options.includes(frames)
    ? [...options, frames].sort((a, b) => a - b)
    : options;
};
export const fpsOptionsForModel = (model) => Array.isArray(model?.fpsOptions) && model.fpsOptions.length > 0
  ? model.fpsOptions
  : FPS_OPTIONS;
const nearestOption = (value, options) => options.reduce(
  (best, option) => Math.abs(option - Number(value)) < Math.abs(best - Number(value)) ? option : best,
  options[0],
);
export const normalizeFramesForModel = (value, model) => isValidFrameCountForModel(value, model)
  ? Number(value)
  : nearestOption(value, frameOptionsForModel(model));
export const normalizeFpsForModel = (value, model) => nearestOption(value, fpsOptionsForModel(model));

// Muting and prompt-audio steering are separate capabilities. Hidden mute state
// from a prior model must never alter a model (such as MiniMax H3) whose joint
// audio track cannot be disabled.
export const supportsVideoAudioControls = (model) => model?.supportsDisableAudio !== false;
// Prompt steering is independent from muting. MiniMax H3 always emits a joint
// audio track, but its documented prompt format explicitly supports
// soundscape/music direction, so "No music" remains useful even though the
// Disable audio checkbox must stay hidden.
export const supportsVideoAudioPromptControls = (model) => model?.supportsAudioPrompting !== false;

// Substitutable prompt conditioners (#4081). The OPTIONS themselves are not
// mirrored here — the server decorates each model entry with its own
// `textEncoderOptions` (label, description, size) in
// `videoGen/local.js#decorateVideoModel`, so the picker renders whatever this
// build's runner can actually key-map and a stale client can't offer one it
// can't. Only the "no override" sentinel is duplicated, and it must stay equal
// to `STOCK_TEXT_ENCODER_ID` in `server/lib/videoTextEncoders.js`: the submit
// builder drops the field when it holds this value, and the server treats an
// absent field and this id identically.
export const STOCK_TEXT_ENCODER_ID = 'stock';
export const textEncoderOptionsForModel = (model) => (
  Array.isArray(model?.textEncoderOptions) ? model.textEncoderOptions : []
);
// Snap a selection onto what the (possibly just-switched) model offers. A model
// with no substitutions answers with the stock sentinel rather than '', so the
// <select> is never left on a value with no matching <option>.
export const normalizeTextEncoderForModel = (id, model) => (
  textEncoderOptionsForModel(model).some((option) => option.id === id) ? id : STOCK_TEXT_ENCODER_ID
);
// Read a conditioner out of a persisted record (a history entry, a resumed
// job's params). Both only record a SUBSTITUTE, so a missing field means stock —
// and must CLEAR a leftover selection rather than carry it into a render the
// user asked to reproduce. Keeping that rule next to the sentinel stops the two
// restore paths from drifting on it.
export const textEncoderIdFromRecord = (value) => (
  typeof value === 'string' && value ? value : STOCK_TEXT_ENCODER_ID
);

// Per-edge bounds for video: mirrors the videoGen route (64..2048). The base
// grid is 64px, while a model may declare a finer resolutionStep (H3 uses 32).
// Shared by the ResolutionField control and the submit-time clamp so a
// hand-typed / mid-edit value can never POST an out-of-range or 0 dimension.
export const VIDEO_EDGE_BOUNDS = { min: 64, max: 2048, step: 64 };
export const videoEdgeBoundsForModel = (model) => {
  const step = Number(model?.resolutionStep);
  return {
    ...VIDEO_EDGE_BOUNDS,
    step: Number.isInteger(step) && step > 0 && step <= VIDEO_EDGE_BOUNDS.step
      ? step
      : VIDEO_EDGE_BOUNDS.step,
  };
};

// Resolve a video model's memory footprint in GB. Prefers the explicit
// `memoryGb` field, falling back to a "~NN GB/GiB" hint in the display name, then
// +Infinity so an unknown model never spuriously "fits" a memory budget.
export const videoModelMemoryGb = (model) => {
  const explicit = Number(model?.memoryGb);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const match = String(model?.name || '').match(/~\s*(\d+(?:\.\d+)?)\s*Gi?B/i);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
};

// Mirror of server computeFflfSafeFrames (server/services/videoGen/local.js):
// the largest numFrames that fits the FFLF/ltx2 stage-2 pixel-frame budget at
// this resolution, rounded down to the LTX 8k+1 latent boundary. The budget
// itself comes from /status (`fflfLtx2PixelBudget`, which scales with the box's
// unified memory and honors the env override) so only this back-solve arithmetic
// is duplicated — not the constant. Lets the multi-keyframe picker reject
// out-of-budget indices before submit instead of letting the worker 400
// mid-render. Returns numFrames when it already fits or the budget is unknown
// (fail-open — the server still enforces the real cap).
export const computeFflfSafeFrames = (width, height, numFrames, budget) => {
  const wh = Number(width) * Number(height);
  const nf = Number(numFrames);
  const b = Number(budget);
  if (!(wh > 0) || !(nf > 0) || !(b > 0)) return nf;
  if (wh * nf <= b) return nf;
  const safeRaw = Math.floor(b / wh);
  const safeLatent = Math.max(1, Math.floor((safeRaw - 1) / 8));
  return safeLatent * 8 + 1;
};

// IC-LoRA remix modes (issue #3100) — mirror of the server registry in
// server/lib/icLoraWeights.js, which is the source of truth. The client needs
// the labels, the input-surface descriptors, and the reference-count/resolution
// rules to render the panel and validate before submit; the weight repo/filename
// stays server-side (the client never resolves a weight path).
//
// Field names match the server entry exactly so drift is mechanically
// detectable: server/lib/icLoraWeights.parity.test.js imports BOTH modules and
// diffs the mirrored fields, so adding a mode (or changing a bound) without
// updating this list fails CI instead of silently letting the form accept a
// render the route rejects.
export const IC_LORA_MODES = [
  {
    mode: 'ic-control',
    label: 'Control',
    description: 'Structure + motion from a control clip',
    uploadLabel: 'Upload a control clip (depth / pose / edges)',
    // The IC encoder downscales the reference by this factor, and the pipeline
    // requires the OUTPUT dimensions to divide evenly by it (the server rejects
    // otherwise with IC_LORA_RESOLUTION_NOT_DIVISIBLE). Per-weight — read from
    // the weight's safetensors metadata server-side, never assumed.
    referenceDownscaleFactor: 2,
    minReferences: 1,
    maxReferences: 1,
    referenceKind: 'video',
  },
  {
    mode: 'ic-colorize',
    label: 'Colorize',
    description: 'Color restored onto a black-and-white clip',
    uploadLabel: 'Upload a B&W clip to restore',
    // 1 — the Colorizer conditions on a full-resolution reference, so it imposes
    // no divisibility rule at all (icResolutionIssue short-circuits at <= 1).
    referenceDownscaleFactor: 1,
    minReferences: 1,
    maxReferences: 1,
    referenceKind: 'video',
  },
  {
    mode: 'ic-ingredients',
    label: 'Ingredients',
    description: 'A scene recomposed from 2-8 reference stills (characters, props, settings)',
    uploadLabel: 'Upload a reference still (character / prop / setting)',
    // 1 — read off the weight's safetensors metadata server-side; conditions on
    // full-resolution references, so no divisibility rule.
    referenceDownscaleFactor: 1,
    minReferences: 2,
    maxReferences: 8,
    // Images, not clips: `referenceKind` drives the panel's picker (a 2-8 row
    // gallery list rather than the single upload/history pair).
    referenceKind: 'image',
  },
];

export const IC_LORA_MODE_VALUES = IC_LORA_MODES.map((m) => m.mode);
export const isIcLoraMode = (mode) => IC_LORA_MODE_VALUES.includes(mode);
export const icLoraSpecForMode = (mode) => IC_LORA_MODES.find((m) => m.mode === mode) || null;

// Mirror of icResolutionIssue in server/lib/icLoraWeights.js: a human message
// when the output dimensions aren't divisible by the weight's reference-downscale
// factor, else null. One implementation so the panel's warning and the submit
// gate can never disagree.
export const icResolutionIssue = (spec, width, height) => {
  const scale = spec?.referenceDownscaleFactor ?? 1;
  if (scale <= 1) return null;
  if (Number(width) % scale === 0 && Number(height) % scale === 0) return null;
  return `${spec.label} mode needs a resolution divisible by ${scale} (its reference encoder downscales by ${scale}); got ${width}×${height}.`;
};

// The one mode-compatibility predicate — used by the Model dropdown and by
// every "can this model do i2v?" gate on the page. a2v and the IC-LoRA remix
// modes stay runtime-gated because they're ltx2 pipeline capabilities rather
// than per-entry facts (the remix ids come from the IC-LoRA weight registry);
// the server enforces the same rules in routes/videoGen.js (A2V_REQUIRES_LTX2 /
// IC_LORA_REQUIRES_LTX2). Every other mode is answered by `supportedModes`,
// which the server resolves for EVERY entry (server/lib/videoModeProfiles.js,
// #3737), so an absent list means the payload didn't come from the registry.
export const isModelAllowedForMode = (model, mode) => {
  if (!model) return false;
  if (mode === 'a2v' || isIcLoraMode(mode)) return isLtx2FamilyRuntime(model.runtime);
  return Array.isArray(model.supportedModes) && model.supportedModes.includes(mode);
};
