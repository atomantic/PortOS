import { useMemo } from 'react';
import { isAudioToVideoRuntime, isLtx2FamilyRuntime } from '../lib/runnerFamilies.js';
import {
  computeFflfSafeFrames,
  icResolutionIssue,
  isModelAllowedForMode,
} from '../lib/videoGenParams.js';

export function validateVideoKeyframes({
  active, frames, height, keyframes, maxSafeFrames, width,
}) {
  if (!active) return null;
  if (keyframes.length < 2) return 'Add at least 2 keyframes.';
  if (keyframes.length > 8) return 'Use at most 8 keyframes.';

  let previousIndex = -1;
  for (let index = 0; index < keyframes.length; index += 1) {
    const keyframe = keyframes[index];
    if (!keyframe.file) return `Keyframe ${index + 1} needs a gallery image.`;
    if (!Number.isInteger(keyframe.index) || keyframe.index < 0) {
      return `Keyframe ${index + 1} needs a frame index ≥ 0.`;
    }
    if (keyframe.index > frames - 1) {
      return `Keyframe ${index + 1} frame ${keyframe.index} must be below numFrames (${frames}).`;
    }
    if (maxSafeFrames < frames && keyframe.index > maxSafeFrames - 1) {
      return `Keyframe ${index + 1} frame ${keyframe.index} exceeds the ${width}×${height} pixel budget (max frame ${maxSafeFrames - 1}). Lower the resolution or raise FFLF_LTX2_PIXEL_BUDGET.`;
    }
    if (keyframe.index <= previousIndex) return 'Keyframe frame indices must be strictly ascending.';
    previousIndex = keyframe.index;
  }
  return null;
}

/** Derives every submit-blocking predicate from the current VideoGen fields. */
export function useVideoGenValidation({
  audioDurationSec,
  audioFile,
  chunks,
  currentModel,
  extendFromVideoId,
  extendingFrame,
  fps,
  height,
  icImageKind,
  icModeActive,
  icReferenceFile,
  icReferenceImageFiles,
  icReferenceVideoId,
  icSpec,
  keyframes,
  keyframesActive,
  mode,
  numFrames,
  pixelBudget,
  sourceImageFile,
  sourceImageUpload,
  width,
}) {
  const maxSafeFrames = useMemo(
    () => computeFflfSafeFrames(width, height, numFrames, pixelBudget),
    [height, numFrames, pixelBudget, width],
  );
  const keyframesError = useMemo(() => validateVideoKeyframes({
    active: keyframesActive,
    frames: numFrames,
    height,
    keyframes,
    maxSafeFrames,
    width,
  }), [height, keyframes, keyframesActive, maxSafeFrames, numFrames, width]);

  const ltx2Runtime = isLtx2FamilyRuntime(currentModel?.runtime);
  const extendModeBlocked = mode === 'extend' && (
    !extendFromVideoId || (!ltx2Runtime && (extendingFrame || !sourceImageFile))
  );
  const a2vRuntime = isAudioToVideoRuntime(currentModel?.runtime);
  const a2vNeedsImage = currentModel?.requiresSourceImageForA2v === true;
  const maxAudioDurationSec = currentModel?.audioDurationDriven === true
    && currentModel?.arbitraryLengthAudio !== true
    && Number.isFinite(Number(currentModel?.maxNumFrames))
    && Number(currentModel.maxNumFrames) > 0
    && Number.isFinite(Number(fps))
    && Number(fps) > 0
    ? Number(currentModel.maxNumFrames) / Number(fps)
    : null;
  const a2vDurationError = mode === 'a2v'
    && maxAudioDurationSec != null
    && Number.isFinite(Number(audioDurationSec))
    && Number(audioDurationSec) > maxAudioDurationSec
    ? `${currentModel.name} supports up to ${maxAudioDurationSec.toFixed(1)}s in one audio-to-video render. Use MiniMax H3 Ref2VA for longer audio, or trim this file.`
    : null;
  const a2vModeBlocked = mode === 'a2v' && (
    !audioFile
    || !a2vRuntime
    || (a2vNeedsImage && !sourceImageFile && !sourceImageUpload)
    || !!a2vDurationError
  );
  const filledImageRefs = icReferenceImageFiles.filter(Boolean).length;
  const icLoraModeBlocked = icModeActive && (
    (icImageKind
      ? (filledImageRefs < icSpec.minReferences || filledImageRefs > icSpec.maxReferences)
      : (!icReferenceFile && !icReferenceVideoId))
    || !ltx2Runtime
    || !!icResolutionIssue(icSpec, width, height)
  );
  const chainingActive = mode !== 'a2v' && !keyframesActive && !icModeActive
    && isModelAllowedForMode(currentModel, 'image') && chunks > 1;

  return {
    a2vDurationError,
    a2vModeBlocked,
    chainingActive,
    extendModeBlocked,
    icLoraModeBlocked,
    keyframesBlocked: keyframesActive && !!keyframesError,
    keyframesError,
    maxSafeFrames,
  };
}

export default useVideoGenValidation;
