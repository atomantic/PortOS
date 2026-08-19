/**
 * `PROVIDER_VENDORS` — one row per coding-agent CLI/TUI vendor, consumed by
 * every dispatch point that used to open-code its own vendor if-chain (#3618).
 *
 * Before this file, adding a vendor meant touching ~8 branches across 5 files,
 * and two of them (the TUI model-injection sites) had already drifted apart
 * before being collapsed into `resolveInjectedTuiModel` — see the doc comment
 * on that function in `providerModels.js` for the incident. This registry
 * doesn't rewrite any vendor's actual argv-building logic (that stays in
 * antigravity.js / grok.js / kimi.js / cursor.js / codex.js, each already
 * dependency-light and already the "one file per vendor" precedent) — it just
 * gives every dispatch site ONE table to walk instead of a hand-duplicated
 * if-chain, so a new vendor is one row instead of N call sites.
 *
 * Each row is intentionally sparse: a vendor only defines the fields the sites
 * that need special-casing for it require. A field left `undefined` means
 * "this vendor has no special case here — fall through to the generic/default
 * behavior", exactly matching what the original if-chains did for e.g. claude
 * and opencode in `applyCommandDefaults` (both fell through unchanged).
 *
 * Two per-vendor "identity" checks exist because the original dispatch sites
 * gated on different things:
 *   - `matchCommand(command)` — basename-based (`isXCommand`), used by
 *     `applyCommandDefaults` / `prepareCliPrompt` (tuiHandshake.js /
 *     cliProviderArgs.js) and by `inferTuiCommand`'s id-substring walk.
 *   - `matchCliProvider(provider)` — provider-level, used by `buildCliArgs` /
 *     `buildCliSpawnConfig`. Most vendors match by command alone, which is
 *     identical to `matchCommand(provider?.command)` — those rows OMIT
 *     `matchCliProvider` and `matchesProvider()` falls back to `matchCommand`
 *     for them. Only codex and the legacy gemini-cli row (match by
 *     `provider.id` alone — their command is inferred, never configured) and
 *     antigravity (matches by id OR command, `isAntigravityCliProvider`)
 *     define their own `matchCliProvider`.
 *
 * `claude` MUST stay the LAST row: its `matchCommand`/`matchCliProvider` both
 * return true unconditionally (it's the historical default), so every
 * `.find()` below would short-circuit on it if it came first.
 *
 * The legacy `gemini-cli` row is a deliberately incomplete vendor: no live
 * provider in `data.reference/providers.json` uses it (Gemini CLI was
 * migrated to Antigravity — see `antigravity.js`'s `LEGACY_GEMINI_CLI_ID`),
 * but old stored configs may still carry it, so `buildCliArgs` and
 * `inferTuiCommand` still recognize it. It intentionally has no `tuiArgs`,
 * `preparePrompt`, or `spawnArgs` — matching every one of those dispatch
 * sites' pre-existing (lack of) gemini-cli handling exactly, including
 * `buildCliSpawnConfig`'s asymmetry (it has never had a gemini-cli arm, so a
 * gemini-cli provider silently falls through to the claude row there, exactly
 * as it did before this file existed).
 *
 * Dependency-light on purpose (mirrors cliProviderArgs.js / grok.js / kimi.js /
 * cursor.js / codex.js): imports only the vendor files above, providerModels.js,
 * and node builtins, so it stays importable from the standalone autofixer
 * process (which pulls in cliProviderArgs.js and must NOT drag in the AI
 * toolkit / data layer).
 */

import {
  resolveCliModel,
  resolveCliEffort,
  foldCursorEffortIntoModel,
  isCursorProvider,
  hasModelFlag,
  resolveInjectedTuiModel,
  resolveBedrockCliModel,
  buildCodexStartupArgs,
  buildEffortArgs,
  isOpencodeCommand,
  prefixOpencodeModel,
  applyLeanClaudeArgs,
} from './providerModels.js';
import { isCodexCommand, ensureCodexTuiArgs, CODEX_COMMAND, CODEX_CLI_ID } from './codex.js';
import {
  ANTIGRAVITY_COMMAND,
  isAntigravityCommand,
  isAntigravityCliProvider,
  ensureAntigravityTuiArgs,
  ensureAntigravityPrintArgs,
  prepareAntigravityPrompt,
  resolveAntigravityModelAndEffort,
} from './antigravity.js';
import { isGrokCommand, ensureGrokTuiArgs, ensureGrokHeadlessArgs, prepareGrokPromptFile } from './grok.js';
import { isKimiCommand, ensureKimiTuiArgs, ensureKimiHeadlessArgs, prepareKimiPrompt } from './kimi.js';
import { CURSOR_COMMAND, isCursorCommand, ensureCursorTuiArgs, ensureCursorHeadlessArgs } from './cursor.js';

