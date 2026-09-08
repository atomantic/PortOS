/**
 * Which provider/model a RECORD resolves to, and the option helpers the
 * assignment editors share: a record's pin else the active provider
 * (`resolveEffectiveProvider`), a Pipeline series run's provider/model
 * (`resolveSeriesRunLlm`), the one "Provider / model" phrasing, and the
 * provider / model / default / tool-use-warning options for an AI Assignments
 * entry — consumed by the global AI Assignments table and every per-record
 * override drawer, so they cannot derive the rule differently.
 *
 * `resolveSeriesRunLlm` is a browser MIRROR of `server/lib/seriesLlmOverride.js`
 * (the precedence rationale lives there).
 *
 * Re-exported by `./providers.js` for existing `utils/providers` imports.
 */

import { localToolUseHint, visionLocalModelFilter } from './localModelHeuristics.js';
import { effectiveModelFor, mergeModelLists } from './providerModels.js';

/**
 * Resolve the provider whose timeout is the "fallback" for a stage — the
 * stage's pinned provider when set, otherwise the active provider. Used to
 * power the placeholder + hint on stage-timeout UIs in PromptManager and
 * the Writers Room. Returns the timeout in ms (or `undefined` if neither
 * provider is present, or its timeout isn't set).
 */
export const getProviderTimeout = (providers, stagePinnedId, activeProviderId) => {
  const id = stagePinnedId || activeProviderId;
  if (!id) return undefined;
  return providers.find((p) => p.id === id)?.timeout;
};

/**
 * The provider a record will ACTUALLY run on: its own pin when set, else the
 * install's active provider. Every picker that offers a "use the default"
 * option needs this — the model list, effort ladder, and "Default (active: X)"
 * label all have to resolve against the fallback, or leaving a record unpinned
 * silently means "no model or effort can be picked either".
 *
 * `usingActive` distinguishes the two so a caller can say which provider the
 * blank option currently means rather than just showing "Default".
 *
 * @param {Array} providers
 * @param {string|null|undefined} pinnedId - The record's own provider pin.
 * @param {string|null|undefined} activeProviderId - The install's active provider.
 * @returns {{provider: object|undefined, usingActive: boolean}}
 */
export const resolveEffectiveProvider = (providers, pinnedId, activeProviderId) => {
  const id = pinnedId || activeProviderId || '';
  const provider = id ? (providers || []).find((p) => p.id === id) : undefined;
  return { provider, usingActive: !pinnedId && !!provider };
};

/**
 * Effective provider/model for a run against a Pipeline series — CLIENT MIRROR
 * of `resolveSeriesLlmOverride` (server/lib/seriesLlmOverride.js; the precedence
 * rationale lives there), extended with the install's active provider as the
 * final fallback so the UI can NAME what a run will call instead of a blank.
 *
 * Used by the Autopilot Options picker and the scheduled-run consent card so
 * both name the same thing the server's `resolveAutopilotLlm` will resolve.
 *
 * @returns {{provider: string, model: string}}
 */
export const resolveSeriesRunLlm = (series, { overrideProvider, overrideModel, activeProviderId } = {}) => {
  const seriesProvider = series?.llm?.provider || '';
  // The series model belongs to the series provider — an override naming a
  // different provider must resolve THAT provider's default instead.
  const inheritsSeriesModel = !overrideProvider || overrideProvider === seriesProvider;
  return {
    provider: overrideProvider || seriesProvider || activeProviderId || '',
    model: overrideModel || (inheritsSeriesModel ? series?.llm?.model || '' : ''),
  };
};

/**
 * "Claude Code / claude-opus-5" — or "Claude Code (provider default model)"
 * when no model is pinned. The one phrasing for "which AI will this run call",
 * so the Autopilot Options copy, its live-progress line and the scheduled-run
 * consent card can't word the same fact three different ways.
 */
export const providerModelLabel = (providers, id, model) =>
  `${providerDisplayName(providers, id, '—')}${model ? ` / ${model}` : ' (provider default model)'}`;

/** Display name for a provider id, falling back to the id then `fallback`. */
export const providerDisplayName = (providers, id, fallback = '') =>
  providers.find((p) => p.id === id)?.name || id || fallback;

