/**
 * Filters for which providers and models a picker may offer: hardware-compatibility filters,
 * agent-harness runnability and fail-closed selection policy.
 *
 * Covers the hardware filters (server-annotated, fail-open), the agent-harness
 * runnability filter, and the fail-closed policies security-sensitive pickers
 * apply (tool-free one-shot, and pr-reviewer public-review postures).
 *
 * The posture half MIRRORS `server/lib/agent/agentExecutionProfiles.js`: a stage names a
 * POSTURE, the server publishes each provider's `publicReviewPostures` /
 * `publicReviewEnforcedPostures` on `GET /api/providers`, and the picker offers
 * what this install can run; no vendor is named on either side.
 */

import { localBackendForProvider } from './providerEndpoints.js';
import { isProcessProvider } from './providerTypes.js';
import { isHardwareCompatible } from './systemCapabilities.js';
import { CALLER_MODE_POLICIES } from '../../../server/lib/callerModePolicy.js';

export const TOOL_FREE_LOCAL_TEXT_CAPABILITIES = Object.freeze(['chat', 'completion']);

/**
 * Whether a local model has an authoritative, explicit capability report that
 * excludes native tool use (embedding-only models can't review a diff). Unknown
 * capability state is unsafe for a security scan and returns false, never a
 * model-name heuristic. `capabilitiesByBackend` is the `useLocalModels` shape;
 * object model entries with their own `capabilities` are accepted too.
 */
