/**
 * What an untyped LOCAL model can do, judged from its id: the embedding /
 * vision / tool-use family regexes, the picker annotations built on them, and
 * the union with the backend's own capability report where the server could
 * probe one (`useToolUseModelIds` / `useVisionModelIds`).
 *
 * The family predicates (`isEmbeddingModel` / `isVisionModel` /
 * `isToolUseModel`) are re-exported from the pure leaf
 * `server/lib/localModelHeuristics.js`. They take a bare id string (the case
 * every caller here has) or a model card, whose explicit capability metadata
 * outranks the id regex.
 *
 * Re-exported by `./providers.js` for existing `utils/providers` imports.
 */

import { isLocalInstanceProvider, localBackendForProvider } from './providerEndpoints.js';
import { filterSelectableModels } from './providerModels.js';
import { commandBasename, isOllamaBackedProvider } from './providerTypes.js';
import { isEmbeddingModel, isToolUseModel, isVisionModel } from '../../../server/lib/localModelHeuristics.js';

export { isEmbeddingModel, isToolUseModel, isVisionModel } from '../../../server/lib/localModelHeuristics.js';

/**
 * Whether a CLI-type provider can read an image file (its CLI accepts a
 * vision attachment). The client's own take on `isVisionCapableCliProvider`
 * in server/lib/localModelHeuristics.js: keyed on the command basename so a
 * path-configured Claude or Codex still qualifies here, where the server
 * matches the bare command exactly. API providers return false; use
 * `visionLocalModelFilter` for their model lists.
 * @param {{type?:string, command?:string}|null|undefined} provider
 * @returns {boolean}
 */
export const isVisionCapableCliProvider = (provider) =>
  provider?.type === 'cli'
  && (commandBasename(provider.command) === 'codex' || commandBasename(provider.command) === 'claude');

/**
 * Agent-picker tool-use annotation for a model id. Agent / CoS tasks (the CD
 * treatment + plan stages, coding agents) only work with a model that can emit
 * native tool calls — a local model that can't (e.g. Gemma) narrates a
 * done-message instead of acting, silently wedging the task. This decides the
 * per-option marker + the "pick a tool-capable model" warning in agent pickers.
 *
 * Tool-use is surfaced as an ANNOTATION + warning, never as a filter: the
 * heuristic is a positive allowlist, so a non-match is "not a recognized
 * tool-caller", not a proven negative, and hiding those options would make a
 * newer tool-capable family unselectable (see {@link withToolUseOptionLabel}).
 *
 * Returns `null` for cloud / API providers: their model ids don't encode their
 * family, so the name heuristic would mislabel them. LOCAL backends return
 * `{ toolCapable }` — where "local" is BOTH a direct Ollama / LM Studio backend
 * ({@link localBackendForProvider}) AND an Ollama-BACKED CLI/TUI wrapper
 * ({@link isOllamaBackedProvider}): a renamed `claude-ollama-tui` / OpenCode
 * wrapper keeps `ollamaBacked: true` but may lose the "ollama"
 * name/endpoint/id that `localBackendForProvider` matches on, and that wrapper
 * is exactly the incident's provider class — so it must still be flagged, not
 * silently skipped.
 *
 * `toolUseIdsByProvider` is the AUTHORITATIVE map the server reports from each
 * backend's own capability metadata (Ollama `/api/show` `tools`) keyed by the
 * PROVIDER ID the server says serves each model — see `useToolUseModelIds`. It
 * is UNIONED with, never substituted for, {@link isToolUseModel}: the regex is a
 * positive allowlist that goes stale every time a new function-calling family
 * ships (`phi4-mini`, newer Gemma builds got "⚠ no known tool use" while the
 * Local LLMs tab's "Agents" badge, reading these same capabilities, said
 * otherwise), while the map can't speak for a provider the server never
 * enumerated. Pass `null` (the default) when it hasn't loaded — that degrades to
 * regex-only, the behavior this picker has always had.
 *
 * Keyed by the ENUMERATED PROVIDER, not flattened and not keyed by backend,
 * because a bare id is not a capability: a CUSTOM provider (or an Ollama-backed
 * CLI wrapper) pointed at a *different* Ollama/LM Studio host resolves to the
 * same backend, but the server never enumerated that host — so a local model's
 * id must not vouch for a remote model that merely shares its name. Such a
 * provider stays regex-only, which is the conservative direction: a false
 * "tool-capable" sends an agent to a model that narrates instead of acting.
 * @param {string} id
 * @param {object} [provider]
 * @param {Record<string, Set<string>>|null} [toolUseIdsByProvider]
 * @returns {{toolCapable:boolean}|null}
 */
