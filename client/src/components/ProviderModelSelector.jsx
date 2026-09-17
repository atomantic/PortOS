/**
 * Preset-first provider > model (> effort) selector (#7566).
 *
 * The provider `<select>` lists the caller's enabled PRESETS grouped by the
 * harness they run on (`groupProvidersByHarness`), then a final "Custom" group
 * holding the saved COMPOSITE selection (when the value is one) and a single
 * "Custom combination…" entry that opens `ProviderComposePopover` — the
 * harness → method → service → model → effort compose flow. Composing emits a
 * composite id (`<harness>.<method>@<service>[+<bootstrap>]`) through the same
 * `onProviderChange` a preset pick uses, so a caller's existing
 * `{ providerId, model, effort }` field needs no schema change; "Save as
 * preset" mints a preset and selects it instead. A composite the caller's
 * `providers` list cannot name is resolved from the shared catalog
 * (`useProviderCatalog.resolveRef`, fetched only then) so an existing pin
 * still renders — with its reason when its harness/service is now off, never
 * auto-replaced (#6368).
 *
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
 *   raw provider `models` array, which can be object-shaped). Omit or leave
 *   empty for a provider the caller's list does not carry (a composite, or a
 *   preset saved through the popover) and the resolved record's own catalog
 *   is offered instead.
 * @param {function} props.onProviderChange - Called with provider ID string ("" when
 *   `emptyProviderOption` is set and the user picks it), or a composite id when
 *   the user composes one.
 * @param {function} [props.onModelChange] - Called with model string. Omit on a
 *   provider-only picker (no `availableModels`); a composed model is then
 *   dropped and the composite runs on its service default.
 * @param {string} [props.id] - Id for the provider `<select>`, when the caller
 *   owns the `<label htmlFor>` (`FormField` injects one onto its first child).
 *   Defaults to a generated id.
 * @param {string} [props.label] - Label text (default: "Provider")
 * @param {boolean} [props.disabled] - Disable both selectors
 * @param {boolean} [props.loading] - The caller's provider list hasn't settled
 *   yet. An empty `providers` is ambiguous — "still fetching" and "none
 *   configured" both render a picker whose only choice is the
 *   `emptyProviderOption` ("Default (active provider)", "Inherit (…)"), which
 *   reads as a broken control rather than a slow one. Pass `true` while the
 *   fetch is in flight to disable the selects and say so instead. This is the
 *   same settle-gate the `annotateToolUse` scan below uses on its own fetch,
 *   applied to the list the caller owns.
 * @param {boolean} [props.modelDisabled] - Disable only the model selector (e.g.
 *   when the selected provider has no models). Composes with `disabled`.
 * @param {boolean} [props.compact] - Hide labels for inline/toolbar use
 * @param {string} [props.emptyProviderOption] - When set, prepends an option with
 *   value `""` and this label, letting the caller represent a "no explicit
 *   provider / use the default" choice. Omit (the default) to force a selection.
 * @param {string} [props.emptyModelOption] - Same idea for the model select.
 * @param {boolean} [props.includeDefaultModel] - Offer the configured default as
 *   an explicit pin on required-model forms, even when absent from the catalog.
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
 * @param {{provider?: function, model?: function, effort?: function, modes?: string[]}} [props.selectionPolicy]
 *   Optional shared policy applied to all three option lists. Provider
 *   predicates receive `(provider)`, model predicates receive `(model, provider)`
 *   and effort predicates receive `(effort, provider, model)`. A selected value
 *   that no longer satisfies the policy remains visible but disabled so it can
 *   be cleared without hiding a stale saved pin. A `modes` list (as
 *   `providerModeSelectionPolicy` publishes) also restricts the compose flow
 *   to those execution methods, unless `composeMethods` overrides it.
 * @param {boolean} [props.compose] - Offer "Custom combination…" (default
 *   `true`). Pass `false` on a surface whose stored value must be a PRESET id
 *   — the install's `activeProvider`, or a field validated by
 *   `presetProviderIdSchema` — so the picker cannot hand it a composite.
 * @param {string[]} [props.composeMethods] - The execution methods the compose
 *   flow may offer (`['tui']` for a shell launcher, `['api']` for a streaming
 *   caller). Defaults to `selectionPolicy.modes`; omit both for no restriction.
 */
