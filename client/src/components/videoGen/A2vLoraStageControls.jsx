import { useId } from 'react';
import { formatCount } from '../../utils/formatters';

export default function A2vLoraStageControls({ value = [1, 1], onChange, supported, disabled = false, loras = [] }) {
  const id = useId();
  return (
    <fieldset className="space-y-2 rounded-lg border border-port-border p-3">
      <legend className="px-1 text-sm font-medium text-port-text">User LoRA stage strengths</legend>
      <p className="text-xs text-port-text-muted">Multipliers of each selected LoRA strength. Distilled refinement keeps its own adapter.</p>
      {!supported && <p role="status" className="text-xs text-port-warning">This selection requires a capable local LTX MLX audio-to-video runtime and a selected LoRA. Reset to defaults to use another workflow.</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {['Motion', 'Detail refinement'].map((label, index) => (
          <div key={label}>
            <label htmlFor={`${id}-${index}`} className="block text-xs text-port-text">{label}: {formatCount(value[index] * 100)}%</label>
            <input id={`${id}-${index}`} type="range" min="0" max="1" step="0.05" value={value[index]}
              disabled={disabled || !supported} className="w-full accent-port-accent"
              onChange={(event) => onChange(value.map((v, i) => i === index ? Number(event.target.value) : v))} />
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-3 text-xs">
        <button type="button" disabled={disabled} className="text-port-accent" onClick={() => onChange([1, 1])}>Default [1, 1]</button>
        <button type="button" disabled={disabled || !supported} className="text-port-accent disabled:opacity-50" onClick={() => onChange([0, 1])}>Motion-friendly [0, 1]</button>
      </div>
      {loras.map((lora) => <p key={lora.filename} className="break-all text-xs text-port-text-muted">{lora.name || lora.filename}: motion {((lora.scale ?? 1) * value[0]).toFixed(2)}, detail {((lora.scale ?? 1) * value[1]).toFixed(2)}</p>)}
    </fieldset>
  );
}
