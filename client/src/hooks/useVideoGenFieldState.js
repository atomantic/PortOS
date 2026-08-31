import { useRef, useState } from 'react';
import { GROK_VIDEO_DEFAULT_DURATION } from '../lib/grokVideoClip.js';
import { DEFAULT_I2V_REFERENCE_MODE } from '../lib/videoReferenceModes.js';
import {
  DEFAULT_CONTEXT_FRAMES,
  DEFAULT_DRAFT_DECODE_ID,
  DEFAULT_SPEED_PROFILE_ID,
  STOCK_TEXT_ENCODER_ID,
} from '../lib/videoGenParams.js';

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
  const [backend, setBackend] = useState('local');
  const [grokDuration, setGrokDuration] = useState(GROK_VIDEO_DEFAULT_DURATION);
  const [mode, setMode] = useState(incomingAudioFilename ? 'a2v' : (incomingSourceImage ? 'image' : 'text'));
  const [prompt, setPrompt] = useState(incomingPrompt || '');
  const [negativePrompt, setNegativePrompt] = useState(incomingNegativePrompt || '');
  const [stylePreset, setStylePreset] = useState(null);
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
  const [seed, setSeed] = useState('');
  const [tiling, setTiling] = useState('auto');
  const [textEncoderId, setTextEncoderId] = useState(STOCK_TEXT_ENCODER_ID);
  const [speedProfileId, setSpeedProfileId] = useState(DEFAULT_SPEED_PROFILE_ID);
  const [draftDecode, setDraftDecode] = useState(DEFAULT_DRAFT_DECODE_ID);
  const [disableAudio, setDisableAudio] = useState(false);
  const [selectedLoras, setSelectedLoras] = useState([]);
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
  const [icStrength, setIcStrength] = useState(1.0);
  const [icSkipStage2, setIcSkipStage2] = useState(false);
  const [icReferenceNames, setIcReferenceNames] = useState([]);
  const staleModelToastRef = useRef(null);

  return {
    audioDurationSec, setAudioDurationSec,
    audioFile, setAudioFile, audioHandoffRef,
    backend, setBackend,
    chunks, setChunks,
    chunkPrompts, setChunkPrompts,
    contextFrames, setContextFrames,
    disableAudio, setDisableAudio,
    extendingFrame, setExtendingFrame,
    extendFromVideoId, setExtendFromVideoId,
    fps, setFps,
    grokDuration, setGrokDuration,
    guidanceScale, setGuidanceScale,
    height, setHeight,
    i2vReferenceMode, setI2vReferenceMode,
    icReferenceFile, setIcReferenceFile,
    icReferenceImageFiles, setIcReferenceImageFiles,
    icReferenceNames, setIcReferenceNames,
    icReferenceVideoId, setIcReferenceVideoId,
    icSkipStage2, setIcSkipStage2,
    icStrength, setIcStrength,
    imageStrength, setImageStrength,
    keyframes, setKeyframes,
    keyframesMode, setKeyframesMode,
    lastImageFile, setLastImageFile,
    lastImageUpload, setLastImageUpload,
    mode, setMode,
    modelId, setModelId,
    negativePrompt, setNegativePrompt,
    noMusic, setNoMusic,
    numFrames, setNumFrames,
    prompt, setPrompt,
    remixModelFallback, setRemixModelFallback,
    remixSourceModel, setRemixSourceModel,
    seed, setSeed,
    selectedLoras, setSelectedLoras,
    sizeManuallySetRef,
    speedProfileId, setSpeedProfileId,
    draftDecode, setDraftDecode,
    staleModelToastRef,
    steps, setSteps,
    stylePreset, setStylePreset,
    sourceImageFile, setSourceImageFile,
    sourceImageUpload, setSourceImageUpload,
    textEncoderId, setTextEncoderId,
    tiling, setTiling,
    width, setWidth,
  };
}

export default useVideoGenFieldState;