export const localToolUseHint = (id, provider, toolUseIdsByProvider = null) =>
  (localBackendForProvider(provider) || isOllamaBackedProvider(provider) || provider?.lmstudioBacked === true || provider?.mtplxBacked === true || provider?.llamaBacked === true || provider?.vllmBacked === true || provider?.sglangBacked === true)
    && typeof id === 'string' && id.length > 0
    ? { toolCapable: toolUseIdsByProvider?.[provider?.id]?.has(id) === true || isToolUseModel(id) }
    : null;

/**
 * Suffix a native `<option>` label with a tool-use marker for an agent picker.
 * No-op (returns `label` unchanged) for cloud providers or a blank id, so it's
 * safe to wrap every option. Pairs with {@link localToolUseHint} for the
 * below-the-select warning. Emoji (not lucide icons) because native `<option>`
 * elements can't render markup.
 *
 * The signal is asymmetric because {@link isToolUseModel} is a *positive
 * allowlist* of families with dependable function-calling: a match is a reliable
 * "tool-capable", but a NON-match only means "not a recognized tool-caller" —
 * NOT a proven negative (a newer tool-capable family whose id isn't in the regex
 * yet would fall here). So the negative marker is worded as unverified, not a
 * false-certain "no tool use". Passing `toolUseIdsByProvider` (from
 * `useToolUseModelIds`) shrinks that unverified band to the models the server
 * couldn't speak for; see {@link localToolUseHint} for the union rule.
 * @param {string} id - model id (drives the heuristic)
 * @param {string} label - display label to annotate (often === id)
 * @param {object} [provider] - the selected provider object
 * @param {Record<string, Set<string>>|null} [toolUseIdsByProvider] - authoritative
 *   server-reported tool-capable ids, keyed by provider id; `null` = regex-only
 * @returns {string}
 */
export const withToolUseOptionLabel = (id, label, provider, toolUseIdsByProvider = null) => {
  const hint = localToolUseHint(id, provider, toolUseIdsByProvider);
  if (!hint) return label;
  return `${label}${hint.toolCapable ? ' · 🔧 tool use' : ' · ⚠ no known tool use'}`;
};

/**
 * Selectable models for a generation/chat picker: drops internal sentinels AND
 * embedding-only models. Use anywhere the user picks a model that will run a
 * prompt (provider editor model lists, fallback model, manuscript review).
 * @param {string[]} models
 * @returns {string[]}
 */
export const filterGenerationModels = (models) =>
  filterSelectableModels(models).filter((m) => !isEmbeddingModel(m));

/**
 * Per-model filter for a VISION picker: restrict LOCAL backends (Ollama /
 * LM Studio) to vision-capable models by id, but leave cloud/API providers'
 * lists untouched — `isVisionModel` is a local-name heuristic and would wrongly
 * hide multimodal cloud models whose ids don't encode vision (`gpt-4o`,
 * `claude-*`). Pass as `useProviderModels({ modelFilter: visionLocalModelFilter })`.
 *
 * `visionIdsByProvider` is the AUTHORITATIVE map the server reports from each
 * backend's own capability metadata (Ollama `/api/show`, LM Studio
 * `type: 'vlm'`), keyed by the PROVIDER ID the server says serves each model —
 * see `useVisionModelIds`. It is unioned with, not substituted for, the id
 * regex: the regex alone goes stale every time a new multimodal family ships
 * (it knew `gemma-3` but not `gemma4`, so a user with only `gemma4:e4b` +
 * `qwen3.6:35b` installed saw an EMPTY vision picker), while the map alone
 * can't speak for a provider the server never enumerated. Pass `null` (the
 * default) when it hasn't loaded — that degrades to regex-only.
 *
 * Keyed by the ENUMERATED PROVIDER, not flattened and not keyed by backend,
 * because a bare id is not a capability:
 *   - The same id can be a VLM on one backend and text-only on another, and the
 *     server also reports `backend: 'cli'` rows asserting vision for EVERY model
 *     of a claude/codex CLI (that CLI reads an image file whatever model it
 *     fronts). Flattening let an ollama-backed Claude CLI's text-only ids — which
 *     collide with the real `ollama` provider's list — pass this filter.
 *   - Keying by backend alone still over-shares: a CUSTOM provider pointed at a
 *     *different* Ollama/LM Studio host (endpoint `:11434` on another machine)
 *     resolves to the same backend, but the server never enumerated that host,
 *     so a local VLM's id would vouch for a remote model that merely shares it.
 * An unenumerated local provider therefore stays on the regex-only path. This
 * matters because sceneEvaluator honors a pin's model verbatim — a wrong yes
 * here sends frames to a model that cannot see them.
 *
 * @param {string} id
 * @param {{id?:string,endpoint?:string,name?:string}} [provider]
 * @param {Record<string, Set<string>>|null} [visionIdsByProvider]
 * @returns {boolean}
 */
