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
  isClaudeCommand,
  hasModelFlag,
  resolveInjectedTuiModel,
  resolveClaudeCliModel,
  buildCodexStartupArgs,
  buildCodexAgentThreadArgs,
  buildEffortArgs,
  isOpencodeCommand,
  prefixOpencodeModel,
  applyLeanClaudeArgs,
} from './providerModels.js';
import {
  isCodexCommand,
  ensureCodexTuiArgs,
  CODEX_COMMAND,
  CODEX_CLI_ID,
} from './codex.js';
import {
  ANTIGRAVITY_COMMAND,
  isAntigravityCommand,
  isAntigravityCliProvider,
  ensureAntigravityTuiArgs,
  ensureAntigravityPrintArgs,
  prepareAntigravityPrompt,
  resolveAntigravityModelAndEffort,
} from './antigravity.js';
import {
  isGrokCommand,
  ensureGrokTuiArgs,
  ensureGrokHeadlessArgs,
  prepareGrokPromptFile,
} from './grok.js';
import { isKimiCommand, ensureKimiTuiArgs, ensureKimiHeadlessArgs, prepareKimiPrompt } from './kimi.js';
import {
  CURSOR_COMMAND,
  isCursorCommand,
  ensureCursorTuiArgs,
  ensureCursorHeadlessArgs,
} from './cursor.js';
import {
  isPublicReviewNoToolProfile,
  publicReviewPostureForProfile,
  PUBLIC_REVIEW_EXECUTION_PROFILE,
  PUBLIC_REVIEW_GATE_EXECUTION_PROFILE,
  PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE,
  PUBLIC_REVIEW_NO_TOOL_POSTURE,
  PUBLIC_REVIEW_ACTIONS_POSTURE,
  PUBLIC_REVIEW_POSTURES,
} from './agentExecutionProfiles.js';

export {
  isPublicReviewNoToolProfile,
  publicReviewPostureForProfile,
  PUBLIC_REVIEW_EXECUTION_PROFILE,
  PUBLIC_REVIEW_GATE_EXECUTION_PROFILE,
  PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE,
  PUBLIC_REVIEW_NO_TOOL_POSTURE,
  PUBLIC_REVIEW_ACTIONS_POSTURE,
  PUBLIC_REVIEW_POSTURES,
} from './agentExecutionProfiles.js';

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
  args.push(...buildEffortArgs(effort, provider, args, model));
  args.push('-'); // stdin marker
  return args;
}

function codexSpawnArgs(provider, { effectiveModel, effort, maxConcurrentThreads }) {
  // Injected UNCONDITIONALLY: this arm builds codex's argv from scratch and
  // never forwards provider.args, so there's no pin to detect here (see the
  // long-form comment history on this in agentCliSpawning.js before #3618).
  const args = [
    'exec',
    '--dangerously-bypass-approvals-and-sandbox',
    ...buildCodexStartupArgs(),
    ...buildCodexAgentThreadArgs(maxConcurrentThreads),
  ];
  if (effectiveModel) {
    args.push('--model', effectiveModel);
  }
  args.push(...buildEffortArgs(effort, provider, args, effectiveModel));
  return { command: provider?.command || CODEX_COMMAND, args, stdinMode: 'prompt' };
}

// Codex's own sandbox modes are the enforcement here, not the prompt. Both
// public-review recipes build argv from scratch and never forward
// `provider.args`: a saved `--dangerously-bypass-approvals-and-sandbox` in a
// user's provider config would otherwise turn a screened review into an
// unrestricted session.
function codexPublicReviewSpawnArgs(provider, { effectiveModel, effort, maxConcurrentThreads }) {
  return codexPublicReviewArgs(provider, { effectiveModel, effort, maxConcurrentThreads }, ['--sandbox', 'read-only']);
}

function codexPublicReviewActionsSpawnArgs(provider, { effectiveModel, effort, maxConcurrentThreads }) {
  // `workspace-write` is intentionally the narrowest Codex sandbox that can
  // apply a supplied patch and run local tests; `--approve-for-me` only
  // suppresses interactive confirmations inside that sandbox. Never replace
  // these with the unrestricted bypass used by the ordinary coding-agent path.
  return codexPublicReviewArgs(provider, { effectiveModel, effort, maxConcurrentThreads }, [
    '--sandbox', 'workspace-write',
    '--approve-for-me',
  ]);
}

function codexPublicReviewArgs(provider, { effectiveModel, effort, maxConcurrentThreads }, postureArgs) {
  const args = [
    'exec',
    ...postureArgs,
    '--ephemeral',
    '--ignore-user-config',
    ...buildCodexStartupArgs(),
    ...buildCodexAgentThreadArgs(maxConcurrentThreads),
  ];
  if (effectiveModel) {
    args.push('--model', effectiveModel);
  }
  args.push(...buildEffortArgs(effort, provider, args, effectiveModel));
  return { command: provider?.command || CODEX_COMMAND, args, stdinMode: 'prompt' };
}

