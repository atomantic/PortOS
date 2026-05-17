// Shared image-gen settings form. Bundles the backend chip strip + the
// per-model ImageGenControls grid + optional negativePrompt / extraStyle
// textareas behind a single `value`/`onChange` contract. Use it anywhere
// you'd otherwise hand-roll the same trio (Drawer settings panels, in-page
// config sections, modal pickers).
//
// Caller owns the `value` shape — typically a flat object like
// { mode, modelId, width, height, steps, guidance, negativePrompt, extraStyle }
// — and a single `onChange(next)` callback receives the merged object.

import BackendChipStrip from '../media/BackendChipStrip';
import ImageGenControls from './ImageGenControls';
import LoraPicker from './LoraPicker';
import StylePresetPicker from '../media/StylePresetPicker';
import { IMAGE_GEN_MODE } from '../../lib/imageGenBackends';

export default function ImageGenSettingsForm({
  value,
  onChange,
  models = [],
  availableBackends = [],
  showStyleFields = true,
  // LoRA picker — local mode only. Pass `availableLoras` + `currentRunnerFamily`
  // to enable. `cfg.loras` holds the selected `[{ filename, name, scale }]`.
  showLoras = false,
  availableLoras = [],
  currentRunnerFamily = null,
  onAppendTrigger = null,
  // Style preset picker — sits above the extra-style textarea. `cfg.stylePreset`
  // holds the full preset object (not just the id) so consumers can compose
  // styled prompts without a second lookup.
  showStylePreset = false,
  disabled = false,
}) {
  const cfg = value || {};
  const merge = (patch) => onChange?.({ ...cfg, ...patch });
  const isCodex = cfg.mode === IMAGE_GEN_MODE.CODEX;
  const isLocal = cfg.mode === IMAGE_GEN_MODE.LOCAL;
  const labelCls = 'block text-xs font-medium text-gray-400 mb-1';
  const textareaCls = 'w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50 resize-y';

  return (
    <div className="space-y-4">
      {availableBackends.length === 0 ? (
        <div className="text-[11px] text-port-warning bg-port-warning/10 border border-port-warning/40 rounded px-2 py-1.5">
          No image gen backend configured. Open Settings → Image Gen to enable Local mflux or Codex <code className="text-gray-400">$imagegen</code>.
        </div>
      ) : null}

      {availableBackends.length > 0 ? (
        <div>
          <span className={labelCls}>Backend</span>
          <BackendChipStrip
            availableBackends={availableBackends}
            value={cfg.mode}
            onChange={(id) => merge({ mode: id })}
            size="md"
            ariaLabel="Image gen backend"
            titlePrefix="Render via"
            disabled={disabled}
          />
          {isCodex ? (
            <p className="text-[10px] text-gray-500 mt-1">
              Codex's <code className="text-gray-400">$imagegen</code> picks model, steps, and seed internally. Only resolution + style fields apply.
            </p>
          ) : null}
        </div>
      ) : null}

      <ImageGenControls
        mode={cfg.mode}
        models={models}
        modelId={cfg.modelId}
        onModelChange={(modelId) => merge({ modelId, steps: '', guidance: '' })}
        width={cfg.width}
        height={cfg.height}
        onResolutionChange={(width, height) => merge({ width, height })}
        steps={cfg.steps}
        onStepsChange={(steps) => merge({ steps })}
        guidance={cfg.guidance}
        onGuidanceChange={(guidance) => merge({ guidance })}
        cfgScale={cfg.cfgScale}
        onCfgScaleChange={(cfgScale) => merge({ cfgScale })}
        quantize={cfg.quantize}
        onQuantizeChange={(quantize) => merge({ quantize })}
        seed={cfg.seed}
        onSeedChange={(seed) => merge({ seed })}
        showSeed
        disabled={disabled}
      />

      {showLoras && isLocal ? (
        <LoraPicker
          availableLoras={availableLoras}
          selected={Array.isArray(cfg.loras) ? cfg.loras : []}
          onChange={(loras) => merge({ loras })}
          currentRunnerFamily={currentRunnerFamily}
          onAppendTrigger={onAppendTrigger}
          disabled={disabled}
        />
      ) : null}

      {showStylePreset ? (
        <StylePresetPicker
          value={cfg.stylePreset?.id || ''}
          onChange={(preset) => merge({ stylePreset: preset })}
          disabled={disabled}
        />
      ) : null}

      {showStyleFields ? (
        <div className="space-y-3">
          <label className="block">
            <span className={labelCls}>Extra style (optional)</span>
            <textarea
              rows={2}
              value={cfg.extraStyle || ''}
              onChange={(e) => merge({ extraStyle: e.target.value })}
              placeholder="cinematic ink, bold panel borders…"
              className={textareaCls}
              disabled={disabled}
            />
          </label>
          <label className="block">
            <span className={labelCls}>Negative prompt (optional)</span>
            <textarea
              rows={2}
              value={cfg.negativePrompt || ''}
              onChange={(e) => merge({ negativePrompt: e.target.value })}
              placeholder="blurry, low quality, watermark…"
              className={textareaCls}
              disabled={disabled}
            />
          </label>
        </div>
      ) : null}
    </div>
  );
}
