/**
 * Stateful side of ProviderModelSelector: the saved-preset overlay with its
 * `selection-*` fetch, and the selection-scope / pending-route machinery that
 * defers a composed route's model and effort until the caller reflects the new
 * provider id.
 */
import { useEffect, useRef, useState } from 'react';
import { request } from '../../services/apiCore.js';
import { saveExecutionOptionSelection } from '../../services/apiProviders.js';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';
import useMounted from '../../hooks/useMounted.js';
import { isCompositeProviderId } from '../../utils/providerRef.js';
import { upsertSavedPreset } from './providerSelectorModel.js';

// The caller's `providers` plus presets minted this session (the caller's list
// predates them, so they are carried here until it refetches) plus a
// `selection-*` preset fetched on demand when the effective id isn't listed.
export function useSelectablePresets({ providers, selectedProviderId, effectiveProviderId }) {
  const [savedPresets, setSavedPresets] = useState([]);
  const [resolvedPreset, setResolvedPreset] = useState(null);
  const callerProviders = Array.isArray(providers) ? providers : [];
  const localProviderList = [
    ...callerProviders,
    ...savedPresets.filter((preset) => !callerProviders.some((p) => p?.id === preset.id)),
  ];
  // Resolve against the effective provider (the pin, or what a blank selection falls back to).
  const lookupId = effectiveProviderId ?? selectedProviderId;
  const needsPreset = typeof lookupId === 'string' && lookupId.startsWith('selection-')
    && !isCompositeProviderId(lookupId) && !localProviderList.some((provider) => provider.id === lookupId);
  useEffect(() => {
    let active = true;
    if (needsPreset) request(`/providers/${encodeURIComponent(lookupId)}`, { silent: true })
      .then((provider) => { if (active) setResolvedPreset({ id: lookupId, provider }); })
      .catch(() => { if (active) setResolvedPreset({ id: lookupId, provider: { id: lookupId, name: lookupId, enabled: false, unavailableReason: 'not available on this install' } }); });
    return () => { active = false; };
  }, [lookupId, needsPreset]);
  const providerList = needsPreset && resolvedPreset?.id === lookupId
    ? [...localProviderList, resolvedPreset.provider] : localProviderList;
  const rememberPreset = (preset) => setSavedPresets((previous) => upsertSavedPreset(previous, preset));
  return { providerList, lookupId, rememberPreset };
}

export function useProviderSelectorRouting({
  selectedProviderId, lookupId, selectedModel, effectiveModel, effort, executionOptions,
  selectedProvider, rememberPreset,
  onProviderChange, onModelChange, onEffortChange, onExecutionOptionsChange,
}) {
  // A composed/minted route's model and effort, waiting for the caller to
  // reflect its provider id (see `selectRoute`).
  const [pendingRoute, setPendingRoute] = useState(null);
  const callbacksRef = useRef({});
  callbacksRef.current = { onProviderChange, onModelChange, onEffortChange, onExecutionOptionsChange };
  const mounted = useMounted();
  // Saving a derived selection must not retarget a newer controlled value,
  // including a model/effort edit that keeps the same provider. Retain a new
  // scope for every change so switching away and back cannot revive a save.
  const selectionKey = JSON.stringify([selectedProviderId, lookupId, selectedModel, effectiveModel, effort, executionOptions, Boolean(onExecutionOptionsChange)]);
  const selectionScope = useRef({ key: selectionKey });
  if (selectionScope.current.key !== selectionKey) selectionScope.current = { key: selectionKey };
  const beginSelection = () => {
    const scope = { key: selectionKey };
    selectionScope.current = scope;
    setPendingRoute(null);
    return scope;
  };
  const selectionStillCurrent = (scope) => mounted.current && selectionScope.current === scope;
  // A composed route lands in the caller's provider field through
  // `onProviderChange`; its model and effort follow only AFTER the caller
  // reflects the new id. Firing all three in one tick would hand
  // `onModelChange` to a handler that merges over the caller's CURRENT
  // provider, silently putting the previous provider back. Waiting also lets
  // the caller's own clearing rule (a provider change resetting the model) run
  // first and then be overridden by the explicit choice. A caller that never
  // reflects the id simply never gets the model/effort.
  const selectRoute = (id, model, routeEffort, options) => {
    beginSelection();
    setPendingRoute({ id, model: model || '', effort: routeEffort || '', options });
    callbacksRef.current.onProviderChange(id);
  };
  useEffect(() => {
    if (!pendingRoute || pendingRoute.id !== selectedProviderId) return;
    callbacksRef.current.onModelChange?.(pendingRoute.model);
    callbacksRef.current.onEffortChange?.(pendingRoute.effort);
    if (pendingRoute.options !== undefined) callbacksRef.current.onExecutionOptionsChange?.(pendingRoute.options);
    setPendingRoute(null);
  }, [pendingRoute, selectedProviderId]);
  // "Use once" passes the composite id; "Save as preset" passes the minted
  // preset (whose defaults are the composed model and effort).
  const [handleCompose, composingSelection] = useAsyncAction(async (compositeId, { model, effort: composedEffort, executionOptions: options }) => {
    const scope = beginSelection();
    if (!onExecutionOptionsChange && Object.keys(options || {}).length) {
      const preset = await saveExecutionOptionSelection(compositeId, model, options, { silent: true });
      if (!selectionStillCurrent(scope)) return;
      rememberPreset(preset);
      selectRoute(preset.id, model, composedEffort);
    } else selectRoute(compositeId, model, composedEffort, options);
  }, { errorMessage: 'Could not save execution selection' });
  const handlePresetSaved = (preset) => {
    rememberPreset(preset);
    selectRoute(preset.id, preset.defaultModel, preset.effort);
  };
  const [changeExecutionOptions, executionOptionsSaving] = useAsyncAction(async (options) => {
    const scope = beginSelection();
    if (onExecutionOptionsChange) return onExecutionOptionsChange(options);
    if (!selectedProvider) return;
    const selection = await saveExecutionOptionSelection(selectedProvider.id, effectiveModel, options, { silent: true });
    if (!selectionStillCurrent(scope)) return;
    rememberPreset(selection);
    selectRoute(selection.id, selectedModel, effort);
  }, { errorMessage: 'Could not save execution options' });
  return { beginSelection, handleCompose, composingSelection, handlePresetSaved, changeExecutionOptions, executionOptionsSaving };
}
