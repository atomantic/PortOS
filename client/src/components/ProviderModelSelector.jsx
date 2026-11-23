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
 * @param {string} [props.selectedModel] - Currently selected model (default `''`)
 * @param {Array} [props.availableModels] - Models for the selected provider. Entries
 *   may be plain strings, or `{ id, name }` objects (the world builder passes the
 *   raw provider `models` array, which can be object-shaped). Omit or leave
 *   empty for a provider the caller's list does not carry (a composite, or a
 *   preset saved through the popover) and the resolved record's own catalog
 *   is offered instead.
 * @param {function} props.onProviderChange - Called with provider ID string ("" when
 *   `emptyProviderOption` is set and the user picks it), or a composite id when
 *   the user composes one.
 * @param {function} [props.onModelChange] - Called with model string. Omit on a
 *   provider-only picker; the model select is then not rendered AT ALL — a
 *   composite resolved from the shared catalog brings its own model list, so
 *   without this gate a provider-only caller grew a second, dead model select
 *   the moment the user composed a route. A composed model is dropped and the
 *   composite runs on its service default.
 * @param {string} [props.modelLabel] - Label text for the model select
 *   (default: "Model"). A form with more than one picker needs distinct
 *   accessible names; the provider select has `label` for the same reason.
 * @param {string} [props.id] - Id for the provider `<select>`, when the caller
 *   owns the `<label htmlFor>` (`FormField` injects one onto its first child).
 *   Defaults to a generated id.
 * @param {string} [props.aria-describedby] - Forwarded to the provider
 *   `<select>` (`FormField` injects its hint's id the same way).
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
 * @param {boolean} [props.dense] - Compact desktop fields while preserving mobile sizing
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
import { COMPOSE_OPTION_VALUE, effectiveModelFor, localToolUseHint, withModelCapabilityOptionLabel } from '../utils/providers.js';
import { isCompositeProviderId } from '../utils/providerRef.js';
import useToolUseModelIds from '../hooks/useToolUseModelIds.js';
import useVisionModelIds from '../hooks/useVisionModelIds.js';
import useProviderCatalog from '../hooks/useProviderCatalog.js';
import ExecutionOptionsSelect from './providers/ExecutionOptionsSelect.jsx';
import EffortSelect from './cos/EffortSelect.jsx';
import ProviderComposePopover from './providers/ProviderComposePopover.jsx';
import ToolUseWarning from './ui/ToolUseWarning.jsx';
import {
  capabilityOptions,
  deriveProviderSelectorModel,
  emptyProviderLabel,
  effortAfterModelChange,
  modelOption,
  modelOptionState,
  providerOptionState,
} from './providers/providerSelectorModel.js';
import { useProviderSelectorRouting, useSelectablePresets } from './providers/useProviderSelectorRouting.js';

const SELECT_CLASS =
  'w-full px-3 py-1.5 min-h-[36px] bg-port-bg border border-port-border rounded-lg text-white text-sm';

function ProviderOption({ provider, providerAllowed }) {
  const { unavailable, suffix } = providerOptionState(provider, providerAllowed);
  return <option value={provider.id} disabled={unavailable}>{provider.name}{suffix}</option>;
}

function ModelOption({ model, provider, modelAllowed, capability }) {
  const opt = modelOption(model);
  if (!opt) return null;
  const { unavailable, suffix } = modelOptionState(provider, model, opt.value, modelAllowed);
  const label = capability ? withModelCapabilityOptionLabel(opt.value, opt.label, provider, capability) : opt.label;
  return <option value={opt.value} disabled={unavailable}>{label}{suffix}</option>;
}

export default function ProviderModelSelector(props) {
  const {
    selectedProviderId, effectiveProviderId, selectedModel = '', availableModels = [],
    onProviderChange, onModelChange, id: idProp, 'aria-describedby': describedBy,
    label = 'Provider', modelLabel = 'Model', disabled = false, loading = false, modelDisabled = false,
    compact = false, dense = false, emptyProviderOption, emptyModelOption,
    alwaysShowModel = false, includeDefaultModel = false, compose = true, composeMethods,
    layout = 'row', highlightToolUse = false, highlightVision = false,
    effort, onEffortChange, executionOptions, onExecutionOptionsChange, selectionPolicy,
  } = props;
  const generatedProviderSelectId = useId();
  const providerSelectId = idProp || generatedProviderSelectId;
  const modelSelectId = useId();
  const effortSelectId = useId();
  const [composeOpen, setComposeOpen] = useState(false);
  const providerAllowed = selectionPolicy?.provider;
  const modelAllowed = selectionPolicy?.model;
  const effortAllowed = selectionPolicy?.effort;

  const { providerList, lookupId, rememberPreset } = useSelectablePresets(props);
  const listedProvider = providerList.find((p) => p.id === lookupId);
  // A composite the caller's list cannot name is looked up in the shared
  // catalog — fetched only in that case, so preset-only pickers never pay for it.
  const needsCatalog = !listedProvider && isCompositeProviderId(lookupId);
  const catalog = useProviderCatalog(needsCatalog);
  const selectedProvider = listedProvider || (needsCatalog ? catalog.resolveRef(lookupId) : undefined) || undefined;
  // A blank model ("Default model") runs the provider's own defaultModel, which
  // can be a non-tool model, so warnings and the effort ladder use the EFFECTIVE model.
  const effectiveModel = effectiveModelFor(selectedProvider, selectedModel);
  const { beginSelection, handleCompose, composingSelection, handlePresetSaved, changeExecutionOptions, executionOptionsSaving } =
    useProviderSelectorRouting({
      selectedProviderId, lookupId, selectedModel, effectiveModel, effort, executionOptions, selectedProvider, rememberPreset,
      onProviderChange, onModelChange, onEffortChange, onExecutionOptionsChange,
    });

  // Authoritative capability ids from the backends, gated so non-agent pickers
  // never pay for the scan. Nothing is asserted until the scan settles
  // (success or failure) to avoid a flash of false "no known tool use".
  const { idsByProvider: toolUseIdsByProvider, loaded: toolUseLoaded } = useToolUseModelIds(highlightToolUse);
  const { idsByProvider: visionIdsByProvider, loaded: visionLoaded } = useVisionModelIds(highlightVision);
  const annotateToolUse = highlightToolUse && toolUseLoaded;
  const annotateVision = highlightVision && visionLoaded;
  const toolHint = annotateToolUse ? localToolUseHint(effectiveModel, selectedProvider, toolUseIdsByProvider) : null;
  const capability = capabilityOptions({ annotateToolUse, annotateVision, toolUseIdsByProvider, visionIdsByProvider });

  const derived = deriveProviderSelectorModel({
    providerList, selectedProviderId, selectedProvider, selectedModel, effectiveModel, availableModels, catalog,
    providerFromCatalog: Boolean(selectedProvider) && !listedProvider,
    includeDefaultModel, selectionPolicy, effort, onModelChange, onEffortChange, alwaysShowModel,
    compose, loading, composeMethods,
  });
  const { presetGroups, selectedComposite, composeEnabled, allowedComposeMethods, modelOptions, showModel, showEffort } = derived;

  const handleModelChange = (value) => {
    beginSelection();
    onModelChange?.(value);
    if (!onEffortChange || !effort) return;
    const next = effortAfterModelChange({ selectedProvider, model: value, effort, effortAllowed });
    if (next !== effort) onEffortChange(next);
  };
  // The compose entry is an ACTION, not a value: opening the popover leaves the
  // controlled value untouched, so cancelling restores the previous selection.
  const handleProviderSelect = (value) => {
    if (value === COMPOSE_OPTION_VALUE) { setComposeOpen(true); return; }
    beginSelection();
    onProviderChange(value);
  };

  // Compact selects wrap by their own container's width, never the viewport: a
  // field keeps at least 9rem so a narrow card puts each select on its own line (#11894).
  const rowClass = compact
    ? 'flex flex-wrap items-center gap-2'
    : 'grid grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),24rem))] items-start gap-2';
  const fieldClass = compact ? 'flex-1 min-w-[min(100%,9rem)]' : 'flex-1 min-w-0';
  const selectClass = dense ? `${SELECT_CLASS} sm:min-h-8 sm:py-1 sm:text-xs` : SELECT_CLASS;
  const fieldLabel = (htmlFor, text) => !compact && <label htmlFor={htmlFor} className="block text-xs text-gray-500 mb-1">{text}</label>;
  const optionFor = (p) => <ProviderOption key={p.id} provider={p} providerAllowed={providerAllowed} />;
  return (
    <div className={layout === 'stacked' ? 'flex flex-col gap-1' : rowClass}>
      <div className={fieldClass}>
        {fieldLabel(providerSelectId, label)}
        <select
          id={providerSelectId}
          value={selectedProviderId}
          onChange={(e) => handleProviderSelect(e.target.value)}
          disabled={disabled || loading}
          title={compact ? label : undefined}
          aria-label={compact ? label : undefined}
          aria-describedby={describedBy}
          className={selectClass}
        >
          {/* Rendered even when the caller forces a selection: mid-fetch there
              is nothing else to offer, and a genuinely empty select reads as broken. */}
          {loading
            ? <option value="">Loading providers…</option>
            : emptyProviderOption != null && <option value="">{emptyProviderLabel({ emptyProviderOption, effectiveProviderId, selectedProvider })}</option>}
          {presetGroups.map((group) => (
            <optgroup key={group.harnessId} label={group.label}>{group.providers.map(optionFor)}</optgroup>
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
        <div className={fieldClass}>
          {fieldLabel(modelSelectId, modelLabel)}
          <select
            id={modelSelectId}
            value={selectedModel}
            onChange={(e) => handleModelChange(e.target.value)}
            disabled={disabled || modelDisabled || loading}
            title={compact ? modelLabel : undefined}
            aria-label={compact ? modelLabel : undefined}
            className={selectClass}
          >
            {emptyModelOption != null && <option value="">{selectedProvider?.defaultModel ? `${emptyModelOption} — ${selectedProvider.defaultModel}` : emptyModelOption}</option>}
            {modelOptions.map((m, i) => (
              <ModelOption key={modelOption(m)?.value ?? i} model={m} provider={selectedProvider} modelAllowed={modelAllowed} capability={capability} />
            ))}
          </select>
          {/* No remediation link: this selector renders in hosts that aren't
              wrapped in a Router, so the shared warning stays link-free here. */}
          {toolHint?.toolCapable === false && (
            <ToolUseWarning model={effectiveModel} isProviderDefault={!selectedModel} className="mt-1" />
          )}
        </div>
      )}
      {showEffort && (
        <div className={fieldClass}>
          {fieldLabel(effortSelectId, 'Thinking effort')}
          <EffortSelect
            id={effortSelectId}
            provider={selectedProvider}
            model={effectiveModel}
            value={effort || ''}
            onChange={(value) => { beginSelection(); onEffortChange(value); }}
            disabled={disabled || loading}
            optionFilter={effortAllowed}
            className={selectClass}
          />
        </div>
      )}
      {selectedProvider && (
        <ExecutionOptionsSelect fieldClassName={fieldClass} provider={selectedProvider} model={effectiveModel}
          value={onExecutionOptionsChange ? executionOptions : selectedProvider.executionSourceProviderId ? selectedProvider.executionSelectionOptions ?? selectedProvider.executionOptions : undefined} onChange={changeExecutionOptions}
          disabled={disabled || loading || executionOptionsSaving || composingSelection || selectedProvider.enabled === false || Boolean(providerAllowed && !providerAllowed(selectedProvider))} className={selectClass} />
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
