import { ChevronDown, Sparkles, X } from 'lucide-react';
import StylePresetPicker from '../media/StylePresetPicker';
import UniverseStylePicker from '../media/UniverseStylePicker';
import PromptEnhancer from '../media/PromptEnhancer';
import PromptFromMedia from '../media/PromptFromMedia';
import RemoteMediaTargetPicker from '../federatedMedia/RemoteMediaTargetPicker';
import MusicVideoFilingSelect from '../media/MusicVideoFilingSelect';
import { FormField } from '../ui/FormField';
import Banner from '../ui/Banner';
import ListLoadError from '../ui/ListLoadError';
import AutoSizeTextarea from '../ui/AutoSizeTextarea';
import ModelInputPreview from '../media/ModelInputPreview';
import HfTokenBanner from './HfTokenBanner';
import ImageGenControls from './ImageGenControls';
import InitImagePicker from './InitImagePicker';
import LoraPicker from './LoraPicker';
import ReferenceImagePicker from './ReferenceImagePicker';
import { appendTriggerWords } from '../../lib/loraTriggers';
import { IMAGE_GEN_MODE } from '../../lib/imageGenBackends';
import FalCatalogStatus from './FalCatalogStatus.jsx';
import DraftNumber from '../ui/DraftNumber';

export default function ImageGenFormEditor({ form, backend, generation }) {
  const { fields, catalogs, settings, derived, actions, loraTest, cloudModelPicker } = form;
  const { effectiveMode, isLocalMode, isAgyMode, remoteTarget } = backend;
  const isFalMode = effectiveMode === IMAGE_GEN_MODE.FAL;
  // An edit (a source image or references) leads the fal.ai list with its featured edit endpoints.
  const falEditing = isFalMode && (form.images?.initImage?.source != null || derived.populatedRefs?.length > 0);
  const {
    modelDownload,
    hfTokenPresent,
    refreshHfTokenStatus,
    flux2Status,
    refreshFlux2Status,
    needsFlux2Token,
  } = generation;

  return (
    <div className="min-w-0 bg-port-card border border-port-border rounded-xl p-3 sm:p-4 space-y-3">
      <FormField label="Prompt" labelClassName="block text-xs font-medium text-gray-400 mb-1">
        <AutoSizeTextarea
          value={fields.prompt}
          onChange={(event) => fields.setPrompt(event.target.value)}
          rows={3}
          className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50 min-h-[80px]"
          placeholder="Describe the image you want to generate..."
        />
      </FormField>
      <ModelInputPreview preview={generation.modelInputPreview} prompt={fields.prompt} />

      <ImageGenActionBar form={form} generation={generation} />

      <MusicVideoFilingSelect id="image-gen-music-video" />

      {(loraTest.pending || loraTest.error) && (
        <Banner tone={loraTest.error ? 'error' : 'info'}>
          <p>{loraTest.error || 'Preparing this LoRA test…'}</p>
          <button type="button" onClick={loraTest.dismiss} className="underline min-h-[44px]">
            Cancel LoRA test
          </button>
        </Banner>
      )}

      <details
        open={fields.optionsOpen}
        onToggle={(event) => fields.setOptionsOpen(event.currentTarget.open)}
        className="group min-w-0"
      >
        <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between rounded-lg border border-port-border px-3 py-2 text-sm font-medium text-gray-300 hover:bg-port-border/30 lg:hidden">
          Options
          <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div className="mt-3 min-w-0 space-y-3 lg:mt-0">
          <UniverseStylePicker
            value={fields.selectedUniverse?.id || ''}
            onChange={fields.setSelectedUniverse}
          />
          <StylePresetPicker
            value={fields.stylePreset?.id || ''}
            onChange={fields.setStylePreset}
          />
          {(!isLocalMode || derived.remoteTargetActive || derived.currentModel?.supportsNegativePrompt !== false || fields.negativePrompt) && <FormField label="Negative Prompt" labelClassName="block text-xs font-medium text-gray-400 mb-1">
            <AutoSizeTextarea
              value={fields.negativePrompt}
              onChange={(event) => fields.setNegativePrompt(event.target.value)}
              rows={3}
              className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50 min-h-[80px]"
              placeholder="What to avoid..."
            />
            {isLocalMode && !derived.remoteTargetActive && derived.currentModel?.supportsNegativePrompt === false && (
              <p className="mt-1 text-xs text-port-warning">This model has no negative prompt. Clear this field before rendering.</p>
            )}
          </FormField>}

          <PromptEnhancer
            kind="image"
            prompt={fields.prompt}
            setPrompt={fields.setPrompt}
            negativePrompt={fields.negativePrompt}
            setNegativePrompt={fields.setNegativePrompt}
            renderConfig={{ stylePreset: fields.stylePreset?.id, mode: effectiveMode }}
          />
          <PromptFromMedia
            kindDefault="both"
            applyKind="image"
            setPrompt={fields.setPrompt}
            setNegativePrompt={fields.setNegativePrompt}
          />

          {needsFlux2Token && (
            <HfTokenBanner
              modelLabel={derived.currentModel?.name || 'FLUX.2-klein'}
              licenseUrl={flux2Status.licenseUrl}
              onSaved={refreshFlux2Status}
            />
          )}
          {derived.needsHfTokenGate && hfTokenPresent === false && (
            <HfTokenBanner
              modelLabel={derived.currentModel?.name || fields.modelId}
              licenseUrl={derived.currentModel?.licenseUrl}
              onSaved={refreshHfTokenStatus}
            />
          )}

          {effectiveMode !== IMAGE_GEN_MODE.GROK && (
            <RemoteMediaTargetPicker
              target={remoteTarget}
              kind="image"
              localBlockedReason={derived.remoteUnsupportedInputs}
            />
          )}

          <ImageGenControls
            mode={effectiveMode}
            models={catalogs.models}
            modelsState={catalogs.modelsState}
            modelsError={catalogs.modelsError}
            onRetryModels={catalogs.retryModels}
            modelId={fields.modelId}
            onModelChange={actions.handleModelChange}
            width={fields.width}
            height={fields.height}
            onResolutionChange={actions.handleResolutionChange}
            steps={fields.steps}
            onStepsChange={fields.setSteps}
            guidance={fields.guidance}
            onGuidanceChange={fields.setGuidance}
            cfgScale={fields.cfgScale}
            onCfgScaleChange={fields.setCfgScale}
            quantize={fields.quantize}
            onQuantizeChange={fields.setQuantize}
            seed={fields.seed}
            onSeedChange={fields.setSeed}
            showSeed
            remoteTargetActive={derived.remoteTargetActive}
            showModel={!derived.remoteTargetActive}
            showQuantize={!derived.remoteTargetActive}
            modelStatus={isLocalMode ? modelDownload.getStatus(fields.modelId) : null}
            onModelDownload={isLocalMode ? modelDownload.start : undefined}
            onModelDownloadCancel={modelDownload.cancel}
            runtimeStatus={isLocalMode ? backend.status : null}
            onRuntimeRemedy={backend.openRuntimeInstall}
            {...cloudModelPicker.controlProps}
            cloudModelEditing={falEditing}
          />
          {isFalMode && backend.falCatalog && <FalCatalogStatus catalog={backend.falCatalog} />}
          {isAgyMode && backend.agy.error && (
            <p role="status" className="text-xs text-port-warning">
              {backend.agy.error} — renders will use the model saved in Media Gen Settings.
            </p>
          )}

          <ImageGenModelInputs form={form} backend={backend} />
          <ImageGenPostProcessOptions fields={fields} settings={settings} mode={effectiveMode} />
        </div>
      </details>

      <ImageGenErrorBanner error={generation.error} errorMeta={generation.errorMeta} />
    </div>
  );
}

