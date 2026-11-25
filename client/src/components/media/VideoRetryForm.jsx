import { useModelInputPreview } from '../../hooks/useModelInputPreview';
import { previewMediaJobRetry } from '../../services/apiMediaJobs';
import ModelInputPreview from './ModelInputPreview';
import { useCallback, useState, useEffect } from 'react';
import { RotateCw } from 'lucide-react';
import A2vLoraStageControls from '../videoGen/A2vLoraStageControls';
import { isDefaultA2vLoraStages } from '../../lib/videoLoraStages';
import { FormField } from '../ui/FormField';
import AutoSizeTextarea from '../ui/AutoSizeTextarea';
import { isCloudVideoMode } from '../../lib/imageGenBackends';
import {
  normalizeI2vReferenceMode, resolveI2vReferenceStrength,
} from '../../lib/videoReferenceModes';
import { getVideoGenModelContext, listLorasFull } from '../../services/apiImageVideo.js';
import ModelSelect from '../ModelSelect';
import ResolutionField from './ResolutionField';
import AdvancedParamsPanel from '../videoGen/AdvancedParamsPanel';
import { resolutionOptionsForModel } from '../../lib/videoGenResolutions';
import {
  videoEdgeBoundsForModel, textEncoderOptionsForModel, STOCK_TEXT_ENCODER_ID,
  normalizeTextEncoderForModel, normalizeSpeedProfileForModel, speedProfileIdFromRecord,
  resolveDraftDecodeForModel, draftDecodeFromRecord, selectedContextFramesForModel,
} from '../../lib/videoGenParams';
import { isDefaultVideoStreamingMode, videoStreamingModeFromRecord } from '../../lib/videoStreamingMode';
import { isDeliveryVideoModel } from '../../lib/videoFinish';
import { loraFamilyOf, videoLoraFamily } from '../../lib/runnerFamilies';
import LoraPicker from '../imageGen/LoraPicker';
import { buildVideoRetryOverrides, reconcileModelBoundParams } from './retryOverrides';

