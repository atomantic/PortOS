/**
 * Judges an untyped local model's capabilities from its id: `isEmbeddingModel`, `isVisionModel`,
 * `isToolUseModel` and picker annotations, re-exported from the server leaf.
 *
 * The family predicates are re-exported from the pure leaf
 * `server/lib/localModelHeuristics.js` and take an id or a model card whose
 * metadata outranks the regex; the picker annotations built on them are unioned
 * with the backend's own capability report (`useToolUseModelIds` / `useVisionModelIds`).
 */

import { isLocalEndpoint, isLocalInstanceProvider, localBackendForProvider } from './providerEndpoints.js';
import { filterSelectableModels } from './providerModels.js';
import { commandBasename, isOllamaBackedProvider } from './providerTypes.js';
import { isEmbeddingModel, isToolUseModel, isVisionModel } from '../../../server/lib/localModelHeuristics.js';

export { isVisionCapableCodexTuiProvider } from '../../../server/lib/codex.js';

export { isEmbeddingModel, isToolUseModel, isVisionModel } from '../../../server/lib/localModelHeuristics.js';

/**
 * Whether a CLI-type provider can read an image file. Keyed on the command
 * basename (as on the server) so a path-configured Claude/Codex/Grok qualifies;
 * API providers use `visionLocalModelFilter`.
 */
export const isVisionCapableCliProvider = (provider) =>
  provider?.type === 'cli'
  && ['codex', 'claude', 'grok'].includes(commandBasename(provider.command));

/**
 * The provider id whose entry in the server's per-provider capability maps vouches
 * for `provider`'s models. Normally its own id; an Ollama-backed CLI/TUI wrapper
 * (`claude-ollama-tui`, ...) is not enumerated by the server but talks to the
 * managed local daemon, so it borrows `ollama`'s entry, only when its base URL is
 * loopback. A wrapper with no URL, or pointed at another host, keeps its own id and stays regex-only.
 */
const capabilityProviderId = (provider) => {
  if (!provider || provider.id === 'ollama' || !isOllamaBackedProvider(provider)) return provider?.id;
  const base = String(provider.envVars?.ANTHROPIC_BASE_URL || provider.endpoint || '').trim();
  return base !== '' && isLocalEndpoint(base) ? 'ollama' : provider.id;
};

/**
 * Agent-picker tool-use annotation for a model id: a model that can't emit native
 * tool calls (e.g. Gemma) narrates a done-message and wedges the task. An
 * ANNOTATION, never a filter: {@link isToolUseModel} is a positive allowlist, so a
 * non-match is not a proven negative (see {@link withToolUseOptionLabel}).
 *
 * Returns `null` for cloud / API providers (ids don't encode a family). LOCAL =
 * a direct Ollama / LM Studio backend ({@link localBackendForProvider}) OR an
 * Ollama-BACKED CLI/TUI wrapper ({@link isOllamaBackedProvider}), which keeps
 * `ollamaBacked` even when a rename loses what `localBackendForProvider` matches.
 *
 * `toolUseIdsByProvider` is the server's AUTHORITATIVE capability map
 * (`useToolUseModelIds`), keyed by the PROVIDER ID serving each model, UNIONED
 * with the regex (which goes stale as families ship); `null` = regex-only. Not
 * keyed by backend: a CUSTOM provider on a *different* Ollama/LM Studio host
 * resolves to the same backend, and a local id must not vouch for a remote model
 * that merely shares its name.
 */
export const localToolUseHint = (id, provider, toolUseIdsByProvider = null) =>
  (localBackendForProvider(provider) || isOllamaBackedProvider(provider) || provider?.lmstudioBacked === true || provider?.mtplxBacked === true || provider?.llamaBacked === true || provider?.vllmBacked === true || provider?.sglangBacked === true)
    && typeof id === 'string' && id.length > 0
    ? { toolCapable: toolUseIdsByProvider?.[capabilityProviderId(provider)]?.has(id) === true || isToolUseModel(id) }
    : null;

/**
 * Suffix a native `<option>` label with a tool-use marker for an agent picker
 * (emoji, since `<option>` can't render markup). Returns `label` unchanged for
 * cloud providers or a blank id. Pairs with {@link localToolUseHint}.
 *
 * A match is a reliable "tool-capable"; a NON-match only means "not recognized",
 * so the negative marker is worded as unverified.
 */
export const withToolUseOptionLabel = (id, label, provider, toolUseIdsByProvider = null) => {
  const hint = localToolUseHint(id, provider, toolUseIdsByProvider);
  if (!hint) return label;
  return `${label}${hint.toolCapable ? ' · 🔧 tool use' : ' · ⚠ no known tool use'}`;
};

/**
 * Annotate a native model option with the capabilities the picker knows about,
 * so selectors share one capability wording and tool/image signal combination.
 */
export const withModelCapabilityOptionLabel = (
  id,
  label,
  provider,
  { toolUseIdsByProvider = null, visionIdsByProvider = null, includeToolUse = true, includeVision = true } = {},
) => {
  const badges = [];
  const toolHint = localToolUseHint(id, provider, toolUseIdsByProvider);
  if (includeToolUse && toolHint) badges.push(toolHint.toolCapable ? '🔧 tool use' : '⚠ no known tool use');
  const visionCapable = isVisionCapableCliProvider(provider)
    || (localBackendForProvider(provider)
      && (visionIdsByProvider?.[provider?.id]?.has(id) === true || isVisionModel(id)));
  if (includeVision && visionCapable) badges.push('🖼 image analysis');
  return badges.length ? `${label} · ${badges.join(' · ')}` : label;
};

/** Selectable models for a generation/chat picker: drops internal sentinels AND embedding-only models. */
export const filterGenerationModels = (models) =>
  filterSelectableModels(models).filter((m) => !isEmbeddingModel(m));

/**
 * Per-model filter for a VISION picker: restrict LOCAL backends to vision-capable
 * models, but leave cloud/API lists untouched (`isVisionModel` is a local-name
 * heuristic and would hide `gpt-4o`, `claude-*`). Pass as
 * `useProviderModels({ modelFilter: visionLocalModelFilter })`.
 *
 * `visionIdsByProvider` is the server's AUTHORITATIVE capability map
 * (`useVisionModelIds`), keyed by the PROVIDER ID serving each model and unioned
 * with the id regex; `null` = regex-only. Keyed by provider, not flattened or by
 * backend, because a bare id is not a capability: the same id can be a VLM on one
 * backend and text-only on another, the server reports `backend: 'cli'` rows
 * asserting vision for EVERY model of a claude/codex CLI, and a CUSTOM provider
 * pointed at a different Ollama/LM Studio host resolves to the same backend
 * without having been enumerated. Unenumerated local providers stay regex-only;
 * sceneEvaluator honors a pin's model verbatim, so a wrong yes sends frames to a
 * model that cannot see them.
 *
 */
export const visionLocalModelFilter = (id, provider, visionIdsByProvider = null) => {
  // Cloud/API providers are left intact (see the docblock).
  if (!localBackendForProvider(provider)) return true;
  return visionIdsByProvider?.[provider?.id]?.has(id) === true || isVisionModel(id);
};

/**
 * Resolve capability badges for a selected model without over-sharing a local
 * runtime's answer: the status endpoint is keyed by backend, but only the
 * canonical `ollama` / `lmstudio` records are known to point at this install's
 * daemon; custom or remote providers stay on conservative inference.
 *
 * `[]` is a valid runtime answer (none reported); `null` means unknown, and
 * `source` says why (loading, probe failed, harness-level fact, no metadata).
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
  // harness; labelled provider-level, not per-model published metadata.
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
