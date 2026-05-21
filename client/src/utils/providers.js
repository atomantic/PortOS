/**
 * Sentinel value used by the Codex provider to indicate the model is configured
 * via ~/.codex/config.toml rather than PortOS. Filter this out of selectable
 * model lists so the UI shows the explanatory note instead of a token dropdown.
 */
export const CODEX_CONFIGURED_DEFAULT = 'codex-configured-default';

/**
 * Provider-type enum mirrored from server/lib/aiToolkit/constants.js#PROVIDER_TYPES.
 * The aiToolkit directory is kept self-contained (no imports out to other PortOS
 * modules) so the client cannot import the server copy directly — keep these two
 * in lockstep when adding a type. The provider type predicates below and the
 * Tailwind chip helper read from this object, so a string literal only needs to
 * appear once per side.
 */
export const PROVIDER_TYPES = Object.freeze({
  CLI: 'cli',
  TUI: 'tui',
  API: 'api'
});

/**
 * Returns the provider's model list with internal sentinel values removed.
 * Use this anywhere a list of user-selectable models is needed.
 * @param {string[]} models
 * @returns {string[]}
 */
export const filterSelectableModels = (models) =>
  (models || []).filter(m => m !== CODEX_CONFIGURED_DEFAULT);

/**
 * Check if a provider is a TUI-backed agent provider. Mirror of
 * `isTuiProvider` in server/services/agentCliSpawning.js.
 */
export const isTuiProvider = (provider) => provider?.type === PROVIDER_TYPES.TUI;

/**
 * Check if a provider is a one-shot CLI agent provider.
 */
export const isCliProvider = (provider) => provider?.type === PROVIDER_TYPES.CLI;

/**
 * Check if a provider is an HTTP-API provider (e.g. OpenAI, Anthropic, LM Studio),
 * as opposed to a process-backed CLI/TUI agent. Use this anywhere you'd write
 * `provider.type === PROVIDER_TYPES.API` against a saved provider.
 */
export const isApiProvider = (provider) => provider?.type === PROVIDER_TYPES.API;

/**
 * Stable, module-scoped filter for `useProviderModels({ filter })` and other
 * call sites that need "enabled HTTP-API providers only". Hoisted so the
 * identity is the same across renders (callers may pass it as a dependency).
 */
export const enabledApiProviderFilter = (provider) => Boolean(provider?.enabled) && isApiProvider(provider);

/**
 * Check if a provider is process-backed (cli or tui), as opposed to an
 * HTTP-API provider. Use this for "shows a Command + args" config predicates.
 */
export const isProcessProvider = (provider) => isCliProvider(provider) || isTuiProvider(provider);

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
 * Tailwind chip classes for the provider type badge ('cli' / 'tui' / 'api').
 * Lifted out of AIProviders.jsx so other components can render the same
 * color treatment without redefining it.
 */
export const providerTypeClass = (type) => {
  if (type === PROVIDER_TYPES.CLI) return 'bg-blue-500/20 text-blue-400';
  if (type === PROVIDER_TYPES.TUI) return 'bg-emerald-500/20 text-emerald-400';
  return 'bg-purple-500/20 text-purple-400';
};
