// Shared image-gen knob grid. Renders model + resolution + steps + guidance/CFG +
// quantize + (optional) seed in a 2- or 3-column grid that matches the standalone
// Image Gen page. Used by ImageGen and Universe Builder batch render so the form
// looks and behaves the same in both places.
//
// Props are intentionally per-field (value + onChange pairs) rather than a single
// `value` object so callers can keep using their existing useState fields without
// reshaping. `mode` drives which knobs are visible: codex hides everything except
// resolution; external swaps guidance for cfgScale; local shows guidance + quantize.

import { useId } from 'react';
import { Dice5 } from 'lucide-react';
import { clampImageEdge, filterResolutions, localImageResolutionBounds, MAX_IMAGE_EDGE, MAX_IMAGE_PIXELS } from '../../lib/imageGenResolutions';
import { randomSeed } from '../../lib/genUtils';
import { RUNNER_FAMILIES } from '../../lib/runnerFamilies';
import { IMAGE_GEN_MODE, isCloudCliMode } from '../../lib/imageGenBackends';
import { formatCount } from '../../utils/formatters';
import ResolutionField from '../media/ResolutionField';
import { FormField } from '../ui/FormField';
import ImageGenModelSection from './ImageGenModelSection';

const QUANTIZE_OPTIONS = [
  { value: '3', label: '3-bit' },
  { value: '4', label: '4-bit (fast)' },
  { value: '5', label: '5-bit' },
  { value: '6', label: '6-bit' },
  { value: '8', label: '8-bit (default)' },
];