export const visionLocalModelFilter = (id, provider, visionIdsByProvider = null) => {
  // Cloud/API providers are left intact — the regex is a local-name heuristic
  // and would wrongly hide multimodal cloud ids like `gpt-4o`.
  if (!localBackendForProvider(provider)) return true;
  return visionIdsByProvider?.[provider?.id]?.has(id) === true || isVisionModel(id);
};

/**
 * Resolve the capability badges for a selected model without over-sharing a
 * local runtime's answer with another provider. The status endpoint is keyed
 * by backend, but only the canonical `ollama` / `lmstudio` provider records
 * are known to point at this install's daemon; custom or remote providers stay
 * on conservative inference. This mirrors the provider-scoped boundary used
 * by `useToolUseModelIds` and `useVisionModelIds`.
 *
 * `[]` is a valid runtime answer meaning no optional capabilities were
 * reported. `null` means the capability set is unknown, and `source` tells the
 * UI whether that is because the runtime is still loading, the runtime probe
 * failed, the provider gave a harness-level fact, or no authoritative metadata
 * exists.
 *
 * @param {{id?:string,type?:string,command?:string,endpoint?:string,name?:string,ollamaBacked?:boolean}|null|undefined} provider
 * @param {string|null|undefined} model
 * @param {{capabilitiesByBackend?: {ollama?: Record<string, string[]|null>, lmstudio?: Record<string, string[]|null>}, recommendations?: {ollama?: object|null, lmstudio?: object|null}, loading?: boolean}} [options]
 * @returns {{capabilities: string[]|null, source: 'unselected'|'runtime'|'runtime-unknown'|'provider'|'inferred'|'loading'|'unknown', recommendation: object|null}}
 */
export const modelCapabilityInfo = (provider, model, {
  capabilitiesByBackend = {},
  recommendations = {},
  loading = false,
} = {}) => {
  const modelId = typeof model === 'string' ? model.trim() : '';
  if (!provider || !modelId) {
    return { capabilities: null, source: 'unselected', recommendation: null };
  }

  const backend = localBackendForProvider(provider);
  const canonicalLocalProvider = backend
    && provider.id === backend
    && isLocalInstanceProvider(provider);
  const recommendation = canonicalLocalProvider ? recommendations?.[backend] : null;
  const selectedRecommendation = recommendation?.id === modelId ? recommendation : null;

  if (canonicalLocalProvider) {
    const modelCapabilities = capabilitiesByBackend?.[backend];
    if (modelCapabilities && Object.hasOwn(modelCapabilities, modelId)) {
      const capabilities = modelCapabilities[modelId];
      return {
        capabilities: Array.isArray(capabilities) ? [...new Set(capabilities)] : null,
        source: Array.isArray(capabilities) ? 'runtime' : 'runtime-unknown',
        recommendation: selectedRecommendation,
      };
    }
    if (loading) {
      return { capabilities: null, source: 'loading', recommendation: selectedRecommendation };
    }
  }

  // A Codex or Claude CLI can attach/read an image and invoke tools through its
  // harness. That is deliberately labelled as provider-level below; it is not
  // pretending that the provider published per-model metadata.
  if (isVisionCapableCliProvider(provider)) {
    return { capabilities: ['tools', 'vision'], source: 'provider', recommendation: null };
  }

  const inferred = [];
  if (backend && isToolUseModel(modelId)) inferred.push('tools');
  if (backend && isVisionModel(modelId)) inferred.push('vision');
  return {
    capabilities: inferred.length ? inferred : null,
    source: inferred.length ? 'inferred' : 'unknown',
    recommendation: selectedRecommendation,
  };
};
