/**
 * Shared sentinel and helpers for provider model resolution.
 * Mirrors the constants in client/src/utils/providers.js — keep in sync.
 */

export const CODEX_CONFIGURED_DEFAULT = 'codex-configured-default';
export const ANTIGRAVITY_CONFIGURED_DEFAULT = 'antigravity-configured-default';

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
  (models || []).filter(m => m !== CODEX_CONFIGURED_DEFAULT && m !== ANTIGRAVITY_CONFIGURED_DEFAULT);

/**
 * Detects whether the provider's stored argv already pins a model with a
 * usable value. Checks both flag forms (`--model` / `-m`) and both styles
 * (separated `--model x` and joined `--model=x`). A separated flag with no
 * value following (`['--model']` at end of argv, or `['--model', '--other']`)
 * is treated as NOT a baked-in pin — the CLI would reject the argv at
 * runtime anyway, and pretending it's a pin would also make refiners report
 * `null` (from extractBakedModel) and skip injecting our own model.
 *
 * Used to gate runner-injected `--model` flags: when the user has hard-coded
 * a model in args, the runner-injected one is suppressed and the args-baked
 * model wins.
 */
export function hasModelFlag(args) {
  if (!Array.isArray(args)) return false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string') continue;
    if (a.startsWith('--model=') && a.length > '--model='.length) return true;
    if (a.startsWith('-m=') && a.length > '-m='.length) return true;
    if (a === '--model' || a === '-m') {
      const next = args[i + 1];
      if (typeof next === 'string' && next.length > 0 && !next.startsWith('-')) return true;
    }
  }
  return false;
}

/**
 * Extract the pinned model id from provider.args when a model flag is baked
 * in. Supports separated form (`--model X` / `-m X`) and joined form
 * (`--model=X` / `-m=X`). Returns null when no model flag is present or the
 * separated form has no value following the flag.
 */
export function extractBakedModel(args) {
  if (!Array.isArray(args)) return null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string') continue;
    if (a === '--model' || a === '-m') {
      const next = args[i + 1];
      if (typeof next === 'string' && next.length > 0 && !next.startsWith('-')) return next;
      return null;
    }
    if (a.startsWith('--model=')) return a.slice('--model='.length) || null;
    if (a.startsWith('-m=')) return a.slice('-m='.length) || null;
  }
  return null;
}
