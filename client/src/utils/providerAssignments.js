/**
 * Resolves which provider/model a record uses (`resolveEffectiveProvider`, `resolveSeriesRunLlm`) plus
 * shared option helpers for assignment editors.
 *
 * `resolveSeriesRunLlm` mirrors `server/lib/seriesLlmOverride.js`.
 */

import { localToolUseHint, visionLocalModelFilter } from './localModelHeuristics.js';
import { effectiveModelFor, mergeModelLists } from './providerModels.js';

/** Timeout (ms) of the stage's pinned provider, else the active one; `undefined` when unset. */
export const getProviderTimeout = (providers, stagePinnedId, activeProviderId) => {
  const id = stagePinnedId || activeProviderId;
  if (!id) return undefined;
  return providers.find((p) => p.id === id)?.timeout;
};

/**
 * The provider a record will ACTUALLY run on: its pin, else the active provider,
 * so "use the default" pickers resolve models and effort against it. `usingActive`
 * says which provider the blank option means.
 * @returns {{provider: object|undefined, usingActive: boolean}}
 */
export const resolveEffectiveProvider = (providers, pinnedId, activeProviderId) => {
  const id = pinnedId || activeProviderId || '';
  const provider = id ? (providers || []).find((p) => p.id === id) : undefined;
  return { provider, usingActive: !pinnedId && !!provider };
};

/**
 * Effective provider/model for a Pipeline series run: CLIENT MIRROR of
 * `resolveSeriesLlmOverride` plus the active provider as final fallback, so the UI
 * can NAME what the server's `resolveAutopilotLlm` will resolve.
 * @returns {{provider: string, model: string}}
 */
export const resolveSeriesRunLlm = (series, { overrideProvider, overrideModel, activeProviderId } = {}) => {
  const seriesProvider = series?.llm?.provider || '';
  // The series model belongs to the series provider; an override naming a
  // different provider resolves THAT provider's default.
  const inheritsSeriesModel = !overrideProvider || overrideProvider === seriesProvider;
  return {
    provider: overrideProvider || seriesProvider || activeProviderId || '',
    model: overrideModel || (inheritsSeriesModel ? series?.llm?.model || '' : ''),
  };
};

/** "Claude Code / claude-opus-5" or "Claude Code (provider default model)": the one phrasing for "which AI will this run call". */
export const providerModelLabel = (providers, id, model) =>
  `${providerDisplayName(providers, id, '—')}${model ? ` / ${model}` : ' (provider default model)'}`;

/** Display name for a provider id, falling back to the id then `fallback`. */
export const providerDisplayName = (providers, id, fallback = '') =>
  providers.find((p) => p.id === id)?.name || id || fallback;

/**
 * Provider `{ id, name, enabled }` options for an assignment entry: its pre-baked
 * `providerOptions`, else providers whose `type` is in `providerTypes`, with a
 * "(disabled)" suffix. `enabled` rides along so a caller can disable the
 * `<option>`; pre-baked options carry none and stay selectable.
 */
export const assignmentProviderOptions = (entry, providers) => {
  if (Array.isArray(entry?.providerOptions)) return entry.providerOptions;
  const types = Array.isArray(entry?.providerTypes) && entry.providerTypes.length
    ? new Set(entry.providerTypes)
    : null;
  return providers
    .filter((p) => !types || types.has(p.type))
    .map((p) => ({ id: p.id, name: `${p.name}${p.enabled ? '' : ' (disabled)'}`, enabled: !!p.enabled }));
};

/**
 * Model-id options for an assignment entry: its pre-baked `modelOptions`, else the provider's own list. With `modelFilter === 'vision'`, LOCAL backends are reduced to vision-capable models
 * (`visionLocalModelFilter`; pass `visionIdsByProvider` for the backend's own metadata); cloud lists are intact. For an ENUMERATED local provider the server's installed-VLM list is UNIONED IN (stored `models`
 * goes stale when the user pulls a model); an unenumerated provider gets no union, or it would be offered models it doesn't serve.
 */
export const assignmentModelOptions = (entry, providers, providerId, visionIdsByProvider = null) => {
  const provider = providers.find((p) => p.id === providerId);
  const baked = Array.isArray(entry?.modelOptions);
  const raw = baked ? entry.modelOptions : (provider?.models || []);
  // Normalize object-shaped entries (`{ id }`) to plain string options.
  const models = raw
    .map((m) => (typeof m === 'string' ? m : m?.id))
    .filter(Boolean);
  if (entry?.modelFilter !== 'vision') return models;
  // Pre-baked `modelOptions` is an explicit caller-supplied full candidate set.
  const installed = baked ? null : visionIdsByProvider?.[providerId];
  const candidates = installed ? mergeModelLists(models, [...installed]) : models;
  return candidates.filter((id) => visionLocalModelFilter(id, provider, visionIdsByProvider));
};

/**
 * Tool-use annotation state for one assignment row, so every editor of the same
 * pin derives it identically. `entry.needsTools` is the SERVER's marker for a
 * provider running an agent harness (`agentEntry` in server/services/aiAssignments.js).
 *
 *   - The EFFECTIVE model is judged, not the pin: a blank model runs the
 *     provider's `defaultModel`, which for a local backend can wedge the run.
 *   - Nothing is asserted until the capability scan SETTLES (`toolUseLoaded`), or a
 *     false "no known tool use" appears then retracts.
 *   - `incapable` is a strict `=== false`, so a non-agent entry, cloud provider or
 *     unpinned row reads as "no warning".
 *
 * @param {{needsTools?:boolean}|null|undefined} entry
 * @param {object|undefined} provider - the selected provider
 * @param {string} model - the row's model pin ('' = provider default)
 * @param {Record<string, Set<string>>|null} [toolUseIdsByProvider]
 * @param {boolean} [toolUseLoaded]
 * @returns {{annotate: boolean, effectiveModel: string, incapable: boolean}}
 */
export const assignmentToolUseState = (entry, provider, model, toolUseIdsByProvider = null, toolUseLoaded = false) => {
  const effectiveModel = effectiveModelFor(provider, model);
  const annotate = entry?.needsTools === true && toolUseLoaded;
  const hint = annotate ? localToolUseHint(effectiveModel, provider, toolUseIdsByProvider) : null;
  return { annotate, effectiveModel, incapable: hint?.toolCapable === false };
};

/** Default model to seed on a provider pick; for vision entries it must be in the filtered options (no text-only default). */
export const assignmentDefaultModel = (entry, providers, providerId, visionIdsByProvider = null) => {
  if (!providerId) return '';
  const provider = providers.find((p) => p.id === providerId);
  if (!provider) return '';
  const def = provider.defaultModel || '';
  if (entry?.modelFilter !== 'vision') return def;
  const models = assignmentModelOptions(entry, providers, providerId, visionIdsByProvider);
  if (def && models.includes(def)) return def;
  return models[0] || '';
};
