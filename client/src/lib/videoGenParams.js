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

// Speed profiles (#4875) follow the SAME shape as the conditioner picker above,
// and for the same reason: the option list is decorated onto each model entry
// by the server (`applyVideoSpeedProfiles` in server/lib/videoSpeedProfiles.js),
// so the picker offers exactly what this install's registry declares and a
// stale client can't submit a schedule that no longer exists. Only the "no
// override" sentinel is duplicated here, and it must stay equal to
// `SPEED_PROFILE_DEFAULT_ID` on the server: the submit builder drops the field
// when it holds this value, and the server treats absence and this id
// identically.
export const DEFAULT_SPEED_PROFILE_ID = 'quality';
// Absence, the empty string and the default id are one request — mirrors
// `isDefaultSpeedProfile` on the server.
export const isDefaultSpeedProfileId = (id) => (
  id == null || id === '' || id === DEFAULT_SPEED_PROFILE_ID
);
// Every profile the model DECLARES, mode-independent. Used to validate a
// stored selection; the picker wants the mode-filtered view below.
export const speedProfilesForModel = (model) => (
  Array.isArray(model?.speedProfiles) ? model.speedProfiles.filter((p) => p?.id) : []
);
// The profiles that actually apply to THIS mode — what the picker offers, and
// the set a selection must be in to drive the sampler. The mode filter lives
// here rather than at each call site because both consumers need the same
// answer: a profile the server would decline must neither appear in the picker
// nor lock Steps/CFG. Mirrors the server's gate (`speedProfileDeclineReason`),
// pinned by server/lib/videoSpeedProfiles.parity.test.js. An absent mode is the
// default text render. A profile declaring no `modes` falls back to the
// two-stage set — NOT to "unrestricted": the server's decline check applies
// exactly that fallback, and reading a missing field as permissive here would
// offer a profile on fflf that the server then declines. (Such a profile can't
// reach a shipped registry — `validateSpeedProfileTable` strips it — so this is
// belt-and-braces against a hand-edited one, and must not diverge.)
export const DEFAULT_SPEED_PROFILE_MODES = ['text', 'image'];
// Accepts a single mode OR the list of modes a request will actually run in —
// a chained render is one clip whose chunks differ (see videoChainChunkModes),
// and the server applies a profile to such a request only when EVERY chunk
// accepts it. Matching that here is what stops the picker from offering a
// speed-up the chain then declines wholesale.
export const speedProfilesForMode = (model, mode) => {
  const wanted = (Array.isArray(mode) ? mode : [mode]).map((m) => m || 'text');
  const modes = wanted.length > 0 ? wanted : ['text'];
  return speedProfilesForModel(model).filter((p) => {
    const declared = Array.isArray(p.modes) ? p.modes : DEFAULT_SPEED_PROFILE_MODES;
    return modes.every((m) => declared.includes(m));
  });
};

// The modes a request's chunks will run in, mirroring generateChainedVideo's
// own dispatch: chunk 0 keeps the request's mode, and chunks 1+ re-enter as
// `extend` on a window-continuity chain or `image` on a frame hop. The
// window/frame rule mirrors resolveContinuityStrategy in
// server/lib/videoContinuity.js — the same predicate supportsContextWindow
// already mirrors for the Continuity control above.
// `hasSourceImage` mirrors the server's own inference for an ABSENT mode
// (`rest.mode || (rest.sourceImagePath ? 'image' : 'text')`). The panel always
// passes `mode`, so it never fires there — but keeping the fallback identical
// means the two cannot disagree for a caller that omits it, which matters the
// moment a profile ships supporting 'text' but not 'image'.
export const videoChainChunkModes = ({ model, mode, chaining, contextFrames, hasSourceImage = false }) => {
  const first = mode || (hasSourceImage ? 'image' : 'text');
  if (!chaining) return [first];
  // resolveContextFrames (server/lib/videoContinuity.js) reads absent / '' /
  // non-finite as DEFAULT_CONTEXT_FRAMES, NOT as zero — so a request that omits
  // the field chains with a window. Reading it as a frame hop here would show
  // the Fast picker and grey out Steps/CFG for a chain the server then declines
  // wholesale, which is the precise failure this gate exists to prevent.
  const windowHop = resolveContextFramesForDisplay(contextFrames) > 0 && supportsContextWindow(model);
  return [first, windowHop ? 'extend' : 'image'];
};

