/**
 * Mutable VideoGen field values, setters, and lifecycle refs, grouped by concern and seeded from URL handoff values.
 *
 * Use when: Internal state slice composed by `useVideoGenForm`; keep model reconciliation and
 * submission behavior in their focused units. Hosted-provider fields live in
 * `useVideoGenBackendCaps`.
 */

import { useRef, useState } from 'react';
import { DEFAULT_I2V_REFERENCE_MODE } from '../../lib/videoReferenceModes.js';
import {
  DEFAULT_CONTEXT_FRAMES,
  DEFAULT_SPEED_PROFILE_ID,
  STOCK_TEXT_ENCODER_ID,
} from '../../lib/videoGenParams.js';
import { DEFAULT_VIDEO_STREAMING_MODE } from '../../lib/videoStreamingMode.js';

/**
 * Owns the mutable fields and lifecycle refs for the VideoGen form.
 * URL-derived values are sampled on mount; reconciliation effects stay in the
 * orchestration hook where they can react to the loaded model catalog.
 */
export function useVideoGenFieldState({
  incomingAudioFilename,
  incomingNegativePrompt,
  incomingPrompt,
  incomingSourceImage,
}) {
  const [mode, setMode] = useState(incomingAudioFilename ? 'a2v' : (incomingSourceImage ? 'image' : 'text'));
  const [prompt, setPrompt] = useState(incomingPrompt || '');
  const [negativePrompt, setNegativePrompt] = useState(incomingNegativePrompt || '');
  const [stylePreset, setStylePreset] = useState(null);
  const [selectedUniverse, setSelectedUniverse] = useState(null);
  const [modelId, setModelId] = useState('');
  const [remixSourceModel, setRemixSourceModel] = useState(null);
  const [remixModelFallback, setRemixModelFallback] = useState(null);
  const [width, setWidth] = useState(768);
  const [height, setHeight] = useState(512);
  const sizeManuallySetRef = useRef(false);
  const [numFrames, setNumFrames] = useState(121);
  const [fps, setFps] = useState(24);
  const [chunks, setChunks] = useState(1);
  const [chunkPrompts, setChunkPrompts] = useState([]);
  const [contextFrames, setContextFrames] = useState(DEFAULT_CONTEXT_FRAMES);
  const [steps, setSteps] = useState('');
  const [guidanceScale, setGuidanceScale] = useState('');
  const [imageStrength, setImageStrength] = useState('');
  const [i2vReferenceMode, setI2vReferenceMode] = useState(DEFAULT_I2V_REFERENCE_MODE);
  const [batchSize, setBatchSize] = useState(1);
  const [seed, setSeed] = useState('');
  const [tiling, setTiling] = useState('auto');
  const [textEncoderId, setTextEncoderId] = useState(STOCK_TEXT_ENCODER_ID);
  const [speedProfileId, setSpeedProfileId] = useState(DEFAULT_SPEED_PROFILE_ID);
  const [streamingMode, setStreamingMode] = useState(DEFAULT_VIDEO_STREAMING_MODE);
  const [disableAudio, setDisableAudio] = useState(false);
  const [selectedLoras, setSelectedLoras] = useState([]);
  const [a2vLoraStageStrengths, setA2vLoraStageStrengths] = useState([1, 1]);
  const [noMusic, setNoMusic] = useState(false);
  const [sourceImageFile, setSourceImageFile] = useState(incomingSourceImage || null);
  const [sourceImageUpload, setSourceImageUpload] = useState(null);
  const [lastImageFile, setLastImageFile] = useState(null);
  const [lastImageUpload, setLastImageUpload] = useState(null);
  const [keyframesMode, setKeyframesMode] = useState(false);
  const [keyframes, setKeyframes] = useState([]);
  const [extendFromVideoId, setExtendFromVideoId] = useState('');
  const [extendingFrame, setExtendingFrame] = useState(false);
  const [audioFile, setAudioFile] = useState(null);
  // Null means metadata has not loaded (or is unreadable), which is distinct
  // from a real numeric duration for validation and frame derivation.
  const [audioDurationSec, setAudioDurationSec] = useState(null);
  const audioHandoffRef = useRef(null);
  const [icReferenceFile, setIcReferenceFile] = useState(null);
  const [icReferenceVideoId, setIcReferenceVideoId] = useState('');
  const [icReferenceImageFiles, setIcReferenceImageFiles] = useState([]);
  const [referenceImageFiles, setReferenceImageFiles] = useState([]);
  const [referenceVideoIds, setReferenceVideoIds] = useState([]);
  const [referenceAudioFiles, setReferenceAudioFiles] = useState([]);
  const [icStrength, setIcStrength] = useState(1.0);
  const [icSkipStage2, setIcSkipStage2] = useState(false);
  const [icReferenceNames, setIcReferenceNames] = useState([]);
  const staleModelToastRef = useRef(null);

  const [unavailableSourceImageName, setUnavailableSourceImageName] = useState('');
  const [unavailableReferenceImageNames, setUnavailableReferenceImageNames] = useState([]);

  // Grouped by the form concern each slice serves, so the orchestration hook
  // reads a named group rather than one flat bag of every setter.
  return {
    prompt: {
      prompt, setPrompt,
      negativePrompt, setNegativePrompt,
      stylePreset, setStylePreset,
      selectedUniverse, setSelectedUniverse,
    },
    model: {
      modelId, setModelId,
      remixSourceModel, setRemixSourceModel,
      remixModelFallback, setRemixModelFallback,
      staleModelToastRef,
      selectedLoras, setSelectedLoras,
      a2vLoraStageStrengths, setA2vLoraStageStrengths,
      textEncoderId, setTextEncoderId,
      speedProfileId, setSpeedProfileId,
      streamingMode, setStreamingMode,
    },
    sampler: {
      width, setWidth,
      height, setHeight,
      sizeManuallySetRef,
      numFrames, setNumFrames,
      fps, setFps,
      chunks, setChunks,
      chunkPrompts, setChunkPrompts,
      contextFrames, setContextFrames,
      steps, setSteps,
      guidanceScale, setGuidanceScale,
      imageStrength, setImageStrength,
      i2vReferenceMode, setI2vReferenceMode,
      batchSize, setBatchSize,
      seed, setSeed,
      tiling, setTiling,
      disableAudio, setDisableAudio,
      noMusic, setNoMusic,
    },
    frames: {
      mode, setMode,
      sourceImageFile, setSourceImageFile,
      sourceImageUpload, setSourceImageUpload,
      unavailableSourceImageName, setUnavailableSourceImageName,
      lastImageFile, setLastImageFile,
      lastImageUpload, setLastImageUpload,
      keyframesMode, setKeyframesMode,
      keyframes, setKeyframes,
      extendFromVideoId, setExtendFromVideoId,
      extendingFrame, setExtendingFrame,
    },
    conditioning: {
      audioFile, setAudioFile,
      audioDurationSec, setAudioDurationSec,
      audioHandoffRef,
      icReferenceFile, setIcReferenceFile,
      icReferenceVideoId, setIcReferenceVideoId,
      icReferenceImageFiles, setIcReferenceImageFiles,
      icReferenceNames, setIcReferenceNames,
      icStrength, setIcStrength,
      icSkipStage2, setIcSkipStage2,
      referenceImageFiles, setReferenceImageFiles,
      unavailableReferenceImageNames, setUnavailableReferenceImageNames,
      referenceVideoIds, setReferenceVideoIds,
      referenceAudioFiles, setReferenceAudioFiles,
    },
  };
}

export default useVideoGenFieldState;
