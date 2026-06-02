/**
 * Two-step provider > model dropdown selector.
 * @param {Object} props
 * @param {Array} props.providers - Provider list from useProviderModels()
 * @param {string} props.selectedProviderId - Currently selected provider ID
 * @param {string} props.selectedModel - Currently selected model
 * @param {Array} props.availableModels - Models for the selected provider. Entries
 *   may be plain strings, or `{ id, name }` objects (the world builder passes the
 *   raw provider `models` array, which can be object-shaped).
 * @param {function} props.onProviderChange - Called with provider ID string ("" when
 *   `emptyProviderOption` is set and the user picks it).
 * @param {function} props.onModelChange - Called with model string
 * @param {string} [props.label] - Label text (default: "Provider")
 * @param {boolean} [props.disabled] - Disable both selectors
 * @param {boolean} [props.modelDisabled] - Disable only the model selector (e.g.
 *   when the selected provider has no models). Composes with `disabled`.
 * @param {boolean} [props.compact] - Hide labels for inline/toolbar use
 * @param {string} [props.emptyProviderOption] - When set, prepends an option with
 *   value `""` and this label, letting the caller represent a "no explicit
 *   provider / use the default" choice. Omit (the default) to force a selection.
 * @param {string} [props.emptyModelOption] - Same idea for the model select.
 * @param {boolean} [props.alwaysShowModel] - Render the model select even when
 *   `availableModels` is empty (default: only render it when there are models).
 *   Pair with `emptyModelOption` when the default choice is itself meaningful.
 * @param {'row'|'stacked'} [props.layout] - 'row' (default) lays the two selects
 *   side by side; 'stacked' places the model select under the provider select for
 *   narrow columns.
 */
import { useId } from 'react';

const SELECT_CLASS =
  'w-full px-3 py-1.5 min-h-[36px] bg-port-bg border border-port-border rounded-lg text-white text-sm';

// Normalize a model entry (string or `{ id, name }`) to `{ value, label }`,
// or null for a nullish entry so the caller can skip it (a provider with an
// empty/sparse model list shouldn't render a blank option or crash).
function modelOption(m) {
  if (m == null) return null;
  if (typeof m === 'string') return { value: m, label: m };
  return { value: m.id, label: m.name || m.id };
}

export default function ProviderModelSelector({
  providers,
  selectedProviderId,
  selectedModel,
  availableModels,
  onProviderChange,
  onModelChange,
  label = 'Provider',
  disabled = false,
  modelDisabled = false,
  compact = false,
  emptyProviderOption,
  emptyModelOption,
  alwaysShowModel = false,
  layout = 'row'
}) {
  const providerSelectId = useId();
  const modelSelectId = useId();
  const showModel = alwaysShowModel || availableModels.length > 0;
  const wrapperClass = layout === 'stacked' ? 'flex flex-col gap-1' : 'flex items-center gap-2';
  return (
    <div className={wrapperClass}>
      <div className="flex-1 min-w-0">
        {!compact && <label htmlFor={providerSelectId} className="block text-xs text-gray-500 mb-1">{label}</label>}
        <select
          id={providerSelectId}
          value={selectedProviderId}
          onChange={(e) => onProviderChange(e.target.value)}
          disabled={disabled}
          title={compact ? label : undefined}
          aria-label={compact ? label : undefined}
          className={SELECT_CLASS}
        >
          {emptyProviderOption != null && <option value="">{emptyProviderOption}</option>}
          {providers.map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>
      {showModel && (
        <div className="flex-1 min-w-0">
          {!compact && <label htmlFor={modelSelectId} className="block text-xs text-gray-500 mb-1">Model</label>}
          <select
            id={modelSelectId}
            value={selectedModel}
            onChange={(e) => onModelChange(e.target.value)}
            disabled={disabled || modelDisabled}
            title={compact ? 'Model' : undefined}
            aria-label={compact ? 'Model' : undefined}
            className={SELECT_CLASS}
          >
            {emptyModelOption != null && <option value="">{emptyModelOption}</option>}
            {availableModels.map(m => {
              const opt = modelOption(m);
              if (!opt) return null;
              return <option key={opt.value} value={opt.value}>{opt.label}</option>;
            })}
          </select>
        </div>
      )}
    </div>
  );
}
