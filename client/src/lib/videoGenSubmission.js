import { isDefaultA2vLoraStages } from './videoLoraStages.js';
import { composeStyledPrompt, stylePromptAdditions } from './composeStyledPrompt';
import { universeStylePreset, withUniverseLabel } from './universeStylePreset.js';
import { isLtx2FamilyRuntime } from './runnerFamilies';
import { isDefaultI2vReferenceMode } from './videoReferenceModes';
import { clampImageEdge } from './imageGenResolutions';
import {
  isMiniMaxH3SpeedProfile, VIDEO_EDGE_BOUNDS,
  videoEdgeBoundsForModel,
  supportsVideoAudioControls,
  supportsVideoAudioPromptControls,
  normalizeTextEncoderForModel,
  STOCK_TEXT_ENCODER_ID,
  selectedSpeedProfile,
  videoChainChunkModes,
  DEFAULT_DRAFT_DECODE_ID,
  resolveDraftDecodeForModel,
} from './videoGenParams.js';
import { isDefaultVideoStreamingMode } from './videoStreamingMode.js';

// The form owns state transitions and validation. This module owns the three
// request contracts the video route accepts: Grok, federated, and local.
const stylePresetsFor = (selectedUniverse, stylePreset) => [
  selectedUniverse ? withUniverseLabel(universeStylePreset(selectedUniverse)) : null,
  stylePreset,
].filter(Boolean);

/**
 * The prompt the cloud lanes actually submit: the user's text with any universe
 * / style-preset prompt folded in front of it. Exported because reactor.inc caps
 * the SUBMITTED prompt at 800 characters — the form's counter has to measure the
 * same string this module builds, not the raw textarea, or a preset silently
 * pushes a "safe" prompt over the cap.
 */
export const styledVideoPrompt = (text, { negativePrompt, stylePreset, selectedUniverse } = {}) =>
  composeStyledPrompt(text, negativePrompt, stylePresetsFor(selectedUniverse, stylePreset)).prompt;

export function envelopVideoPrompt(text, {
  currentModel, negativePrompt, stylePreset, selectedUniverse, noMusic, disableAudio,
}) {
  const composed = composeStyledPrompt(text, negativePrompt, stylePresetsFor(selectedUniverse, stylePreset));
  return addsNoMusic(composed.prompt, { currentModel, noMusic, disableAudio })
    ? `${composed.prompt}\n\n${NO_MUSIC_LINE}`
    : composed.prompt;
}

const NO_MUSIC_LINE = 'no music, no soundtrack';

// The "No music" toggle's line, added only on a model that takes audio prompt
// controls while its audio is on, and only once.
const addsNoMusic = (composedPrompt, { currentModel, noMusic, disableAudio }) => {
  const effectiveDisableAudio = supportsVideoAudioControls(currentModel) && disableAudio;
  return supportsVideoAudioPromptControls(currentModel) && noMusic && !effectiveDisableAudio && !/no music/i.test(composedPrompt);
};

/** Everything the form adds around the typed prompt, as labeled chips (#11317). */
export function videoPromptAdditions({ prompt, negativePrompt, stylePreset, selectedUniverse, currentModel, noMusic, disableAudio, isLocal = true }) {
  const presets = stylePresetsFor(selectedUniverse, stylePreset);
  const composed = composeStyledPrompt(prompt, negativePrompt, presets);
  return [
    ...stylePromptAdditions(presets),
    ...(isLocal && addsNoMusic(composed.prompt, { currentModel, noMusic, disableAudio })
      ? [{ id: 'no-music', label: 'No music', text: NO_MUSIC_LINE }] : []),
  ];
}

// Hosted lanes (Grok, fal, reactor, Runway) take only text or image mode, and the
// source pair is meaningful only in image mode. '' is the wire value otherwise.
const hostedImageFields = (mode, sourceImageFile, sourceImageUpload) => {
  const isImage = mode === 'image';
  return {
    mode: isImage ? 'image' : 'text',
    sourceImageFile: isImage ? (sourceImageFile || '') : '',
    sourceImage: isImage ? (sourceImageUpload || '') : '',
  };
};

