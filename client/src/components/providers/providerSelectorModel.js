/**
 * Pure derivation for ProviderModelSelector: option lists, unavailable-label
 * formatting, effort gating and the saved-preset overlay merge. No React, no I/O.
 */
import {
  effortSurvivingModel,
  effortLevelsForProvider,
  effectiveModelFor,
  filterHardwareCompatibleProviderModels,
  filterSelectableModels,
  isProviderHardwareCompatible,
  isProviderModelHardwareCompatible,
  providerModelList,
  selectableProviders,
  sortProviderModels,
} from '../../utils/providers.js';
import { groupProvidersByHarness } from '../../utils/providerHarnesses.js';
import { isCompositeProviderId } from '../../utils/providerRef.js';

// Normalize a model entry (string or `{ id, name }`) to `{ value, label }`,
// or null for a nullish entry so the caller can skip it (a provider with an
// empty/sparse model list shouldn't render a blank option or crash).
export function modelOption(m) {
  if (m == null) return null;
  if (typeof m === 'string') return { value: m, label: m };
  return { value: m.id, label: m.name || m.id };
}

// One suffix for provider and model options. Hardware wins over policy, which
// wins over a provider-supplied reason (model options carry no reason).
export function formatUnavailableSuffix({ hardwareUnavailable, policyDisallowed, reason }) {
  if (hardwareUnavailable) return ' (unavailable on this machine)';
  if (policyDisallowed) return ' (not permitted here)';
  return reason ? ` (${reason})` : '';
}

// Replace-or-append by id so a re-saved preset never duplicates.
export function upsertSavedPreset(list, preset) {
  return [...list.filter((entry) => entry.id !== preset.id), preset];
}

export function providerOptionState(provider, providerAllowed) {
  const hardwareUnavailable = !isProviderHardwareCompatible(provider);
  const policyDisallowed = Boolean(providerAllowed && !providerAllowed(provider));
  const reason = provider.unavailableReason;
  return {
    unavailable: hardwareUnavailable || policyDisallowed || Boolean(reason),
    suffix: formatUnavailableSuffix({ hardwareUnavailable, policyDisallowed, reason }),
  };
}

export function modelOptionState(provider, model, value, modelAllowed) {
  const hardwareUnavailable = !isProviderModelHardwareCompatible(provider, value);
  const policyDisallowed = Boolean(modelAllowed && !modelAllowed(model, provider));
  return {
    unavailable: hardwareUnavailable || policyDisallowed,
    suffix: formatUnavailableSuffix({ hardwareUnavailable, policyDisallowed }),
  };
}

// Models the select may offer: the caller's list (or the provider's own catalog
// when it came from the shared catalog), the pinned default, hardware/policy
// filtering, and the selected value kept visible even when it is unavailable.
function deriveModelOptions({ availableModels, providerFromCatalog, selectedProvider, includeDefaultModel, selectedModel, modelAllowed }) {
  const callerModels = Array.isArray(availableModels) ? availableModels : [];
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
  const preserveSelectedModel = selectedModel && (
    selectedModel === defaultModel
    || !isProviderModelHardwareCompatible(selectedProvider, selectedModel)
    || (modelAllowed && !modelAllowed(selectedModel, selectedProvider))
  );
  return sortProviderModels(preserveSelectedModel
    && !compatibleModels.some((model) => modelOption(model)?.value === selectedModel)
    ? [selectedModel, ...compatibleModels]
    : compatibleModels);
}

// Effort select visibility: opt-in (`onEffortChange`) AND self-hiding, since
// EffortSelect renders null for a provider with no effort control.
function deriveShowEffort({ selectedProvider, effectiveModel, effort, effortAllowed, onEffortChange }) {
  const levels = effortLevelsForProvider(selectedProvider, effectiveModel);
  const hasVisibleLevel = Boolean(levels?.some((level) => !effortAllowed || effortAllowed(level, selectedProvider, effectiveModel)));
  const selectedDisallowed = Boolean(effort && effortAllowed && !effortAllowed(effort, selectedProvider, effectiveModel));
  return !!onEffortChange && (hasVisibleLevel || selectedDisallowed);
}