function resolveSubmitGuard({ derived, loraTest, remix, modelUnavailable }) {
  const backendBlocked = derived.remoteTargetActive
    ? derived.remoteBlocked !== null
    : derived.localBackendPending || derived.notConnected || derived.editImageMissing || derived.cloudNeedsPrompt;
  const disabled = Boolean(modelUnavailable || derived.loraHandoffBlocked || derived.unsupportedLocalInputs
    || derived.invalidLocalResolution || derived.unsupportedCloudInputs || remix.pending || backendBlocked);

  if (derived.unsupportedLocalInputs) return { disabled, title: 'Clear unsupported LoRAs, input images, or negative prompts in Options. A style preset or universe style can also add a negative prompt.' };
  if (derived.invalidLocalResolution) return { disabled, title: 'Set a supported width and height in Options before rendering.' };
  if (loraTest.pending) return { disabled, title: 'Preparing this LoRA test…' };
  if (loraTest.error) return { disabled, title: loraTest.error };
  if (remix.pending) return { disabled, title: 'Restoring this image’s settings…' };
  if (derived.localBackendPending) return { disabled, title: 'Checking the image backend…' };
  if (derived.remoteBlocked) return { disabled, title: derived.remoteBlocked };
  if (derived.editImageMissing) return { disabled, title: 'This image-edit model needs a source image — open Options and upload one first' };
  if (derived.cloudNeedsPrompt) return { disabled, title: derived.cloudPromptHint };
  if (modelUnavailable) return { disabled, title: 'Select an available Runway model in Options or update your Settings default.' };
  return { disabled };
}