const clampedSize = (width, height, bounds = VIDEO_EDGE_BOUNDS) => ({
  width: clampImageEdge(width, bounds),
  height: clampImageEdge(height, bounds),
});

// A seed of 0 is a real value; only an unset seed is omitted.
const omitReactorSeed = (reactorSeed) => (
  reactorSeed === '' || reactorSeed === null || reactorSeed === undefined ? undefined : reactorSeed
);

function grokVideoSubmission({
  composed, grokDuration, width, height, mode, sourceImageFile, sourceImageUpload,
}) {
  return {
    backend: 'grok',
    prompt: composed.prompt,
    negativePrompt: composed.negativePrompt,
    grokDuration,
    ...clampedSize(width, height),
    ...hostedImageFields(mode, sourceImageFile, sourceImageUpload),
  };
}

function falVideoSubmission({
  composed, falDuration, falModelId, falResolution, falGenerateAudio,
  width, height, mode, sourceImageFile, sourceImageUpload,
}) {
  return {
    backend: 'fal',
    prompt: composed.prompt,
    // No negativePrompt: fal's buildRequestBody never sends one, so posting it
    // only stamped a promise on the history record that nothing honored.
    falDuration,
    falModelId: falModelId || undefined,
    ...(falResolution ? { falResolution } : {}),
    ...(falGenerateAudio ? { falGenerateAudio: true } : {}),
    ...clampedSize(width, height),
    ...hostedImageFields(mode, sourceImageFile, sourceImageUpload),
  };
}

// Runway renders from a start frame (Image mode) or, on a model with a
// text-to-video rule, from the prompt alone (Text mode). The negative prompt is sent; the server passes it
// natively or as an "Avoid:" line, listed as a chip in the sent-prompt view.
function runwayVideoSubmission({
  composed, runwayModelId, runwayDuration, runwayResolution, runwayInputs = {},
  width, height, mode, sourceImageFile, sourceImageUpload,
}) {
  if (mode === 'video-edit' || mode === 'character-performance') return {
    backend: 'runway', mode, runwayModelId,
    prompt: mode === 'character-performance' ? '' : composed.prompt,
    negativePrompt: mode === 'character-performance' ? '' : composed.negativePrompt,
    runwayVideo: runwayInputs.video || '',
    runwayCharacterVideo: mode === 'character-performance' ? runwayInputs.characterVideo || '' : '',
    sourceImageFile: runwayInputs.characterVideo ? '' : sourceImageFile || '',
    sourceImage: runwayInputs.characterVideo ? '' : sourceImageUpload || '',
    ...(runwayInputs.targetAspectRatio ? { runwayTargetAspect: runwayInputs.targetAspectRatio } : {}),
    ...(runwayInputs.ratio ? { runwayRatio: runwayInputs.ratio } : {}),
    ...(mode === 'character-performance' ? { runwayBodyControl: runwayInputs.bodyControl ?? true, runwayExpressionIntensity: runwayInputs.expressionIntensity ?? 3 } : {}),
    ...(runwayInputs.seed != null && runwayInputs.seed !== '' ? { runwaySeed: Number(runwayInputs.seed) } : {}),
  };
  return {
    backend: 'runway',
    prompt: composed.prompt,
    negativePrompt: composed.negativePrompt,
    runwayModelId: runwayModelId || undefined,
    ...(runwayDuration ? { runwayDuration: Number(runwayDuration) } : {}),
    ...(runwayResolution ? { runwayResolution } : {}),
    ...clampedSize(width, height),
    ...hostedImageFields(mode, sourceImageFile, sourceImageUpload),
  };
}