const isToolFreeLocalModel = (model, provider, capabilitiesByBackend) => {
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

/** One-shot authoring permits direct APIs or a server-verified tool-free CLI.
 * Never infer CLI support from a command name, and never admit a TUI session.
 */
export const supportsToolFreeOneShot = (provider) => provider?.enabled !== false
  && (provider?.type === 'api' || provider?.type === 'cli' && (provider.toolFreeOneShot === true || provider.authoringOneShot === true));

/** Can run a Music Video frame check: an enabled provider the server says sees an image with no host-writing tool (#15576). */
export const supportsImageReview = (provider) => provider?.enabled !== false && provider?.imageReview === true;

// No compose modes: an unmaterialized CLI combination has no server capability
// annotation yet; existing pins still render, incompatible ones visible but disabled.
export const toolFreeOneShotSelectionPolicy = Object.freeze({ provider: supportsToolFreeOneShot });

/** Strictly tool-free: a direct API or a server-verified tool-free CLI, never a
 * read-only-sandboxed authoring CLI. Mirrors `isToolFreeOneShotProvider` in
 * server/lib/provider/providerVendors.js, for pickers whose server refuses the rest.
 */
export const supportsStrictToolFreeOneShot = (provider) => provider?.enabled !== false
  && (provider?.type === 'api' || provider?.type === 'cli' && provider.toolFreeOneShot === true);

export const strictToolFreeOneShotSelectionPolicy = Object.freeze({ provider: supportsStrictToolFreeOneShot });

// The two enforceable public-review postures (MIRROR of
// `server/lib/agent/agentExecutionProfiles.js`); the server publishes each provider's
// `publicReviewPostures`.
export const PUBLIC_REVIEW_NO_TOOL_POSTURE = 'no-tool';

export const PUBLIC_REVIEW_ACTIONS_POSTURE = 'sandboxed-actions';

/**
 * Whether the SERVER says this provider can enforce `posture`. Falls back to the
 * older per-posture booleans so an older server still renders a correct picker.
 */
export const supportsPublicReviewPosture = (provider, posture) => {
  if (Array.isArray(provider?.publicReviewPostures)) return provider.publicReviewPostures.includes(posture);
  return posture === PUBLIC_REVIEW_ACTIONS_POSTURE
    ? provider?.publicReviewActionsSupported === true
    : provider?.publicReviewSupported === true;
};

/**
 * Whether the SERVER runs `posture` through a vendor-enforced recipe (e.g. an OS
 * sandbox), not merely allows it. An older server that doesn't publish
 * `publicReviewEnforcedPostures` only offered enforced providers, so its eligible
 * set is taken as enforced.
 */
export const enforcesPublicReviewPosture = (provider, posture) => {
  if (Array.isArray(provider?.publicReviewEnforcedPostures)) return provider.publicReviewEnforcedPostures.includes(posture);
  return supportsPublicReviewPosture(provider, posture);
};

/**
 * Selection policy for a pr-reviewer stage. Provider eligibility is server-derived.
 * Model eligibility adds the no-tool capability check only where PortOS can probe
 * it (a LOCAL runtime); a cloud model isn't probeable, so the vendor's enforced
 * argv (`--restricted --tools ''`, `--sandbox read-only`, `--permission-mode
 * plan`) denies tools and every listed model stays selectable.
 */
export const publicReviewSelectionPolicy = (posture, capabilitiesByBackend = {}) => ({
  provider: (provider) => supportsPublicReviewPosture(provider, posture),
  model: (model, provider) => {
    if (!supportsPublicReviewPosture(provider, posture)) return false;
    if (posture !== PUBLIC_REVIEW_NO_TOOL_POSTURE || !localBackendForProvider(provider)) return true;
    return isToolFreeLocalModel(model, provider, capabilitiesByBackend);
  },
});

/** Retain an existing non-runnable pin so a saved job can be edited and cleared, while limiting new selections to runnable providers. */
export const filterRunnableProviders = (providers, selectedProviderIds = []) => {
  const preservedIds = new Set(
    (Array.isArray(selectedProviderIds) ? selectedProviderIds : [selectedProviderIds]).filter(Boolean)
  );
  return (Array.isArray(providers) ? providers : []).filter(provider =>
    isProcessProvider(provider) || preservedIds.has(provider?.id)
  );
};

/** Hardware metadata is advisory for unknown probes and definitive only at `state: 'unavailable'`; fail-open so older servers and custom providers stay selectable. */
export const isProviderHardwareCompatible = (provider) =>
  isHardwareCompatible(provider?.hardwareCompatibility);

/**
 * The providers a picker may offer: enabled, hardware-runnable and policy-allowed,
 * plus the currently-selected id whatever its state so a saved pin still renders.
 * The single rule `ProviderModelSelector` renders from; a list of "eligible"
 * providers beside such a picker must derive from here so they cannot disagree.
 */
export const selectableProviders = (providers, { selectedId = '', allowed = null } = {}) =>
  (Array.isArray(providers) ? providers : []).filter((provider) => (
    provider?.id === selectedId
    || (!(provider?.executionSourceProviderId || provider?.executionSelectionRoot) && provider?.enabled !== false && isProviderHardwareCompatible(provider) && (!allowed || allowed(provider)))
  ));

export const isProviderModelHardwareCompatible = (provider, model) =>
  isProviderHardwareCompatible(provider)
  && isHardwareCompatible(provider?.modelHardwareCompatibility?.[model]);

export const filterHardwareCompatibleProviderModels = (models, provider) =>
  (models || []).filter((model) => {
    const modelId = typeof model === 'string' ? model : model?.id;
    return isProviderModelHardwareCompatible(provider, modelId);
  });

/**
 * The allowed execution modes for a caller policy name (or the array itself),
 * read off `CALLER_MODE_POLICIES` (`server/lib/callerModePolicy.js`) so the picker
 * can't offer a mode the server refuses. An unknown name yields `[]` (permits
 * nothing) where the server's `allowedModesFor` throws. The server stays the
 * authority; this lets a picker SHOW the rule, keeping an ineligible saved value
 * visible-but-disabled with a reason.
 */
export const callerModeList = (policy) =>
  (Array.isArray(policy) ? policy : CALLER_MODE_POLICIES[policy]?.allowedModes) || [];

/**
 * A `selectionPolicy` restricting the provider select to one caller's allowed
 * modes. An unknown policy name permits nothing (the server's fail-closed
 * direction), so a typo shows a blocked picker, not a permissive one.
 */
export const providerModeSelectionPolicy = (policy) => {
  const allowed = callerModeList(policy);
  return {
    provider: (provider) => allowed.includes(provider?.type),
    // Exposed so the preset-first selector restricts "Custom combination…" compose
    // to the same modes, or the user could build a route the server refuses.
    modes: allowed,
  };
};

/**
 * The value of the "Custom combination…" option in the preset-first
 * `ProviderModelSelector`. Outside BOTH provider reference grammars (`_` is not in
 * the preset alphabet; no `.`/`@`), so it can't collide with a stored id and fails
 * `providerRefSchema` loudly if persisted.
 */
export const COMPOSE_OPTION_VALUE = '__compose__';
