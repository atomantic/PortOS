import { useEffect, useState } from 'react';
import { Palette, Check, Dice5, Cpu, Settings as SettingsIcon } from 'lucide-react';
import { randomSeed } from '../../lib/genUtils';
import BackendChipStrip from '../media/BackendChipStrip';
import { IMAGE_GEN_MODE } from '../../lib/imageGenBackends';
import StagePromptModelPicker from './StagePromptModelPicker';
import { STYLE_ID, EMPTY_IMAGE_STYLE } from '../../lib/wrImageDefaults';

const SCRIPT_STAGE = 'writers-room-script';

function groupPresetsByCategory(presets) {
  const map = new Map();
  for (const p of presets) {
    const cat = p.category || 'Other';
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat).push(p);
  }
  return Array.from(map.entries());
}

// World style picker — dropdown of curated presets + Custom + None.
// Selecting a preset fills the prompt textarea; the user can edit it freely
// from there, which flips the presetId to 'custom' the moment text diverges.
// Saves are debounced into a single PATCH on blur (not per-keystroke) — the
// onChange contract is "give me the next imageStyle" not "save it now."
function WorldStyleRow({ value, presets, onChange }) {
  const [draftPrompt, setDraftPrompt] = useState(value.prompt || '');
  const [draftNeg, setDraftNeg] = useState(value.negativePrompt || '');

  // Pull the saved value down when the work id swaps (or anything else that
  // replaces the value object identity from the parent).
  useEffect(() => {
    setDraftPrompt(value.prompt || '');
    setDraftNeg(value.negativePrompt || '');
  }, [value.presetId, value.prompt, value.negativePrompt]);

  const pickPreset = (presetId) => {
    if (presetId === STYLE_ID.NONE) {
      onChange?.(EMPTY_IMAGE_STYLE);
      return;
    }
    if (presetId === STYLE_ID.CUSTOM) {
      // Keep whatever's in the textarea — just flip the discriminator.
      onChange?.({ presetId: STYLE_ID.CUSTOM, prompt: draftPrompt, negativePrompt: draftNeg });
      return;
    }
    const preset = presets.find((p) => p.id === presetId);
    if (!preset) return;
    onChange?.({ presetId: preset.id, prompt: preset.prompt, negativePrompt: preset.negativePrompt });
  };

  const commitDraft = () => {
    if (draftPrompt === value.prompt && draftNeg === value.negativePrompt) return;
    // If the user edited a preset's text, flip to 'custom' so the dropdown
    // reflects that the prompt no longer matches the curated preset.
    const matchingPreset = presets.find((p) => p.id === value.presetId);
    const stillMatchesPreset = matchingPreset
      && matchingPreset.prompt === draftPrompt
      && matchingPreset.negativePrompt === draftNeg;
    onChange?.({
      presetId: stillMatchesPreset ? value.presetId : STYLE_ID.CUSTOM,
      prompt: draftPrompt,
      negativePrompt: draftNeg,
    });
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[9px] uppercase tracking-wider text-gray-500 flex items-center gap-1">
          <Palette size={10} /> World style
        </span>
        {value.presetId !== STYLE_ID.NONE && (
          <button
            type="button"
            onClick={() => pickPreset(STYLE_ID.NONE)}
            className="text-[9px] text-gray-500 hover:text-port-error"
            title="Clear style"
          >
            Clear
          </button>
        )}
      </div>
      <select
        value={value.presetId}
        onChange={(e) => pickPreset(e.target.value)}
        className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-[11px] text-gray-200"
      >
        <option value={STYLE_ID.NONE}>None — use scene visualPrompt only</option>
        {groupPresetsByCategory(presets).map(([cat, items]) => (
          <optgroup key={cat} label={cat}>
            {items.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </optgroup>
        ))}
        <option value={STYLE_ID.CUSTOM}>Custom</option>
      </select>
      {value.presetId !== STYLE_ID.NONE && (
        <>
          <label className="block">
            <span className="text-[9px] uppercase tracking-wider text-gray-500">
              Style prompt {value.presetId === STYLE_ID.CUSTOM && <Check size={9} className="inline text-port-accent" />}
            </span>
            <textarea
              value={draftPrompt}
              onChange={(e) => setDraftPrompt(e.target.value)}
              onBlur={commitDraft}
              rows={3}
              placeholder="cinematic still, anamorphic lens…"
              className="w-full mt-0.5 bg-port-bg border border-port-border rounded px-2 py-1 text-[11px] text-gray-200 font-sans resize-y"
            />
          </label>
          <label className="block">
            <span className="text-[9px] uppercase tracking-wider text-gray-500">Negative prompt (optional)</span>
            <textarea
              value={draftNeg}
              onChange={(e) => setDraftNeg(e.target.value)}
              onBlur={commitDraft}
              rows={2}
              placeholder="cartoon, low quality…"
              className="w-full mt-0.5 bg-port-bg border border-port-border rounded px-2 py-1 text-[11px] text-gray-200 font-sans resize-y"
            />
          </label>
          <div className="text-[10px] text-gray-500">
            Style is prepended to every scene's image prompt. Re-render scenes to see the change.
          </div>
        </>
      )}
    </div>
  );
}

const RES_PRESETS = [
  { label: '768×512 (3:2)',  width: 768, height: 512 },
  { label: '512×512 (1:1)',  width: 512, height: 512 },
  { label: '512×768 (2:3)',  width: 512, height: 768 },
  { label: '1024×576 (16:9)', width: 1024, height: 576 },
  { label: '1024×1024 (1:1)', width: 1024, height: 1024 },
];

// Per-mode form layout — Codex picks model/steps/seed internally, External
// SD-API loads its model server-side. Showing fields the active backend
// can't act on misleads the user about what's actually controlling renders.
const MODE_HINT = {
  [IMAGE_GEN_MODE.LOCAL]: 'Renders locally via mflux/diffusers on this machine.',
  [IMAGE_GEN_MODE.CODEX]: "Codex's $imagegen skill renders via your logged-in Codex session. Model, steps, and seed are picked by Codex itself.",
  [IMAGE_GEN_MODE.EXTERNAL]: 'External SD-API renders against your configured A1111/Forge endpoint. The active model is set by the SD-API server.',
};

function ImageGenSettingsRow({ cfg, models, availableBackends = [], onChange }) {
  const presetMatch = RES_PRESETS.find((p) => p.width === cfg.width && p.height === cfg.height);
  const currentModel = models.find((m) => m.id === cfg.modelId);
  const inputCls = 'w-full mt-0.5 bg-port-bg border border-port-border rounded px-2 py-1 text-[11px] text-gray-200 focus:border-port-accent outline-none';
  const labelCls = 'text-[9px] uppercase tracking-wider text-gray-500';
  const isLocalMode = cfg.mode === IMAGE_GEN_MODE.LOCAL;
  const isCodexMode = cfg.mode === IMAGE_GEN_MODE.CODEX;
  return (
    <div className="space-y-1.5">
      {availableBackends.length > 0 && (
        <div>
          <span className={labelCls}>Backend</span>
          <div className="mt-0.5">
            <BackendChipStrip
              availableBackends={availableBackends}
              value={cfg.mode}
              onChange={(id) => onChange({ ...cfg, mode: id })}
              size="sm"
              ariaLabel="Image gen backend"
              titlePrefix="Render storyboard scenes via"
            />
          </div>
          <p className="text-[9px] text-gray-500 mt-1">{MODE_HINT[cfg.mode]}</p>
        </div>
      )}
      <div className="grid grid-cols-2 gap-1.5">
        {isLocalMode && (
          <label className="block">
            <span className={labelCls}>Image model</span>
            <select
              value={cfg.modelId}
              onChange={(e) => onChange({ ...cfg, modelId: e.target.value })}
              className={inputCls}
            >
              {models.length === 0 && <option value={cfg.modelId}>{cfg.modelId}</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.name || m.id}</option>
              ))}
            </select>
          </label>
        )}
        <label className="block">
          <span className={labelCls}>Resolution</span>
          <select
            value={presetMatch ? `${cfg.width}x${cfg.height}` : 'custom'}
            onChange={(e) => {
              if (e.target.value === 'custom') return;
              const [w, h] = e.target.value.split('x').map(Number);
              onChange({ ...cfg, width: w, height: h });
            }}
            className={inputCls}
          >
            {RES_PRESETS.map((p) => (
              <option key={p.label} value={`${p.width}x${p.height}`}>{p.label}</option>
            ))}
            {!presetMatch && <option value="custom">Custom ({cfg.width}×{cfg.height})</option>}
          </select>
        </label>
      </div>
      {!isCodexMode && (
        <div className="grid grid-cols-2 gap-1.5">
          <label className="block">
            <span className={labelCls}>
              Steps {isLocalMode && currentModel?.steps && <span className="normal-case text-gray-600">(default {currentModel.steps})</span>}
            </span>
            <input
              type="number" min={1} max={150}
              value={cfg.steps}
              onChange={(e) => onChange({ ...cfg, steps: e.target.value })}
              placeholder={isLocalMode ? String(currentModel?.steps || 'auto') : 'server default'}
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className={labelCls}>Seed</span>
            <div className="flex items-stretch gap-1 mt-0.5">
              <input
                type="number"
                value={cfg.seed}
                onChange={(e) => onChange({ ...cfg, seed: e.target.value })}
                placeholder="random"
                className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1 text-[11px] text-gray-200 focus:border-port-accent outline-none"
              />
              <button
                type="button"
                onClick={() => onChange({ ...cfg, seed: randomSeed() })}
                className="px-1.5 text-gray-500 hover:text-port-accent border border-port-border rounded"
                title="Randomize seed"
                aria-label="Randomize seed"
              >
                <Dice5 size={11} />
              </button>
            </div>
          </label>
        </div>
      )}
    </div>
  );
}

