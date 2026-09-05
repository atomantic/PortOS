import { composeStyledPrompt } from './composeStyledPrompt';
import { universeStylePreset } from './universeStylePreset.js';
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
const stylePresetsFor = (selectedUniverse, stylePreset) => [
  selectedUniverse ? universeStylePreset(selectedUniverse) : null,
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
  const effectiveDisableAudio = supportsVideoAudioControls(currentModel) && disableAudio;
  return (supportsVideoAudioPromptControls(currentModel) && noMusic && !effectiveDisableAudio && !/no music/i.test(composed.prompt))
    ? `${composed.prompt}\n\nno music, no soundtrack`
    : composed.prompt;
}

export function buildVideoGenSubmission({
  isGrok, grokDuration, isFal, falDuration, falModelId,
  isReactor, reactorClipId, reactorSeconds, reactorSeed, reactorAspect, remoteSubmissionFields,
  displaySleepEnabled,
  prompt, negativePrompt, stylePreset, selectedUniverse,
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
  const composed = composeStyledPrompt(prompt, negativePrompt, stylePresetsFor(selectedUniverse, stylePreset));
  const effectiveDisableAudio = supportsVideoAudioControls(currentModel) && disableAudio;
  const withEnvelope = (text) => envelopVideoPrompt(text, {
    currentModel, negativePrompt, stylePreset, selectedUniverse, noMusic, disableAudio,
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

  if (isFal) {
    return {
      backend: 'fal',
      prompt: composed.prompt,
      // No negativePrompt: fal's buildRequestBody never sends one, so posting it
      // only stamped a promise on the history record that nothing honored.
      falDuration,
      falModelId: falModelId || undefined,
      width: clampImageEdge(width, VIDEO_EDGE_BOUNDS),
      height: clampImageEdge(height, VIDEO_EDGE_BOUNDS),
      mode: mode === 'image' ? 'image' : 'text',
      sourceImageFile: mode === 'image' ? (sourceImageFile || '') : '',
      sourceImage: mode === 'image' ? (sourceImageUpload || '') : '',
    };
  }

  if (isReactor) {
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
      // value — `|| undefined` would silently drop it (the reactor route
      // and reactor.js's own buildRequestBody already preserve 0 correctly,
      // so only the client-side send needs the nullish check).
      reactorSeed: reactorSeed === '' || reactorSeed === null || reactorSeed === undefined ? undefined : reactorSeed,
      // No width/height: fast-h3's resolution is its session CANVAS, and every
      // canvas holds a 768px short edge, so the aspect string is the whole
      // choice. '' is the picker's Auto entry — sending nothing asks the server
      // to derive the canvas from the starting frame instead of opening the
      // 16:9 session that squeezed a portrait image into a landscape render.
      reactorAspect: reactorAspect || undefined,
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
    // Only meaningful on a runtime the GPU-watchdog mitigation applies to —
    // absent otherwise so an unrelated model's render never carries a stale
    // choice. The grok/fal/reactor/remote branches above already returned, so
    // reaching here already means none of those apply.
    ...(currentModel?.sleepsDisplayDuringRender ? { displaySleep: displaySleepEnabled ? 'true' : 'false' } : {}),
    mode,
    imageStrength: imageStrength || '',
    i2vReferenceMode: isDefaultI2vReferenceMode(i2vReferenceMode) ? '' : i2vReferenceMode,
    keyframes: keyframesActive ? JSON.stringify(keyframes) : '',
    loraFilenames: (loraFamily && selectedLoras.length) ? selectedLoras.map((lora) => lora.filename) : undefined,
    loraScales: (loraFamily && selectedLoras.length) ? selectedLoras.map((lora) => lora.scale) : undefined,
    sourceImageFile: (mode === 'image' || mode === 'a2v' || legacyFflf
      || (mode === 'extend' && !isLtx2FamilyRuntime(currentModel?.runtime)))
      ? (sourceImageFile || '') : '',
    sourceImage: (mode === 'image' || mode === 'a2v' || legacyFflf) ? (sourceImageUpload || '') : '',
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
