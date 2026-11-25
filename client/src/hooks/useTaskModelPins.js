/**
 * Hook managing provider/model/effort pins for one CoS scheduled task with optimistic writes and
 * cascading clears when the provider or model changes.
 *
 * Provider/model/effort pins for one CoS scheduled task: optimistic write per change (`'' → null` clears; a provider pick clears model+effort, a model pick clears the effort only when the model has no tiers at all), rollback when
 * `onUpdate` resolves falsy, a `saving` flag to gate "Run Now", plus the derived `availableModels`, `effectiveProviderId` and `defaultProviderLabel` a `ProviderModelSelector` needs. Use for any surface that retargets a scheduled task's model.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { isCompositeProviderId } from '../utils/providerRef.js';
import { effortAwareModelOptions, effortSurvivingModel, mergeModelLists, resolveEffectiveProvider } from '../utils/providers';

/**
 * Provider / model / effort pins for one CoS scheduled task, shared by the
 * schedule card's quick controls and the config drawer's global controls so a
 * change made in either place goes through the same optimistic-write path.
 *
 * Changes apply optimistically (`'' → null` clears the pin) and roll back to
 * the last persisted values when a write fails. Picking a provider also
 * clears model + effort in the same PUT — a model from the previous provider
 * would not resolve. Picking a model clears the effort in the same PUT only when
 * that model has no effort tiers at all (see `changeModel`).
 *
 * `saving` is the in-flight flag callers must use to gate any action that reads
 * these pins server-side (the "Run Now" button), per the repo's
 * "in-flight saves must gate dependent actions" convention — otherwise the user
 * picks a model and triggers a run before the server has it.
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
    executionOptions: config?.executionOptions,
  }), [config?.providerId, config?.model, config?.effort, config?.executionOptions]);

  const [pins, setPins] = useState(persisted);
  const [saving, setSaving] = useState(false);

  const writeRef = useRef(null);
  const synced = useRef(persisted);

  useEffect(() => {
    if (saving || synced.current === persisted) return;
    synced.current = persisted;
    setPins(persisted);
  }, [persisted, saving]);

  // The shared selector may emit model and effort together, or confirm a
  // composed provider before supplying the rest of its route. Merge callbacks
  // from the same turn and serialize any follow-up while Run stays disabled.
  const change = useCallback((patch) => {
    setPins(prev => ({ ...prev, ...patch }));
    const pending = writeRef.current;
    if (pending) {
      Object.assign(pending.next, patch);
      return pending.done;
    }

    const write = { next: { ...patch }, done: null };
    writeRef.current = write;
    setSaving(true);
    onBusyChange?.(true);
    write.done = Promise.resolve().then(async () => {
      let saved = persisted;
      while (Object.keys(write.next).length) {
        const next = write.next;
        write.next = {};
        const settings = Object.fromEntries(
          Object.entries(next).map(([field, value]) => [field, value === '' ? null : value])
        );
        const ok = await onUpdate(taskType, settings).catch(() => false);
        if (!ok) break;
        saved = { ...saved, ...next };
      }
      writeRef.current = null;
      setPins(saved);
      setSaving(false);
      onBusyChange?.(false);
    });
    return write.done;
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
    const surviving = provider ? effortSurvivingModel(provider, next, pins.effort) : pins.effort;
    return change(surviving === pins.effort ? { model: next } : { model: next, effort: surviving });
  }, [change, provider, pins.effort]);
  const changeEffort = useCallback((next) => change({ effort: next }), [change]);

  const changeExecutionOptions = useCallback((next) => change({ executionOptions: next }), [change]);

  // Both surfaces that use these pins persist a separate effort, so Antigravity
  // lists BASE models (`gemini-3.6-flash`) with the tier picked beside them —
  // `effortAwareModelOptions` also keeps a legacy suffixed pin selectable, since
  // the server splits it back into `--model` + `--effort` and it still runs.
  // An unresolved composite leaves the list empty so the shared selector
  // can derive its options from the catalog.
  const availableModels = useMemo(() => {
    if (!provider && isCompositeProviderId(pins.providerId)) return [];
    const selectable = effortAwareModelOptions(provider, pins.model);
    return pins.model ? mergeModelLists([pins.model], selectable) : selectable;
  }, [provider, pins.providerId, pins.model]);

  return {
    ...pins,
    provider,
    effectiveProviderId: provider?.id || pins.providerId,
    toolFree,
    defaultProviderLabel: toolFree ? 'Default (Abuse Guard source policy)' : usingActive ? `Default (active: ${provider.name})` : 'Default (active provider)',
    availableModels,
    saving,
    changeProvider,
    changeModel,
    changeEffort,
    changeExecutionOptions,
  };
}

export default useTaskModelPins;