import { useId, useState } from 'react';
import {
  COMPOSE_OPTION_VALUE,
  effectiveModelFor,
  effortLevelsForProvider,
  effortSurvivingModel,
  filterHardwareCompatibleProviderModels,
  filterSelectableModels,
  isProviderHardwareCompatible,
  isProviderModelHardwareCompatible,
  providerModelList,
  selectableProviders,
  localToolUseHint,
  withToolUseOptionLabel,
} from '../utils/providers.js';
import { groupProvidersByHarness } from '../utils/providerHarnesses.js';
import { isCompositeProviderId } from '../utils/providerRef.js';
import useToolUseModelIds from '../hooks/useToolUseModelIds.js';
import useProviderCatalog from '../hooks/useProviderCatalog.js';
import EffortSelect from './cos/EffortSelect.jsx';
import ProviderComposePopover from './providers/ProviderComposePopover.jsx';
import ToolUseWarning from './ui/ToolUseWarning.jsx';

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
  id: idProp,
  label = 'Provider',
  disabled = false,
  loading = false,
  modelDisabled = false,
  compact = false,
  emptyProviderOption,
  emptyModelOption,
  alwaysShowModel = false,
  includeDefaultModel = false,
  layout = 'row',
  highlightToolUse = false,
  effort,
  onEffortChange,
  selectionPolicy,
  compose = true,
  composeMethods,
}) {
  const generatedProviderSelectId = useId();
  const providerSelectId = idProp || generatedProviderSelectId;
  const modelSelectId = useId();
  const effortSelectId = useId();
  const [composeOpen, setComposeOpen] = useState(false);
  // Presets minted through the popover's "Save as preset" this session. The
  // caller's `providers` list predates them, so they are carried here until
  // the caller refetches — otherwise the freshly selected id would render as
  // an unknown value the moment the popover closed.
  const [savedPresets, setSavedPresets] = useState([]);
  const providerAllowed = selectionPolicy?.provider;
  const modelAllowed = selectionPolicy?.model;
  const effortAllowed = selectionPolicy?.effort;
  const providerList = [
    ...(Array.isArray(providers) ? providers : []),
    ...savedPresets.filter((preset) => !(providers || []).some((p) => p?.id === preset.id)),
  ];
  // Resolve against the effective provider (the pin, or what a blank selection
  // falls back to) — everything below describes what a run would actually use.
  const lookupId = effectiveProviderId ?? selectedProviderId;
  const listedProvider = providerList.find((p) => p.id === lookupId);
  // A composite the caller's list cannot name is looked up in the shared
  // catalog — fetched only in that case, so the many preset-only pickers never
  // pay for it. `resolveRef` is a pure lookup over the fetched catalog.
  const needsCatalog = !listedProvider && isCompositeProviderId(lookupId);
  const catalog = useProviderCatalog(needsCatalog);
  const selectedProvider = listedProvider || (needsCatalog ? catalog.resolveRef(lookupId) : undefined) || undefined;
  const providerFromCatalog = Boolean(selectedProvider) && !listedProvider;
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
  // Only offer enabled, hardware-compatible, policy-allowed providers; the
  // currently-selected provider stays visible whatever its state, so a record
  // pinned to a now-disabled provider still renders its value instead of
  // silently blanking the select (`selectableProviders` is the one rule).
  const visibleProviders = selectableProviders(providerList, { selectedId: selectedProviderId, allowed: providerAllowed });
  // Presets are grouped by harness; a composite in the list (a hook that
  // appended the resolved pin) belongs to the "Custom" group instead.
  const presetGroups = groupProvidersByHarness(visibleProviders.filter((p) => !isCompositeProviderId(p.id)));
  const selectedComposite = isCompositeProviderId(selectedProviderId)
    ? (visibleProviders.find((p) => p.id === selectedProviderId)
      || (selectedProvider?.id === selectedProviderId ? selectedProvider : null)
      // Unresolvable (catalog unknown, or still loading): keep the raw id on
      // screen rather than blanking a stored selection.
      || { id: selectedProviderId, name: selectedProviderId, unavailableReason: catalog.loading ? null : 'not available on this install' })
    : null;
  const allowedComposeMethods = composeMethods ?? selectionPolicy?.modes;
  // Fail closed under a provider policy the compose flow cannot honor: a
  // posture/allowlist predicate judges PRESET records, and a composed route
  // has no such record to judge until the server materializes it. Only a
  // policy that publishes its execution `modes` (or an explicit
  // `composeMethods`) says what compose may build.
  const composePolicyKnown = !providerAllowed || Array.isArray(allowedComposeMethods);
  const composeEnabled = compose && !loading && composePolicyKnown
    && (!allowedComposeMethods || allowedComposeMethods.length > 0);
  // Defaults may be omitted from a provider's browsable catalog. Offer a real
  // pin as well as the blank inheritance option, including on required forms.
  const callerModels = Array.isArray(availableModels) ? availableModels : [];
  // A provider the caller's list doesn't carry brings its own catalog (a
  // composite's service models, a just-saved preset's list).
  const catalogModels = callerModels.length === 0 && providerFromCatalog
    ? filterSelectableModels(providerModelList(selectedProvider).filter(Boolean))
    : callerModels;
  const defaultModel = selectedProvider?.defaultModel;
  const selectableModels = includeDefaultModel && defaultModel
    && !catalogModels.some((model) => modelOption(model)?.value === defaultModel)
    ? [defaultModel, ...catalogModels]
    : catalogModels;
  const compatibleModels = filterHardwareCompatibleProviderModels(selectableModels, selectedProvider)
    .filter((model) => !modelAllowed || modelAllowed(model, selectedProvider));
  // Keep a configured default visible even when it is a CLI-default sentinel
  // omitted from the browsable catalog, alongside unavailable saved pins.
  const preserveSelectedModel = selectedModel && (
    selectedModel === selectedProvider?.defaultModel
    || !isProviderModelHardwareCompatible(selectedProvider, selectedModel)
    || (modelAllowed && !modelAllowed(selectedModel, selectedProvider))
  );
  const modelOptions = preserveSelectedModel
    && !compatibleModels.some((model) => modelOption(model)?.value === selectedModel)
    ? [selectedModel, ...compatibleModels]
    : compatibleModels;
  const showModel = alwaysShowModel || modelOptions.length > 0;
  // The effort select is opt-in (`onEffortChange`) AND self-hiding: EffortSelect
  // renders null for a provider with no effort control, so gate the label+wrapper
  // on the same predicate or a non-effort provider gets an orphaned label.
  const effortLevels = effortLevelsForProvider(selectedProvider, effectiveModel);
  const visibleEffortLevels = effortLevels?.filter(
    (level) => !effortAllowed || effortAllowed(level, selectedProvider, effectiveModel)
  );
  const selectedEffortIsDisallowed = Boolean(
    effort
    && effortAllowed
    && !effortAllowed(effort, selectedProvider, effectiveModel)
  );
  const showEffort = !!onEffortChange && Boolean(visibleEffortLevels?.length || selectedEffortIsDisallowed);
  // Picking a model with NO effort tiers (Antigravity's ladder is per-model) makes
  // the select above disappear — so clear the effort with it, or the value stays in
  // state with no UI left to change it and every submit still sends it. Owned here
  // rather than by each caller so the rule can't be forgotten by the next picker.
  const handleModelChange = (value) => {
    onModelChange?.(value);
    if (!onEffortChange || !effort) return;
    const surviving = effortSurvivingModel(selectedProvider, value, effort);
    const filteredSurviving = surviving && effortAllowed
      && !effortAllowed(surviving, selectedProvider, effectiveModelFor(selectedProvider, value))
      ? ''
      : surviving;
    if (filteredSurviving !== effort) onEffortChange(filteredSurviving);
  };
  // The compose entry is an ACTION, not a value: opening the popover leaves the
  // controlled value untouched, so cancelling restores the previous selection
  // for free and no caller ever receives the sentinel.
  const handleProviderSelect = (value) => {
    if (value === COMPOSE_OPTION_VALUE) {
      setComposeOpen(true);
      return;
    }
    onProviderChange(value);
  };
  // "Use once": the composite lands in the caller's existing provider field;
  // the model/effort the user composed follow through the same callbacks a
  // pick in the sibling selects would use, so the caller's own clearing rules
  // (a provider change resetting the model) run first and are then overridden
  // by the explicit choice.
  const handleCompose = (compositeId, { model, effort: composedEffort }) => {
    onProviderChange(compositeId);
    onModelChange?.(model || '');
    onEffortChange?.(composedEffort || '');
  };
  // "Save as preset": the stored preset already carries the composed model and
  // effort as its defaults, so select it and pin exactly those — the same
  // outcome as "Use once", with a preset id in the field instead.
  const handlePresetSaved = (preset) => {
    setSavedPresets((prev) => [...prev.filter((p) => p.id !== preset.id), preset]);
    onProviderChange(preset.id);
    onModelChange?.(preset.defaultModel || '');
    onEffortChange?.(preset.effort || '');
  };
  const optionFor = (p) => {
    const hardwareUnavailable = !isProviderHardwareCompatible(p);
    const policyDisallowed = Boolean(providerAllowed && !providerAllowed(p));
    const unavailable = hardwareUnavailable || policyDisallowed || Boolean(p.unavailableReason);
    const reason = hardwareUnavailable
      ? ' (unavailable on this machine)'
      : policyDisallowed ? ' (not permitted here)'
        : p.unavailableReason ? ` (${p.unavailableReason})` : '';
    return (
      <option key={p.id} value={p.id} disabled={unavailable}>
        {p.name}{reason}
      </option>
    );
  };
  // Use available container space, including narrow drawers on desktop. Bound
  // labeled fields so a lone provider does not stretch across the whole page.
  const rowClass = compact
    ? (showEffort ? 'flex flex-col sm:flex-row sm:items-center gap-2' : 'flex items-center gap-2')
    : 'grid grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),24rem))] items-start gap-2';
  const wrapperClass = layout === 'stacked' ? 'flex flex-col gap-1' : rowClass;
  return (
    <div className={wrapperClass}>
      <div className="flex-1 min-w-0">
        {!compact && <label htmlFor={providerSelectId} className="block text-xs text-gray-500 mb-1">{label}</label>}
        <select
          id={providerSelectId}
          value={selectedProviderId}
          onChange={(e) => handleProviderSelect(e.target.value)}
          disabled={disabled || loading}
          title={compact ? label : undefined}
          aria-label={compact ? label : undefined}
          className={SELECT_CLASS}
        >
          {/* Rendered even when the caller forces a selection: mid-fetch there
              is nothing else to offer, and a genuinely empty select reads as the
              same broken control. */}
          {loading
            ? <option value="">Loading providers…</option>
            : emptyProviderOption != null && <option value="">{effectiveProviderId && selectedProvider?.name && typeof emptyProviderOption === 'string' && !emptyProviderOption.includes(selectedProvider.name) ? `${emptyProviderOption} — ${selectedProvider.name}` : emptyProviderOption}</option>}
          {presetGroups.map((group) => (
            <optgroup key={group.harnessId} label={group.label}>
              {group.providers.map(optionFor)}
            </optgroup>
          ))}
          {(selectedComposite || composeEnabled) && (
            <optgroup label="Custom">
              {selectedComposite && optionFor(selectedComposite)}
              {composeEnabled && <option value={COMPOSE_OPTION_VALUE}>Custom combination…</option>}
            </optgroup>
          )}
        </select>
      </div>
      {showModel && (
        <div className="flex-1 min-w-0">
          {!compact && <label htmlFor={modelSelectId} className="block text-xs text-gray-500 mb-1">Model</label>}
          <select
            id={modelSelectId}
            value={selectedModel}
            onChange={(e) => handleModelChange(e.target.value)}
            disabled={disabled || modelDisabled || loading}
            title={compact ? 'Model' : undefined}
            aria-label={compact ? 'Model' : undefined}
            className={SELECT_CLASS}
          >
            {emptyModelOption != null && <option value="">{selectedProvider?.defaultModel ? `${emptyModelOption} — ${selectedProvider.defaultModel}` : emptyModelOption}</option>}
            {modelOptions.map(m => {
              const opt = modelOption(m);
              if (!opt) return null;
              const hardwareUnavailable = !isProviderModelHardwareCompatible(selectedProvider, opt.value);
              const policyDisallowed = Boolean(modelAllowed && !modelAllowed(m, selectedProvider));
              const unavailable = hardwareUnavailable || policyDisallowed;
              const label = annotateToolUse
                ? withToolUseOptionLabel(opt.value, opt.label, selectedProvider, toolUseIdsByProvider)
                : opt.label;
              return (
                <option key={opt.value} value={opt.value} disabled={unavailable}>
                  {hardwareUnavailable
                    ? `${label} (unavailable on this machine)`
                    : policyDisallowed ? `${label} (not permitted here)` : label}
                </option>
              );
            })}
          </select>
          {/* No remediation link: this selector renders in hosts that aren't
              wrapped in a Router, so the shared warning stays link-free here. */}
          {toolIncapable && (
            <ToolUseWarning model={effectiveModel} isProviderDefault={!selectedModel} className="mt-1" />
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
            disabled={disabled || loading}
            optionFilter={effortAllowed}
            className={SELECT_CLASS}
          />
        </div>
      )}
      {composeEnabled && (
        <ProviderComposePopover
          open={composeOpen}
          onClose={() => setComposeOpen(false)}
          onCompose={handleCompose}
          onPresetSaved={handlePresetSaved}
          allowedMethods={allowedComposeMethods}
        />
      )}
    </div>
  );
}
