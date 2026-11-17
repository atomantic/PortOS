import { useMemo } from 'react';
import EffortSelect from '../cos/EffortSelect';
import { FormField } from '../ui/FormField';
import ExecutionOptionsSelect from './ExecutionOptionsSelect.jsx';
import ProviderModelAccess from './ProviderModelAccess';
import ProviderModelAutocomplete from './ProviderModelAutocomplete';
import { configuredDefaultIn, filterGenerationModels, filterHardwareCompatibleProviderModels, isEmbeddingModel, isProcessProvider, isProviderHardwareCompatible, isProviderModelHardwareCompatible, mergeModelLists, modelOptionLabel, sortProviderModels } from '../../utils/providers';
import { configuredModelsOf, normalizeModelAccess, scopeModelsByAccess } from '../../utils/providerModelAccess';
import { argList, liveHardwareFor, liveModelsFor, modelListFromText } from './providerFormData';

// The four optional capability-tier overrides, in picker order (#8149).
const TIER_FIELDS = [
  { key: 'lightModel', label: 'Light (fast)', dot: 'bg-port-success', placeholder: 'haiku' },
  { key: 'mediumModel', label: 'Medium (balanced)', dot: 'bg-port-warning', placeholder: 'sonnet' },
  { key: 'heavyModel', label: 'Heavy (powerful)', dot: 'bg-port-error', placeholder: 'opus' },
  { key: 'ultraModel', label: 'Ultra (frontier)', dot: 'bg-port-error', placeholder: 'Fable or Astra model ID' },
];