/**
 * For every vendor EXCEPT codex/claude, `buildCliSpawnConfig`'s argv is just
 * `cliArgs` called against `provider.args` (instead of a pre-sanitized
 * `baseArgs`) plus a static `stdinMode`/fallback `command` — there's no
 * independent per-vendor spawn convention to preserve. Codex (never forwards
 * `provider.args`) and claude (an entirely different flag set + streamFormat)
 * keep their own dedicated `spawnArgs`.
 */
function defaultSpawnArgs(cliArgsFn, fallbackCommand) {
  return (provider, { effectiveModel, effort }) => ({
    command: provider?.command || fallbackCommand,
    args: cliArgsFn(provider?.args || [], { model: effectiveModel, effort, provider }),
    stdinMode: 'prompt',
  });
}

// ─── codex ──────────────────────────────────────────────────────────────────

function codexCliArgs(baseArgs, { model, effort, provider }) {
  // Detect an existing leading `exec` in user/legacy args so we don't end up
  // running `codex exec --full-auto exec -` after migration of legacy
  // configs that already pinned an `exec` subcommand.
  const hasExec = baseArgs.includes('exec');
  const args = hasExec ? [...baseArgs] : [...baseArgs, 'exec'];
  args.push(...buildCodexStartupArgs(baseArgs));
  if (model) {
    args.push('--model', model);
  }
  args.push(...buildEffortArgs(effort, provider, args));
  args.push('-'); // stdin marker
  return args;
}

function codexSpawnArgs(provider, { effectiveModel, effort }) {
  // Injected UNCONDITIONALLY: this arm builds codex's argv from scratch and
  // never forwards provider.args, so there's no pin to detect here (see the
  // long-form comment history on this in agentCliSpawning.js before #3618).
  const args = ['exec', '--dangerously-bypass-approvals-and-sandbox', ...buildCodexStartupArgs()];
  if (effectiveModel) {
    args.push('--model', effectiveModel);
  }
  args.push(...buildEffortArgs(effort, provider, args));
  return { command: provider?.command || CODEX_COMMAND, args, stdinMode: 'prompt' };
}

const CODEX = {
  id: 'codex',
  idFragment: 'codex',
  inferredCommand: CODEX_COMMAND,
  matchCommand: isCodexCommand,
  matchCliProvider: (provider) => provider?.id === CODEX_CLI_ID,
  tuiArgs: ensureCodexTuiArgs,
  cliArgs: codexCliArgs,
  spawnArgs: codexSpawnArgs,
};

// ─── antigravity ────────────────────────────────────────────────────────────

function antigravityCliArgs(baseArgs, { model, effort, provider }) {
  return ensureAntigravityPrintArgs(baseArgs, { model, effort, models: provider?.models });
}

const ANTIGRAVITY = {
  id: 'antigravity',
  idFragment: 'antigravity',
  inferredCommand: ANTIGRAVITY_COMMAND,
  matchCommand: isAntigravityCommand,
  // Antigravity is the one non-codex/gemini vendor matched by id OR command
  // (isAntigravityCliProvider), not command alone — keep its own row.
  matchCliProvider: isAntigravityCliProvider,
  tuiArgs: ensureAntigravityTuiArgs,
  cliArgs: antigravityCliArgs,
  preparePrompt: prepareAntigravityPrompt,
  spawnArgs: defaultSpawnArgs(antigravityCliArgs, ANTIGRAVITY_COMMAND),
};

// ─── opencode ───────────────────────────────────────────────────────────────

