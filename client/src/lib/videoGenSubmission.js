import { composeStyledPrompt } from './composeStyledPrompt';
import { isLtx2FamilyRuntime } from './runnerFamilies';
import { isDefaultI2vReferenceMode } from './videoReferenceModes';
import { clampImageEdge } from './imageGenResolutions';
import {
  VIDEO_EDGE_BOUNDS,
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

// The form owns state transitions and validation. This module owns the three
// request contracts the video route accepts: Grok, federated, and local.
export function envelopVideoPrompt(text, {
  currentModel, negativePrompt, stylePreset, noMusic, disableAudio,
}) {
  const composed = composeStyledPrompt(text, negativePrompt, stylePreset);
  const effectiveDisableAudio = supportsVideoAudioControls(currentModel) && disableAudio;
  return (supportsVideoAudioPromptControls(currentModel) && noMusic && !effectiveDisableAudio && !/no music/i.test(composed.prompt))
    ? `${composed.prompt}\n\nno music, no soundtrack`
    : composed.prompt;
}

export function buildVideoGenSubmission({
  isGrok, grokDuration, remoteSubmissionFields,
  prompt, negativePrompt, stylePreset,
  width, height, mode, sourceImageFile, sourceImageUpload,
  numFrames, fps, steps, guidanceScale, seed,
  currentModel, models, modelId, tiling, textEncoderId, speedProfileId, draftDecode,
  disableAudio, noMusic, imageStrength, i2vReferenceMode,
  keyframesActive, keyframes, loraFamily, selectedLoras,
  lastImageFile, lastImageUpload, extendFromVideoId, audioFile,
  icModeActive, icImageKind, icReferenceFile, icReferenceVideoId,
  icReferenceImageFiles, icStrength, icSkipStage2,
  chainingActive, chunks, chunkPrompts, contextFrames,
}) {
  const composed = composeStyledPrompt(prompt, negativePrompt, stylePreset);
  const effectiveDisableAudio = supportsVideoAudioControls(currentModel) && disableAudio;
  const withEnvelope = (text) => envelopVideoPrompt(text, {
    currentModel, negativePrompt, stylePreset, noMusic, disableAudio,
  });
  // The backing array is deliberately not truncated as chunks change. Only
  // slice live chunks at the wire boundary.
  const beats = chainingActive
    ? chunkPrompts.slice(0, chunks).map((beat) => (beat?.trim() ? withEnvelope(beat) : ''))
    : [];

  if (isGrok) {
    return {
      backend: 'grok',
      prompt: composed.prompt,
      negativePrompt: composed.negativePrompt,
      grokDuration,
      width: clampImageEdge(width, VIDEO_EDGE_BOUNDS),
      height: clampImageEdge(height, VIDEO_EDGE_BOUNDS),
      mode: mode === 'image' ? 'image' : 'text',
      sourceImageFile: mode === 'image' ? (sourceImageFile || '') : '',
      sourceImage: mode === 'image' ? (sourceImageUpload || '') : '',
    };
  }

  if (remoteSubmissionFields) {
    return {
      backend: 'local',
      mode: 'text',
      prompt: composed.prompt,
      negativePrompt: composed.negativePrompt,
      width: clampImageEdge(width, VIDEO_EDGE_BOUNDS),
      height: clampImageEdge(height, VIDEO_EDGE_BOUNDS),
      numFrames,
      fps,
      steps: steps || '',
      guidanceScale: guidanceScale || '',
      seed: seed || '',
      ...remoteSubmissionFields,
    };
  }

  const legacyFflf = mode === 'fflf' && !keyframesActive;
  const localEdgeBounds = videoEdgeBoundsForModel(currentModel);
  return {
    backend: 'local',
    prompt: withEnvelope(prompt),
    negativePrompt: currentModel?.supportsNegativePrompt === false ? '' : composed.negativePrompt,
    modelId,
    width: clampImageEdge(width, localEdgeBounds),
    height: clampImageEdge(height, localEdgeBounds),
    numFrames,
    fps,
    steps: steps || '',
    guidanceScale: guidanceScale || '',
    seed: seed || '',
    tiling: currentModel?.supportsTiling === false ? 'auto' : tiling,
    textEncoderId: normalizeTextEncoderForModel(textEncoderId, currentModel) === STOCK_TEXT_ENCODER_ID
      ? undefined
      : textEncoderId,
    speedProfileId: selectedSpeedProfile(speedProfileId, currentModel, videoChainChunkModes({
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
    disableAudio: effectiveDisableAudio ? 'true' : 'false',
    mode,
    imageStrength: imageStrength || '',
    i2vReferenceMode: isDefaultI2vReferenceMode(i2vReferenceMode) ? '' : i2vReferenceMode,
    keyframes: keyframesActive ? JSON.stringify(keyframes) : '',
    loraFilenames: (loraFamily && selectedLoras.length) ? selectedLoras.map((lora) => lora.filename) : undefined,
    loraScales: (loraFamily && selectedLoras.length) ? selectedLoras.map((lora) => lora.scale) : undefined,
    sourceImageFile: (mode === 'image' || legacyFflf
      || (mode === 'extend' && !isLtx2FamilyRuntime(currentModel?.runtime)))
      ? (sourceImageFile || '') : '',
    sourceImage: (mode === 'image' || legacyFflf) ? (sourceImageUpload || '') : '',
    lastImageFile: legacyFflf ? (lastImageFile || '') : '',
    lastImage: legacyFflf ? (lastImageUpload || '') : '',
    extendFromVideoId: (mode === 'extend' && isLtx2FamilyRuntime(currentModel?.runtime))
      ? (extendFromVideoId || '') : '',
    audioFile: mode === 'a2v' ? (audioFile || '') : '',
    icReference: (icModeActive && !icImageKind) ? (icReferenceFile || '') : '',
    icReferenceVideoIds: (icModeActive && !icImageKind && !icReferenceFile) ? (icReferenceVideoId || '') : '',
    icReferenceImageFiles: icImageKind ? icReferenceImageFiles.filter(Boolean) : undefined,
    icStrength: icModeActive ? icStrength : '',
    icSkipStage2: icModeActive && icSkipStage2 ? 'true' : '',
    chunks: chainingActive ? chunks : '',
    chunkPrompts: beats.some((beat) => beat.trim()) ? JSON.stringify(beats) : '',
    contextFrames: chainingActive ? String(contextFrames) : '',
  };
}
