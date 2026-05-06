/**
 * Shared sentinel and helpers for provider model resolution.
 * Mirrors the constants in client/src/utils/providers.js — keep in sync.
 */

export const CODEX_CONFIGURED_DEFAULT = 'codex-configured-default';

export const isCodexConfiguredDefault = (model) => model === CODEX_CONFIGURED_DEFAULT;

/**
 * Returns the model string to pass to a CLI's --model flag, or null if the
 * caller should omit --model entirely (Codex sentinel case — the CLI will use
 * whatever model is configured in ~/.codex/config.toml).
 * @param {string|null|undefined} model
 * @returns {string|null}
 */
export const resolveCliModel = (model) => isCodexConfiguredDefault(model) ? null : (model || null);

/**
 * Strip the sentinel from a model list — the user-selectable view.
 * @param {string[]} models
 * @returns {string[]}
 */
export const filterSelectableModels = (models) =>
  (models || []).filter(m => m !== CODEX_CONFIGURED_DEFAULT);