function reactorVideoSubmission({
  composed, reactorClipId, reactorSeconds, reactorSeed, reactorAspect,
  mode, sourceImageFile, sourceImageUpload,
}) {
  return {
    backend: 'reactor',
    prompt: composed.prompt,
    // No negativePrompt: fast-h3's enqueue command has no such field (same as
    // the fal lane above).
    // The clip id chains this render onto a previous reactor clip via
    // continue_from_clip_id; the picker only offers ids off completed reactor
    // history records. Dropped in Image mode because continuation and a
    // starting frame are exclusive — the service rejects a request carrying
    // both, and the picker is already disabled there.
    reactorClipId: (mode === 'image' ? '' : reactorClipId) || undefined,
    reactorSeconds: reactorSeconds || undefined,
    // Unlike falDuration/falModelId, a seed of 0 is a real, meaningful
    // value — `|| undefined` would silently drop it.
    reactorSeed: omitReactorSeed(reactorSeed),
    // No width/height: fast-h3's resolution is its session CANVAS, and every
    // canvas holds a 768px short edge, so the aspect string is the whole
    // choice. '' is the picker's Auto entry — sending nothing asks the server
    // to derive the canvas from the starting frame instead of opening the
    // 16:9 session that squeezed a portrait image into a landscape render.
    reactorAspect: reactorAspect || undefined,
    ...hostedImageFields(mode, sourceImageFile, sourceImageUpload),
  };
}

function remoteVideoSubmission({
  composed, remoteSubmissionFields, width, height, numFrames, fps, steps, guidanceScale, seed,
}) {
  return {
    backend: 'local',
    mode: 'text',
    prompt: composed.prompt,
    negativePrompt: composed.negativePrompt,
    ...clampedSize(width, height),
    numFrames,
    fps,
    steps: steps || '',
    guidanceScale: guidanceScale || '',
    seed: seed ?? '',
    ...remoteSubmissionFields,
  };
}

const attachesStartFrame = (mode, runtime, legacyFflf) => (
  mode === 'image' || mode === 'a2v' || legacyFflf
  || (mode === 'extend' && !isLtx2FamilyRuntime(runtime))
);

// The inline-upload half of the start frame: an extend on a non-LTX-2 runtime
// reuses a stored file only, so it never carries an upload.
const attachesStartUpload = (mode, legacyFflf) => mode === 'image' || mode === 'a2v' || legacyFflf;

// LTX-2 extends continue a prior render by id instead of a start frame.
const attachesExtendSource = (mode, runtime) => mode === 'extend' && isLtx2FamilyRuntime(runtime);

function frameSourceFields({
  mode, runtime, legacyFflf, sourceImageFile, sourceImageUpload,
  lastImageFile, lastImageUpload, extendFromVideoId, audioFile,
}) {
  return {
    sourceImageFile: attachesStartFrame(mode, runtime, legacyFflf) ? (sourceImageFile || '') : '',
    sourceImage: attachesStartUpload(mode, legacyFflf) ? (sourceImageUpload || '') : '',
    lastImageFile: legacyFflf ? (lastImageFile || '') : '',
    lastImage: legacyFflf ? (lastImageUpload || '') : '',
    extendFromVideoId: attachesExtendSource(mode, runtime) ? (extendFromVideoId || '') : '',
    audioFile: mode === 'a2v' ? (audioFile || '') : '',
  };
}

// IC-LoRA references: a video reference (file wins over a stored video id) and
// image references are mutually exclusive by `icImageKind`.
function icReferenceFields({
  icModeActive, icImageKind, icReferenceFile, icReferenceVideoId,
  icReferenceImageFiles, icStrength, icSkipStage2,
}) {
  const videoKind = icModeActive && !icImageKind;
  return {
    icReference: videoKind ? (icReferenceFile || '') : '',
    icReferenceVideoIds: (videoKind && !icReferenceFile) ? (icReferenceVideoId || '') : '',
    icReferenceImageFiles: icImageKind ? icReferenceImageFiles.filter(Boolean) : undefined,
    icStrength: icModeActive ? icStrength : '',
    icSkipStage2: icModeActive && icSkipStage2 ? 'true' : '',
  };
}

