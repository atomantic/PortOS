// Shared image-gen knob grid. Renders model + resolution + steps + guidance/CFG +
// quantize + (optional) seed in a 2- or 3-column grid that matches the standalone
// Image Gen page. Used by ImageGen and World Builder batch render so the form
// looks and behaves the same in both places.
//
// Props are intentionally per-field (value + onChange pairs) rather than a single
// `value` object so callers can keep using their existing useState fields without
// reshaping. `mode` drives which knobs are visible: codex hides everything except
// resolution; external swaps guidance for cfgScale; local shows guidance + quantize.

import { Dice5 } from 'lucide-react';
import { RESOLUTIONS, findResolution } from '../../lib/imageGenResolutions';
import { randomSeed } from '../../lib/genUtils';

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
}) {
  const isLocal = mode === 'local';
  const isCodex = mode === 'codex';

  const currentModel = models.find((m) => m.id === modelId);
  const isFlux2 = currentModel?.runner === 'flux2';

  const matched = findResolution(width, height);
  const resolutionLabel = matched?.label || (width && height ? `${width}×${height}` : '');
  const handleResolution = (e) => {
    const r = RESOLUTIONS.find((opt) => opt.label === e.target.value);
    if (r) onResolutionChange?.(r.w, r.h);
  };

  const inputCls = 'w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50';

  return (
    <div className={className}>
      {showModel && isLocal && models.length > 0 && (
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">Model</label>
          <select
            value={modelId || ''}
            onChange={(e) => onModelChange?.(e.target.value)}
            disabled={disabled}
            className={inputCls}
          >
            {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>
      )}

      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1">Resolution</label>
        <select
          value={resolutionLabel}
          onChange={handleResolution}
          disabled={disabled}
          className={inputCls}
        >
          {RESOLUTIONS.map((r) => <option key={r.label} value={r.label}>{r.label}</option>)}
          {!matched && resolutionLabel && <option value={resolutionLabel}>{resolutionLabel} (custom)</option>}
        </select>
      </div>

      {/* Codex's image_gen tool ignores seed/steps/guidance — only resolution
          is honored, so the rest of the knobs are hidden in that mode. */}
      {!isCodex && showSeed && (
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">Seed</label>
          <div className="flex items-center gap-1">
            <input
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
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">
            Steps {currentModel?.steps && `(default: ${currentModel.steps})`}
          </label>
          <input
            type="number" min={1} max={150}
            value={steps ?? ''}
            onChange={(e) => onStepsChange?.(e.target.value)}
            placeholder={String(currentModel?.steps || 25)}
            disabled={disabled}
            className={inputCls}
          />
        </div>
      )}

      {/* Step-wise distilled models (Flux Schnell, FLUX.2 Klein, Z-Image-Turbo)
          have classifier-free guidance baked in — the diffusers runner ignores
          any guidance scale we pass and prints a warning. Hide the input for
          those models so the user doesn't waste a knob-turn on a no-op. */}
      {!isCodex && isLocal && !currentModel?.cfgDisabled && (
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">
            Guidance {currentModel?.guidance != null && `(default: ${currentModel.guidance})`}
          </label>
          <input
            type="number" min={0} max={20} step={0.5}
            value={guidance ?? ''}
            onChange={(e) => onGuidanceChange?.(e.target.value)}
            placeholder={String(currentModel?.guidance ?? '')}
            disabled={disabled}
            className={inputCls}
          />
        </div>
      )}

      {!isCodex && isLocal && showQuantize && !isFlux2 && (
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">Quantize (bits)</label>
          <select
            value={quantize ?? '8'}
            onChange={(e) => onQuantizeChange?.(e.target.value)}
            disabled={disabled}
            className={inputCls}
          >
            {QUANTIZE_OPTIONS.map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}
          </select>
        </div>
      )}

      {!isCodex && !isLocal && onCfgScaleChange && (
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">CFG Scale ({cfgScale})</label>
          <input
            type="range" min={1} max={20} step={0.5}
            value={cfgScale ?? 7}
            disabled={disabled}
            onChange={(e) => onCfgScaleChange?.(Number(e.target.value))}
            className="w-full accent-port-accent"
          />
        </div>
      )}
    </div>
  );
}
