import { useState, useEffect, useCallback, useMemo } from 'react';
import { effortAwareModelOptions, effortSurvivingModel, mergeModelLists, resolveEffectiveProvider } from '../utils/providers';

/**
 * Provider / model / effort pins for one CoS scheduled task, shared by the
 * schedule card's quick controls and the config drawer's global controls so a
 * change made in either place goes through the same optimistic-write path.
 *
 * Each change is written immediately (`'' → null` clears the pin) and rolled
 * back to the persisted value when the write fails. Picking a provider also
 * clears model + effort in the same PUT — a model from the previous provider
 * would not resolve. Picking a model clears the effort in the same PUT only when
 * that model has no effort tiers at all (see `changeModel`).
 *
 * `saving` is the in-flight flag callers must use to gate any action that reads
 * these pins server-side (the "Run Now" button), per the repo's
 * "in-flight saves must gate dependent actions" convention — otherwise the user
 * picks a model and triggers a run before the server has it.
 *
 * @param {object} params
 * @param {string} params.taskType - Task id (e.g. `code-review`).
 * @param {object} params.config - The live task config from the schedule payload.
 * @param {object[]} [params.providers] - Provider records, for resolving the model list.
 * @param {string} [params.activeProviderId] - The install's active provider, which
 *   an unpinned task runs on (see `resolveEffectiveProvider`).
 * @param {function} params.onUpdate - `(taskType, settings) => Promise<boolean>`;
 *   resolving falsy (or rejecting) rolls the local selection back.
 * @param {function} [params.onBusyChange] - Mirrors `saving` into a caller-owned
 *   updating flag (the drawer disables its whole form — and blocks Esc — off one).
 * @returns {{providerId: string, model: string, effort: string, provider: object|undefined,
 *   effectiveProviderId: string, defaultProviderLabel: string, availableModels: string[],
 *   saving: boolean, changeProvider: function, changeModel: function, changeEffort: function}}
 */
export function useTaskModelPins({ taskType, config, providers, activeProviderId, onUpdate, onBusyChange }) {
  const persisted = useMemo(() => ({
    providerId: config?.providerId || '',
    model: config?.model || '',
    effort: config?.effort || '',
  }), [config?.providerId, config?.model, config?.effort]);

  const [pins, setPins] = useState(persisted);
  const [saving, setSaving] = useState(false);

  // Re-sync from the refetched config (and when the hosting surface switches task).
  useEffect(() => { setPins(persisted); }, [taskType, persisted]);

  // One optimistic write for all three pins: apply locally, PUT ('' → null
  // clears the pin), restore the persisted values if the write didn't land.
  const change = useCallback(async (patch) => {
    setPins(prev => ({ ...prev, ...patch }));
    setSaving(true);
    onBusyChange?.(true);
    const settings = Object.fromEntries(
      Object.entries(patch).map(([field, value]) => [field, value === '' ? null : value])
    );
    const ok = await onUpdate(taskType, settings).catch(() => false);
    if (!ok) setPins(persisted);
    setSaving(false);
    onBusyChange?.(false);
  }, [onUpdate, taskType, persisted, onBusyChange]);

  const toolFree = taskType === 'issue-watcher';
  const { provider, usingActive } = useMemo(
    () => resolveEffectiveProvider(providers, pins.providerId, toolFree ? null : activeProviderId),
    [providers, pins.providerId, activeProviderId, toolFree]
  );

  // Provider is the only one that clears its siblings outright: a model (and the
  // effort ladder behind it) belongs to the provider it came from.
  const changeProvider = useCallback((next) => change({ providerId: next, model: '', effort: '' }), [change]);
  // Model clears the effort CONDITIONALLY, in the same write: picking a model with
  // no effort tiers (Antigravity's ladder is per-model) hides the effort select,
  // and a stored level with no UI left to change it would keep being sent on every
  // run — an invocation agy rejects. A merely narrowed ladder is left alone, since
  // EffortSelect still renders the clamp as a visible option.
  const changeModel = useCallback((next) => {
    const surviving = effortSurvivingModel(provider, next, pins.effort);
    return change(surviving === pins.effort ? { model: next } : { model: next, effort: surviving });
  }, [change, provider, pins.effort]);
  const changeEffort = useCallback((next) => change({ effort: next }), [change]);

  // Both surfaces that use these pins persist a separate effort, so Antigravity
  // lists BASE models (`gemini-3.6-flash`) with the tier picked beside them —
  // `effortAwareModelOptions` also keeps a legacy suffixed pin selectable, since
  // the server splits it back into `--model` + `--effort` and it still runs.
  // Any OTHER pin the provider no longer lists stays selectable too, or the
  // select would hold a value matching no option, render blank, and read as
  // "Default".
  const availableModels = useMemo(() => {
    const selectable = effortAwareModelOptions(provider, pins.model);
    return pins.model ? mergeModelLists([pins.model], selectable) : selectable;
  }, [provider, pins.model]);

  return {
    ...pins,
    provider,
    effectiveProviderId: provider?.id || '',
    toolFree,
    defaultProviderLabel: toolFree ? 'Default (Abuse Guard source policy)' : usingActive ? `Default (active: ${provider.name})` : 'Default (active provider)',
    availableModels,
    saving,
    changeProvider,
    changeModel,
    changeEffort,
  };
}

export default useTaskModelPins;