export default function ProviderModelsTab({
  provider, formData, setFormData, modelsText, setModelsText, mergedModels, capabilityProvider, generationControls, localModels, allProviders,
}) {
  // The tier models the access policy must never scope out. Memoized on the six
  // fields themselves rather than on `formData`, so typing in any other field
  // cannot re-scope the whole catalog in the policy editor's preview.
  const modelAccessKeeps = useMemo(
    () => configuredModelsOf(formData),
    // Dependency list is intentionally partial.
    [formData.defaultModel, formData.lightModel, formData.mediumModel,
      formData.heavyModel, formData.ultraModel, formData.fallbackModel],
  );
  // Capability requests inspect the saved connection, so edited routing must
  // be saved before its speed settings can be verified. Old pins stay clearable.
  const executionConnectionChanged = provider && (
    formData.type !== (provider.type || 'cli')
    || formData.command !== (provider.command || '')
    || JSON.stringify(argList(formData.args)) !== JSON.stringify(provider.args || [])
    || formData.codexAuthMode !== (provider.codexAuthMode || '')
    || formData.ignoreUserConfig !== (provider.ignoreUserConfig === true)
    || formData.enabled !== (provider.enabled !== false)
    || JSON.stringify(formData.envVars) !== JSON.stringify(provider.envVars || {})
    || formData.credentialBootstrapCommand !== (provider.credentialBootstrap?.command || '')
  );
  // Scoped by the same Model Access policy `ProviderModelAccess` previews above,
  // so the Default Model + tier selects can't offer a model the policy hides —
  // they used to read straight off `mergedModels` and ignore the policy entirely.
  // `keep` preserves an already-configured tier's model even if the (possibly
  // just-edited) policy would now exclude it, matching the editor's own preview.
  const availableModels = scopeModelsByAccess(
    filterHardwareCompatibleProviderModels(
      filterGenerationModels(mergedModels),
      capabilityProvider,
    ),
    normalizeModelAccess(formData.modelAccess),
    { keep: modelAccessKeeps },
  );
  const configuredModels = [
    formData.defaultModel,
    formData.lightModel,
    formData.mediumModel,
    formData.heavyModel,
    formData.ultraModel,
  ].filter((model) => model
    && !isEmbeddingModel(model)
    && !availableModels.includes(model)
    && !isProviderModelHardwareCompatible(capabilityProvider, model));
  // A provider can pin its tiers to the "use the CLI's own default" sentinel
  // while still publishing a real model catalog (Antigravity: `agy models`
  // lists real ids, but PortOS leaves the tiers on agy's own default). The
  // sentinel is filtered out of `availableModels`, so without an explicit
  // option for it the four selects below would hold a value matching no option
  // and render blank — reading as "no model configured" when one is.
  const configuredDefault = configuredDefaultIn(mergedModels);
  // Shared option list for the Default Model + tier selects, so the sentinel
  // option can't be added to some and missed on others. Only the empty row's
  // meaning differs: no Default Model is "None", while an empty tier INHERITS
  // the Default Model (resolveProviderModelTier) — so a preset only sets the
  // tiers it wants on a different model (#8149).
  const sortedTierModels = sortProviderModels([...new Set([...configuredModels, ...availableModels])]);
  const modelSelectOptions = (emptyLabel = 'None') => [
    { value: '', label: emptyLabel },
    ...(configuredDefault ? [{ value: configuredDefault, label: "Use the CLI's configured default" }] : []),
    ...sortedTierModels.map(model => ({
      value: model,
      label: `${modelOptionLabel(model, localModels.ctxById, capabilityProvider)}${availableModels.includes(model) ? '' : ' (unavailable on this machine)'}`,
      disabled: !availableModels.includes(model),
    })),
  ];

  // Filter out current provider from fallback options (treat undefined enabled as enabled)
  const fallbackOptions = allProviders.filter(p => p.id !== provider?.id
    && p.enabled !== false
    && (isProviderHardwareCompatible(p) || p.id === formData.fallbackProvider));

  // The fallback model is a model OF the selected fallback provider, so its
  // option list comes from that provider's `models` — merged with the live
  // installed list for local backends, and embedding-only models dropped (a
  // fallback runs prompts, so `nomic-embed-text` must never be selectable here).
  const selectedFallbackProvider = allProviders.find(p => p.id === formData.fallbackProvider);
  const fallbackCapabilityProvider = selectedFallbackProvider && {
    ...selectedFallbackProvider,
    modelHardwareCompatibility: {
      ...selectedFallbackProvider.modelHardwareCompatibility,
      ...liveHardwareFor(localModels, selectedFallbackProvider),
    },
  };
  const fallbackModelOptions = filterGenerationModels(
    mergeModelLists(selectedFallbackProvider?.models, liveModelsFor(localModels, selectedFallbackProvider)),
  );
  const compatibleFallbackModelOptions = sortProviderModels(filterHardwareCompatibleProviderModels(
    fallbackModelOptions,
    fallbackCapabilityProvider,
  ));
  const fallbackModelIsUnavailable = Boolean(
    formData.fallbackModel
    && !isEmbeddingModel(formData.fallbackModel)
    && !compatibleFallbackModelOptions.includes(formData.fallbackModel)
    && !isProviderModelHardwareCompatible(fallbackCapabilityProvider, formData.fallbackModel)
  );
  const fallbackModelSelectOptions = [
    { value: '', label: "Use fallback provider's default" },
    ...(fallbackModelIsUnavailable ? [{
      value: formData.fallbackModel,
      label: `${modelOptionLabel(formData.fallbackModel, localModels.ctxById, selectedFallbackProvider)} (unavailable on this machine)`,
      disabled: true,
    }] : []),
    ...compatibleFallbackModelOptions.map(model => ({
      value: model,
      label: modelOptionLabel(model, localModels.ctxById, selectedFallbackProvider),
    })),
  ];

  return (
    <div className="space-y-4">
      <FormField label={<>
          Available Models
          {formData.type === 'api' && <span className="text-xs text-gray-500 ml-2">(Use Refresh button after saving)</span>}
        </>}>
        <textarea
          value={modelsText}
          onChange={(e) => {
            const text = e.target.value;
            setModelsText(text);
            const models = modelListFromText(text);
            setFormData(prev => ({ ...prev, models }));
          }}
          placeholder="model-1, model-2, model-3"
          rows={2}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white resize-none focus:border-port-accent focus:outline-hidden"
        />
        <p className="text-xs text-gray-500 mt-1">
          Comma-separated list of available models. For API providers, use Refresh to auto-populate.
        </p>
      </FormField>

      {/* Which of that catalog this install is entitled to run. Fed the
          FULL list (`formData.models`, seeded from `modelCatalog`), because
          the policy is authored against everything the upstream
          advertises — the scoped view is what it produces. */}
      <ProviderModelAccess
        catalog={formData.models || []}
        value={formData.modelAccess}
        configuredModels={modelAccessKeeps}
        onChange={(modelAccess) => setFormData(prev => ({ ...prev, modelAccess }))}
      />

      {availableModels.length > 0 ? (
        <ProviderModelAutocomplete
          label="Default Model"
          description="Search and select the model to use when no tier is specified."
          value={formData.defaultModel}
          options={modelSelectOptions()}
          onChange={(defaultModel) => setFormData(prev => ({ ...prev, defaultModel }))}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
        />
      ) : (
        <FormField label="Default Model">
          <input
            type="text"
            value={formData.defaultModel}
            onChange={(e) => setFormData(prev => ({ ...prev, defaultModel: e.target.value }))}
            placeholder="claude-sonnet-4-20250514"
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
          />
          <p className="text-xs text-gray-500 mt-1">Save and test provider to fetch available models</p>
        </FormField>
      )}

      {provider?.id && <div>
        <ExecutionOptionsSelect provider={{ ...capabilityProvider, args: argList(formData.args), executionOptions: undefined }} model={formData.defaultModel} value={formData.executionOptions}
          inspectionBlockedReason={executionConnectionChanged ? 'Save connection changes before refreshing execution capabilities.' : null}
          onChange={executionOptions => setFormData(current => ({ ...current, executionOptions }))}
          className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-white text-sm" />
        <p className="text-xs text-gray-500">Saved execution defaults apply to future runs, including scheduled jobs using this preset.</p>
      </div>}
      <EffortSelect
        provider={isProcessProvider(capabilityProvider) ? capabilityProvider : null}
        model={formData.defaultModel}
        value={formData.effort}
        onChange={(effort) => setFormData(prev => ({ ...prev, effort }))}
        label="Default Effort"
        hint={generationControls
          ? 'Reasoning effort used when a run does not specify one — passed to the local model as reasoningEffort.'
          : 'Reasoning effort used when a run does not specify one.'}
      />

      {/* Model Tiers */}
      <div className="border-t border-port-border pt-4 mt-4">
        <h4 className="text-sm font-medium text-gray-300 mb-3">Model Tier Overrides</h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {TIER_FIELDS.map(({ key, label, dot, placeholder }) => {
            const tierLabel = <><span className={`inline-block w-2 h-2 rounded-full ${dot} mr-1`}></span>{label}</>;
            return availableModels.length > 0 ? (
              <ProviderModelAutocomplete
                key={key}
                label={tierLabel}
                labelClassName="block text-xs text-gray-400 mb-1"
                value={formData[key]}
                options={modelSelectOptions(key === 'ultraModel' ? 'Inherit Heavy' : 'Inherit Default Model')}
                onChange={(model) => setFormData(prev => ({ ...prev, [key]: model }))}
                className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-hidden"
              />
            ) : (
              <FormField key={key} labelClassName="block text-xs text-gray-400 mb-1" label={tierLabel}>
                <input
                  type="text"
                  value={formData[key]}
                  onChange={(e) => setFormData(prev => ({ ...prev, [key]: e.target.value }))}
                  placeholder={placeholder}
                  className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-hidden"
                />
              </FormField>
            );
          })}
        </div>
        <p className="text-xs text-gray-500 mt-2">
          {availableModels.length > 0
            ? 'Search and select optional tier models. A task, role, or prompt stage that names a tier runs on its model here; a blank tier uses the Default Model (Ultra uses Heavy first). Nothing picks a tier automatically.'
            : 'Save provider, then use Test or Refresh to fetch available models'}
        </p>
      </div>

      {/* Fallback Provider */}
      <div className="border-t border-port-border pt-4 mt-4">
        <FormField label="Fallback Provider">
        <select
          value={formData.fallbackProvider}
          onChange={(e) => setFormData(prev => ({
            ...prev,
            fallbackProvider: e.target.value,
            // The model belongs to the fallback provider; clear it when the
            // provider changes so a stale model from the previous pick
            // doesn't carry over.
            fallbackModel: ''
          }))}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
        >
          <option value="">None (use system default)</option>
          {fallbackOptions.map(p => (
            <option key={p.id} value={p.id} disabled={!isProviderHardwareCompatible(p)}>
              {p.name}{!isProviderHardwareCompatible(p) ? ' (unavailable on this machine)' : ''}
            </option>
          ))}
        </select>
        <p className="text-xs text-gray-500 mt-1">
          If this provider hits a usage limit or becomes unavailable, tasks will automatically use the fallback provider.
        </p>
        </FormField>

        {formData.fallbackProvider && (
          compatibleFallbackModelOptions.length > 0 ? (
              <ProviderModelAutocomplete
                label="Fallback Model"
                wrapperClassName="mt-3"
                description="Search and select a model on the fallback provider. Leave blank to use that provider's default model."
                value={formData.fallbackModel}
                options={fallbackModelSelectOptions}
                onChange={(fallbackModel) => setFormData(prev => ({ ...prev, fallbackModel }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
              />
            ) : (
              <FormField label="Fallback Model" className="mt-3">
                <input
                  type="text"
                  value={formData.fallbackModel}
                  onChange={(e) => setFormData(prev => ({ ...prev, fallbackModel: e.target.value }))}
                  placeholder="Use fallback provider's default"
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                />
                <p className="text-xs text-gray-500 mt-1">Model to run on the fallback provider. Leave blank to use that provider's default model.</p>
              </FormField>
            )
        )}
      </div>
    </div>
  );
}
