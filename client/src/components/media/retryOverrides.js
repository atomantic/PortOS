// Pure logic behind the queue's inline "Edit and retry" forms: the shared
// change-detection helpers, the video retry override builder, and the single
// model-compatibility reconciliation the video form applies when its model
// (or the async model catalog) changes. Kept free of React so the diffing is
// unit-testable without rendering the form.
import { isDefaultA2vLoraStages } from '../../lib/videoLoraStages';
import {
  DEFAULT_I2V_REFERENCE_MODE, isDefaultI2vReferenceMode, normalizeI2vReferenceMode,
  runtimeSupportsI2vReferenceMode,
} from '../../lib/videoReferenceModes';
import {
  isMiniMaxH3SpeedProfile, normalizeTextEncoderForModel, DEFAULT_SPEED_PROFILE_ID,
  normalizeSpeedProfileForModel, isFullDecodeId, resolveDraftDecodeForModel,
  selectedContextFramesForModel,
} from '../../lib/videoGenParams';
import { isDefaultVideoStreamingMode, videoStreamingModeFromRecord } from '../../lib/videoStreamingMode';

// Safe-read a Codex job's stored reasoning effort. Mirrors codex.js's server-side
// guard (`typeof effort === 'string' && effort.trim()`): a non-string value from
// hand-edited media-jobs.json returns '' instead of throwing on `.trim()`, and a
// blank/absent value returns '' so callers can apply their own fallback (the row
// resolves to the shipped default level; the retry editor to its 'default' option).
export const codexEffortOf = (raw) => (typeof raw === 'string' ? raw.trim() : '');

export const textChanged = (value, original) => (value || '').trim() !== (original || '').trim();

// A blank form field reads as "no value" so it compares equal to an absent original.
export const numberChanged = (value, original) => (value === '' ? null : Number(value)) !== (original ?? null);

const orNull = (overrides) => (Object.keys(overrides).length ? overrides : null);
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Snap every model-bound draft value onto what `model` declares. Models arrive
// asynchronously, so an unresolved model means "not known yet", never "cannot
// honor it" — the draft is returned untouched until the catalog entry exists.
// Used by one effect keyed on the model so a model switch and the initial
// catalog load go through the same normalization:
//   - contextFrames: clamp to the model's supported window;
//   - i2vReferenceMode: a model that pins frame one offers only Anchor (#4874),
//     so a stranded `inspire` would be invisible to the user and rejected on submit;
//   - textEncoderId / speedProfileId: drop a recorded value the registry no longer offers;
//   - draftDecode: snap to the model's decoders (Full for a delivery model).
export function reconcileModelBoundParams(model, models, draft) {
  if (!model) return draft;
  const keepReferenceMode = isDefaultI2vReferenceMode(draft.i2vReferenceMode)
    || runtimeSupportsI2vReferenceMode(model.runtime, draft.i2vReferenceMode);
  return {
    contextFrames: selectedContextFramesForModel(model, draft.contextFrames),
    i2vReferenceMode: keepReferenceMode ? draft.i2vReferenceMode : DEFAULT_I2V_REFERENCE_MODE,
    textEncoderId: normalizeTextEncoderForModel(draft.textEncoderId, model),
    speedProfileId: normalizeSpeedProfileForModel(draft.speedProfileId, model),
    draftDecode: resolveDraftDecodeForModel(draft.draftDecode, model, models),
  };
}

function chainingOverrides(draft, p, { chainingActive, displayedContextFrames }) {
  const overrides = {};
  if (numberChanged(draft.chunks, p.chunks ?? 1)) overrides.chunks = Number(draft.chunks);
  if (Number(draft.chunks) <= 1 && Number(p.chunks ?? 1) > 1) overrides.chunkPrompts = [];
  else if (!sameJson(draft.chunkPrompts, p.chunkPrompts || [])) overrides.chunkPrompts = draft.chunkPrompts;
  const submittedContextFrames = chainingActive ? displayedContextFrames : 0;
  if (numberChanged(submittedContextFrames, p.contextFrames ?? 0)) overrides.contextFrames = submittedContextFrames;
  if (chainingActive || p.continuityStrategy != null) {
    const continuityStrategy = submittedContextFrames > 0 ? 'window' : 'frame';
    if (continuityStrategy !== p.continuityStrategy) overrides.continuityStrategy = continuityStrategy;
  }
  return overrides;
}

