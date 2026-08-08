/**
 * Per-CLI argv conventions for stdin-based prompt delivery.
 *
 * Extracted from `server/services/runner.js` (which still re-exports
 * `buildCliArgs` for its existing importers) so the conventions live in a
 * dependency-light module: it imports only the pure `providerModels.js`
 * helpers and node builtins. That keeps it importable from contexts that must
 * NOT pull in the AI toolkit / data layer — notably the standalone
 * `portos-autofixer` PM2 process, which runs from its own minimal package and
 * shells the user's configured CLI provider to fix crashed apps.
 *
 * Each CLI reads its prompt from stdin under a different convention:
 *   - Codex:       `codex exec -`        (+ `--model` when not the sentinel)
 *   - Antigravity: `agy --print <prompt>` (argv value, not stdin; + `--model`)
 *   - Gemini CLI:  legacy prompt piped to stdin (+ `-m <model>`)
 *   - Grok Build:  `grok --prompt-file /dev/stdin` (+ `--model <id>`, see grok.js)
 *   - Kimi Code:   `kimi --print --prompt <value>` (argv value, not stdin; see kimi.js)
 *   - Cursor:      `cursor-agent --print --force` (prompt on stdin; see cursor.js)
 *   - Claude Code: `-p -`                (+ `--model <id>`)
 */

import { resolveCliModel, stripBrokenModelFlags } from './providerModels.js';
// buildVendorCliArgs / prepareCliPrompt dispatch through the PROVIDER_VENDORS
// registry (#3618) instead of a hand-rolled per-vendor if-chain — see
// providerVendors.js for the vendor rows and its own dependency-light note
// (this module must stay importable from the standalone autofixer process).
import { buildVendorCliArgs, prepareCliPrompt } from './providerVendors.js';

/**
 * Build CLI args based on provider type. Each CLI provider has different
 * conventions for stdin input and model selection. `provider.defaultModel`
 * is honored for all three (codex / claude-code / gemini-cli) so a per-call
 * clone with an overridden defaultModel actually picks that model instead of
 * falling back to whatever's baked into `provider.args`.
 *
 * Model-flag injection is GATED on `provider.args` not already containing a
 * model flag — users who hard-coded e.g. `--model gemini-2.5-pro` in their
 * saved provider config keep that override and don't get a duplicate flag.
 *
 * `provider.effort` carries a per-run reasoning-effort override the same way
 * `provider.defaultModel` carries the per-run model: callers clone the provider
 * with both pinned (see `promptRunner.js#executeProviderRunOnce`). It becomes
 * `--effort <level>` on claude/agy and `-c model_reasoning_effort=<level>` on
 * codex, and is suppressed when the saved args already bake an effort pin.
 */
export function buildCliArgs(provider) {
  const effort = provider?.effort || null;
  // Sanitize: drop any broken/dangling `--model` / `-m` tokens before
  // appending. hasModelFlag (in providerVendors.js's per-vendor arg builders)
  // treats those as "not a real pin" so the injection path fires — but if we
  // kept the bogus token in baseArgs the CLI would still see two `--model`
  // occurrences and reject the argv.
  const baseArgs = stripBrokenModelFlags(Array.isArray(provider?.args) ? provider.args : []);
  // Configured-default sentinels (Codex / Antigravity / Grok Build) resolve to
  // null so the CLI uses its own latest/default model without a --model flag.
  const effectiveDefaultModel = resolveCliModel(provider.defaultModel);
  return buildVendorCliArgs(provider, baseArgs, { model: effectiveDefaultModel, effort });
}

/**
 * Spawn-time prompt delivery dispatcher. Every CLI spawn site runs the built
 * argv + prompt through this right before spawning, then honors the returned
 * `useStdin` flag (write the prompt to stdin only when true) and calls
 * `cleanup()` after the run. Returns `{ args, useStdin, cleanup }`.
 *
 *   - Antigravity (`agy`): the prompt is spliced in as the VALUE of --print
 *     (agy does NOT read stdin) → `useStdin: false`.
 *   - Kimi (`kimi`): the prompt is spliced in as the VALUE of --prompt
 *     (kimi does NOT read stdin in --print mode) → `useStdin: false`.
 *   - Grok on Windows: the `/dev/stdin` prompt-file is rewritten to a temp file
 *     → `useStdin: false` with a real `cleanup`.
 *   - Every other provider (Claude Code `-p -`, Codex `exec -`, OpenCode `run`,
 *     Cursor `cursor-agent --print`): unchanged, prompt delivered over stdin →
 *     `useStdin: true`.
 *
 * @param {string} command - provider.command (e.g. 'agy', 'claude', 'grok')
 * @param {string[]} args - argv as built by buildCliArgs
 * @param {string} prompt - the full prompt text
 * @returns {{ args: string[], useStdin: boolean, cleanup: () => void }}
 *
 * Defined in providerVendors.js (the PROVIDER_VENDORS registry, #3618);
 * re-exported here for existing importers of this module.
 */
export { prepareCliPrompt };

// Re-exported from providerModels.js (its home, next to `hasModelFlag`, so the
// antigravity arg builders can share it without importing this module and
// creating a cycle). Kept here for the existing importers of this module.
export { stripBrokenModelFlags };
