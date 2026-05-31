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
 *   - Antigravity: `agy --print` with prompt piped to stdin
 *   - Gemini CLI:  legacy prompt piped to stdin (+ `-m <model>`)
 *   - Claude Code: `-p -`                (+ `--model <id>`)
 */

import { resolveCliModel, hasModelFlag } from './providerModels.js';
import { ensureAntigravityPrintArgs, isAntigravityCliProvider } from './antigravity.js';

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
 */
export function buildCliArgs(provider) {
  const providerId = provider?.id || '';
  // Sanitize: drop any broken/dangling `--model` / `-m` tokens before
  // appending. hasModelFlag treats those as "not a real pin" so the
  // injection path fires — but if we kept the bogus token in baseArgs the
  // CLI would still see two `--model` occurrences and reject the argv.
  const baseArgs = stripBrokenModelFlags(Array.isArray(provider?.args) ? provider.args : []);
  const effectiveDefaultModel = providerId === 'codex'
    ? resolveCliModel(provider.defaultModel)
    : provider.defaultModel;

  // Codex CLI: `codex exec -` reads prompt from stdin, --model for model.
  // Detect an existing leading `exec` in user/legacy args so we don't end up
  // running `codex exec --full-auto exec -` after migration of legacy
  // configs that already pinned an `exec` subcommand.
  if (providerId === 'codex') {
    const hasExec = baseArgs.includes('exec');
    const args = hasExec ? [...baseArgs] : [...baseArgs, 'exec'];
    if (effectiveDefaultModel) {
      args.push('--model', effectiveDefaultModel);
    }
    args.push('-'); // stdin marker
    return args;
  }

  // Antigravity CLI (`agy`) replaces the old Gemini CLI for Google's coding
  // agent. Print mode is the headless one-shot interface; prompt text still
  // travels over stdin so large PortOS prompts do not hit OS argv limits.
  if (isAntigravityCliProvider(provider)) {
    return ensureAntigravityPrintArgs(baseArgs);
  }

  // Gemini CLI: prompt is piped via stdin directly. `-m <model>` is gemini-
  // cli's documented short flag for model selection (long form: `--model`).
  // Skip injection when the user's saved args already pin a model (either
  // form) so we don't duplicate the flag.
  if (providerId === 'gemini-cli') {
    const args = [...baseArgs];
    if (effectiveDefaultModel && !hasModelFlag(baseArgs)) {
      args.push('-m', effectiveDefaultModel);
    }
    return args;
  }

  // Default (Claude Code CLI): `-p -` means "read prompt from stdin".
  // `--model <id>` is claude-code's model flag; it parses flags
  // positionally so appending after `-p -` is fine. Same gate as gemini-
  // cli — respect user-baked model flags.
  const args = [...baseArgs, '-p', '-'];
  if (effectiveDefaultModel && !hasModelFlag(baseArgs)) {
    args.push('--model', effectiveDefaultModel);
  }
  return args;
}

// Strip dangling/empty `--model` / `-m` tokens (no value follows, or the
// joined form has an empty value). Those would survive into the spawned
// argv unchanged and cause the CLI to reject the invocation — see the
// comment on hasModelFlag for the full reasoning. Pinned-with-value tokens
// are preserved untouched so user-baked model selections still win.
export function stripBrokenModelFlags(args) {
  if (!Array.isArray(args) || args.length === 0) return [];
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a === 'string' && (a === '--model=' || a === '-m=')) {
      continue; // empty joined form
    }
    if (a === '--model' || a === '-m') {
      const next = args[i + 1];
      const hasValue = typeof next === 'string' && next.length > 0 && !next.startsWith('-');
      if (!hasValue) continue; // dangling separated form
    }
    out.push(a);
  }
  return out;
}
