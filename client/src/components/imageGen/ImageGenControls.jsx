// Shared image-gen knob grid. Renders model + resolution + steps + guidance/CFG +
// quantize + (optional) seed in a 2- or 3-column grid that matches the standalone
// Image Gen page. Used by ImageGen and Universe Builder batch render so the form
// looks and behaves the same in both places.
//
// Props are intentionally per-field (value + onChange pairs) rather than a single
// `value` object so callers can keep using their existing useState fields without
// reshaping. `mode` drives which knobs are visible: codex hides everything except
// resolution; external swaps guidance for cfgScale; local shows guidance + quantize.

import { useState, useEffect } from 'react';
import { Dice5 } from 'lucide-react';
import {
  filterResolutions, resolveResolutionLabel, clampImageEdge,
  CUSTOM_RESOLUTION_VALUE, MAX_IMAGE_EDGE, MAX_IMAGE_PIXELS,
} from '../../lib/imageGenResolutions';
import { randomSeed } from '../../lib/genUtils';
import { RUNNER_FAMILIES } from '../../lib/runnerFamilies';
import { IMAGE_GEN_MODE } from '../../lib/imageGenBackends';
import ModelDownloadBadge, { deriveSizeEstimate } from '../media/ModelDownloadBadge';
import { FormField } from '../ui/FormField';

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
}) {
  const isLocal = mode === IMAGE_GEN_MODE.LOCAL;
  const isCodex = mode === IMAGE_GEN_MODE.CODEX;

  const currentModel = models.find((m) => m.id === modelId);
  const isFlux2 = currentModel?.runner === RUNNER_FAMILIES.FLUX2;

  // Filter by backend; a stale w/h (e.g. Flux 2 → Flux 1 with 1536 still set)
  // falls through to the custom inputs below so the value stays visible and
  // editable until the user picks a supported preset.
  const availableResolutions = filterResolutions(mode, currentModel?.runner);
  const { matched } = resolveResolutionLabel(availableResolutions, width, height);
  // Custom mode is sticky once opened (so a preset-matching size the user is
  // mid-edit doesn't snap the dropdown back to a preset) but also auto-engages
  // whenever the current dimensions match no preset (remix, uploaded photo, a
  // stale off-backend size) so the inputs appear without an extra click.
  const [customOpen, setCustomOpen] = useState(false);
  const isCustom = customOpen || (!matched && !!width && !!height);
  const selectValue = isCustom ? CUSTOM_RESOLUTION_VALUE : (matched?.label ?? '');
  // Latch custom mode stickily once a non-preset size appears (remix, uploaded
  // photo, stale off-backend size). Without this, clearing a Width/Height field
  // to a transient 0 mid-edit would flip `!matched && width && height` false and
  // unmount the inputs the user is typing into — which also skips the blur-snap.
  // `handleResolution` still clears the latch when a preset is explicitly picked.
  useEffect(() => {
    if (!matched && width && height) setCustomOpen(true);
  }, [matched, width, height]);
  const handleResolution = (e) => {
    if (e.target.value === CUSTOM_RESOLUTION_VALUE) { setCustomOpen(true); return; }
    const r = availableResolutions.find((opt) => opt.label === e.target.value);
    if (r) { setCustomOpen(false); onResolutionChange?.(r.w, r.h); }
  };
  // Live edits pass through raw so typing feels natural (0 = mid-edit/empty);
  // the blur handler clamps to the server's [64, MAX_IMAGE_EDGE] per-edge bounds.
  const handleCustomDim = (axis, raw) => {
    const n = Math.floor(Number(raw));
    // n > 0 already excludes NaN; Infinity can't come from a number input and
    // would clamp to MAX_IMAGE_EDGE anyway. 0 = mid-edit/empty.
    const v = n > 0 ? Math.min(MAX_IMAGE_EDGE, n) : 0;
    if (axis === 'w') onResolutionChange?.(v, height || 0);
    else onResolutionChange?.(width || 0, v);
  };
  const snapCustomDim = (axis) => {
    if (axis === 'w') onResolutionChange?.(clampImageEdge(width), height || 0);
    else onResolutionChange?.(width || 0, clampImageEdge(height));
  };
  const pixelCount = (width || 0) * (height || 0);
  const overPixelCap = pixelCount > MAX_IMAGE_PIXELS;

  const inputCls = 'w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50';

  return (
    <div className={className}>
      {showModel && isLocal && models.length > 0 && (
        <FormField label="Model" labelClassName="block text-xs font-medium text-gray-400 mb-1">
          <select
            value={modelId || ''}
            onChange={(e) => onModelChange?.(e.target.value)}
            disabled={disabled}
            className={inputCls}
          >
            {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          {onModelDownload && modelStatus && (
            <ModelDownloadBadge
              status={modelStatus}
              onDownload={() => onModelDownload(modelId)}
              onCancel={onModelDownloadCancel}
              estimateLabel={deriveSizeEstimate(currentModel?.name)}
            />
          )}
        </FormField>
      )}

      <FormField label="Resolution" labelClassName="block text-xs font-medium text-gray-400 mb-1">
        <select
          value={selectValue}
          onChange={handleResolution}
          disabled={disabled}
          className={inputCls}
        >
          {availableResolutions.map((r) => <option key={r.label} value={r.label}>{r.label}</option>)}
          <option value={CUSTOM_RESOLUTION_VALUE}>Custom…</option>
        </select>
      </FormField>

      {/* Arbitrary width/height. The server accepts any edge in [64, 3840] with
          total pixels ≤ 8.29M (imageEdgeSchema + refineImagePixelCap), so custom
          sizes like 704×1280 (9:16 portrait) work without a new preset. Step 8
          keeps values latent-friendly for the local diffusion runners. */}
      {isCustom && (
        <>
          <FormField label="Width" labelClassName="block text-xs font-medium text-gray-400 mb-1">
            <input
              type="number" min={64} max={MAX_IMAGE_EDGE} step={8}
              value={width || ''}
              onChange={(e) => handleCustomDim('w', e.target.value)}
              onBlur={() => snapCustomDim('w')}
              disabled={disabled}
              className={inputCls}
            />
          </FormField>
          <FormField label="Height" labelClassName="block text-xs font-medium text-gray-400 mb-1">
            <input
              type="number" min={64} max={MAX_IMAGE_EDGE} step={8}
              value={height || ''}
              onChange={(e) => handleCustomDim('h', e.target.value)}
              onBlur={() => snapCustomDim('h')}
              disabled={disabled}
              className={inputCls}
            />
          </FormField>
          <p className={`col-span-full text-[10px] -mt-1 ${overPixelCap ? 'text-port-error' : 'text-gray-500'}`}>
            {overPixelCap
              ? `Too large — ${pixelCount.toLocaleString()} px exceeds the ${MAX_IMAGE_PIXELS.toLocaleString()} px cap. Reduce width or height.`
              : `Each edge 64–${MAX_IMAGE_EDGE}px, total ≤ ${MAX_IMAGE_PIXELS.toLocaleString()} px. Multiples of 8 render best on local models.`}
          </p>
        </>
      )}

      {/* Codex's image_gen tool ignores seed/steps/guidance — only resolution
          is honored, so the rest of the knobs are hidden in that mode. */}
      {!isCodex && showSeed && (
        <div>
          <label htmlFor="image-gen-seed" className="block text-xs font-medium text-gray-400 mb-1">Seed</label>
          <div className="flex items-center gap-1">
            <input
              id="image-gen-seed"
              type="number"
              value={seed ?? ''}
              onChange={(e) => onSeedChange?.(e.target.value)}
              disabled={disabled}
              placeholder="Random"
              className={`flex-1 ${inputCls}`}
            />
            <button
              type="button"
              onClick={() => onSeedChange?.(randomSeed())}
              disabled={disabled}
              className="p-2 text-gray-400 hover:text-white border border-port-border rounded-lg hover:bg-port-border/50 disabled:opacity-50 min-h-[40px] min-w-[40px] flex items-center justify-center"
              title="Randomize seed"
            >
              <Dice5 className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {!isCodex && (
        <FormField
          label={<>Steps {currentModel?.steps && `(default: ${currentModel.steps})`}</>}
          labelClassName="block text-xs font-medium text-gray-400 mb-1"
        >
          <input
            type="number" min={1} max={150}
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
      {!isCodex && isLocal && !currentModel?.cfgDisabled && (
        <FormField
          label={<>Guidance {currentModel?.guidance != null && `(default: ${currentModel.guidance})`}</>}
          labelClassName="block text-xs font-medium text-gray-400 mb-1"
        >
          <input
            type="number" min={0} max={20} step={0.5}
            value={guidance ?? ''}
            onChange={(e) => onGuidanceChange?.(e.target.value)}
            placeholder={String(currentModel?.guidance ?? '')}
            disabled={disabled}
            className={inputCls}
          />
        </FormField>
      )}

      {!isCodex && isLocal && showQuantize && !isFlux2 && (
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

      {!isCodex && !isLocal && onCfgScaleChange && (
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