function opencodeCliArgs(baseArgs, { model, provider }) {
  const args = baseArgs.includes('run') ? [...baseArgs] : ['run', ...baseArgs];
  const resolvedModel = prefixOpencodeModel(provider, model);
  if (resolvedModel && !hasModelFlag(baseArgs)) {
    args.push('-m', resolvedModel);
  }
  return args;
}

const OPENCODE = {
  id: 'opencode',
  idFragment: 'opencode',
  inferredCommand: 'opencode',
  matchCommand: isOpencodeCommand,
  // No dedicated matchCliProvider — matches by command, same as matchCommand
  // (buildVendorCliArgs/buildVendorSpawnConfig fall back to matchCommand when
  // matchCliProvider is absent).
  cliArgs: opencodeCliArgs,
  spawnArgs: defaultSpawnArgs(opencodeCliArgs, 'opencode'),
};

// ─── grok ───────────────────────────────────────────────────────────────────

function grokCliArgs(baseArgs, { model }) {
  return ensureGrokHeadlessArgs(baseArgs, model);
}

const GROK = {
  id: 'grok',
  idFragment: 'grok',
  inferredCommand: 'grok',
  matchCommand: isGrokCommand,
  // No dedicated matchCliProvider — matches by command, same as matchCommand.
  tuiArgs: ensureGrokTuiArgs,
  cliArgs: grokCliArgs,
  spawnArgs: defaultSpawnArgs(grokCliArgs, 'grok'),
};

// ─── kimi ───────────────────────────────────────────────────────────────────

function kimiCliArgs(baseArgs, { model }) {
  return ensureKimiHeadlessArgs(baseArgs, model);
}

const KIMI = {
  id: 'kimi',
  idFragment: 'kimi',
  inferredCommand: 'kimi',
  matchCommand: isKimiCommand,
  // No dedicated matchCliProvider — matches by command, same as matchCommand.
  tuiArgs: ensureKimiTuiArgs,
  cliArgs: kimiCliArgs,
  preparePrompt: prepareKimiPrompt,
  spawnArgs: defaultSpawnArgs(kimiCliArgs, 'kimi'),
};

// ─── cursor ─────────────────────────────────────────────────────────────────

function cursorCliArgs(baseArgs, { model, effort }) {
  // cursor-agent has no `--effort` flag (it exits non-zero on one), so the level
  // is folded into the model id instead — resolved through cursor's ladder first
  // so an out-of-range value clamps the way every other CLI's does. Resolved
  // against the CLI this row IS, not `provider`, so a provider that reaches this
  // row by id alone still gets its level applied.
  return ensureCursorHeadlessArgs(baseArgs, model, resolveCliEffort(effort, { command: CURSOR_COMMAND }));
}

const CURSOR = {
  id: 'cursor',
  idFragment: 'cursor',
  inferredCommand: CURSOR_COMMAND,
  matchCommand: isCursorCommand,
  // No dedicated matchCliProvider — matches by command, same as matchCommand.
  tuiArgs: ensureCursorTuiArgs,
  cliArgs: cursorCliArgs,
  spawnArgs: defaultSpawnArgs(cursorCliArgs, CURSOR_COMMAND),
};

// ─── gemini (legacy — see file header) ─────────────────────────────────────

const GEMINI_LEGACY = {
  id: 'gemini-legacy',
  idFragment: 'gemini',
  inferredCommand: 'gemini',
  matchCommand: (command) => command != null && String(command).toLowerCase().includes('gemini'),
  matchCliProvider: (provider) => provider?.id === 'gemini-cli',
  cliArgs: (baseArgs, { model }) => {
    const args = [...baseArgs];
    if (model && !hasModelFlag(baseArgs)) {
      args.push('-m', model);
    }
    return args;
  },
  // No tuiArgs / preparePrompt / spawnArgs — see file header on why this row
  // is deliberately incomplete.
};

// ─── claude (default fallback — MUST stay last) ────────────────────────────

function claudeCliArgs(baseArgs, { model, effort, provider }) {
  const args = [...baseArgs, '-p', '-'];
  if (model && !hasModelFlag(baseArgs)) {
    const resolvedModel = resolveBedrockCliModel(model, {
      env: { ...process.env, ...provider?.envVars },
      providerId: provider?.id || '',
    });
    args.push('--model', resolvedModel);
  }
  args.push(...buildEffortArgs(effort, provider, args));
  return args;
}

