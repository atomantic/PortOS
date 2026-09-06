/**
 * Which PROVIDERS and MODELS a picker may offer on this install: the
 * hardware-compatibility filters (server-annotated, fail-open), the
 * agent-harness runnability filter, and the fail-closed selection policies
 * security-sensitive pickers apply — the tool-free local policy and the
 * pr-reviewer public-review postures.
 *
 * The posture half is a browser MIRROR of `server/lib/agentExecutionProfiles.js`:
 * a pipeline stage names a POSTURE, the server publishes each provider's
 * `publicReviewPostures` / `publicReviewEnforcedPostures` on
 * `GET /api/providers`, and the picker offers exactly the providers this
 * install can run the stage on — no vendor is named on either side.
 *
 * Re-exported by `./providers.js` for existing `utils/providers` imports.
 */

import { isLocalInstanceProvider, localBackendForProvider } from './providerEndpoints.js';
import { AGENT_HARNESS_PROVIDER_TYPES, isApiProvider } from './providerTypes.js';
import { isHardwareCompatible } from './systemCapabilities.js';

// Direct local HTTP providers are the only provider class that can be made
// tool-free by construction. CLI/TUI providers may be pointed at a local model,
// but the harness still has filesystem/process authority, so they do not belong
// in a tool-free security-review picker.
export const TOOL_FREE_LOCAL_PROVIDER_IDS = Object.freeze(['ollama', 'lmstudio']);

export const TOOL_FREE_LOCAL_TEXT_CAPABILITIES = Object.freeze(['chat', 'completion']);

/**
 * True only for PortOS's canonical local HTTP backends on this machine.
 *
 * The explicit ids keep a custom provider from inheriting a security-sensitive
 * policy merely because its endpoint happens to mention Ollama or LM Studio.
 * `isLocalInstanceProvider` keeps a renamed canonical record pointed at another
 * machine out of the same policy.
 */
export const isToolFreeLocalProvider = (provider) =>
  isApiProvider(provider)
  && TOOL_FREE_LOCAL_PROVIDER_IDS.includes(String(provider?.id || '').toLowerCase())
  && isLocalInstanceProvider(provider);

/**
 * Whether a local model has an authoritative, explicit text capability report
 * that excludes native tool use. Embedding-only models cannot review a diff;
 * unknown capability state is unsafe for a security scan and therefore returns
 * false rather than falling back to model-name heuristics.
 *
 * `capabilitiesByBackend` is the shape returned by `useLocalModels`; object
 * model entries are accepted too so callers with a richer model catalog can use
 * the same predicate without rebuilding a map.
 */
const isToolFreeLocalModelForProvider = (model, provider, capabilitiesByBackend, providerPredicate) => {
  if (!providerPredicate(provider)) return false;
  const id = typeof model === 'string' ? model : model?.id || model?.name;
  if (typeof id !== 'string' || !id.trim()) return false;
  const reported = Array.isArray(model?.capabilities)
    ? model.capabilities
    : capabilitiesByBackend?.[localBackendForProvider(provider)]?.[id];
  if (!Array.isArray(reported)) return false;
  const normalized = reported.map((capability) => String(capability).toLowerCase());
  return normalized.some((capability) => TOOL_FREE_LOCAL_TEXT_CAPABILITIES.includes(capability))
    && !normalized.includes('tools');
};

export const isToolFreeLocalModel = (model, provider, capabilitiesByBackend = {}) =>
  isToolFreeLocalModelForProvider(model, provider, capabilitiesByBackend, isToolFreeLocalProvider);

/**
 * Build the shared selection policy used by security-sensitive AI pickers.
 * ProviderModelSelector owns applying all three predicates consistently; a
 * caller supplies only the policy-specific capability source.
 */
export const toolFreeLocalSelectionPolicy = (
  capabilitiesByBackend = {},
  { providerPredicate = isToolFreeLocalProvider } = {},
) => ({
  provider: providerPredicate,
  model: (model, provider) => isToolFreeLocalModelForProvider(
    model,
    provider,
    capabilitiesByBackend,
    providerPredicate,
  ),
});

// The two enforceable public-review postures. MIRROR of
// `server/lib/agentExecutionProfiles.js`; a pr-reviewer stage names a posture
// and the server publishes each provider's `publicReviewPostures` on
// `GET /api/providers`, so no vendor is ever named on either side.
export const PUBLIC_REVIEW_NO_TOOL_POSTURE = 'no-tool';

