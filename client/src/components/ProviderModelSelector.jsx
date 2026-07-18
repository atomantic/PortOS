/**
 * Two-step provider > model dropdown selector.
 * @param {Object} props
 * @param {Array} props.providers - Provider list from useProviderModels(). Disabled
 *   providers (`enabled === false`) are filtered out of the dropdown automatically,
 *   except the currently-selected one (so a pinned-but-disabled provider still shows
 *   its value). This is the single source of truth for "enabled only" pickers — a
 *   caller that already filtered (e.g. via the hook's default `enabled` filter) is
 *   unaffected since re-filtering enabled entries is idempotent.
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
 * @param {boolean} [props.highlightToolUse] - Opt-in for AGENT / CoS-task pickers:
 *   marks each LOCAL (Ollama / LM Studio) model option with a tool-use indicator
 *   and warns below the select when the chosen local model can't call tools (it
 *   would narrate instead of acting). Off by default so non-agent pickers
 *   (embeddings, vision, prose generation) stay unannotated. No-op for cloud/API
 *   providers, whose ids don't encode their family.
 */
import { useId } from 'react';
import { localToolUseHint, withToolUseOptionLabel } from '../utils/providers.js';

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
  layout = 'row',
  highlightToolUse = false
}) {
  const providerSelectId = useId();
  const modelSelectId = useId();
  // Agent-picker tool-use highlight (opt-in). Resolve the selected provider so
  // the annotation only fires for local backends (the heuristic mislabels cloud
  // ids). `localToolUseHint` returns null for cloud/blank, so the warning stays
  // scoped to a genuinely tool-incapable local pin.
  const selectedProvider = providers.find((p) => p.id === selectedProviderId);
  // A blank model ("Default model") isn't a no-op: the agent resolver then runs
  // the provider's own defaultModel — which for an Ollama-backed provider can be
  // a non-tool model that silently wedges the stage. So evaluate the EFFECTIVE
  // model (explicit selection, else the provider default) for the warning.
  const effectiveModel = selectedModel || selectedProvider?.defaultModel || '';
  const toolHint = highlightToolUse ? localToolUseHint(effectiveModel, selectedProvider) : null;
  const toolIncapable = toolHint?.toolCapable === false;
  // Only offer enabled providers (treat a missing `enabled` as enabled). The
  // currently-selected provider stays visible even if disabled, so a record
  // pinned to a now-disabled provider still renders its value instead of
  // silently blanking the select. This is the single DRY gate for every
  // provider→model picker; callers may also pre-filter, which is idempotent.
  const visibleProviders = providers.filter(
    (p) => p.enabled !== false || p.id === selectedProviderId
  );
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
          {visibleProviders.map(p => (
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
              const label = highlightToolUse
                ? withToolUseOptionLabel(opt.value, opt.label, selectedProvider)
                : opt.label;
              return <option key={opt.value} value={opt.value}>{label}</option>;
            })}
          </select>
          {toolIncapable && (
            <p className="mt-1 text-xs text-port-warning">
              ⚠ <span className="font-medium">{effectiveModel}</span>
              {!selectedModel && ' (this provider’s default)'} isn't a recognized tool-calling
              model — many local models (e.g. Gemma) reply with text instead of calling tools, which
              stalls an agent. Prefer a recognized tool-capable model (e.g. qwen3.6:35b).
            </p>
          )}
        </div>
      )}
    </div>
  );
}
