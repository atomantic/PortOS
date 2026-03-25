/**
 * Two-step provider > model dropdown selector.
 * @param {Object} props
 * @param {Array} props.providers - Provider list from useProviderModels()
 * @param {string} props.selectedProviderId - Currently selected provider ID
 * @param {string} props.selectedModel - Currently selected model
 * @param {Array} props.availableModels - Models for the selected provider
 * @param {function} props.onProviderChange - Called with provider ID string
 * @param {function} props.onModelChange - Called with model string
 * @param {string} [props.label] - Label text (default: "Provider")
 * @param {boolean} [props.disabled] - Disable both selectors
 * @param {boolean} [props.compact] - Hide labels for inline/toolbar use
 */
export default function ProviderModelSelector({
  providers,
  selectedProviderId,
  selectedModel,
  availableModels,
  onProviderChange,
  onModelChange,
  label = 'Provider',
  disabled = false,
  compact = false
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 min-w-0">
        {!compact && <label className="block text-xs text-gray-500 mb-1">{label}</label>}
        <select
          value={selectedProviderId}
          onChange={(e) => onProviderChange(e.target.value)}
          disabled={disabled}
          title={compact ? label : undefined}
          className="w-full px-3 py-1.5 min-h-[36px] bg-port-bg border border-port-border rounded-lg text-white text-sm"
        >
          {providers.map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>
      {availableModels.length > 0 && (
        <div className="flex-1 min-w-0">
          {!compact && <label className="block text-xs text-gray-500 mb-1">Model</label>}
          <select
            value={selectedModel}
            onChange={(e) => onModelChange(e.target.value)}
            disabled={disabled}
            title={compact ? 'Model' : undefined}
            className="w-full px-3 py-1.5 min-h-[36px] bg-port-bg border border-port-border rounded-lg text-white text-sm"
          >
            {availableModels.map(m => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