// Display-side mirror of resolveContextFrames. Only the absent/invalid→default
// rule matters for the gate above; the clamp is the server's business.
export const resolveContextFramesForDisplay = (requested) => {
  if (requested == null || requested === '') return DEFAULT_CONTEXT_FRAMES;
  const n = Number(requested);
  return Number.isFinite(n) ? n : DEFAULT_CONTEXT_FRAMES;
};
// Snap a selection onto what the (possibly just-switched) model declares, so
// the <select> is never left on a value with no matching <option>. Deliberately
// NOT mode-filtered: switching to fflf hides the picker, it must not silently
// rewrite the choice the user makes again when they switch back.
export const normalizeSpeedProfileForModel = (id, model) => (
  speedProfilesForModel(model).some((p) => p.id === id) ? id : DEFAULT_SPEED_PROFILE_ID
);
// Read a profile out of a persisted record (a history entry, a resumed job's
// params). Both record only a NON-default profile, so a missing field means
// Quality — and must CLEAR a leftover selection rather than carry it into a
// render the user asked to reproduce.
export const speedProfileIdFromRecord = (value) => (
  typeof value === 'string' && value ? value : DEFAULT_SPEED_PROFILE_ID
);
// The profile actually driving THIS render, or null for Quality / an unknown id
// / one this mode doesn't support. The picker disables Steps and CFG on exactly
// this — a profile owns both dials together, the same way a `samplerLocked`
// model does — so it must agree with what the server will resolve.
export const selectedSpeedProfile = (id, model, mode = null) => (
  isDefaultSpeedProfileId(id) ? null : speedProfilesForMode(model, mode).find((p) => p.id === id) || null
);

// --- Draft decode (#5423) -------------------------------------------------
// Mirrors server/lib/videoDraftDecoders.js. The OPTION LIST is server-declared
// and rides to the client on each model entry as `draftDecodeOptions` (built by
// `publicVideoDraftDecodeOptions`), so there is no client-side decoder table to
// drift — only the same "absence IS full decode" sentinel rule the speed-profile
// and text-encoder helpers above follow.
export const DEFAULT_DRAFT_DECODE_ID = 'full';
export const isFullDecodeId = (id) => (
  id == null || id === '' || id === DEFAULT_DRAFT_DECODE_ID
);
// The decode choices this model offers, or [] when it declares no draft decoder
// — which is the signal to render NO control rather than a one-entry select.
export const draftDecodeOptionsForModel = (model) => (
  Array.isArray(model?.draftDecodeOptions) ? model.draftDecodeOptions.filter((o) => o?.id) : []
);
export const supportsDraftDecode = (model) => draftDecodeOptionsForModel(model).length > 0;
// Snap a selection onto what the (possibly just-switched) model declares, so
// the <select> is never left on a value with no matching <option>.
export const normalizeDraftDecodeForModel = (id, model) => (
  draftDecodeOptionsForModel(model).some((o) => o.id === id) ? id : DEFAULT_DRAFT_DECODE_ID
);
// Read a decode out of a persisted record (a history entry, a resumed job's
// params). Both record only a NON-default decode, so a missing field means Full
// — and must CLEAR a leftover selection rather than carry it into a render the
// user asked to reproduce.
export const draftDecodeFromRecord = (value) => (
  typeof value === 'string' && value ? value : DEFAULT_DRAFT_DECODE_ID
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

// Host RAM PortOS holds back from a MiniMax H3 render's ALLOCATOR for the OS and
// itself. Mirrors MINIMAX_H3_HOST_RESERVE_GB in server/lib/minimaxH3Memory.js —
// the only number mirrored here, because the per-profile floors ride on the
// model entry the client already fetches — and pinned by
// server/lib/minimaxH3Memory.test.js. It is reported, never subtracted before
// comparing against a profile's floor: those floors are total-RAM claims, so
// netting it off first would put the 128 GB model out of reach of a 128 GB box.
export const VIDEO_MEMORY_RESERVE_GB = 16;

// The weight-placement profile this machine can hold, out of the ones the model
// declares (#5420). Entries carry `memoryProfiles` best-first, each with an
// honest `minMemoryGb` total-RAM floor, so the disclosure can name the recipe a
// render will really get rather than only the headline `memoryGb`.
//
// Returns `{ profile, usableGb, floorGb }`:
//   profile  the best profile that fits, or `null` when none does
//   usableGb system memory minus the reserve — what the allocator is actually
//            capped at — or `null` when unmeasured. That null is the "not
//            measured" sentinel, deliberately distinct from a small number so an
//            absent /status field never renders as "this box is too small".
//   floorGb  the smallest floor any declared profile has, so a UI that has to
//            say what it would take has the number
export const selectVideoMemoryProfile = (model, systemMemoryGb) => {
  const profiles = Array.isArray(model?.memoryProfiles)
    ? model.memoryProfiles.filter((profile) => typeof profile?.id === 'string' && profile.id)
    : [];
  const floors = profiles
    .map((profile) => Number(profile.minMemoryGb))
    .filter((floor) => Number.isFinite(floor) && floor > 0);
  const floorGb = floors.length > 0 ? Math.min(...floors) : null;
  const system = Number(systemMemoryGb);
  const measured = Number.isFinite(system) && system > 0 ? system : null;
  const usableGb = measured === null ? null : Math.max(0, measured - VIDEO_MEMORY_RESERVE_GB);
  if (profiles.length === 0) return { profile: null, usableGb, floorGb };
  if (measured === null) return { profile: profiles[0], usableGb, floorGb };
  const profile = profiles.find((candidate) => {
    const floor = Number(candidate.minMemoryGb);
    return !Number.isFinite(floor) || floor <= 0 || measured >= floor;
  }) || null;
  return { profile, usableGb, floorGb };
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