function numericOverrides(draft, p) {
  const overrides = {};
  if (numberChanged(draft.width, p.width) && draft.width !== '') overrides.width = Number(draft.width);
  if (numberChanged(draft.height, p.height) && draft.height !== '') overrides.height = Number(draft.height);
  if (draft.numFrames !== '' && numberChanged(draft.numFrames, p.numFrames)) overrides.numFrames = Number(draft.numFrames);
  if (draft.fps !== '' && numberChanged(draft.fps, p.fps)) overrides.fps = Number(draft.fps);
  // Clearable knobs: a blanked field that the original carried resets it with `null`.
  for (const key of ['seed', 'steps', 'guidanceScale', 'imageStrength']) {
    if (draft[key] === '') {
      if (p[key] != null) overrides[key] = null;
    } else if (numberChanged(draft[key], p[key])) {
      overrides[key] = Number(draft[key]);
    }
  }
  return overrides;
}

// Model-bound knobs. A model switch counts as a change for each of them: the
// switch can snap an inherited value to the default locally (so local and
// baseline compare equal) while the old job's value would otherwise ride
// through the retry's inherited params and be echoed for a render that never
// used it. `null` clears the inherited request because an explicit default and
// an absent field are the same request.
function modelBoundOverrides(draft, p, context, modelChanged, overrides) {
  const { currentModel, originalEncoder, originalSpeedProfileForModel, originalDraftDecode } = context;
  const out = {};
  if (modelChanged || draft.textEncoderId !== originalEncoder) out.textEncoderId = draft.textEncoderId;
  if (modelChanged || draft.speedProfileId !== originalSpeedProfileForModel) {
    out.speedProfileId = draft.speedProfileId === DEFAULT_SPEED_PROFILE_ID ? null : draft.speedProfileId;
  }
  // MiniMax H3 profiles own their own sampler, so inherited steps/guidance must be dropped.
  if (currentModel?.speedProfiles?.some((profile) => profile.id === draft.speedProfileId && isMiniMaxH3SpeedProfile(profile))) {
    if (p.steps != null || overrides.steps !== undefined) out.steps = null;
    if (p.guidanceScale != null || overrides.guidanceScale !== undefined) out.guidanceScale = null;
  }
  if (modelChanged || draft.draftDecode !== originalDraftDecode) {
    out.draftDecode = isFullDecodeId(draft.draftDecode) ? null : draft.draftDecode;
  }
  return out;
}

function flagOverrides(draft, p) {
  const overrides = {};
  if (draft.i2vReferenceMode !== normalizeI2vReferenceMode(p.i2vReferenceMode)) {
    // `null` clears the persisted value, mirroring the numeric knobs — an
    // explicit 'anchor' would leave the retry carrying a knob that changed nothing.
    overrides.i2vReferenceMode = isDefaultI2vReferenceMode(draft.i2vReferenceMode) ? null : draft.i2vReferenceMode;
  }
  if (draft.tiling !== (p.tiling || 'auto')) overrides.tiling = draft.tiling;
  if (draft.disableAudio !== (p.disableAudio === true)) overrides.disableAudio = draft.disableAudio;
  if (!sameJson(draft.a2vLoraStageStrengths, p.a2vLoraStageStrengths ?? [1, 1])) {
    overrides.a2vLoraStageStrengths = isDefaultA2vLoraStages(draft.a2vLoraStageStrengths) ? null : draft.a2vLoraStageStrengths;
  }
  if (draft.streamingMode !== videoStreamingModeFromRecord(p.streamingMode)) {
    overrides.streamingMode = isDefaultVideoStreamingMode(draft.streamingMode) ? null : draft.streamingMode;
  }
  if (!sameJson(draft.selectedLoras, p.loras || [])) overrides.loras = draft.selectedLoras;
  return overrides;
}

// Diff the video retry draft against the original job params and return only
// the keys the user changed (null when nothing changed) so unchanged fields
// ride through from the original job. `context` carries the model-derived
// baselines the form computes: { currentModel, isHosted, chainingActive,
// displayedContextFrames, originalEncoder, originalSpeedProfileForModel,
// originalDraftDecode }.
export function buildVideoRetryOverrides(draft, p, context) {
  const overrides = {};
  if (textChanged(draft.prompt, p.prompt)) overrides.prompt = draft.prompt.trim();
  if (textChanged(draft.negativePrompt, p.negativePrompt)) overrides.negativePrompt = draft.negativePrompt.trim();
  // A hosted retry edits only the prompts: size, duration and model are the
  // provider's own params, and every field below is a local-render knob that
  // would rewrite them.
  if (context.isHosted) return orNull(overrides);
  const modelChanged = textChanged(draft.modelId, p.modelId);
  if (modelChanged) overrides.modelId = draft.modelId.trim();
  Object.assign(overrides, numericOverrides(draft, p), chainingOverrides(draft, p, context));
  Object.assign(overrides, flagOverrides(draft, p));
  Object.assign(overrides, modelBoundOverrides(draft, p, context, modelChanged, overrides));
  return orNull(overrides);
}
