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
 * @param {string} [props.effectiveProviderId] - The provider a blank selection
 *   actually resolves to at run time (the install's active provider). The select
 *   still shows the blank `emptyProviderOption`, but the model annotations,
 *   tool-use warning and effort ladder resolve against this — otherwise "no
 *   provider pinned" would also mean "no model or effort can be picked".
 *   Defaults to `selectedProviderId`. See `resolveEffectiveProvider`.
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
 * @param {string} [props.effort] - Current reasoning-effort override (`''` = the
 *   provider's default). Pass with `onEffortChange` to get a third select for
 *   effort-capable providers (Antigravity, Claude, Codex); it renders itself
 *   away for every other provider, so no caller-side guard is needed. Omit both
 *   props for the two-select picker.
 * @param {function} [props.onEffortChange] - Called with the new effort string.
 * @param {boolean} [props.highlightToolUse] - Opt-in for AGENT / CoS-task pickers:
 *   marks each LOCAL (Ollama / LM Studio) model option with a tool-use indicator
 *   and warns below the select when the chosen local model can't call tools (it
 *   would narrate instead of acting). Off by default so non-agent pickers
 *   (embeddings, vision, prose generation) stay unannotated — it also gates the
 *   authoritative capability fetch (`useToolUseModelIds`), so an unannotated
 *   picker costs nothing. No-op for cloud/API providers, whose ids don't encode
 *   their family.
 */
import { useId } from 'react';
import { effectiveModelFor, effortLevelsForProvider, effortSurvivingModel, localToolUseHint, withToolUseOptionLabel } from '../utils/providers.js';
import useToolUseModelIds from '../hooks/useToolUseModelIds.js';
import EffortSelect from './cos/EffortSelect.jsx';

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
  effectiveProviderId,
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
  highlightToolUse = false,
  effort,
  onEffortChange
}) {
  const providerSelectId = useId();
  const modelSelectId = useId();
  const effortSelectId = useId();
  // Agent-picker tool-use highlight (opt-in). Resolve the selected provider so
  // the annotation only fires for local backends (the heuristic mislabels cloud
  // ids). `localToolUseHint` returns null for cloud/blank, so the warning stays
  // scoped to a genuinely tool-incapable local pin.
  // Resolve against the effective provider (the pin, or what a blank selection
  // falls back to) — everything below describes what a run would actually use.
  const selectedProvider = providers.find((p) => p.id === (effectiveProviderId ?? selectedProviderId));
  // A blank model ("Default model") isn't a no-op: the agent resolver then runs
  // the provider's own defaultModel — which for an Ollama-backed provider can be
  // a non-tool model that silently wedges the stage. So evaluate the EFFECTIVE
  // model (explicit selection, else the provider default) for the warning — and
  // for the effort ladder, which is per-model on Antigravity.
  const effectiveModel = effectiveModelFor(selectedProvider, selectedModel);
  // Authoritative tool-use capability from the backends themselves, unioned into
  // the id regex so a tool-capable family the regex predates isn't mislabelled.
  // Gated on `highlightToolUse`, so the many non-agent pickers never pay for the
  // capability scan; the fetch is module-shared, so a list page rendering one
  // selector per row still issues a single request.
  const { idsByProvider: toolUseIdsByProvider, loaded: toolUseLoaded } = useToolUseModelIds(highlightToolUse);
  // Nothing is asserted until the scan settles (success OR failure). Annotating
  // mid-fetch would show the exact false "⚠ no known tool use" this union exists
  // to remove, only for it to vanish a beat later; a failed fetch settles too, so
  // an unreachable backend degrades to the regex-only labels rather than muting
  // the annotation forever.
  const annotateToolUse = highlightToolUse && toolUseLoaded;
  const toolHint = annotateToolUse ? localToolUseHint(effectiveModel, selectedProvider, toolUseIdsByProvider) : null;
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
  // The effort select is opt-in (`onEffortChange`) AND self-hiding: EffortSelect
  // renders null for a provider with no effort control, so gate the label+wrapper
  // on the same predicate or a non-effort provider gets an orphaned label.
  const showEffort = !!onEffortChange && !!effortLevelsForProvider(selectedProvider, effectiveModel);
  // Picking a model with NO effort tiers (Antigravity's ladder is per-model) makes
  // the select above disappear — so clear the effort with it, or the value stays in
  // state with no UI left to change it and every submit still sends it. Owned here
  // rather than by each caller so the rule can't be forgotten by the next picker.
  const handleModelChange = (value) => {
    onModelChange(value);
    if (!onEffortChange || !effort) return;
    const surviving = effortSurvivingModel(selectedProvider, value, effort);
    if (surviving !== effort) onEffortChange(surviving);
  };
  // `row` was sized for two selects; the effort control makes it three, which is
  // unreadable at phone width — stack until `sm` when it's showing.
  const rowClass = showEffort ? 'flex flex-col sm:flex-row sm:items-center gap-2' : 'flex items-center gap-2';
  const wrapperClass = layout === 'stacked' ? 'flex flex-col gap-1' : rowClass;
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
            onChange={(e) => handleModelChange(e.target.value)}
            disabled={disabled || modelDisabled}
            title={compact ? 'Model' : undefined}
            aria-label={compact ? 'Model' : undefined}
            className={SELECT_CLASS}
          >
            {emptyModelOption != null && <option value="">{emptyModelOption}</option>}
            {availableModels.map(m => {
              const opt = modelOption(m);
              if (!opt) return null;
              const label = annotateToolUse
                ? withToolUseOptionLabel(opt.value, opt.label, selectedProvider, toolUseIdsByProvider)
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
      {showEffort && (
        <div className="flex-1 min-w-0">
          {!compact && (
            <label htmlFor={effortSelectId} className="block text-xs text-gray-500 mb-1">
              Thinking effort
            </label>
          )}
          <EffortSelect
            id={effortSelectId}
            provider={selectedProvider}
            model={effectiveModel}
            value={effort || ''}
            onChange={onEffortChange}
            disabled={disabled}
            className={SELECT_CLASS}
          />
        </div>
      )}
    </div>
  );
}