/**
 * Provider `{ id, name, enabled }` options eligible for an assignment entry —
 * the entry's pre-baked `providerOptions` when present, else every provider
 * whose `type` is in the entry's `providerTypes` (all providers when
 * unfiltered), tagged with a "(disabled)" suffix on disabled providers.
 *
 * `enabled` rides along so a caller can mark the rendered `<option>` itself
 * `disabled` — the suffix alone still lets a `<select>` submit a provider that
 * can't actually run. Pre-baked `providerOptions` carry no `enabled` field, so
 * they're left selectable (undefined, not false).
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
 * Model-id options for an assignment entry given the selected provider — the
 * entry's pre-baked `modelOptions` when present, else the provider's own model
 * list (empty when the provider is unknown or has none).
 *
 * When `entry.modelFilter === 'vision'`, LOCAL backends (Ollama / LM Studio)
 * are reduced to vision-capable models via `visionLocalModelFilter` so the
 * Scene Evaluation (and other vision) pickers can't offer text-only ids.
 * Cloud/API providers are left intact by that filter. Pass `visionIdsByProvider`
 * (from `useVisionModelIds`) so that reduction uses the backend's own capability
 * metadata instead of the id regex alone.
 *
 * For a vision entry on an ENUMERATED local provider, the server's installed-VLM
 * list is also UNIONED INTO the candidates rather than only filtering them: a
 * provider's stored `models` is a snapshot that goes stale the moment the user
 * pulls a model (`/local-llm/install` doesn't refresh it, and the shipped
 * `ollama` provider starts out empty), so filtering that list alone still hides
 * a VLM that is installed right now — the same staleness `useLocalModels` +
 * `mergeModelLists` exists to solve for non-vision pickers. Only the provider
 * the server actually enumerated gets this: an unenumerated one would otherwise
 * be offered models from a host it doesn't serve.
 */
export const assignmentModelOptions = (entry, providers, providerId, visionIdsByProvider = null) => {
  const provider = providers.find((p) => p.id === providerId);
  const baked = Array.isArray(entry?.modelOptions);
  const raw = baked ? entry.modelOptions : (provider?.models || []);
  // Normalize object-shaped entries (`{ id }`) so both baked and live lists
  // yield plain string options for the <select>.
  const models = raw
    .map((m) => (typeof m === 'string' ? m : m?.id))
    .filter(Boolean);
  if (entry?.modelFilter !== 'vision') return models;
  // Pre-baked `modelOptions` is an explicit caller-supplied list — honor it as
  // the full candidate set rather than widening it from the backend.
  const installed = baked ? null : visionIdsByProvider?.[providerId];
  const candidates = installed ? mergeModelLists(models, [...installed]) : models;
  return candidates.filter((id) => visionLocalModelFilter(id, provider, visionIdsByProvider));
};

/**
 * Tool-use annotation state for one AI-assignment row/stage, so every editor of
 * the same pin (the AI Assignments table, the Creative Director Models drawer,
 * any future one) derives it identically instead of re-deriving the rule and
 * drifting — the drawer used to be the only editor that warned at all, because
 * its stage list hard-coded `needsTools` client-side.
 *
 * `entry.needsTools` is the SERVER's marker for an assignment whose provider runs
 * an agent harness (see `agentEntry` in server/services/aiAssignments.js). It
 * mirrors `modelFilter: 'vision'`: one server flag, read uniformly.
 *
 * Three rules are baked in here so a caller can't forget one:
 *   - The EFFECTIVE model is judged, not the pin. A blank model isn't a no-op —
 *     the agent resolver then runs the provider's own `defaultModel`, which for a
 *     local backend can be the non-tool model that wedges the run.
 *   - Nothing is asserted until the capability scan SETTLES (`toolUseLoaded`,
 *     success or failure). Annotating mid-scan shows the false "no known tool
 *     use" the authoritative union exists to remove, only to retract it a beat
 *     later.
 *   - `incapable` is a strict `=== false` on the hint, so a non-agent entry, a
 *     cloud provider (`localToolUseHint` returns null — ids don't encode family)
 *     or an unpinned row all read as "no warning", never as "incapable".
 *
 * @param {{needsTools?:boolean}|null|undefined} entry - the assignment entry
 * @param {object|undefined} provider - the currently selected provider object
 * @param {string} model - the row's model pin ('' = provider default)
 * @param {Record<string, Set<string>>|null} [toolUseIdsByProvider] - from `useToolUseModelIds`
 * @param {boolean} [toolUseLoaded] - whether that scan has settled
 * @returns {{annotate: boolean, effectiveModel: string, incapable: boolean}}
 */
export const assignmentToolUseState = (entry, provider, model, toolUseIdsByProvider = null, toolUseLoaded = false) => {
  const effectiveModel = effectiveModelFor(provider, model);
  const annotate = entry?.needsTools === true && toolUseLoaded;
  const hint = annotate ? localToolUseHint(effectiveModel, provider, toolUseIdsByProvider) : null;
  return { annotate, effectiveModel, incapable: hint?.toolCapable === false };
};

/**
 * Default model to seed when the user picks a provider for an assignment.
 * For vision-filtered entries, only returns a model that still appears in the
 * filtered options — a local backend's text-only `defaultModel` must not be
 * seeded into the Scene Evaluation picker.
 */
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