function ImageGenActionBar({ form, generation }) {
  const { fields, derived, images, loraTest, remix, cloudModelPicker } = form;
  const { generating, statusMsg, progressPct, pendingQueued, stageLabel, error } = generation;
  const submitGuard = resolveSubmitGuard({ derived, loraTest, remix, modelUnavailable: cloudModelPicker.unavailable });
  return (
    <div
      className="sticky top-0 z-10 -mx-3 flex flex-wrap items-center gap-2 border-y border-port-border bg-port-card/95 px-3 py-2 backdrop-blur sm:-mx-4 sm:px-4 lg:static lg:mx-0 lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none"
      data-testid="image-primary-actions"
    >
      <button
        type="submit"
        disabled={submitGuard.disabled}
        title={submitGuard.title}
        aria-describedby={derived.unsupportedCloudInputs ? 'image-gen-unsupported-cloud-inputs' : undefined}
        className="flex min-h-[44px] items-center gap-2 rounded-lg bg-port-accent px-4 py-2 text-sm font-medium text-white hover:bg-port-accent/80 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Sparkles className="w-4 h-4" /> {generating ? 'Queue' : 'Generate'}
        {derived.isAsyncMode && fields.batchCount > 1 && <span className="text-xs opacity-80">× {fields.batchCount}</span>}
      </button>
      {derived.unsupportedCloudInputs && (
        <>
          <span id="image-gen-unsupported-cloud-inputs" role="status" className="text-xs text-port-warning">
            This text-only model cannot use the selected images. Clear them or switch to a model that accepts images.
          </span>
          <button
            type="button"
            className="min-h-[44px] rounded-lg border border-port-border px-3 text-xs hover:bg-port-border/30"
            onClick={() => {
              images.handleClearInitImage();
              images.clearReferenceImages();
            }}
          >
            Clear selected images
          </button>
        </>
      )}
      {derived.editImageMissing && (
        <span className="text-xs text-port-warning">Open Options to upload a source image for this edit model</span>
      )}
      {derived.cloudNeedsPrompt && (
        <span className="text-xs text-port-warning">{derived.cloudPromptHint}</span>
      )}
      {derived.isAsyncMode && (
        <label className="flex items-center gap-1.5 text-xs text-gray-400" title="Batch size: number of renders to queue per submit">
          <span className="select-none" aria-hidden="true">×</span>
          <DraftNumber integer min={1} max={20} value={fields.batchCount} onCommit={fields.setBatchCount}>
            {(field) => <input type="number" aria-label="Batch size" className="w-14 bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent" {...field} />}
          </DraftNumber>
        </label>
      )}
      {generating && (
        <button
          type="button"
          onClick={generation.handleCancel}
          className="flex min-h-[44px] items-center gap-2 rounded-lg bg-port-error px-3 py-2 text-sm font-medium text-white hover:bg-port-error/80"
        >
          <X className="w-4 h-4" /> Cancel current
        </button>
      )}
      {pendingQueued > 0 && (
        <span className="text-xs px-2 py-1 rounded bg-port-accent/20 text-port-accent border border-port-accent/30">
          +{pendingQueued} queued
        </span>
      )}
      {progressPct != null && <span className="text-xs text-port-accent">{progressPct}%</span>}
      {(generating || error) && (
        <span role="status" className={`text-xs truncate ${error ? 'text-port-error' : 'text-gray-400'}`}>
          {error ? String(error).split('\n')[0] : stageLabel || statusMsg || 'Working...'}
        </span>
      )}
    </div>
  );
}