// Antigravity's `--sandbox` is its maintained terminal-restriction posture and
// `--mode` picks what the session may do inside it: `plan` cannot edit at all,
// `accept-edits` may apply the screened patch and run tests. Provider args are
// intentionally not copied: saved args could turn a safe profile back into an
// unrestricted session. `--print` carries the prompt as its VALUE (see
// antigravity.js) — `prepareAntigravityPrompt` relocates it to the end of the
// argv at spawn time, which is why it is safe to append flags after it here.
function antigravityPublicReviewSpawnArgs(provider, ctx) {
  return antigravityPublicReviewArgs(provider, ctx, 'plan');
}

function antigravityPublicReviewActionsSpawnArgs(provider, ctx) {
  return antigravityPublicReviewArgs(provider, ctx, 'accept-edits');
}

function antigravityPublicReviewArgs(provider, { effectiveModel, effort } = {}, mode) {
  const args = [
    '--sandbox',
    '--mode', mode,
    '--disable-slash-commands',
    '--print',
  ];
  if (effectiveModel) args.push('--model', effectiveModel);
  args.push(...buildEffortArgs(effort, provider, args, effectiveModel));
  return { command: provider?.command || ANTIGRAVITY_COMMAND, args, stdinMode: 'prompt' };
}

// Grok exposes both halves of the contract as first-class flags:
// `--permission-mode plan` is its read-only mode, `--tools ''` empties the
// built-in tool allowlist, and `--sandbox <profile>` applies its own
// filesystem/network sandbox (`workspace` is grok's built-in profile). The
// safety flags are seeded as the BASE args so `ensureGrokHeadlessArgs` sees a
// permission posture already pinned and does not append its usual
// `--permission-mode bypassPermissions`.
function grokPublicReviewSpawnArgs(provider, ctx) {
  return grokPublicReviewArgs(provider, ctx, ['--permission-mode', 'plan', '--tools', '']);
}

function grokPublicReviewActionsSpawnArgs(provider, ctx) {
  return grokPublicReviewArgs(provider, ctx, ['--sandbox', 'workspace', '--permission-mode', 'acceptEdits']);
}