export const PUBLIC_REVIEW_ACTIONS_POSTURE = 'sandboxed-actions';

/**
 * Whether the SERVER says this provider can enforce `posture`. Falls back to
 * the older per-posture booleans so a browser talking to a peer/older server
 * still renders a correct picker instead of an empty one.
 */
export const supportsPublicReviewPosture = (provider, posture) => {
  if (Array.isArray(provider?.publicReviewPostures)) return provider.publicReviewPostures.includes(posture);
  return posture === PUBLIC_REVIEW_ACTIONS_POSTURE
    ? provider?.publicReviewActionsSupported === true
    : provider?.publicReviewSupported === true;
};

/**
 * Whether the SERVER runs `posture` on this provider through a vendor-enforced
 * recipe (an OS sandbox for the actions stage), as opposed to merely allowing
 * it. `publicReviewEnforcedPostures` is the server's subset; an older server
 * that does not publish it only ever offered enforced providers, so its
 * eligible set is taken as enforced.
 */
export const enforcesPublicReviewPosture = (provider, posture) => {
  if (Array.isArray(provider?.publicReviewEnforcedPostures)) return provider.publicReviewEnforcedPostures.includes(posture);
  return supportsPublicReviewPosture(provider, posture);
};

/**
 * Selection policy for a pr-reviewer stage.
 *
 * Provider eligibility is entirely server-derived. Model eligibility adds the
 * authoritative no-tool capability check only where PortOS can actually probe
 * it — a LOCAL runtime behind the provider. A cloud model is not probeable, so
 * the vendor's enforced argv (`--restricted --tools ''`, `--sandbox read-only`,
 * `--permission-mode plan`) is what denies it tools, and every model the
 * provider lists stays selectable.
 */
export const publicReviewSelectionPolicy = (posture, capabilitiesByBackend = {}) => ({
  provider: (provider) => supportsPublicReviewPosture(provider, posture),
  model: (model, provider) => {
    if (!supportsPublicReviewPosture(provider, posture)) return false;
    if (posture !== PUBLIC_REVIEW_NO_TOOL_POSTURE || !localBackendForProvider(provider)) return true;
    return isToolFreeLocalModelForProvider(
      model,
      provider,
      capabilitiesByBackend,
      () => true,
    );
  },
});

/**
 * Retain an existing non-runnable pin so a saved job can still be edited and
 * cleared, while limiting new agent-job selections to runnable providers.
 */
export const filterRunnableProviders = (providers, selectedProviderIds = []) => {
  const preservedIds = new Set(
    (Array.isArray(selectedProviderIds) ? selectedProviderIds : [selectedProviderIds]).filter(Boolean)
  );
  return (Array.isArray(providers) ? providers : []).filter(provider =>
    AGENT_HARNESS_PROVIDER_TYPES.includes(provider?.type) || preservedIds.has(provider?.id)
  );
};

/**
 * Server-side hardware metadata is advisory for unknown probe results and
 * definitive only when `state` is `unavailable`. Keep this helper fail-open so
 * older servers and custom providers remain selectable.
 */
export const isProviderHardwareCompatible = (provider) =>
  isHardwareCompatible(provider?.hardwareCompatibility);

/**
 * The providers a picker may offer: enabled, runnable on this hardware, and
 * allowed by the caller's policy — plus the currently-selected id whatever its
 * state, so a saved pin still renders instead of silently blanking. This is
 * the single rule `ProviderModelSelector` renders from; a caller that lists
 * "eligible" providers beside such a picker must derive the list from here so
 * the note and the dropdown cannot disagree.
 */
export const selectableProviders = (providers, { selectedId = '', allowed = null } = {}) =>
  (Array.isArray(providers) ? providers : []).filter((provider) => (
    provider?.id === selectedId
    || (provider?.enabled !== false && isProviderHardwareCompatible(provider) && (!allowed || allowed(provider)))
  ));

export const isProviderModelHardwareCompatible = (provider, model) =>
  isProviderHardwareCompatible(provider)
  && isHardwareCompatible(provider?.modelHardwareCompatibility?.[model]);

export const filterHardwareCompatibleProviderModels = (models, provider) =>
  (models || []).filter((model) => {
    const modelId = typeof model === 'string' ? model : model?.id;
    return isProviderModelHardwareCompatible(provider, modelId);
  });