function claudeSpawnArgs(provider, { effectiveModel, effort, systemPromptFile, settingsEnv }) {
  const providerId = provider?.id || 'claude-code';
  const args = applyLeanClaudeArgs(provider, [
    '--dangerously-skip-permissions',
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    ...(provider?.args || []),
  ], provider?.command || 'claude');
  if (systemPromptFile) {
    args.push('--append-system-prompt-file', systemPromptFile);
  }
  if (effectiveModel) {
    const injectedModel = resolveBedrockCliModel(effectiveModel, {
      env: { ...process.env, ...settingsEnv, ...provider?.envVars },
      providerId,
    });
    args.push('--model', injectedModel);
  }
  const command = provider?.command || process.env.CLAUDE_PATH || 'claude';
  args.push(...buildEffortArgs(effort, { id: providerId, command }, args));
  return { command, args, stdinMode: 'prompt', streamFormat: 'stream-json' };
}

const CLAUDE = {
  id: 'claude',
  idFragment: null, // never matched by id.includes() — it's the outside-the-loop default
  inferredCommand: 'claude',
  // The historical default: matches everything (no dedicated matchCliProvider
  // — falls back to this same always-true matchCommand). MUST stay the last
  // row so this doesn't short-circuit every other vendor's lookup.
  matchCommand: () => true,
  cliArgs: claudeCliArgs,
  spawnArgs: claudeSpawnArgs,
};

/**
 * One row per vendor, ordered to double as `inferTuiCommand`'s historical
 * id-substring check order (codex, antigravity, cursor, gemini, kimi, grok,
 * opencode — preserved in case a contrived id ever contained more than one
 * vendor's fragment) with `claude` last. `claude` MUST stay last: its
 * `matchCommand` returns true unconditionally (it's the historical default),
 * so every `.find()` below would short-circuit on it if it came first. Order
 * among the rest doesn't otherwise matter for the command/provider-based
 * dispatchers — every `matchCommand`/`matchCliProvider` pair is mutually
 * exclusive by construction (distinct binary basenames, or a provider-id
 * check that doesn't overlap with a command-basename check).
 */
export const PROVIDER_VENDORS = [CODEX, ANTIGRAVITY, CURSOR, GEMINI_LEGACY, KIMI, GROK, OPENCODE, CLAUDE];

/**
 * A row's `matchCliProvider` may be absent when it's identical to
 * `matchCommand(provider?.command)` (true for every vendor except codex,
 * antigravity, and the legacy gemini-cli row, which match by provider id).
 */
function matchesProvider(vendor, provider) {
  return vendor.matchCliProvider ? vendor.matchCliProvider(provider) : vendor.matchCommand(provider?.command);
}

/**
 * `inferTuiCommand`'s id-substring walk (tuiHandshake.js) checks a DIFFERENT
 * thing than every other dispatch site here — `provider.id` substrings, not
 * `provider.command` basenames — so it can't reuse `matchCommand`/`.find()`.
 * It still sources every returned command string from `PROVIDER_VENDORS`
 * (via `idFragment`/`inferredCommand`) so it can't independently drift; only
 * `claude` has no `idFragment` (it's the true fallback below, not matched by
 * substring).
 */
export function inferTuiCommand(id) {
  if (!id) return CLAUDE.inferredCommand;
  for (const vendor of PROVIDER_VENDORS) {
    if (vendor.idFragment && id.includes(vendor.idFragment)) return vendor.inferredCommand;
  }
  return CLAUDE.inferredCommand;
}

/** `applyCommandDefaults` (tuiHandshake.js): TUI posture-flag dispatch. */
export function applyCommandDefaults(command, args) {
  const vendor = PROVIDER_VENDORS.find((v) => v.tuiArgs && v.matchCommand(command));
  return vendor ? vendor.tuiArgs(args) : args;
}