export default function ImageGenControls({
  mode,
  models = [],
  // `useListResource` state of the local model catalog. `null` (the default
  // for callers that hand in a resolved list) renders as before; 'error' and
  // an empty 'ready' list get their own rows so a failed read never looks
  // like "no models".
  modelsState = null,
  modelsError = null,
  onRetryModels,
  modelId, onModelChange,
  width, height, onResolutionChange,
  steps, onStepsChange,
  guidance, onGuidanceChange,
  cfgScale, onCfgScaleChange,
  quantize, onQuantizeChange,
  seed, onSeedChange,
  showSeed = false,
  showQuantize = true,
  showModel = true,
  remoteTargetActive = false,
  disabled = false,
  // Optional column override — defaults to 2/3 like the Image Gen page.
  // Pass e.g. "grid-cols-2 sm:grid-cols-4" to fit a denser layout.
  className = 'grid grid-cols-2 sm:grid-cols-3 gap-3',
  // Pre-download badge integration. `modelStatus` is the per-model entry from
  // useModelDownloadStatus().getStatus(modelId); `onModelDownload` /
  // `onModelDownloadCancel` are optional triggers. Omitting the props hides
  // the badge — callers that don't care (Universe Builder batch render) opt
  // out by simply not passing them.
  modelStatus = null,
  onModelDownload,
  onModelDownloadCancel,
  // The local runtime verdict for the picked model (GET /image-gen/status),
  // so the badge never says "Available" over a runtime that cannot load the
  // weights. `onRuntimeRemedy(kind)` performs a self-serve remedy in place.
  runtimeStatus = null,
  onRuntimeRemedy,
  // Per-render cloud-CLI model override. `cloudModels` is the live catalog —
  // an id outside it makes the CLI exit before generating, so the select only
  // renders once the probe has returned something AND the host wired
  // `onCloudModelChange`. Omitting either prop hides the knob entirely rather
  // than shipping a control whose value the host would silently drop. No mode
  // check here: the host owns which backends it supplies a catalog for (see
  // supportsCloudModelOverride), so a second CLI backend is a caller change,
  // not an edit to this shared component. Entries are plain ids, or
  // `{ id, label }` rows for a catalog whose ids need a human label (fal.ai).
  cloudModels = [],
  cloudModel = '',
  onCloudModelChange,
  cloudModelLabel = 'Model',
  cloudModelDefaultLabel = '',
  // An edit or refine, or a fal render that already has a source image, leads
  // with the featured edit endpoints. A fresh text render keeps Featured as-is.
  cloudModelEditing = false,
}) {
  // useId: the queue's retry editors render this grid beside the compose form, so a fixed id would collide.
  const seedId = useId();
  const isLocal = mode === IMAGE_GEN_MODE.LOCAL;
  // Cloud-CLI backends (codex, grok) pick model/steps/seed internally — only
  // resolution + style fields apply, so the local-only knobs are hidden.
  const isCloudCli = isCloudCliMode(mode);

  // A peer chooses its own model; the retained local selection cannot constrain it.
  const currentModel = remoteTargetActive ? null : models.find((m) => m.id === modelId);
  const isFlux2 = currentModel?.runner === RUNNER_FAMILIES.FLUX2;
  const isFlux3 = isLocal && currentModel?.runner === 'flux3';
  const isMoss = isLocal && currentModel?.runner === 'moss-swift';
  const resolutionBounds = isLocal ? localImageResolutionBounds(currentModel?.runner) : undefined;

  // Filter by backend; a stale w/h (e.g. Flux 2 → Flux 1 with 1536 still set)
  // falls through to the custom inputs (rendered by ResolutionField) so the
  // value stays visible and editable until the user picks a supported preset.
  const availableResolutions = filterResolutions(mode, currentModel?.runner)
    .filter(size => !resolutionBounds || [size.w, size.h].every(edge => clampImageEdge(edge, resolutionBounds) === edge));

  const inputCls = 'w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50';

  return (
    <div className={className}>
      <ImageGenModelSection
        mode={mode}
        models={models}
        modelsState={modelsState}
        modelsError={modelsError}
        onRetryModels={onRetryModels}
        modelId={modelId}
        onModelChange={onModelChange}
        showModel={showModel}
        currentModel={currentModel}
        disabled={disabled}
        inputCls={inputCls}
        modelStatus={modelStatus}
        onModelDownload={onModelDownload}
        onModelDownloadCancel={onModelDownloadCancel}
        runtimeStatus={runtimeStatus}
        onRuntimeRemedy={onRuntimeRemedy}
        cloudModels={cloudModels}
        cloudModel={cloudModel}
        onCloudModelChange={onCloudModelChange}
        cloudModelLabel={cloudModelLabel}
        cloudModelDefaultLabel={cloudModelDefaultLabel}
        cloudModelEditing={cloudModelEditing}
      />

      {/* Preset dropdown + arbitrary width/height. The image route accepts ANY
          integer edge in [64, 3840] with total pixels ≤ 8.29M (imageEdgeSchema
          is `z.number().int().min(64).max(3840)` + refineImagePixelCap), so
          custom sizes like 704×1280 (9:16 portrait) work without a new preset.
          step=1 (not 8) so a hand-typed non-multiple-of-8 edge isn't blocked by
          the form's native stepMismatch validation before submit — the note
          keeps "multiples of 8 render best" as advice, not a hard constraint. */}
      <ResolutionField
        presets={availableResolutions}
        width={width}
        height={height}
        onChange={onResolutionChange}
        min={resolutionBounds?.min ?? 64}
        max={resolutionBounds?.max ?? MAX_IMAGE_EDGE}
        step={resolutionBounds?.step ?? 1}
        maxPixels={MAX_IMAGE_PIXELS}
        disabled={disabled}
        inputClassName={inputCls}
        note={resolutionBounds
          ? `Each edge must be ${resolutionBounds.min}–${resolutionBounds.max}px, in multiples of ${resolutionBounds.step}.`
          : `Each edge 64–${MAX_IMAGE_EDGE}px, total ≤ ${formatCount(MAX_IMAGE_PIXELS)} px. Multiples of 8 render best on local models.`}
      />

      {/* Codex's image_gen tool ignores seed/steps/guidance — only resolution
          is honored, so the rest of the knobs are hidden in that mode. */}
      {!isCloudCli && showSeed && (
        <div>
          <label htmlFor={seedId} className="block text-xs font-medium text-gray-400 mb-1">Seed</label>
          <div className="flex items-center gap-1">
            <input
              id={seedId}
              type="number"
              value={seed ?? ''}
              onChange={(e) => onSeedChange?.(e.target.value)}
              disabled={disabled}
              placeholder="Random"
              className={`min-w-0 flex-1 ${inputCls}`}
            />
            <button
              type="button"
              onClick={() => onSeedChange?.(randomSeed())}
              disabled={disabled}
              className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 p-2 text-gray-400 hover:text-white border border-port-border rounded-lg hover:bg-port-border/50 disabled:opacity-50 min-h-[40px] min-w-[40px] flex items-center justify-center"
              title="Randomize seed" aria-label="Randomize seed"
            >
              <Dice5 className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {!isCloudCli && !(isLocal && currentModel?.samplerLocked) && (
        <FormField
          label={<>Steps {currentModel?.steps && `(default: ${currentModel.steps})`}</>}
          labelClassName="block text-xs font-medium text-gray-400 mb-1"
        >
          <input
            type="number" min={1} max={isMoss ? 100 : 150}
            value={steps ?? ''}
            onChange={(e) => onStepsChange?.(e.target.value)}
            placeholder={String(currentModel?.steps || 25)}
            disabled={disabled}
            className={inputCls}
          />
        </FormField>
      )}

      {/* Step-wise distilled models (Flux Schnell, FLUX.2 Klein, Z-Image-Turbo)
          have classifier-free guidance baked in — the diffusers runner ignores
          any guidance scale we pass and prints a warning. Hide the input for
          those models so the user doesn't waste a knob-turn on a no-op. */}
      {!isCloudCli && isLocal && !currentModel?.cfgDisabled && (
        <FormField
          label={<>Guidance {currentModel?.guidance != null && `(default: ${currentModel.guidance})`}</>}
          labelClassName="block text-xs font-medium text-gray-400 mb-1"
        >
          <input
            type="number" min={0} max={isMoss ? 10 : 20} step={0.5}
            value={guidance ?? ''}
            onChange={(e) => onGuidanceChange?.(e.target.value)}
            placeholder={String(currentModel?.guidance ?? '')}
            disabled={disabled}
            className={inputCls}
          />
        </FormField>
      )}

      {!isCloudCli && isLocal && showQuantize && !isFlux2 && !isFlux3 && !currentModel?.quantization && currentModel?.runner !== 'moss-swift' && (
        <FormField label="Quantize (bits)" labelClassName="block text-xs font-medium text-gray-400 mb-1">
          <select
            value={quantize ?? '8'}
            onChange={(e) => onQuantizeChange?.(e.target.value)}
            disabled={disabled}
            className={inputCls}
          >
            {QUANTIZE_OPTIONS.map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}
          </select>
        </FormField>
      )}

      {!isCloudCli && !isLocal && onCfgScaleChange && (
        <FormField
          label={<>CFG Scale ({cfgScale})</>}
          labelClassName="block text-xs font-medium text-gray-400 mb-1"
        >
          <input
            type="range" min={1} max={20} step={0.5}
            value={cfgScale ?? 7}
            disabled={disabled}
            onChange={(e) => onCfgScaleChange?.(Number(e.target.value))}
            className="w-full accent-port-accent"
          />
        </FormField>
      )}
    </div>
  );
}