// Extra reference stills for a reference-to-video model. Sent only when the
// selected model takes them, so a stale list from a previous model never rides
// along to one that would reject it.
function referenceImageFields({ currentModel, referenceImageFiles = [], referenceVideoIds = [], referenceAudioFiles = [] }) {
  const max = Number(currentModel?.maxReferenceImages) || 0;
  const files = max > 1 ? referenceImageFiles.filter(Boolean).slice(0, max - 1) : [];
  const clips = referenceVideoIds.filter(Boolean).slice(0, Number(currentModel?.maxReferenceVideos) || 0);
  const voices = referenceAudioFiles.slice(0, Number(currentModel?.maxReferenceAudios) || 0);
  return {
    ...(files.length ? { referenceImageFiles: files } : {}),
    ...(clips.length ? { referenceVideoIds: clips } : {}),
    // The streaming parser keeps one file per field name, hence indexed slots.
    ...Object.fromEntries(voices.map((file, i) => [`referenceAudio${i}`, file])),
  };
}

function chunkFields({ chainingActive, chunks, beats, contextFrames }) {
  return {
    chunks: chainingActive ? chunks : '',
    chunkPrompts: beats.some((beat) => beat.trim()) ? JSON.stringify(beats) : '',
    contextFrames: chainingActive ? String(contextFrames) : '',
  };
}

// Request-only knobs whose absence (undefined) means "server default".
function localOptionalFields({
  currentModel, models, textEncoderId, speedProfileId, draftDecode, streamingMode,
  mode, chainingActive, contextFrames,
}) {
  return {
    textEncoderId: normalizeTextEncoderForModel(textEncoderId, currentModel) === STOCK_TEXT_ENCODER_ID
      ? undefined
      : textEncoderId,
    speedProfileId: currentModel?.speedProfiles?.some((p) => p.id === speedProfileId && isMiniMaxH3SpeedProfile(p))
      ? speedProfileId : selectedSpeedProfile(speedProfileId, currentModel, videoChainChunkModes({
      model: currentModel, mode, chaining: chainingActive, contextFrames,
    }))?.id,
    // Preview-fidelity decode (#5423). Sent only when it is a real, still-valid
    // choice on THIS model — a stale selection carried across a model switch, or
    // one aimed at a DELIVERY model, would otherwise POST a knob the server
    // declines and logs. Absence is a full decode, so an unswapped render's
    // payload is unchanged.
    draftDecode: resolveDraftDecodeForModel(draftDecode, currentModel, models) === DEFAULT_DRAFT_DECODE_ID
      ? undefined
      : draftDecode,
    // Block-streaming request (#6499). Sent only when it is both a real
    // choice (this model's runtime is LTX-2/2.5 MLX — every other runtime
    // ignores the flag by construction, so sending it there would just be a
    // stale value the server logs and drops) and a non-default one — a
    // model switch away from LTX2 or back to Auto both leave the payload
    // absent, so an unswapped render stays byte-identical.
    streamingMode: (isLtx2FamilyRuntime(currentModel?.runtime) && !isDefaultVideoStreamingMode(streamingMode))
      ? streamingMode
      : undefined,
  };
}

function loraFields({ loraFamily, selectedLoras }) {
  const hasLoras = loraFamily && selectedLoras.length;
  return {
    loraFilenames: hasLoras ? selectedLoras.map((lora) => lora.filename) : undefined,
    loraScales: hasLoras ? selectedLoras.map((lora) => lora.scale) : undefined,
  };
}

function conditioningFields({ mode, imageStrength, i2vReferenceMode, keyframesActive, keyframes }) {
  return {
    mode,
    imageStrength: imageStrength || '',
    i2vReferenceMode: isDefaultI2vReferenceMode(i2vReferenceMode) ? '' : i2vReferenceMode,
    keyframes: keyframesActive ? JSON.stringify(keyframes) : '',
  };
}