/**
 * `prepareCliPrompt` (cliProviderArgs.js): spawn-time prompt delivery.
 * `prepareGrokPromptFile` is the universal DEFAULT (not gated on grok, per its
 * own doc comment — it's a no-op for any argv that isn't its own /dev/stdin
 * sentinel, so calling it unconditionally as the fallback is safe and matches
 * the original `prepareCliPrompt` body exactly).
 */
export function prepareCliPrompt(command, args, prompt) {
  const vendor = PROVIDER_VENDORS.find((v) => v.preparePrompt && v.matchCommand(command));
  return vendor ? vendor.preparePrompt(args, prompt) : prepareGrokPromptFile(args, prompt);
}

/** `buildCliArgs` (cliProviderArgs.js): headless one-shot argv per vendor. */
export function buildVendorCliArgs(provider, baseArgs, { model, effort }) {
  const vendor = PROVIDER_VENDORS.find((v) => v.cliArgs && matchesProvider(v, provider));
  return vendor.cliArgs(baseArgs, { model, effort, provider });
}

/**
 * `buildCliSpawnConfig` (agentCliSpawning.js): full `{ command, args,
 * stdinMode, streamFormat? }` shape per vendor. Requires `spawnArgs` to be
 * defined on the matched row — `gemini-legacy` deliberately has none, so a
 * gemini-cli provider here falls through to `claude`'s row, exactly as it did
 * before this registry existed (see file header).
 */
export function buildVendorSpawnConfig(provider, ctx) {
  const vendor = PROVIDER_VENDORS.find((v) => v.spawnArgs && matchesProvider(v, provider));
  return vendor.spawnArgs(provider, ctx);
}

/**
 * Shared TUI model+effort injection — the piece that had ALREADY drifted once
 * before #3618 was filed (an antigravity Bedrock exemption landed in
 * `tuiHandshake.js#buildTuiInvocation` and was missed in
 * `agentTuiSpawning.js#appendModelArgs`). Both call sites now call this one
 * function instead of hand-duplicating the antigravity-vs-everyone-else split.
 *
 * `baseArgs` must already be the POST-`applyCommandDefaults` argv (posture
 * flags applied) — this only handles `--model`/`--effort` injection.
 */
export function injectTuiModelAndEffort(command, baseArgs, provider, model, effort) {
  if (isAntigravityCommand(command)) {
    // agy validates the (model, effort) PAIR — resolved together against the
    // provider's catalog (see antigravity.js).
    const resolved = resolveAntigravityModelAndEffort(baseArgs, { model, effort, models: provider?.models });
    const withModel = resolved.model ? [...baseArgs, '--model', resolved.model] : baseArgs;
    return [...withModel, ...buildEffortArgs(resolved.effort, resolved.provider, withModel, resolved.base)];
  }
  if (isCursorProvider({ id: provider?.id, command })) {
    // Cursor's effort is a model-variant parameter, not a flag — fold it in so
    // the TUI honors a pinned level instead of dropping it (buildEffortArgs
    // emits nothing for cursor by design).
    const cursorModel = foldCursorEffortIntoModel(
      resolveCliModel(model),
      resolveCliEffort(effort, { id: provider?.id, command })
    );
    return (cursorModel && !hasModelFlag(baseArgs)) ? [...baseArgs, '--model', cursorModel] : baseArgs;
  }
  const effectiveModel = resolveCliModel(model);
  const shouldInject = !!effectiveModel && !hasModelFlag(baseArgs);
  // Per-command model rewriting (OpenCode namespacing, Bedrock mapping) lives
  // in resolveInjectedTuiModel, shared across both TUI spawn paths so they
  // can't diverge again.
  const withModel = shouldInject
    ? [...baseArgs, '--model', resolveInjectedTuiModel(effectiveModel, provider, command)]
    : baseArgs;
  return [...withModel, ...buildEffortArgs(effort, { id: provider?.id, command }, withModel)];
}

// Every command a shipped vendor row resolves to, PLUS legacy/custom commands
// with no corresponding PROVIDER_VENDORS row (no vendor file, no dispatch
// special-casing — just historically allowlisted). allowedCommands.js derives
// its Set from this so a new vendor row automatically becomes spawnable
// without a second hand-maintained list.
export const EXTRA_ALLOWED_COMMANDS = ['aider', 'copilot'];
