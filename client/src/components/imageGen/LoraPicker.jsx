// Shared LoRA multi-select used by the Image Gen page and the Universe
// Builder batch-render form. Filters `availableLoras` by `currentRunnerFamily`
// (legacy entries with `runnerFamily === null` are shown too — the runner
// may still accept them and we surface a clear error otherwise).
//
// `selected` is the caller-owned list of `{ filename, name, scale }` entries.
// `onChange(next)` receives the full updated list (add / remove / scale edit).
//
// When `onAppendTrigger` is provided, each selected LoRA with trigger words
// gets a `+ trigger` button — typically wired to append the trigger tokens to
// the caller's prompt. Omit it (or pass `null`) where there's no prompt to
// append into (batch render with per-variation prompts).

import { Link } from 'react-router-dom';

// Matches /api/image-gen/generate and /api/universe-builder/:id/render's
// .max(8) on the LoRA list. Hard cap stops the user from queuing a render
// that the server would reject with a confusing 400.
const MAX_SELECTED_LORAS = 8;

export default function LoraPicker({
  availableLoras = [],
  selected = [],
  onChange,
  currentRunnerFamily,
  onAppendTrigger = null,
  disabled = false,
}) {
  if (!availableLoras.length) return null;
  const compatible = availableLoras.filter((l) => !l.runnerFamily || l.runnerFamily === currentRunnerFamily);
  const atCap = selected.length >= MAX_SELECTED_LORAS;

  const toggle = (lora, on) => {
    if (on) {
      if (atCap) return;
      const recommended = typeof lora.recommendedScale === 'number' ? lora.recommendedScale : 1.0;
      onChange?.([...selected, { filename: lora.filename, name: lora.name, scale: recommended }]);
    } else {
      onChange?.(selected.filter((s) => s.filename !== lora.filename));
    }
  };
  const setScale = (filename, scale) => {
    onChange?.(selected.map((s) => s.filename === filename ? { ...s, scale } : s));
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="block text-xs font-medium text-gray-400">
          LoRAs <span className="text-gray-600 font-normal">
            ({compatible.length}/{availableLoras.length} compatible
            {selected.length > 0 ? ` · ${selected.length}/${MAX_SELECTED_LORAS} selected` : ''})
          </span>
        </label>
        <Link to="/media/loras" className="text-[11px] text-port-accent hover:underline">Manage →</Link>
      </div>
      {compatible.length === 0 ? (
        <p className="text-xs text-gray-500 italic">
          No LoRAs match this model&apos;s runner. Install one matching <code>{currentRunnerFamily}</code> on the LoRAs page.
        </p>
      ) : (
        <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
          {compatible.map((lora) => {
            const sel = selected.find((s) => s.filename === lora.filename);
            const recommended = typeof lora.recommendedScale === 'number' ? lora.recommendedScale : 1.0;
            const triggers = lora.triggerWords || [];
            return (
              <div key={lora.filename} className="flex items-center gap-2">
                <label className={`flex items-center gap-2 flex-1 min-w-0 ${atCap && !sel ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
                  <input
                    type="checkbox"
                    checked={!!sel}
                    disabled={disabled || (atCap && !sel)}
                    onChange={(e) => toggle(lora, e.target.checked)}
                    className="rounded"
                    title={atCap && !sel ? `Maximum ${MAX_SELECTED_LORAS} LoRAs per render — uncheck one to swap` : undefined}
                  />
                  <span className="text-xs text-gray-300 truncate flex-1" title={triggers.length ? `Trigger words: ${triggers.join(', ')}` : lora.name}>
                    {lora.name}
                    {/* baseModel suffix disambiguates multiple installed
                        versions of the same model (e.g. ZImageBase vs
                        ZImageTurbo, both mapping to 'z-image' family). */}
                    {lora.civitai?.baseModel && (
                      <span className="ml-1.5 text-[10px] text-gray-600 font-mono">[{lora.civitai.baseModel}]</span>
                    )}
                    {triggers.length > 0 && (
                      <span className="ml-2 text-[10px] text-gray-500 font-mono">{triggers.slice(0, 2).join(', ')}{triggers.length > 2 ? '…' : ''}</span>
                    )}
                  </span>
                </label>
                {sel && (
                  <div className="flex items-center gap-2">
                    {triggers.length > 0 && onAppendTrigger && (
                      <button
                        type="button"
                        onClick={() => onAppendTrigger(triggers)}
                        disabled={disabled}
                        title={`Append to prompt: ${triggers.join(', ')}`}
                        className="text-[11px] px-2 py-1 rounded bg-port-accent/10 text-port-accent border border-port-accent/30 hover:bg-port-accent/20 disabled:opacity-50 whitespace-nowrap"
                      >
                        + trigger
                      </button>
                    )}
                    <span className="text-xs text-gray-500" title={`Recommended: ${recommended.toFixed(2)}`}>Scale</span>
                    <input
                      type="number" min={0} max={2} step={0.1}
                      value={sel.scale}
                      disabled={disabled}
                      onChange={(e) => setScale(lora.filename, parseFloat(e.target.value) || 0)}
                      className="w-20 bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-gray-200"
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
