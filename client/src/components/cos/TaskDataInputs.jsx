import ToggleSwitch from '../ToggleSwitch';

/** Shared selector for deterministic context loaded before a scheduled agent starts. */
export default function TaskDataInputs({ catalog = [], value = [], onChange, disabled = false }) {
  if (!catalog.length) return null;
  const selected = new Set(value || []);

  const toggle = (id) => {
    const next = selected.has(id)
      ? (value || []).filter((entry) => entry !== id)
      : [...(value || []), id];
    onChange(next);
  };

  return (
    <div>
      <span className="text-sm text-gray-400 block mb-2">Preloaded data</span>
      <p className="text-xs text-gray-500 mb-2">
        PortOS reads selected sources before the agent starts and appends them to its prompt, avoiding repeated discovery tool calls.
      </p>
      <div className="space-y-1">
        {catalog.map(({ id, label, description }) => {
          const enabled = selected.has(id);
          return (
            <button
              key={id}
              type="button"
              disabled={disabled}
              aria-pressed={enabled}
              aria-label={`${label}: ${enabled ? 'on' : 'off'}`}
              onClick={() => toggle(id)}
              className={`w-full flex items-center justify-between gap-3 min-h-[44px] rounded px-2 -mx-2 text-left ${disabled ? 'opacity-60 cursor-not-allowed' : 'hover:bg-port-card/30 active:bg-port-card/50'}`}
            >
              <span className="min-w-0 flex-1">
                <span className="text-sm text-white block">{label}</span>
                <span className="text-xs text-gray-500 block">{description}</span>
              </span>
              <ToggleSwitch enabled={enabled} disabled={disabled} decorative />
            </button>
          );
        })}
      </div>
    </div>
  );
}