function ImageGenModelInputs({ form, backend }) {
  const { fields, catalogs, images, derived } = form;
  const { isLocalMode, effectiveMode, cloudModeLabel } = backend;
  return (
    <>
      {isLocalMode && catalogs.lorasState === 'error' && (
        <ListLoadError what="the LoRA library" error={catalogs.lorasError} onRetry={catalogs.retryLoras} />
      )}
      {isLocalMode && (derived.remoteTargetActive || derived.currentModel?.supportsLoras !== false) && (
        <LoraPicker
          availableLoras={catalogs.availableLoras}
          selected={fields.selectedLoras}
          onChange={fields.setSelectedLoras}
          currentRunnerFamily={derived.currentRunnerFamily}
          currentCompatKey={derived.currentCompatKey}
          onAppendTrigger={(words) => fields.setPrompt((prompt) => appendTriggerWords(prompt, words, derived.styledPrompt))}
          prompt={derived.styledPrompt}
        />
      )}
      {isLocalMode && !derived.remoteTargetActive && derived.currentModel?.supportsLoras === false && fields.selectedLoras.length > 0 && (
        <Banner tone="warning" size="sm">
          This model cannot use the selected LoRAs. Remove them before rendering.
          <button type="button" className="ml-2 min-h-[44px] text-port-accent" onClick={() => fields.setSelectedLoras([])}>Remove selected LoRAs</button>
        </Banner>
      )}
      {isLocalMode && !derived.remoteTargetActive && derived.currentModel?.supportsImg2Img === false && images.initImage.source != null && (
        <Banner tone="warning" size="sm">
          This model cannot use the selected input image.
          <button type="button" className="ml-2 min-h-[44px] text-port-accent" onClick={images.handleClearInitImage}>Remove input image</button>
        </Banner>
      )}

      {derived.i2iCapable && (
        <InitImagePicker
          initImage={images.initImage}
          initImageStrength={images.initImageStrength}
          onStrengthChange={images.setInitImageStrength}
          onPick={images.handlePickInitImage}
          onClear={images.handleClearInitImage}
          onBrowse={() => images.setGalleryPicker({ kind: 'init' })}
          editOnly={derived.isEditOnlyModel}
          backend={effectiveMode}
        />
      )}

      {derived.referenceSlotCount > 0 && (
        <ReferenceImagePicker
          referenceImages={images.activeReferenceImages}
          showStrength={derived.showReferenceStrength}
          caption={isLocalMode
            ? `up to ${derived.referenceSlotCount} images for ${derived.currentModel?.name || 'this model'} multi-reference edit`
            : `up to ${derived.referenceSlotCount} more image${derived.referenceSlotCount === 1 ? '' : 's'} ${cloudModeLabel} will use as visual references`}
          onPick={images.handlePickReferenceImage}
          onClear={images.handleClearReferenceImage}
          onStrengthChange={images.handleReferenceStrengthChange}
          onBrowse={(slot) => images.setGalleryPicker({ kind: 'reference', slot })}
        />
      )}

      {derived.droppedRefCount > 0 && !derived.unsupportedCloudInputs && (
        <p className="text-xs text-amber-400" role="status">
          {derived.droppedRefCount} reference image{derived.droppedRefCount === 1 ? '' : 's'} you picked
          {' '}won't be sent — {isLocalMode ? 'this model' : cloudModeLabel} takes {derived.referenceSlotCount}
          {derived.referenceSlotCount === 1 ? ' reference' : ' references'} here
          {images.initImage.source != null && derived.referenceSlotCount > 0 ? ', and the init image already uses a slot' : ''}.
          {' '}They stay selected if you clear the init image or switch backends.
          {!derived.remoteTargetActive && derived.currentModel?.runner === 'moss-swift' && (
            <button type="button" className="ml-2 min-h-[44px] text-port-accent" onClick={images.clearReferenceImages}>Remove reference images</button>
          )}
        </p>
      )}
    </>
  );
}

