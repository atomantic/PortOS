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
 * toolkit / data layer). That is load-bearing, not cosmetic: reaching into
 * opencodeConfig.js for the OpenCode public-review agent name pulled ports.js
 * in behind it and broke a suite that partially mocks it — which is why that
 * constant lives in providerModels.js beside its siblings.
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
  localRuntimeNamespace,
  opencodeProviderIsLocalOnly,
  OPENCODE_PUBLIC_REVIEW_AGENT,
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
import { PROVIDER_TYPES } from './aiToolkit/constants.js';
import {
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

/**
 * A provider record that names a local binary PortOS can spawn. A TUI record of
 * a vendor (`codex-tui`, `grok-tui`, …) is spawned through that vendor's
 * headless public-review recipe exactly like its CLI sibling, so the user's
 * enabled TUI providers are legal stage choices. The one exception is a recipe
 * marked `tui: true` (see `supportsTuiPublicReviewPosture`), which the
 * sandboxed-actions stage may run as an attachable session so an operator can
 * watch and steer it. API/custom providers have no binary and no recipe.
 */
const isDirectBinaryProvider = (provider) => provider?.type === PROVIDER_TYPES.CLI || provider?.type === PROVIDER_TYPES.TUI;

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
      matchProvider: (provider) => isDirectBinaryProvider(provider) && (isCodexCommand(provider?.command) || provider?.id === CODEX_CLI_ID || provider?.id === 'codex-tui'),
    },
    [PUBLIC_REVIEW_ACTIONS_POSTURE]: {
      spawnArgs: codexPublicReviewActionsSpawnArgs,
      matchProvider: (provider) => isDirectBinaryProvider(provider) && isCodexCommand(provider?.command),
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
      matchProvider: (provider) => isDirectBinaryProvider(provider) && isAntigravityCommand(provider?.command),
    },
    [PUBLIC_REVIEW_ACTIONS_POSTURE]: {
      spawnArgs: antigravityPublicReviewActionsSpawnArgs,
      matchProvider: (provider) => isDirectBinaryProvider(provider) && isAntigravityCommand(provider?.command),
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

/**
 * An OpenCode wrapper this install can actually run the tool-free gate on.
 * Three conditions, each closing a different way the stage would otherwise be
 * offered and then fail — or, worse, appear to succeed:
 *
 *   - **an Ollama namespace.** `validatePublicReviewModel` can only probe an
 *     Ollama catalog for the authoritative "no `tools` capability" answer, and
 *     rejects every other local runtime with `public-review-runtime-unsupported`.
 *     Offering MTPLX / llama.cpp / vLLM / SGLang here would put a permanently
 *     blocking choice in the picker. (A hosted gateway is excluded by
 *     `localRuntimeNamespace` before that.)
 *   - **only local endpoints.** The enforcement rides in
 *     `OPENCODE_CONFIG_CONTENT`, which `cliChildEnv.js` keeps through the
 *     public-review env allowlist under the SAME `opencodeConfigIsLocalOnly`
 *     rule. A provider carrying `ollamaBacked` but a relocated off-box
 *     `baseURL` would pass a marker-only check here, then have its hardened
 *     config stripped there — and OpenCode falls back to the user's own
 *     `~/.config/opencode`, tools and MCP servers intact, while the gate still
 *     reports as enforced. Sharing one predicate is what makes that
 *     unrepresentable.
 *   - **a spawnable binary**, as for every other vendor.
 */
const isLocalOpencodeProvider = (provider) => isDirectBinaryProvider(provider)
  && isOpencodeCommand(provider?.command)
  && localRuntimeNamespace(provider) === 'ollama'
  && opencodeProviderIsLocalOnly(provider);

/**
 * OpenCode is the natural harness for a local Ollama model — but unlike every
 * other vendor here it has NO read-only argv flag: its tool posture, permission
 * block and per-model `tool_call` advertisement all live in the config. So this
 * recipe is only half the enforcement; the other half is
 * `hardenOpencodeConfigForNoTool` in `opencodeConfig.js`, which the same
 * `safetyProfile` applies to `OPENCODE_CONFIG_CONTENT`.
 *
 * The argv is the ordinary headless one seeded with the read-only agent (the
 * shape grok's recipe uses), so `run`/`-m` namespacing cannot drift from the
 * normal path. Provider args are deliberately not forwarded: a saved
 * `--agent build` would select the tool-enabled agent. There is no effort flag
 * to add — `opencode run` has none; the level rides
 * `agent.<name>.reasoningEffort` in the config, which the harden step copies
 * onto this agent (see `hardenOpencodeConfigForNoTool`).
 */
function opencodePublicReviewSpawnArgs(provider, { effectiveModel } = {}) {
  return {
    command: provider?.command || 'opencode',
    args: opencodeCliArgs(['--agent', OPENCODE_PUBLIC_REVIEW_AGENT], { model: effectiveModel, provider }),
    stdinMode: 'prompt',
  };
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
  publicReview: {
    [PUBLIC_REVIEW_NO_TOOL_POSTURE]: {
      spawnArgs: opencodePublicReviewSpawnArgs,
      matchProvider: isLocalOpencodeProvider,
    },
    // No `sandboxed-actions` recipe: OpenCode ships no OS sandbox of its own,
    // so it stays in the open-to-every-binary tier where the disposable
    // worktree is the isolation — see `supportsPublicReviewPosture`.
  },
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
      matchProvider: (provider) => isDirectBinaryProvider(provider) && isGrokCommand(provider?.command),
    },
    [PUBLIC_REVIEW_ACTIONS_POSTURE]: {
      spawnArgs: grokPublicReviewActionsSpawnArgs,
      matchProvider: (provider) => isDirectBinaryProvider(provider) && isGrokCommand(provider?.command),
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

// Shared by both Claude postures: no MCP servers, no browser bridge, no
// persisted session, no slash commands. `--bare` is NOT here: it also disables
// OAuth/keychain auth, so it would break a subscription-authenticated cloud
// Claude — `applyLeanClaudeArgs` adds it for the local Ollama wrapper only.
const CLAUDE_PUBLIC_REVIEW_COMMON_ARGS = [
  '--strict-mcp-config',
  '--mcp-config', '{"mcpServers":{}}',
  '--no-chrome',
  '--no-session-persistence',
  '--disable-slash-commands',
];

const CLAUDE_PUBLIC_REVIEW_NO_TOOL_ARGS = [
  '--permission-mode', 'plan',
  // The code-review model gets the cleared PR material in its prompt. Keep
  // both controls: `--restricted` removes the command/network-capable built-in
  // tools, while the explicit empty set prevents Claude Code from advertising
  // any tool schema to a local model that does not support tool calls.
  '--restricted',
  '--tools', '',
  ...CLAUDE_PUBLIC_REVIEW_COMMON_ARGS,
];

// Claude Code's OS-level sandbox (seatbelt on macOS, bubblewrap on Linux) is a
// settings switch rather than a flag; `--settings` accepts inline JSON. Inside
// it, Bash runs without prompting but filesystem writes stay inside the working
// tree and the empty domain allowlist denies every network request — in
// `--print` mode a denied request is simply not executed, there is nobody to
// approve it. The web tools are denied outright for the same reason.
//
// `sandbox.filesystem.allowWrite` (a real, current setting) does NOT reach a
// PR that edits `.claude/skills`, `.claude/agents`, `.claude/commands`,
// `.claude/hooks`, `.claude/workflows`, or `.mcp.json` — Claude Code's docs
// state plainly that these are "protected paths" and "there is no way to
// exempt one of them: an allowWrite entry ... doesn't lift the protection."
// (docs.claude.com/en/docs/claude-code/sandboxing, "Protected paths"). The
// only way to lift it is `sandbox.filesystem.disabled`, which turns off
// filesystem isolation for every path — defeating the point of sandboxing an
// untrusted PR's patch. So the Stage 3 review prompt (`pr-reviewer-review` in
// taskPromptDefaults/prompts.js) is taught the `git apply --cached` +
// index-verification fallback instead (#5963).
const CLAUDE_SANDBOX_SETTINGS = JSON.stringify({
  sandbox: { enabled: true, autoAllowBashIfSandboxed: true, network: { allowedDomains: [] } },
});
const CLAUDE_PUBLIC_REVIEW_ACTIONS_ARGS = [
  '--permission-mode', 'acceptEdits',
  '--settings', CLAUDE_SANDBOX_SETTINGS,
  '--disallowedTools', 'WebFetch,WebSearch',
  ...CLAUDE_PUBLIC_REVIEW_COMMON_ARGS,
];

// Flags Claude Code accepts ONLY alongside `--print`, mapped to whether they
// consume the following argv entry as their value. The posture arrays above are
// written for the headless launch, so an attachable (`tui: true`) recipe has to
// drop them — the CLI refuses to start at all otherwise:
//
//   Error: --no-session-persistence can only be used with --print mode.
//
// That is a 3-second exit(1) before the prompt is ever pasted, and it burned all
// three retries of a Stage 3 pr-reviewer run. Worse, the only thing in the PTY
// transcript by then was the shell's echo of the argv, so the failure analyzer
// classified the run off `--mcp-config '{"mcpServers":{}}'` and filed "MCP server
// error" for what was a flag-compatibility bug (agent-a12b1837).
//
// Filtered rather than conditionally spread so a print-only flag added to ANY
// posture set is dropped for the attachable recipe automatically.
const CLAUDE_PRINT_ONLY_ARGS = new Map([
  ['--no-session-persistence', false],
  ['--output-format', true],
]);

function dropPrintOnlyArgs(args) {
  const kept = [];
  for (let i = 0; i < args.length; i += 1) {
    if (!CLAUDE_PRINT_ONLY_ARGS.has(args[i])) {
      kept.push(args[i]);
      continue;
    }
    if (CLAUDE_PRINT_ONLY_ARGS.get(args[i])) i += 1; // also skip its value
  }
  return kept;
}

const claudePublicReviewSpawnArgsFor = (postureArgs) => (provider, ctx) => claudePublicReviewArgs(postureArgs, provider, ctx);

function claudePublicReviewArgs(postureArgs, provider, {
  effectiveModel,
  effort,
  systemPromptFile,
  tui = false,
} = {}) {
  const providerId = provider?.id || 'claude-code';
  const args = [
    ...(tui ? dropPrintOnlyArgs(postureArgs) : postureArgs),
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

const matchClaudeBinary = (provider) => isDirectBinaryProvider(provider) && isClaudeCommand(provider?.command);

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
    // never inherit claude's flag set.
    [PUBLIC_REVIEW_NO_TOOL_POSTURE]: {
      spawnArgs: claudePublicReviewSpawnArgsFor(CLAUDE_PUBLIC_REVIEW_NO_TOOL_ARGS),
      matchProvider: matchClaudeBinary,
    },
    [PUBLIC_REVIEW_ACTIONS_POSTURE]: {
      spawnArgs: claudePublicReviewSpawnArgsFor(CLAUDE_PUBLIC_REVIEW_ACTIONS_ARGS),
      matchProvider: matchClaudeBinary,
      // The only posture/vendor pairing that may run as an ATTACHABLE session.
      // `claudePublicReviewArgs` drops only the flags that REQUIRE `--print`
      // (the headless output set plus CLAUDE_PRINT_ONLY_ARGS) for
      // `tui: true`; every enforcement flag above (`--permission-mode
      // acceptEdits`, the `--settings` sandbox JSON, `--disallowedTools`, and
      // the shared no-MCP/no-chrome/no-slash-command set) is still emitted, so
      // an operator who drops into the PTY inherits the same boundary the
      // headless run had. Nothing inside the session can widen it: the only
      // lever that lifts Claude Code's filesystem protection is
      // `sandbox.filesystem.disabled`, which this recipe never emits, and
      // `--disable-slash-commands` removes the in-session settings surface.
      tui: true,
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

/**
 * `applyCommandDefaults` (tuiHandshake.js): interactive-session flag dispatch.
 * Public-review stages never reach this — headless OR attachable, their argv
 * comes from `buildVendorSpawnConfig`, which is where a posture is enforced.
 * (That is load-bearing for the attachable case: `ensureAntigravityTuiArgs` and
 * friends append `--dangerously-skip-permissions`-class defaults, which would
 * undo the recipe.)
 */
export function applyCommandDefaults(command, args) {
  const vendor = PROVIDER_VENDORS.find((v) => v.tuiArgs && v.matchCommand(command));
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
    // An interactive spawn has no headless fallback tier: the ordinary
    // `spawnArgs` of a vendor without a TUI-capable recipe emits that vendor's
    // HEADLESS argv (`--print`, `exec`, `run`), which in a PTY neither accepts
    // a pasted prompt nor enforces anything. Fail closed rather than open a
    // session whose posture is decorative. Callers decide TUI-vs-headless from
    // `supportsTuiPublicReviewPosture`, so reaching this is a routing bug.
    if (ctx?.tui) {
      if (!recipe?.tui) {
        throw new Error(`Provider '${providerLabel(provider)}' has no attachable ${posture} public-review recipe`);
      }
      return recipe.spawnArgs(provider, ctx);
    }
    if (recipe) return recipe.spawnArgs(provider, ctx);
    // See supportsPublicReviewPosture for why the actions stage may fall
    // through to the vendor's ordinary headless recipe and the gate may not.
    if (!supportsPublicReviewPosture(provider, posture)) {
      throw new Error(`Provider '${providerLabel(provider)}' has no enforced ${posture} public-review posture`);
    }
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
 * API/custom providers have no maintained recipe: a generic read-only prompt
 * is not enforcement, so they fail closed. A TUI record IS eligible — the
 * stage spawns its binary through the vendor's enforced recipe, headless unless
 * that recipe is also marked `tui: true` (see `isDirectBinaryProvider` and
 * `supportsTuiPublicReviewPosture`).
 */
export function publicReviewPosturesForProvider(provider) {
  return PUBLIC_REVIEW_POSTURES.filter((posture) => supportsPublicReviewPosture(provider, posture));
}

/**
 * The subset of `publicReviewPosturesForProvider` backed by a vendor-enforced
 * recipe; the schedule UI uses the difference to say which actions-stage
 * choices are OS-sandboxed and which rely on the worktree alone.
 */
export function enforcedPublicReviewPosturesForProvider(provider) {
  return PUBLIC_REVIEW_POSTURES.filter((posture) => enforcesPublicReviewPosture(provider, posture));
}

const enforcesPublicReviewPosture = (provider, posture) => (
  isDirectBinaryProvider(provider) && Boolean(publicReviewRecipe(provider, posture))
);

/**
 * Vendor ids that declare a maintained recipe for `posture`, for naming what a
 * user could install when nothing on their machine qualifies. Derived from the
 * rows so the suggestion cannot go stale when a vendor gains or loses a recipe.
 */
export function publicReviewCapableVendorIds(posture) {
  return PROVIDER_VENDORS.filter((vendor) => vendor.publicReview?.[posture]?.spawnArgs).map((vendor) => vendor.id);
}

/**
 * Whether `provider` may run a stage with this posture.
 *
 * The no-tool gate requires a maintained recipe: only an enforced argv can
 * hold a model tool-free. The sandboxed-actions stage is open to EVERY enabled
 * binary (CLI/TUI) provider — a vendor recipe (Codex, Antigravity, Grok,
 * Claude) adds an OS-level sandbox on top, but the stage's baseline isolation
 * is the disposable worktree, the stripped child environment, and the
 * deterministic coordinator owning all forge mutations. API providers have no
 * binary to spawn and fail closed for both.
 */
export function supportsPublicReviewPosture(provider, posture) {
  return enforcesPublicReviewPosture(provider, posture)
    || (posture === PUBLIC_REVIEW_ACTIONS_POSTURE && isDirectBinaryProvider(provider));
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
export function publicReviewProviderBlock(provider, posture) {
  if (!posture) return null;
  if (supportsPublicReviewPosture(provider, posture)) return null;
  return {
    reason: `Provider '${providerLabel(provider)}' has no enforced ${posture} public-content review mode`,
    category: posture === PUBLIC_REVIEW_ACTIONS_POSTURE
      ? 'public-review-actions-provider-unsupported'
      : 'public-review-provider-unsupported',
  };
}

/** Whether a provider can run a tool-free public-content stage. */
export function supportsPublicReviewProvider(provider) {
  return supportsPublicReviewPosture(provider, PUBLIC_REVIEW_NO_TOOL_POSTURE);
}

/** Whether a provider can run the sandboxed final public-review stage. */
export function supportsPublicReviewActionsProvider(provider) {
  return supportsPublicReviewPosture(provider, PUBLIC_REVIEW_ACTIONS_POSTURE);
}

/**
 * Whether `provider` may run a `posture` stage as an ATTACHABLE PTY session
 * rather than headless.
 *
 * Deliberately much narrower than `supportsPublicReviewPosture`: that one lets
 * the actions stage fall through to a vendor's ordinary headless recipe when it
 * declares none, which is fine for a `--print` child and useless in a PTY. An
 * interactive session requires a recipe that has been reviewed for it and says
 * so with `tui: true` — the recipe still owns the argv (`spawnArgs(provider,
 * { ...ctx, tui: true })`), it just drops the flags that only work under
 * `--print`.
 *
 * `no-tool` is structurally excluded: an interactive session for a reasoner
 * with no tools buys nothing and widens the boundary for free, so no row
 * declares it and this returns false for that posture by construction.
 */
export function supportsTuiPublicReviewPosture(provider, posture) {
  return isDirectBinaryProvider(provider) && Boolean(publicReviewRecipe(provider, posture)?.tui);
}

/** Whether the sandboxed final public-review stage can attach a PTY here. */
export function supportsTuiPublicReviewActionsProvider(provider) {
  return supportsTuiPublicReviewPosture(provider, PUBLIC_REVIEW_ACTIONS_POSTURE);
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