// ─── Config (image gen + style + Adapt LLM) ───────────────────────────────
export default function StoryboardConfigTab({ imageCfg, models, availableBackends, onCfgChange, stylePresets, imageStyle, onStyleChange, onOpenImageGenSettings }) {
  return (
    <div className="px-3 py-3 space-y-4">
      <section className="space-y-1.5">
        <div className="text-[12px] font-semibold text-gray-200">Adapt LLM</div>
        <StagePromptModelPicker
          stageName={SCRIPT_STAGE}
          label="Adapt LLM"
          icon={<Cpu size={10} />}
          hint="Used when you click Run Adapt to break prose into scenes."
        />
      </section>
      <section className="space-y-1.5 pt-3 border-t border-port-border">
        <div className="text-[12px] font-semibold text-gray-200">World style</div>
        <WorldStyleRow value={imageStyle} presets={stylePresets} onChange={onStyleChange} />
      </section>
      <section className="space-y-1.5 pt-3 border-t border-port-border">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[12px] font-semibold text-gray-200">Image generation</div>
          <button
            type="button"
            onClick={onOpenImageGenSettings}
            className="flex items-center gap-1 px-2 py-1 text-[10px] rounded border border-port-border text-gray-300 hover:bg-port-border/40 hover:text-white"
            title="Configure image gen backends — enable Codex $imagegen, set local Python, etc."
          >
            <SettingsIcon size={10} /> Backends
          </button>
        </div>
        {availableBackends.length === 0 && (
          <div className="text-[10px] text-port-warning bg-port-warning/10 border border-port-warning/40 rounded px-2 py-1.5">
            No image gen backend configured. Click <span className="font-medium">Backends</span> to enable Local mflux, Codex <code className="text-gray-400">$imagegen</code>, or an External SD-API endpoint.
          </div>
        )}
        <ImageGenSettingsRow cfg={imageCfg} models={models} availableBackends={availableBackends} onChange={onCfgChange} />
      </section>
    </div>
  );
}