function grokPublicReviewArgs(provider, { effectiveModel, effort } = {}, postureArgs) {
  const args = ensureGrokHeadlessArgs([
    ...postureArgs,
    '--no-subagents',
    '--disable-web-search',
  ], effectiveModel);
  args.push(...buildEffortArgs(effort, provider, args, effectiveModel));
  // `ensureGrokHeadlessArgs` appends the GROK_STDIN_PROMPT_PATH prompt-file
  // sentinel that `prepareGrokPromptFile` rewrites on Windows; keep it present.
  return { command: provider?.command || 'grok', args, stdinMode: 'prompt' };
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
  publicReview: {
    // The CLI id and the TUI id share one binary, so both reach the same
    // enforced recipe when a stage selects them.
    [PUBLIC_REVIEW_NO_TOOL_POSTURE]: {
      spawnArgs: codexPublicReviewSpawnArgs,
      matchProvider: (provider) => isCodexCommand(provider?.command) || provider?.id === CODEX_CLI_ID || provider?.id === 'codex-tui',
    },
    [PUBLIC_REVIEW_ACTIONS_POSTURE]: {
      spawnArgs: codexPublicReviewActionsSpawnArgs,
      matchProvider: (provider) => provider?.type === 'cli' && isCodexCommand(provider?.command),
    },
  },
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
  publicReview: {
    [PUBLIC_REVIEW_NO_TOOL_POSTURE]: {
      spawnArgs: antigravityPublicReviewSpawnArgs,
      matchProvider: (provider) => provider?.type === 'cli' && isAntigravityCommand(provider?.command),
    },
    [PUBLIC_REVIEW_ACTIONS_POSTURE]: {
      spawnArgs: antigravityPublicReviewActionsSpawnArgs,
      matchProvider: (provider) => provider?.type === 'cli' && isAntigravityCommand(provider?.command),
    },
  },
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
  publicReview: {
    [PUBLIC_REVIEW_NO_TOOL_POSTURE]: {
      spawnArgs: grokPublicReviewSpawnArgs,
      matchProvider: (provider) => provider?.type === 'cli' && isGrokCommand(provider?.command),
    },
    [PUBLIC_REVIEW_ACTIONS_POSTURE]: {
      spawnArgs: grokPublicReviewActionsSpawnArgs,
      matchProvider: (provider) => provider?.type === 'cli' && isGrokCommand(provider?.command),
    },
  },
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
    const resolvedModel = resolveClaudeCliModel(model, {
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
    const injectedModel = resolveClaudeCliModel(effectiveModel, {
      env: { ...process.env, ...settingsEnv, ...provider?.envVars },
      providerId,
    });
    args.push('--model', injectedModel);
  }
  const command = provider?.command || process.env.CLAUDE_PATH || 'claude';
  args.push(...buildEffortArgs(effort, { id: providerId, command }, args));
  return { command, args, stdinMode: 'prompt', streamFormat: 'stream-json' };
}

const CLAUDE_PUBLIC_REVIEW_ARGS = [
  '--permission-mode', 'plan',
  // The code-review model gets the cleared PR material in its prompt. Keep
  // both controls: `--restricted` removes the command/network-capable built-in
  // tools, while the explicit empty set prevents Claude Code from advertising
  // any tool schema to a local model that does not support tool calls.
  '--restricted',
  '--tools', '',
  '--strict-mcp-config',
  '--mcp-config', '{"mcpServers":{}}',
  '--no-chrome',
  '--no-session-persistence',
  '--disable-slash-commands',
  '--bare',
];

function claudePublicReviewArgs(provider, {
  effectiveModel,
  effort,
  systemPromptFile,
  settingsEnv,
  tui = false,
} = {}) {
  const providerId = provider?.id || 'claude-code';
  const args = [
    ...CLAUDE_PUBLIC_REVIEW_ARGS,
    ...(tui ? [] : ['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']),
  ];
  if (systemPromptFile) args.push('--append-system-prompt-file', systemPromptFile);
  if (effectiveModel) {
    // Pass the stage's model id through VERBATIM. Do not consult the host's
    // Bedrock settings or ambient environment while constructing it: this
    // profile is reachable from an Ollama-backed Claude wrapper, and a server
    // started in Bedrock mode must not turn a local model into a cloud one.
    args.push('--model', effectiveModel);
  }
  const safeArgs = applyLeanClaudeArgs(provider, args, provider?.command || 'claude');
  safeArgs.push(...buildEffortArgs(effort, { id: providerId, command: provider?.command || 'claude' }, safeArgs));
  return {
    command: provider?.command || 'claude',
    args: safeArgs,
    stdinMode: 'prompt',
    streamFormat: 'stream-json',
  };
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
  publicReview: {
    // Claude is the historical always-true fallback row, so its posture
    // matcher must positively identify the binary — an unknown command must
    // never inherit claude's flag set. There is deliberately no
    // sandboxed-actions recipe: Claude Code has no OS-level sandbox flag, only
    // permission modes, so it fails closed for the actions stage.
    [PUBLIC_REVIEW_NO_TOOL_POSTURE]: {
      spawnArgs: claudePublicReviewArgs,
      matchProvider: (provider) => provider?.type === 'cli' && isClaudeCommand(provider?.command),
    },
  },
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
 * The vendor recipe enforcing `posture` for `provider`, or null when this
 * install has no maintained recipe for that pairing.
 *
 * Eligibility is DECLARED by the vendor row, never named by the caller: a
 * pipeline stage asks for a posture and every enabled provider whose vendor
 * declares it is a legal choice. That is what lets an install with only grok
 * (or only a local Claude wrapper) configure the same stages an install with
 * codex configures. A row's matcher must positively identify the binary —
 * claude's `matchCommand` is unconditionally true (it is the historical
 * fallback row), so an unknown command must never inherit its argv.
 */
export function publicReviewRecipe(provider, posture) {
  if (!PUBLIC_REVIEW_POSTURES.includes(posture)) return null;
  for (const vendor of PROVIDER_VENDORS) {
    const recipe = vendor.publicReview?.[posture];
    if (recipe?.spawnArgs && recipe.matchProvider(provider)) return recipe;
  }
  return null;
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
export function applyCommandDefaults(command, args, { safetyProfile = null } = {}) {
  if (publicReviewPostureForProfile(safetyProfile) === PUBLIC_REVIEW_ACTIONS_POSTURE) {
    throw new Error('The public-review-actions profile requires a supported direct CLI sandbox');
  }
  const vendor = PROVIDER_VENDORS.find((v) => (
    (isPublicReviewNoToolProfile(safetyProfile) ? v.publicReviewTuiArgs : v.tuiArgs)
      && v.matchCommand(command)
  ));
  if (isPublicReviewNoToolProfile(safetyProfile)) {
    if (!vendor || typeof vendor.publicReviewTuiArgs !== 'function') {
      throw new Error(`Provider command '${command}' has no enforced public-review posture`);
    }
    return vendor.publicReviewTuiArgs(args, { safetyProfile });
  }
  if (!vendor) return args;
  return vendor.tuiArgs(args);
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

/** How a provider names itself in an error a user has to act on. */
function providerLabel(provider) {
  return provider?.id || provider?.command || 'unknown';
}

/**
 * `buildCliSpawnConfig` (agentCliSpawning.js): full `{ command, args,
 * stdinMode, streamFormat? }` shape per vendor. Requires `spawnArgs` to be
 * defined on the matched row — `gemini-legacy` deliberately has none, so a
 * gemini-cli provider here falls through to `claude`'s row, exactly as it did
 * before this registry existed (see file header).
 */
export function buildVendorSpawnConfig(provider, ctx) {
  const posture = publicReviewPostureForProfile(ctx?.safetyProfile);
  if (posture) {
    const recipe = publicReviewRecipe(provider, posture);
    if (!recipe) {
      throw new Error(`Provider '${providerLabel(provider)}' has no enforced ${posture} public-review posture`);
    }
    return recipe.spawnArgs(provider, ctx);
  }
  const vendor = PROVIDER_VENDORS.find((v) => v.spawnArgs && matchesProvider(v, provider));
  return vendor.spawnArgs(provider, ctx);
}

/**
 * Every public-review posture this provider can actually be configured for,
 * in `PUBLIC_REVIEW_POSTURES` order. This is the value the schedule UI reads to
 * offer a stage's eligible providers, so it must stay derived from the vendor
 * rows rather than from a hardcoded list of vendor names.
 *
 * Interactive (TUI) sessions and API/custom providers have no maintained
 * recipe: a generic read-only prompt is not enforcement, so they fail closed.
 */
export function publicReviewPosturesForProvider(provider, { tui = false } = {}) {
  if (tui || provider?.type !== 'cli') return [];
  return PUBLIC_REVIEW_POSTURES.filter((posture) => Boolean(publicReviewRecipe(provider, posture)));
}

/**
 * Vendor ids that declare a maintained recipe for `posture`, for naming what a
 * user could install when nothing on their machine qualifies. Derived from the
 * rows so the suggestion cannot go stale when a vendor gains or loses a recipe.
 */
export function publicReviewCapableVendorIds(posture) {
  return PROVIDER_VENDORS.filter((vendor) => vendor.publicReview?.[posture]?.spawnArgs).map((vendor) => vendor.id);
}

/** Whether `provider` has a maintained, enforced recipe for one posture. */
export function supportsPublicReviewPosture(provider, posture, { tui = false } = {}) {
  if (tui || provider?.type !== 'cli') return false;
  return Boolean(publicReviewRecipe(provider, posture));
}

/**
 * The spawn-time gate for a public-content stage, as a block or `null`.
 *
 * Takes the POSTURE (what the stage requires), not a boolean, because the
 * caller's posture is `null` for every ordinary task — and `null` has no
 * recipe, so asking `supportsPublicReviewPosture` about it answers "false"
 * for work that was never public-content at all. Deciding here keeps the
 * "no posture requested" case explicit instead of a caller-side `&&` that a
 * refactor can drop (it was, in #5830: every ordinary agent task blocked with
 * "has no enforced null public-content review mode").
 *
 * @returns {{ reason: string, category: string }|null}
 */
export function publicReviewProviderBlock(provider, posture, { tui = false } = {}) {
  if (!posture) return null;
  if (supportsPublicReviewPosture(provider, posture, { tui })) return null;
  return {
    reason: `Provider '${providerLabel(provider)}' has no enforced ${posture} public-content review mode`,
    category: posture === PUBLIC_REVIEW_ACTIONS_POSTURE
      ? 'public-review-actions-provider-unsupported'
      : 'public-review-provider-unsupported',
  };
}

/** Whether a provider can run a tool-free public-content stage. */
export function supportsPublicReviewProvider(provider, options) {
  return supportsPublicReviewPosture(provider, PUBLIC_REVIEW_NO_TOOL_POSTURE, options);
}

/** Whether a provider can run the sandboxed final public-review stage. */
export function supportsPublicReviewActionsProvider(provider, options) {
  return supportsPublicReviewPosture(provider, PUBLIC_REVIEW_ACTIONS_POSTURE, options);
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
  return [...withModel, ...buildEffortArgs(
    effort,
    { id: provider?.id, command },
    withModel,
    effectiveModel,
  )];
}

// Every command a shipped vendor row resolves to, PLUS legacy/custom commands
// with no corresponding PROVIDER_VENDORS row (no vendor file, no dispatch
// special-casing — just historically allowlisted). allowedCommands.js derives
// its Set from this so a new vendor row automatically becomes spawnable
// without a second hand-maintained list.
export const EXTRA_ALLOWED_COMMANDS = ['aider', 'copilot'];