// The retry editor deliberately reuses the same resolution and advanced
// controls rendered by VideoGen. Keeping the capability predicates in those
// components means a newly-supported video knob is not silently absent here.
export default function VideoRetryForm({ job, retrying, onSubmit, onCancel }) {
  const p = job.params || {};
  const [models, setModels] = useState([]);
  const [modelId, setModelId] = useState(p.modelId || '');
  const [prompt, setPrompt] = useState(p.retryPrompt ?? p.prompt ?? '');
  const [negativePrompt, setNegativePrompt] = useState(p.retryNegativePrompt ?? p.negativePrompt ?? '');
  const [width, setWidth] = useState(p.width ?? '');
  const [height, setHeight] = useState(p.height ?? '');
  const [numFrames, setNumFrames] = useState(p.numFrames ?? '');
  const [fps, setFps] = useState(p.fps ?? '');
  const [chunks, setChunks] = useState(p.chunks ?? 1);
  const [chunkPrompts, setChunkPrompts] = useState(p.chunkPrompts || []);
  const [contextFrames, setContextFrames] = useState(p.continuityStrategy === 'frame' ? 0 : (p.contextFrames ?? 0));
  const [seed, setSeed] = useState(p.seed ?? '');
  const [steps, setSteps] = useState(p.steps ?? '');
  const [guidanceScale, setGuidanceScale] = useState(p.guidanceScale ?? '');
  const [imageStrength, setImageStrength] = useState(p.imageStrength ?? '');
  // The conditioning promise rides the retry the same way the strength does — a
  // retry that silently dropped it would re-render an anchored clip under the
  // original job's Inspire label. Absent means the default.
  const [i2vReferenceMode, setI2vReferenceMode] = useState(normalizeI2vReferenceMode(p.i2vReferenceMode));
  const [tiling, setTiling] = useState(p.tiling || 'auto');
  const [disableAudio, setDisableAudio] = useState(p.disableAudio === true);
  const [textEncoderId, setTextEncoderId] = useState(p.textEncoderId || STOCK_TEXT_ENCODER_ID);
  // The failed job's sampler schedule (#4875). Seeded from its params so the
  // picker reports what the render actually used rather than always reading
  // "Quality", and so an unchanged retry re-submits the same schedule.
  const [speedProfileId, setSpeedProfileId] = useState(speedProfileIdFromRecord(p.speedProfileId));
  // The decode the job was submitted with (#5423, #5449). Seeded from its params
  // for the same reason the schedule above is: an untouched requeue must
  // re-submit what the original render asked for, not snap silently back to Full.
  const [draftDecode, setDraftDecode] = useState(draftDecodeFromRecord(p.draftDecode));
  // Keep a recorded explicit memory request editable until the catalog loads;
  // only the render bridge decides whether its pinned pipeline can honor it.
  const [streamingMode, setStreamingMode] = useState(videoStreamingModeFromRecord(p.streamingMode));
  const [a2vLoraStageStrengths, setA2vLoraStageStrengths] = useState(p.a2vLoraStageStrengths ?? [1, 1]);
  const [availableLoras, setAvailableLoras] = useState([]);
  const [selectedLoras, setSelectedLoras] = useState(Array.isArray(p.loras) ? p.loras : []);

  useEffect(() => {
    getVideoGenModelContext({ silent: true })
      .then((status) => setModels(Array.isArray(status?.models) ? status.models : []))
      .catch(() => {});
  }, []);
  useEffect(() => {
    listLorasFull({ silent: true })
      .then((loras) => setAvailableLoras(Array.isArray(loras) ? loras : []))
      .catch(() => {});
  }, []);

  const currentModel = models.find((model) => model.id === modelId) || null;
  // Models arrive asynchronously, so recorded values can only be validated once
  // the catalog entry resolves. One reconciliation pass snaps every model-bound
  // draft value onto what the model declares (see reconcileModelBoundParams);
  // it is idempotent, so re-running as the draft settles cannot loop.
  useEffect(() => {
    if (!currentModel) return;
    const next = reconcileModelBoundParams(currentModel, models, { contextFrames, i2vReferenceMode, textEncoderId, speedProfileId, draftDecode });
    setContextFrames(next.contextFrames);
    setI2vReferenceMode(next.i2vReferenceMode);
    setTextEncoderId(next.textEncoderId);
    setSpeedProfileId(next.speedProfileId);
    setDraftDecode(next.draftDecode);
  }, [currentModel, models, contextFrames, i2vReferenceMode, textEncoderId, speedProfileId, draftDecode]);
  // Hosted backends (grok / fal / reactor) own their params: `mode` is the
  // dispatch discriminator and `modelId` is a provider id the local catalog
  // doesn't know, so the local model / size / sampler / chaining controls don't apply.
  const isHosted = isCloudVideoMode(p.mode);
  const loraFamily = videoLoraFamily(currentModel);
  const videoLoras = loraFamily ? availableLoras.filter((lora) => loraFamilyOf(lora) === loraFamily) : [];
  const encoderOptions = textEncoderOptionsForModel(currentModel);
  const originalEncoder = normalizeTextEncoderForModel(p.textEncoderId || STOCK_TEXT_ENCODER_ID, currentModel);
  const originalSpeedProfileForModel = normalizeSpeedProfileForModel(speedProfileIdFromRecord(p.speedProfileId), currentModel);
  // Preview-fidelity decode (#5449). A model the finish graph names as a
  // DELIVERY target always decodes on its own decoder, so the picker is locked
  // to Full there rather than offering a draft the server would decline — the
  // same reset the Video Gen form makes when Finish switches models.
  const deliveryModel = isDeliveryVideoModel(currentModel, models);
  const recordedDraftDecode = draftDecodeFromRecord(p.draftDecode);
  // What an UNTOUCHED requeue would re-submit. Two deliberate readings:
  //   - until `models` resolves, an unknown model means "not known yet", never
  //     "no draft decoder", so the baseline stays the recorded value and a
  //     requeue submitted mid-load still sends no decode override at all;
  //   - on a delivery model it ALSO stays the recorded value, so the lock's
  //     reset to Full counts as a change and clears the stale request rather
  //     than silently re-inheriting a decode the render can never perform.
  const originalDraftDecode = (currentModel && !deliveryModel)
    ? resolveDraftDecodeForModel(recordedDraftDecode, currentModel, models)
    : recordedDraftDecode;
  // Multi-keyframe inputs are not exposed in the sanitized queue projection,
  // but FFLF is their persisted semantic mode. IC/a2v conditioning also pins
  // a single render, so keep the shared chaining controls consistent with the
  // normal VideoGen form for those retry records.
  const chainingLocked = p.mode === 'fflf' || p.mode === 'a2v' || p.mode?.startsWith('ic-');
  const chainingActive = chunks > 1 && !chainingLocked;
  const displayedContextFrames = selectedContextFramesForModel(currentModel, contextFrames);
  const continuationPending = !isHosted && chainingActive && !currentModel;
  const handleModelChange = (event) => {
    const nextModelId = event.target.value;
    const nextModel = models.find((model) => model.id === nextModelId) || null;
    setModelId(nextModelId);
    if (videoLoraFamily(nextModel) !== loraFamily) setSelectedLoras([]);
  };
  const setChunkPromptAt = (index, value) => setChunkPrompts((prev) => {
    const next = [...prev];
    while (next.length <= index) next.push('');
    next[index] = value;
    return next;
  });
  const displayedNumFrames = numFrames === '' ? (currentModel?.defaultFrames ?? 121) : numFrames;
  const displayedFps = fps === '' ? 24 : fps;

  const draft = {
    prompt, negativePrompt, modelId, width, height, numFrames, fps, chunks, chunkPrompts, seed, steps,
    guidanceScale, imageStrength, i2vReferenceMode, tiling, disableAudio, textEncoderId, speedProfileId,
    draftDecode, a2vLoraStageStrengths, streamingMode, selectedLoras,
  };
  const overrides = buildVideoRetryOverrides(draft, p, {
    currentModel, isHosted, chainingActive, displayedContextFrames,
    originalEncoder, originalSpeedProfileForModel, originalDraftDecode,
  });
  const fetchPreview = useCallback((body, options) => previewMediaJobRetry(job.id, body, options), [job.id]);
  const modelInputPreview = useModelInputPreview(fetchPreview, overrides, { enabled: !continuationPending });
  const submit = (event) => {
    event.preventDefault();
    if (!continuationPending && !modelInputPreview.error && (overrides?.prompt === undefined || prompt.trim())) onSubmit(overrides);
  };

  return (
    <form onSubmit={submit} className="mt-3 pt-3 border-t border-port-border space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <FormField label="Prompt" labelClassName="block text-xs font-medium text-gray-400 mb-1">
          <AutoSizeTextarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white min-h-[80px]" />
        </FormField>
        <FormField label="Negative Prompt" labelClassName="block text-xs font-medium text-gray-400 mb-1">
          <AutoSizeTextarea value={negativePrompt} onChange={(e) => setNegativePrompt(e.target.value)} rows={3} className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white min-h-[80px]" />
        </FormField>
      </div>
      <ModelInputPreview preview={modelInputPreview} prompt={prompt} alwaysShowFull
        referencesIntro="The retry uses the saved inputs from the original job." />
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {!isHosted && (
          <FormField className="col-span-2 sm:col-span-3" label="Model" labelClassName="block text-xs font-medium text-gray-400 mb-1">
            {models.length > 0 ? <ModelSelect models={models} value={modelId} onChange={handleModelChange} /> : (
              <input value={modelId} onChange={(e) => setModelId(e.target.value)} className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white" />
            )}
          </FormField>
        )}
        {!isHosted && <ResolutionField presets={resolutionOptionsForModel(currentModel)} width={width} height={height} onChange={(w, h) => { setWidth(w); setHeight(h); }} {...videoEdgeBoundsForModel(currentModel)} snapOnBlur />}
      </div>
      {!isHosted && encoderOptions.length > 1 && (
        <FormField label="Text encoder" labelClassName="block text-xs font-medium text-gray-400 mb-1">
          <ModelSelect models={encoderOptions} value={textEncoderId} onChange={(e) => setTextEncoderId(e.target.value)} getLabel={(option) => option.label} />
        </FormField>
      )}
      {!isHosted && loraFamily && videoLoras.length > 0 && (
        <LoraPicker
          availableLoras={videoLoras}
          selected={selectedLoras}
          onChange={setSelectedLoras}
          currentRunnerFamily={loraFamily}
          currentCompatKey={loraFamily}
          prompt={prompt}
        />
      )}
      {!isHosted && (
        <AdvancedParamsPanel
          mode={p.mode || 'text'} currentModel={currentModel}
          numFrames={displayedNumFrames} onNumFramesChange={setNumFrames}
          chunks={chunks} onChunksChange={setChunks} keyframesActive={chainingLocked}
          chunkPrompts={chunkPrompts} onChunkPromptChange={setChunkPromptAt} chainingActive={chainingActive}
          contextFrames={displayedContextFrames} onContextFramesChange={setContextFrames}
          fps={displayedFps} onFpsChange={setFps} seed={seed} onSeedChange={setSeed} onRandomSeed={() => setSeed(Math.floor(Math.random() * 2147483647))}
          steps={steps} onStepsChange={setSteps} guidanceScale={guidanceScale} onGuidanceScaleChange={setGuidanceScale}
          speedProfileId={speedProfileId} onSpeedProfileChange={setSpeedProfileId}
          width={width} height={height}
          streamingMode={streamingMode} onStreamingModeChange={setStreamingMode}
          showStreamingMode={currentModel ? undefined : !isDefaultVideoStreamingMode(p.streamingMode)}
          draftDecode={draftDecode} onDraftDecodeChange={setDraftDecode} draftDecodeLocked={deliveryModel}
          imageStrength={imageStrength} onImageStrengthChange={setImageStrength} tiling={tiling} onTilingChange={setTiling}
          i2vReferenceMode={i2vReferenceMode} onI2vReferenceModeChange={setI2vReferenceMode}
          effectiveImageStrength={resolveI2vReferenceStrength(i2vReferenceMode, imageStrength)}
          disableAudio={disableAudio} onDisableAudioChange={setDisableAudio}
          idPrefix={`retry-video-${job.id}`}
        />
      )}
      {((!isHosted && p.mode === 'a2v' && currentModel?.a2vLoraStageCapable && selectedLoras.length > 0)
        || !isDefaultA2vLoraStages(a2vLoraStageStrengths)) && (
        <A2vLoraStageControls value={a2vLoraStageStrengths} onChange={setA2vLoraStageStrengths}
          supported={!isHosted && p.mode === 'a2v' && currentModel?.a2vLoraStageCapable && selectedLoras.length > 0} loras={selectedLoras} />
      )}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button type="button" disabled={retrying} onClick={onCancel} className="px-3 py-1 text-xs text-port-text-muted hover:text-white">Cancel</button>
        <button type="submit" disabled={retrying || continuationPending || !!modelInputPreview.error} title={continuationPending ? 'Waiting for the model continuation capability.' : undefined} className="inline-flex items-center gap-1 px-3 py-1 bg-port-accent text-white text-xs rounded hover:bg-port-accent/90 disabled:opacity-50"><RotateCw className="w-3 h-3" />Retry with changes</button>
      </div>
    </form>
  );
}
