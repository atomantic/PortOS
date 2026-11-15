import ModelSelect from '../ModelSelect';
import { FormField } from '../ui/FormField';
import ListLoadError from '../ui/ListLoadError';
import ResolutionField from '../media/ResolutionField';
import ModelDownloadBadge, { deriveSizeEstimate } from '../media/ModelDownloadBadge';
import LoraPicker from '../imageGen/LoraPicker';
import A2vLoraStageControls from './A2vLoraStageControls';
import ModelWorkflowHelp from './ModelWorkflowHelp';
import TextEncoderPicker from './TextEncoderPicker';
import { TEXT_ENCODER_DOWNLOAD_ID } from '../../hooks/useModelDownloadStatus';
import { appendTriggerWords } from '../../lib/loraTriggers';
import { isMiniMaxH3Runtime } from '../../lib/runnerFamilies';
import { isDefaultA2vLoraStages } from '../../lib/videoLoraStages';
import { resolutionOptionsForModel } from '../../lib/videoGenResolutions';
import { isModelAllowedForMode, videoEdgeBoundsForModel, videoModelModeOptions } from '../../lib/videoGenParams.js';

/**
 * Local-lane render settings: the Model field with its download, repair,
 * access-error and text-encoder affordances, the video LoRA picker and its
 * hints, the A2V LoRA stage dials, and the model-aware resolution field.
 * `model`, `sampler` and `promptFields` are `useVideoGenForm()` groups;
 * `weights` is `useVideoGenWeightAssets()`; `catalog` is the page's model
 * list request (`models`, `modelContextRequest`, `refreshModelContext`).
 */