function localVideoSubmission(args, { composed, withEnvelope, effectiveDisableAudio, beats }) {
  const {
    prompt, width, height, mode, numFrames, fps, steps, guidanceScale, seed, batchSize = 1,
    currentModel, modelId, tiling, displaySleepEnabled, keyframesActive,
    chainingActive, chunks, contextFrames,
  } = args;
  const legacyFflf = mode === 'fflf' && !keyframesActive;
  const h3SpeedProfile = currentModel?.speedProfiles?.some((p) => p.id === args.speedProfileId && isMiniMaxH3SpeedProfile(p));
  return {
    backend: 'local',
    prompt: withEnvelope(prompt),
    negativePrompt: currentModel?.supportsNegativePrompt === false ? '' : composed.negativePrompt,
    modelId,
    ...clampedSize(width, height, videoEdgeBoundsForModel(currentModel)),
    numFrames,
    fps,
    steps: h3SpeedProfile ? '' : (steps || ''),
    guidanceScale: h3SpeedProfile ? '' : (guidanceScale || ''),
    seed: seed ?? '',
    ...(currentModel?.supportsWarmBatch && !chainingActive && batchSize > 1 ? { batchSize } : {}),
    tiling: currentModel?.supportsTiling === false ? 'auto' : tiling,
    ...localOptionalFields(args),
    disableAudio: effectiveDisableAudio ? 'true' : 'false',
    // Only meaningful on a runtime the GPU-watchdog mitigation applies to —
    // absent otherwise so an unrelated model's render never carries a stale
    // choice.
    ...(currentModel?.sleepsDisplayDuringRender ? { displaySleep: displaySleepEnabled ? 'true' : 'false' } : {}),
    ...conditioningFields(args),
    ...loraFields(args),
    ...frameSourceFields({ ...args, runtime: currentModel?.runtime, legacyFflf }),
    ...icReferenceFields(args),
    ...referenceImageFields(args),
    ...chunkFields({ chainingActive, chunks, beats, contextFrames }),
  };
}

// The backing array is deliberately not truncated as chunks change. Only
// slice live chunks at the wire boundary.
const liveBeats = (chainingActive, chunkPrompts, chunks, withEnvelope) => (
  chainingActive
    ? chunkPrompts.slice(0, chunks).map((beat) => (beat?.trim() ? withEnvelope(beat) : ''))
    : []
);

// Keyed by the form's resolved `hostedLane` (null = local or federated).
const HOSTED_VIDEO_SUBMISSIONS = {
  grok: grokVideoSubmission,
  fal: falVideoSubmission,
  reactor: reactorVideoSubmission,
  runway: runwayVideoSubmission,
};

export function buildVideoGenSubmission(args) {
  const {
    hostedLane, remoteSubmissionFields,
    prompt, negativePrompt, stylePreset, selectedUniverse,
    currentModel, disableAudio, noMusic, chainingActive, chunks, chunkPrompts,
  } = args;
  const composed = composeStyledPrompt(prompt, negativePrompt, stylePresetsFor(selectedUniverse, stylePreset));
  const withEnvelope = (text) => envelopVideoPrompt(text, {
    currentModel, negativePrompt, stylePreset, selectedUniverse, noMusic, disableAudio,
  });
  const shared = { ...args, composed };

  const isLocal = !hostedLane && !remoteSubmissionFields;
  const additions = hostedLane === 'runway' && args.mode === 'character-performance'
    ? [] : videoPromptAdditions({ ...args, isLocal });
  const payload = hostedLane ? HOSTED_VIDEO_SUBMISSIONS[hostedLane](shared)
    : remoteSubmissionFields ? remoteVideoSubmission(shared)
    : localVideoSubmission(args, {
      composed,
      withEnvelope,
      effectiveDisableAudio: supportsVideoAudioControls(currentModel) && disableAudio,
      beats: liveBeats(chainingActive, chunkPrompts, chunks, withEnvelope),
    });
  // Preserve an explicit schedule across backend/model switches: the server
  // must refuse unsupported execution instead of silently dropping this choice.
  if (!isDefaultA2vLoraStages(args.a2vLoraStageStrengths)) {
    payload.a2vLoraStageStrengths = JSON.stringify(args.a2vLoraStageStrengths);
  }
  return additions.length ? { ...payload, promptAdditions: additions } : payload;
}