// The Custom group's saved composite. Unresolvable ids keep the raw id on
// screen rather than blanking a stored selection.
function deriveSelectedComposite({ selectedProviderId, selectedRecord, catalog }) {
  if (!isCompositeProviderId(selectedProviderId)) return null;
  if (selectedRecord) return selectedRecord;
  const unavailableReason = catalog.loading ? null : catalog.error ? 'catalog unavailable' : 'not available on this install';
  return { id: selectedProviderId, name: selectedProviderId, unavailableReason };
}

// Fail closed under a provider policy the compose flow cannot honor: a
// posture/allowlist predicate judges PRESET records, and a composed route has
// no such record to judge until the server materializes it. Only a policy that
// publishes its execution `modes` (or an explicit `composeMethods`) says what
// compose may build.
function deriveCompose({ compose, loading, providerAllowed, composeMethods, selectionPolicy }) {
  const allowedComposeMethods = composeMethods ?? selectionPolicy?.modes;
  const policyKnown = !providerAllowed || Array.isArray(allowedComposeMethods);
  const composeEnabled = compose && !loading && policyKnown
    && (!allowedComposeMethods || allowedComposeMethods.length > 0);
  return { allowedComposeMethods, composeEnabled };
}

export function deriveProviderSelectorModel(input) {
  const {
    providerList, selectedProviderId, selectedProvider, providerFromCatalog, selectedModel, effectiveModel,
    availableModels, includeDefaultModel, selectionPolicy, effort, onModelChange, onEffortChange,
    alwaysShowModel, catalog,
  } = input;
  const providerAllowed = selectionPolicy?.provider;
  const modelAllowed = selectionPolicy?.model;
  // Only offer enabled, hardware-compatible, policy-allowed providers; the
  // selected provider stays visible whatever its state (`selectableProviders`
  // is the one rule). Presets group by harness; composites go in "Custom".
  const visibleProviders = selectableProviders(providerList, { selectedId: selectedProviderId, allowed: providerAllowed });
  const presetGroups = groupProvidersByHarness(visibleProviders.filter((p) => !isCompositeProviderId(p.id)));
  const selectedRecord = providerList.find((p) => p.id === selectedProviderId)
    ?? (selectedProvider?.id === selectedProviderId ? selectedProvider : null);
  const modelOptions = deriveModelOptions({ availableModels, providerFromCatalog, selectedProvider, includeDefaultModel, selectedModel, modelAllowed });
  return {
    presetGroups,
    selectedComposite: deriveSelectedComposite({ selectedProviderId, selectedRecord, catalog }),
    ...deriveCompose({ ...input, providerAllowed }),
    modelOptions,
    // A model select with no `onModelChange` is a dead control, so the
    // callback, not the list, decides the select exists at all.
    showModel: !!onModelChange && (alwaysShowModel || modelOptions.length > 0),
    showEffort: deriveShowEffort({ selectedProvider, effectiveModel, effort, effortAllowed: selectionPolicy?.effort, onEffortChange }),
  };
}

// Picking a model with NO effort tiers (Antigravity's ladder is per-model)
// hides the effort select, so the effort is cleared with it. Returns the effort
// to apply, or `effort` unchanged when nothing needs to change.
export function effortAfterModelChange({ selectedProvider, model, effort, effortAllowed }) {
  const surviving = effortSurvivingModel(selectedProvider, model, effort);
  return surviving && effortAllowed
    && !effortAllowed(surviving, selectedProvider, effectiveModelFor(selectedProvider, model))
    ? ''
    : surviving;
}

// The "Default (<provider name>)" label for the blank provider option when a
// blank selection resolves to the install's effective provider.
export function emptyProviderLabel({ emptyProviderOption, effectiveProviderId, selectedProvider }) {
  const name = selectedProvider?.name;
  return effectiveProviderId && name && typeof emptyProviderOption === 'string' && !emptyProviderOption.includes(name)
    ? `${emptyProviderOption} — ${name}` : emptyProviderOption;
}

// Options for withModelCapabilityOptionLabel, or null when no annotation is on.
export function capabilityOptions({ annotateToolUse, annotateVision, toolUseIdsByProvider, visionIdsByProvider }) {
  if (!annotateToolUse && !annotateVision) return null;
  return {
    toolUseIdsByProvider: annotateToolUse ? toolUseIdsByProvider : null,
    visionIdsByProvider: annotateVision ? visionIdsByProvider : null,
    includeToolUse: annotateToolUse,
    includeVision: annotateVision,
  };
}