export default function VideoGenLocalModelSettings({
  mode, isGrok, model, sampler, promptFields, weights, catalog, loraLibrary, isRemote, generating, onOpenSettings,
}) {
  const {
    modelId, handleModelChange, currentModel, visibleModels, otherModeModels, remixModelFallback,
    loraFamily, videoLoras, loraUnavailableHint, selectedLoras, setSelectedLoras,
    a2vLoraStageStrengths, setA2vLoraStageStrengths, textEncoderOptions, textEncoderId,
  } = model;
  const { width, height, handleResolutionChange } = sampler;
  const { setPrompt, envelopedPrompt } = promptFields;
  const {
    modelDownload, modelStatus, ltx25ReferenceId, ltx25ReferenceStatus, selectedH3SpeedProfile,
    usesSharedTextEncoder, textEncoderStatus, sharedEncoderAsset,
    textEncoderOptionDownloadId, textEncoderOptionStatus, handleTextEncoderChange, activeWeightError,
  } = weights;
  const { models, modelContextRequest, refreshModelContext } = catalog;
  // The Model field renders as soon as there is anything to say — the list, or
  // the fact that it is still being fetched. Only a finished fetch that named
  // no model at all takes the field away. That fetch no longer waits on the
  // python probe, so on a cold load the list itself is normally what lands.
  const modelsLoading = models.length === 0;
  const modelFieldVisible = !modelsLoading || modelContextRequest.state !== 'ready';
  const localResolutionBounds = videoEdgeBoundsForModel(currentModel);

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {/* The peer advertises its own models; the local list would name
          none of them, and a stale selection here must not read as the
          model that rendered the clip. Locally the field holds its place
          through the probe rather than popping into the form late. */}
      {modelFieldVisible && !isRemote && (
        <FormField className="col-span-2 sm:col-span-3" label="Model" labelClassName="block text-xs font-medium text-gray-400 mb-1">
          <ModelSelect
            models={visibleModels}
            optionGroups={[{ label: 'Other modes (select to switch)', models: otherModeModels }]}
            getLabel={(m) => isModelAllowedForMode(m, mode)
              ? m.name
              : `${m.name}${m.deprecated ? ' (Legacy)' : ''} — ${videoModelModeOptions(m).map((option) => option.label).join(' / ')} only`}
            value={modelId}
            onChange={(e) => handleModelChange(e.target.value)}
            loading={modelsLoading}
          />
          {modelContextRequest.error && (
            <ListLoadError
              what="the model list"
              error={modelContextRequest.error}
              onRetry={refreshModelContext}
              retrying={modelContextRequest.state === 'loading'}
              className="mb-2"
            />
          )}
          <ModelWorkflowHelp model={currentModel} mode={mode} models={models} onResolutionChange={handleResolutionChange} />
          {remixModelFallback && (
            <p className="mt-1 text-[11px] text-port-accent leading-snug" role="status">
              {remixModelFallback.sourceName} {remixModelFallback.samplerLocked && remixModelFallback.negativePromptUnsupported
                ? 'has fixed sampler controls and no negative prompt'
                : remixModelFallback.samplerLocked
                  ? 'has fixed sampler controls'
                  : 'does not support a negative prompt'}. This remix is using {remixModelFallback.targetName} so its negative prompt, Steps, and CFG Scale remain editable.
            </p>
          )}
          {modelStatus && (
            <ModelDownloadBadge
              status={modelStatus}
              onDownload={() => modelDownload.start(modelId)}
              onCancel={modelDownload.cancel}
              estimateLabel={deriveSizeEstimate(currentModel?.name)}
            />
          )}
          {ltx25ReferenceStatus && !ltx25ReferenceStatus.cached && (
            <div className="mt-2 rounded-lg border border-port-border px-3 py-2 text-[11px] text-gray-400">
              <p>Optional: add reference images for characters, props and locations with the LTX 2.5 Ingredients adapter.</p>
              <p>Accept access on <a className="underline" href="https://huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-Ingredients" target="_blank" rel="noreferrer">Hugging Face</a> and connect the same account before downloading.</p>
              <ModelDownloadBadge
                status={ltx25ReferenceStatus}
                onDownload={() => modelDownload.start(ltx25ReferenceId)}
                onCancel={modelDownload.cancel}
                disabled={modelDownload.downloading && modelDownload.activeModelId !== ltx25ReferenceId}
                disabledReason="Wait for the current download to finish"
                estimateLabel="~1.31 GB"
              />
            </div>
          )}
          {activeWeightError && (
            <div role="status" className="mt-2 rounded-lg border border-port-error/40 bg-port-error/10 px-3 py-2 text-[11px] text-port-error">
              <p>{activeWeightError.message}</p>
              <div className="mt-1 flex flex-wrap gap-2">
                <button type="button" onClick={onOpenSettings} className="underline hover:text-white">
                  Open Hugging Face settings
                </button>
                {activeWeightError.repo && (
                  <a
                    href={`https://huggingface.co/${activeWeightError.repo}`}
                    target="_blank"
                    rel="noreferrer"
                    className="underline hover:text-white"
                  >
                    Open repository access page
                  </a>
                )}
              </div>
            </div>
          )}
          {modelDownload.statusError && (
            <div role="status" className="mt-2 rounded-lg border border-port-warning/40 bg-port-warning/10 px-3 py-2 text-[11px] text-port-warning flex flex-wrap items-center justify-between gap-2">
              <span>{modelDownload.statusError}</span>
              <button type="button" onClick={modelDownload.refresh} className="underline hover:text-white">
                Retry cache check
              </button>
            </div>
          )}
          {/* Prompt conditioner. Sits with the Model field rather than in
              the collapsed Advanced panel: a substitute is its own
              multi-GB pull and gates Generate, so its badge has to be
              visible at the moment it's picked. Renders nothing unless
              the model offers a real choice. */}
          <TextEncoderPicker
            options={textEncoderOptions}
            value={textEncoderId}
            onChange={handleTextEncoderChange}
            status={textEncoderOptionStatus}
            onDownload={() => modelDownload.start(textEncoderOptionDownloadId)}
            queued={modelDownload.queuedModelId === textEncoderOptionDownloadId}
            onCancel={modelDownload.cancel}
            disabled={generating}
          />
          {usesSharedTextEncoder && textEncoderStatus && (sharedEncoderAsset.missingWeights || textEncoderStatus.downloading) && (
            <div className="mt-1">
              <p className="text-[10px] text-gray-500">Text encoder ({textEncoderStatus.repo}) is also required:</p>
              <ModelDownloadBadge
                status={textEncoderStatus}
                onDownload={() => modelDownload.start(TEXT_ENCODER_DOWNLOAD_ID)}
                onCancel={modelDownload.cancel}
              />
            </div>
          )}
        </FormField>
      )}

      {/* Video LoRAs — only on runtimes with a compatible video family
          (loraFamily non-null) and when at least one matching LoRA is
          installed (videoLoras is the strict family subset; see hook). */}
      {loraFamily && loraLibrary.state === 'error' && (
        <ListLoadError
          className="col-span-2 sm:col-span-3"
          what="the LoRA library"
          error={loraLibrary.error}
          onRetry={loraLibrary.retry}
        />
      )}
      {loraFamily && loraLibrary.state === 'ready' && videoLoras.length === 0 && (
        <p className="col-span-2 sm:col-span-3 text-xs text-gray-500">No installed LoRAs match this model&apos;s video family.</p>
      )}
      {loraFamily && videoLoras.length > 0 && (
        <div className="col-span-2 sm:col-span-3">
          <LoraPicker
            availableLoras={videoLoras}
            selected={selectedLoras}
            onChange={setSelectedLoras}
            currentRunnerFamily={loraFamily}
            currentCompatKey={loraFamily}
            // Shared with ImageGen: skips a word already present rather than
            // re-appending it, and judges presence against the ENVELOPED prompt
            // (style preset + no-music suffix) — the exact text the server
            // weaves against, so the button and the hint agree with the render.
            onAppendTrigger={(triggers) => setPrompt((p) => appendTriggerWords(p, triggers, envelopedPrompt))}
            // Grok payloads carry no LoRAs and never reach the local weave, so
            // the hint would promise an append that cannot happen. `null`
            // (not `''`) is the picker's "host didn't opt in" signal.
            prompt={isGrok ? null : envelopedPrompt}
            disabled={generating}
          />
        </div>
      )}


      {((mode === 'a2v' && currentModel?.a2vLoraStageCapable && selectedLoras.length > 0)
        || !isDefaultA2vLoraStages(a2vLoraStageStrengths)) && !isRemote && (
        <div className="col-span-2 sm:col-span-3">
          <A2vLoraStageControls value={a2vLoraStageStrengths} onChange={setA2vLoraStageStrengths}
            supported={mode === 'a2v' && currentModel?.a2vLoraStageCapable && selectedLoras.length > 0}
            disabled={generating} loras={selectedLoras} />
        </div>
      )}

      {/* LTX model that can't fuse LoRAs (quantized mlx_video — q4/q8) with
          compatible LoRAs on disk: explain the absence instead of hiding
          silently, and point at the models that CAN run them. */}
      {loraUnavailableHint && (
        <div className="col-span-2 sm:col-span-3 rounded-lg border border-port-warning/40 bg-port-warning/10 px-3 py-2 text-xs text-port-warning leading-snug">
          {loraUnavailableHint.kind === 'ltx' ? (
            <>You have {loraUnavailableHint.count} LTX video LoRA{loraUnavailableHint.count === 1 ? '' : 's'} installed, but <strong className="font-semibold">{currentModel?.name}</strong> can't fuse LoRAs (its quantized <code>mlx_video</code> runtime isn't supported yet). Switch to the <strong className="font-semibold">LTX-2.3 Unified Beta</strong> (bf16) or an <strong className="font-semibold">LTX-2.3 dgrauet (Q4/Q8)</strong> model to use them.</>
          ) : (
            <>You have {loraUnavailableHint.count} MiniMax H3 LoRA{loraUnavailableHint.count === 1 ? '' : 's'} installed, but this H3 runtime did not pass PortOS's quantization-aware LoRA probe. Repair the <strong className="font-semibold">MiniMax H3</strong> runtime from the model setup panel, then retry.</>
          )}
        </div>
      )}

      {/* Preset dropdown + free-form custom W×H for exact I2V sizing beyond
          the preset list. Most runners use the shared 64px grid; models
          such as H3 declare their native 32px grid and trained presets. */}
      <ResolutionField
        presets={resolutionOptionsForModel(currentModel)}
        width={width}
        height={height}
        onChange={handleResolutionChange}
        {...localResolutionBounds}
        snapOnBlur
        note={isMiniMaxH3Runtime(currentModel?.runtime)
          ? selectedH3SpeedProfile
            ? `The selected Speed profile supports ${selectedH3SpeedProfile.canvases.map(([w, h]) => `${w}×${h}`).join(', ')}. Set an exact size below; each edge snaps to 32px.`
            : 'H3 quality presets follow its trained 768px short-edge, area-capped canvas. Smaller custom sizes are off-distribution but useful for faster wiring tests; each edge snaps to 32px.'
          : `Each edge 64–2048px; the server rounds each down to the nearest multiple of ${localResolutionBounds.step}px.`}
      />

    </div>
  );
}
