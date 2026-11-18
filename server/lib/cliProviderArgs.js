/**
 * Per-CLI argv conventions (`buildCliArgs`) for stdin prompt delivery — dependency-light extraction
 * from runner.js so out-of-process callers (autofixer) can import it.
 */

import { resolveCliModel, stripBrokenModelFlags } from './provider/providerModels.js';
// Must stay dependency-light: importable from the standalone autofixer process.
import { buildVendorCliArgs, prepareCliPrompt, toolFreeOneShotArgs } from './provider/providerVendors.js';

/**
 * Build CLI args by provider type. `provider.defaultModel` and `provider.effort`
 * are per-run overrides; model flags are injected only when `provider.args` has
 * no model flag already, so a hard-coded user pin is kept. `toolFree`: see
 * `toolFreeOneShotArgs` in providerVendors.js.
 */
export function buildCliArgs(provider, { toolFree = false } = {}) {
  const effort = provider?.effort || null;
  // Drop dangling `--model` / `-m` tokens, or the injected flag would duplicate them and the CLI rejects the argv.
  const baseArgs = stripBrokenModelFlags(Array.isArray(provider?.args) ? provider.args : []);
  // Configured-default sentinels resolve to null: the CLI uses its own default model.
  const effectiveDefaultModel = resolveCliModel(provider.defaultModel);
  const args = buildVendorCliArgs(provider, baseArgs, { model: effectiveDefaultModel, effort, toolFree });
  // Applied to the BUILT argv because several vendor builders append their bypass themselves.
  return toolFree ? toolFreeOneShotArgs(provider, args).args : args;
}

/**
 * Spawn-time prompt delivery dispatcher: honor the returned `useStdin` (write the prompt to stdin
 * only when true) and call `cleanup()` after the run. Defined in providerVendors.js; re-exported
 * for existing importers.
 *
 * @param {string} command - provider.command (e.g. agy, claude, grok)
 * @param {string[]} args - argv as built by buildCliArgs
 * @param {string} prompt - the full prompt text
 * @returns {{ args: string[], useStdin: boolean, cleanup: () => void }}
 */
export { prepareCliPrompt };

// Lives in providerModels.js to avoid an import cycle with the antigravity arg builders.
export { stripBrokenModelFlags };