function ImageGenPostProcessOptions({ fields, settings, mode }) {
  return (
    <div className="flex flex-col gap-1 text-xs text-gray-400">
      <label
        className="flex items-center gap-2 cursor-pointer select-none"
        title="Lossless strip of the gpt-image C2PA provenance chunk. Pixels untouched. Overrides the saved Media Gen Settings default for this render only."
      >
        <input
          type="checkbox"
          checked={fields.cleanC2PA}
          onChange={(event) => fields.setCleanC2PA(event.target.checked)}
          className="rounded"
        />
        <span>
          Clean C2PA
          {settings.savedCleanC2PAByMode[mode] !== undefined && fields.cleanC2PA !== settings.savedCleanC2PAByMode[mode] && (
            <span className="ml-1 text-port-warning">(overrides saved default)</span>
          )}
        </span>
      </label>
      <label
        className="flex items-center gap-2 cursor-pointer select-none"
        title="Median + sharpen pass for AI-artifact reduction. WARNING: blurs annotation text and small details. Skip for sheets, infographics, comic panels."
      >
        <input
          type="checkbox"
          checked={fields.denoise}
          onChange={(event) => fields.setDenoise(event.target.checked)}
          className="rounded"
        />
        <span>
          Denoise <span className="text-port-warning">(blurs text)</span>
          {settings.savedDenoiseByMode[mode] !== undefined && fields.denoise !== settings.savedDenoiseByMode[mode] && (
            <span className="ml-1 text-port-warning">(overrides saved default)</span>
          )}
        </span>
      </label>
      <label
        className="flex items-center gap-2 cursor-pointer select-none"
        title="Checks the generated image for hand and finger counts, extra limbs, and composition."
      >
        <input
          type="checkbox"
          checked={Boolean(fields.verifyImage)}
          onChange={(event) => fields.setVerifyImage(event.target.checked)}
          className="rounded"
        />
        <span className="text-port-accent">
          Verify Quality & Anatomy
        </span>
      </label>
    </div>
  );
}

const ERROR_HEADINGS = {
  gated_repo: 'Model access required',
  hf_unauthorized: 'HuggingFace token rejected',
  repo_not_found: 'Model repo not found',
};

function ImageGenErrorBanner({ error, errorMeta }) {
  if (!error) return null;
  return (
    <div role="alert" className="rounded-lg border border-port-error/40 bg-port-error/10 px-3 py-3 text-xs text-port-error space-y-2">
      <div className="font-semibold text-sm">
        {ERROR_HEADINGS[errorMeta?.kind] || 'Generation failed'}
      </div>
      <div className="whitespace-pre-wrap break-words text-port-warning/90">
        {String(error)}
      </div>
      {errorMeta?.kind === 'gated_repo' && errorMeta?.repo && (
        <a
          href={`https://huggingface.co/${errorMeta.repo}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-port-accent text-white text-xs font-medium hover:bg-port-accent/80"
        >
          Request access to {errorMeta.repo} ↗
        </a>
      )}
      {errorMeta?.kind === 'hf_unauthorized' && (
        <div className="text-port-warning/80">
          Paste a fresh token in the HF token banner above (it appears when the model needs one).
        </div>
      )}
    </div>
  );
}
