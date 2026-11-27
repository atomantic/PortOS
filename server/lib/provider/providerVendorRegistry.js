/**
 * `PROVIDER_VENDORS` table of coding-agent CLI/TUI vendors (claude, codex, opencode, grok, kimi,
 * cursor and others) so dispatch sites avoid hand-rolled vendor if-chains.
 */

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

import { EXECUTION_OPTION_DEFINITIONS, validateExecutionOptions, executionOptionsError } from '../executionOptions.js';
import { isProcessProvider } from './providerTypes.js';
import {
  resolveCliModel,
  resolveCliEffort,
  foldCursorEffortIntoModel,
  isCursorProvider,
  isClaudeCommand,
  hasModelFlag,
  extractBakedModel,
  argvHasFlag,
  resolveClaudeCliModel,
  buildCodexStartupArgs,
  buildCodexAgentThreadArgs,
  buildEffortArgs,
  isOpencodeCommand,
  HERMES_COMMAND,
  isHermesCommand,
  ensureLeadingSubcommand,
  prefixOpencodeModel,
  localRuntimeNamespace,
  opencodeProviderIsLocalOnly,
  OPENCODE_PUBLIC_REVIEW_AGENT,
  OPENCODE_BUILD_AGENT,
  applyLeanClaudeArgs,
} from './providerModels.js';
import {
  isCodexCommand,
  ensureCodexTuiArgs,
  buildCodexExecutionOptionArgs,
  CODEX_COMMAND,
  CODEX_CLI_ID,
  buildCodexOssArgs,
  buildCodexAuthModeArgs,
} from '../codex.js';
import {
  ANTIGRAVITY_COMMAND,
  isAntigravityCommand,
  isAntigravityCliProvider,
  ensureAntigravityTuiArgs,
  ensureAntigravityPrintArgs,
  prepareAntigravityPrompt,
  resolveAntigravityModelAndEffort,
} from '../antigravity.js';
import {
  isGrokCommand,
  ensureGrokTuiArgs,
  ensureGrokHeadlessArgs,
  withGrokCodeReviewOutput,
  GROK_STREAMING_JSON_FORMAT,
  GROK_NO_TOOL_ARGS,
  grokServiceTierModel,
  grokSpeedArgsConflict,
} from '../grok.js';
import { isKimiCommand, ensureKimiTuiArgs, ensureKimiHeadlessArgs, prepareKimiPrompt } from '../kimi.js';
import {
  CURSOR_COMMAND,
  isCursorCommand,
  ensureCursorTuiArgs,
  ensureCursorHeadlessArgs,
} from '../cursor.js';
import { PI_COMMAND, isPiCommand, ensurePiTuiArgs, ensurePiHeadlessArgs, preparePiPrompt } from '../pi.js';
import { KILO_COMMAND, KILO_COMMAND_ALIASES, isKiloCommand, ensureKiloTuiArgs, ensureKiloHeadlessArgs } from '../kilo.js';
import {
  OPENCHAMBER_COMMAND,
  isOpenchamberCommand,
  ensureOpenchamberHeadlessArgs,
  prepareOpenchamberPrompt,
} from '../openchamber.js';
import {
  PUBLIC_REVIEW_NO_TOOL_POSTURE,
  PUBLIC_REVIEW_ACTIONS_POSTURE,
} from '../agent/agentExecutionProfiles.js';

import {
  claudeToolFreeArgs,
  claudeImageReadArgs,
  grokToolFreeArgs,
  grokImageReadArgs,
  piToolFreeArgs,
  codexReadOnlyOneShotArgs
} from './providerOneShotRecipes.js';

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

// The opt-in that pins a Codex run to the account PortOS believes it is using.
// A third-party bridge re-points Codex by writing top-level routing keys into
// `~/.codex/config.toml`, and codex honors that file on every invocation — so
// without this flag PortOS's runs, reviewer rounds and autofixer repairs route
// wherever that file says while the provider card reports a ChatGPT account.
// Default OFF (an absent flag is today's behavior); the AI Providers page badges
// the override and offers the toggle. Same flag the public-review recipes
// already pass, so no new Codex surface is introduced here.
const codexIgnoreUserConfigArgs = (provider, existingArgs = []) => (
  provider?.ignoreUserConfig === true && !existingArgs.includes('--ignore-user-config')
    ? ['--ignore-user-config']
    : []
);

function codexCliArgs(baseArgs, { model, effort, provider }) {
  const executionArgs = buildCodexExecutionOptionArgs(provider, baseArgs);
  // Detect an existing leading `exec` in user/legacy args so we don't end up
  // running `codex exec --full-auto exec -` after migration of legacy
  // configs that already pinned an `exec` subcommand.
  const hasExec = baseArgs.includes('exec');
  const args = hasExec ? [...baseArgs] : [...baseArgs, 'exec'];
  args.push(...executionArgs);
  args.push(...codexIgnoreUserConfigArgs(provider, args));
  args.push(...buildCodexAuthModeArgs(provider, baseArgs));
  args.push(...buildCodexStartupArgs(baseArgs));
  // The local-model backing, when the record carries a runtime marker codex can
  // serve. Emitted from the marker rather than from provider args so a wrapper
  // stays declarative — see buildCodexOssArgs in codex.js.
  args.push(...buildCodexOssArgs(provider, baseArgs));
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
    ...buildCodexExecutionOptionArgs(provider, provider?.args || []),
    ...codexIgnoreUserConfigArgs(provider),
    ...buildCodexAuthModeArgs(provider),
    ...buildCodexStartupArgs(),
    ...buildCodexOssArgs(provider),
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

// Code-review reader: Codex's OS-level read-only sandbox may inspect files but
// never write or run a mutating command. It still exposes read tools, so it is
// the read-only code-review tier, not the no-tool posture. Claim reviews run in
// an isolated non-repository scratch cwd with the diff inlined, which codex
// refuses ("Not inside a trusted directory") unless the repo check is skipped;
// the read-only sandbox, not the repo check, is the safety boundary here.
function codexReadOnlyReviewSpawnArgs(provider, ctx) {
  return codexPublicReviewArgs(provider, ctx, ['--sandbox', 'read-only', '--skip-git-repo-check']);
}

function codexPublicReviewArgs(provider, { effectiveModel, effort, maxConcurrentThreads }, postureArgs) {
  const args = [
    'exec',
    ...postureArgs,
    '--ephemeral',
    '--ignore-user-config',
    ...buildCodexExecutionOptionArgs(provider, provider?.args || []),
    ...(Object.keys(provider?.executionOptions || {}).length ? buildCodexAuthModeArgs(provider) : []),
    ...buildCodexStartupArgs(),
    // The backing is orthogonal to the posture: a local-backed record reviews
    // untrusted public code under the SAME sandbox ladder, with the tokens
    // generated on-box. `--ignore-user-config` does not strip it — the pair is
    // argv, not config.
    ...buildCodexOssArgs(provider),
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
// `--permission-mode plan` is its read-only mode, `--disallowed-tools` removes
// every built-in tool (an empty `--tools ''` removes none, #14476), and
// `--sandbox <profile>` applies its own
// filesystem/network sandbox (`workspace` is grok's built-in profile). The
// safety flags are seeded as the BASE args so `ensureGrokHeadlessArgs` sees a
// permission posture already pinned and does not append its usual
// `--permission-mode bypassPermissions`.
function grokPublicReviewSpawnArgs(provider, ctx) {
  return grokPublicReviewArgs(provider, ctx, GROK_NO_TOOL_ARGS);
}

function grokPublicReviewActionsSpawnArgs(provider, ctx) {
  return grokPublicReviewArgs(provider, ctx, ['--sandbox', 'workspace', '--permission-mode', 'acceptEdits']);
}

function grokPublicReviewArgs(provider, { effectiveModel, effort } = {}, postureArgs) {
  const base = [
    ...postureArgs,
    '--no-subagents',
    '--disable-web-search',
  ];
  const tiered = grokExecutionModel(effectiveModel, provider, base);
  const args = ensureGrokHeadlessArgs(base, tiered);
  args.push(...buildEffortArgs(effort, provider, args, grokEffortModel(provider, effectiveModel)));
  // `ensureGrokHeadlessArgs` appends the GROK_STDIN_PROMPT_PATH prompt-file
  // sentinel that `prepareGrokPromptFile` rewrites on Windows; keep it present.
  return { command: provider?.command || 'grok', args, stdinMode: 'prompt' };
}

const matchCodexProcess = (provider) => isProcessProvider(provider) && isCodexCommand(provider?.command);

const CODEX = {
  id: 'codex',
  idFragment: 'codex',
  inferredCommand: CODEX_COMMAND,
  matchCommand: isCodexCommand,
  // Id OR command: the shipped `codex` record is not the only one that must
  // build codex argv any more — a local-backed wrapper (`codex-ollama`) carries
  // its own id, and an id-only match would drop it through to `claude`'s
  // fallback row and spawn `claude --print` against the codex binary.
  matchCliProvider: (provider) => provider?.id === CODEX_CLI_ID || isCodexCommand(provider?.command),
  tuiArgs: ensureCodexTuiArgs,
  cliArgs: codexCliArgs,
  spawnArgs: codexSpawnArgs,
  toolFreeOneShot: { matchCommand: isCodexCommand, sandboxArgs: codexReadOnlyOneShotArgs },
  publicReview: {
    // The CLI id and the TUI id share one binary, so both reach the same
    // enforced recipe when a stage selects them.
    // Read-only filesystem access still exposes tools; it is not no-tool.
    [PUBLIC_REVIEW_ACTIONS_POSTURE]: {
      spawnArgs: codexPublicReviewActionsSpawnArgs,
      matchProvider: matchCodexProcess,
    },
  },
  readOnlyReview: {
    spawnArgs: codexReadOnlyReviewSpawnArgs,
    matchProvider: matchCodexProcess,
  },
};

// ─── antigravity ────────────────────────────────────────────────────────────

function antigravityCliArgs(baseArgs, { model, effort, provider }) {
  return ensureAntigravityPrintArgs(baseArgs, { model, effort, models: provider?.models });
}

const ANTIGRAVITY = {
  injectTuiModel(baseArgs, { provider, model, effort }) {
    // agy validates the (model, effort) PAIR — resolved together against the
    // provider's catalog (see antigravity.js).
    const resolved = resolveAntigravityModelAndEffort(baseArgs, { model, effort, models: provider?.models });
    const withModel = resolved.model ? [...baseArgs, '--model', resolved.model] : baseArgs;
    return [...withModel, ...buildEffortArgs(resolved.effort, resolved.provider, withModel, resolved.base)];
  },
  id: 'antigravity',
  // `isAntigravityCommand` has always accepted this spelling beside `agy`; the
  // allowlist did not, so such a record 400'd at /spawn-tui.
  commandAliases: ['antigravity'],
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
    // Plan mode is not an explicit empty-tool contract.
    [PUBLIC_REVIEW_ACTIONS_POSTURE]: {
      spawnArgs: antigravityPublicReviewActionsSpawnArgs,
      matchProvider: (provider) => isProcessProvider(provider) && isAntigravityCommand(provider?.command),
    },
  },
};

// ─── opencode ───────────────────────────────────────────────────────────────

/** Append the namespaced `-m` unless the argv already pins a model. */
function appendOpencodeModel(args, provider, model) {
  const resolvedModel = prefixOpencodeModel(provider, model);
  if (resolvedModel && !hasModelFlag(args)) args.push('-m', resolvedModel);
  return args;
}

const opencodeSpawnConfig = (provider, args) => ({ command: provider?.command || 'opencode', args, stdinMode: 'prompt' });

/**
 * Pin OpenCode's tool-enabled `build` agent unless the argv already selects one.
 *
 * Unlike every other vendor here, OpenCode's ROLE — not just its permissions —
 * is argv state, and the seeded records ship `args: []` (TUI) / `args: ["run"]`
 * (headless). A bare invocation therefore opens in whatever agent that install
 * defaults to, which is how a completion run came up as a read-only specialist
 * and refused to write its own sentinel (#7405 — the contract it could not
 * reconcile is `SENTINEL_WRITE_PERMISSION_NOTE` in promptSections/completion.js).
 * Argv, not `OPENCODE_CONFIG_CONTENT`: that env var is stripped for a
 * gateway-backed wrapper (`cliChildEnv.js`), and a `data.reference` seed edit
 * would never reach an install's already-stored record.
 *
 * Idempotent on `--agent`, which is what lets the public-review recipes keep
 * their `--agent plan` while sharing these builders.
 *
 * @param {string[]} args
 * @returns {string[]}
 */
const ensureOpencodeAgent = (args) =>
  argvHasFlag(args, ['--agent']) ? args : [...args, '--agent', OPENCODE_BUILD_AGENT];

function opencodeCliArgs(baseArgs, { model, provider, toolFree = false }) {
  if (toolFree) {
    // Reusing agent, attachment or session flags could bypass the config for
    // this invocation. Keep model and reasoning selection on the fresh run.
    const args = ['run', '--pure', '--agent', OPENCODE_BUILD_AGENT];
    const pinned = extractBakedModel(baseArgs);
    const variantIndex = baseArgs.findIndex((arg) => arg === '--variant' || arg.startsWith('--variant='));
    const variantFlag = baseArgs[variantIndex];
    const variant = variantFlag === '--variant' ? baseArgs[variantIndex + 1] : variantFlag?.slice('--variant='.length);
    if (variant && !variant.startsWith('-')) args.push('--variant', variant);
    return pinned ? [...args, '-m', pinned] : appendOpencodeModel(args, provider, model);
  }
  const args = ensureLeadingSubcommand(baseArgs, 'run');
  return ensureOpencodeAgent(appendOpencodeModel(args, provider, model));
}

/** `applyCommandDefaults` arm — both TUI spawn paths share it, so they can't drift. */
const ensureOpencodeTuiArgs = (args = []) => ensureOpencodeAgent([...args]);

/**
 * An OpenCode wrapper this install can actually run the tool-free gate on.
 * Three conditions, each closing a different way the stage would otherwise be
 * offered and then fail — or, worse, appear to succeed:
 *
 *   - **an Ollama or LM Studio namespace.** Private assessments verify installed
 *     weights on either runtime. Public-review model validation independently
 *     keeps its stricter Ollama-only capability probe. Other local runtimes
 *     have no maintained assessment recipe.
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
const matchOpencodeBinary = (provider) => isProcessProvider(provider) && isOpencodeCommand(provider?.command);

const isLocalOpencodeProvider = (provider) => matchOpencodeBinary(provider)
  && ['ollama', 'lmstudio'].includes(localRuntimeNamespace(provider))
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
  return opencodeSpawnConfig(provider, opencodeCliArgs(['--agent', OPENCODE_PUBLIC_REVIEW_AGENT], { model: effectiveModel, provider }));
}

/**
 * The ATTACHABLE `sandboxed-actions` invocation (#6238). OpenCode's headless
 * argv is a one-shot `opencode run …`, which cannot become an interactive
 * session by dropping flags the way Claude's recipe does — in a PTY it neither
 * accepts a pasted prompt nor renders. Its real interactive entry point is the
 * BARE binary, which takes the same `--agent`/`-m` flags and reads the prompt
 * the spawner pastes into every TUI (`agentTuiSpawning.js`). The tool-enabled
 * agent is pinned on the argv and provider args are not forwarded (same rule as
 * `buildTuiSpawnConfig`): a saved `--agent plan` would hand the session to a
 * human nobody has to be. Permissions are the config's, on both paths — every
 * tool allowed, the interactive gates denied (`buildOpencodeEnvVars`) — for as
 * long as `OPENCODE_CONFIG_CONTENT` survives the actions env allowlist, i.e. a
 * local-only endpoint (`cliChildEnv.js`); a gateway-backed wrapper runs on the
 * operator's own `~/.config/opencode` instead, exactly as its headless run
 * already did.
 *
 * The row supplies ONLY this builder: a headless actions run keeps falling
 * through to the ordinary `run` argv, and with no headless `spawnArgs` the row
 * is not an enforcement (OpenCode ships no sandbox; the disposable worktree is
 * the isolation), so the schedule UI keeps reporting it as worktree-only.
 */
function opencodePublicReviewActionsTuiSpawnArgs(provider, { effectiveModel } = {}) {
  return opencodeSpawnConfig(provider, appendOpencodeModel(['--agent', OPENCODE_BUILD_AGENT], provider, effectiveModel));
}

const OPENCODE = {
  id: 'opencode',
  idFragment: 'opencode',
  inferredCommand: 'opencode',
  matchCommand: isOpencodeCommand,
  // No dedicated matchCliProvider — matches by command, same as matchCommand
  // (buildVendorCliArgs/buildVendorSpawnConfig fall back to matchCommand when
  // matchCliProvider is absent).
  tuiArgs: ensureOpencodeTuiArgs,
  cliArgs: opencodeCliArgs,
  spawnArgs: defaultSpawnArgs(opencodeCliArgs, 'opencode'),
  publicReview: {
    [PUBLIC_REVIEW_NO_TOOL_POSTURE]: {
      spawnArgs: opencodePublicReviewSpawnArgs,
      matchProvider: isLocalOpencodeProvider,
    },
    [PUBLIC_REVIEW_ACTIONS_POSTURE]: {
      // No `spawnArgs` here — see the builder's docstring above: OpenCode
      // ships no sandbox, so this row is never an enforcement and the
      // attachable builder below is unreachable through the posture gate
      // (`enforcesPublicReviewPosture` requires `spawnArgs`).
      tuiSpawnArgs: opencodePublicReviewActionsTuiSpawnArgs,
      matchProvider: matchOpencodeBinary,
    },
  },
};

// ─── kilo ───────────────────────────────────────────────────────────────────

function kiloCliArgs(baseArgs, { model }) {
  return ensureKiloHeadlessArgs(baseArgs, model);
}

const KILO = {
  id: 'kilo',
  idFragment: 'kilo',
  inferredCommand: KILO_COMMAND,
  // `@kilocode/cli` installs two bin names for one program, and `isKiloCommand`
  // accepts both — so the runner's allowlist has to as well, or a provider
  // configured as `kilocode` is classified everywhere and spawnable nowhere.
  commandAliases: KILO_COMMAND_ALIASES,
  matchCommand: isKiloCommand,
  // No dedicated matchCliProvider — matches by command, same as matchCommand.
  tuiArgs: ensureKiloTuiArgs,
  cliArgs: kiloCliArgs,
  spawnArgs: defaultSpawnArgs(kiloCliArgs, KILO_COMMAND),
  // No publicReview recipe: Kilo is an OpenCode fork whose tool posture lives in
  // its config rather than argv, and PortOS writes no Kilo config (see
  // providerHarnesses.js) — so there is nothing here that could ENFORCE a
  // tool-free stage, and declaring one would make the gate decorative.
};

// ─── openchamber ────────────────────────────────────────────────────────────

function openchamberCliArgs(baseArgs, { model }) {
  return ensureOpenchamberHeadlessArgs(baseArgs, model);
}

const OPENCHAMBER = {
  id: 'openchamber',
  idFragment: 'openchamber',
  inferredCommand: OPENCHAMBER_COMMAND,
  matchCommand: isOpenchamberCommand,
  // No dedicated matchCliProvider — matches by command, same as matchCommand.
  // No `tuiArgs`: OpenChamber's interactive surface is a web app, and the bare
  // binary starts its SERVER — there is nothing for a PTY to attach to, and an
  // argv builder here would exist only to be misused (see openchamber.js).
  cliArgs: openchamberCliArgs,
  preparePrompt: prepareOpenchamberPrompt,
  spawnArgs: defaultSpawnArgs(openchamberCliArgs, OPENCHAMBER_COMMAND),
};

// ─── grok ───────────────────────────────────────────────────────────────────

/**
 * `--model` value for an explicit Grok speed. Unset speed returns `model`
 * unchanged, so a flat fast id still launches until the user picks Standard
 * or Fast. Grok Build CLI 1.0.92 takes the tier as the catalog id itself
 * (`<base>-build-fast` / `<base>`), not a `--fast` flag and not Codex
 * `service_tier`. The 1.0.70 `name[fast=true|false]` setting is now an
 * "unknown model id": the CLI drops `--effort` and the TUI falls back to the
 * default model at its default (low) effort.
 */
function grokExecutionModel(model, provider, baseArgs) {
  const tier = provider?.executionOptions?.serviceTier;
  if (!tier) return model;
  if (grokSpeedArgsConflict(baseArgs)) {
    throw executionOptionsError('Execution speed conflicts with provider args; remove the baked model pin');
  }
  const pinned = grokServiceTierModel(model, tier, provider?.executionOptionSupport?.modelBase);
  if (!pinned) throw executionOptionsError('Choose an explicit model before changing Grok speed');
  return pinned;
}

/** Effort ladders stay keyed on the base catalog id, not the `-build-fast` argv value. */
function grokEffortModel(provider, model) {
  return provider?.executionOptionSupport?.modelBase || model;
}

function grokCliArgs(baseArgs, { model, toolFree, provider }) {
  return ensureGrokHeadlessArgs(baseArgs, grokExecutionModel(model, provider, baseArgs), { toolFree });
}

function grokCodeReviewSpawnConfig(config) {
  return { ...config, args: withGrokCodeReviewOutput(config.args), streamFormat: GROK_STREAMING_JSON_FORMAT };
}

const GROK = {
  injectTuiModel(baseArgs, { provider, command, model, effort }) {
    const effectiveModel = resolveCliModel(model);
    const tiered = grokExecutionModel(effectiveModel, provider, baseArgs);
    const withModel = tiered && !hasModelFlag(baseArgs) ? [...baseArgs, '--model', tiered] : baseArgs;
    return [...withModel, ...buildEffortArgs(effort, { id: provider?.id, command }, withModel, grokEffortModel(provider, effectiveModel))];
  },
  id: 'grok',
  idFragment: 'grok',
  inferredCommand: 'grok',
  matchCommand: isGrokCommand,
  // No dedicated matchCliProvider — matches by command, same as matchCommand.
  tuiArgs: ensureGrokTuiArgs,
  cliArgs: grokCliArgs,
  spawnArgs: defaultSpawnArgs(grokCliArgs, 'grok'),
  toolFreeOneShot: { matchCommand: isGrokCommand, toolFreeArgs: grokToolFreeArgs, imageReadArgs: grokImageReadArgs },
  // The code reviewer parses a strict JSON envelope from the reply, so it needs
  // grok's final message alone, not plain output's gluing of pre-tool narration
  // onto it (#14391). Pipeline public-review stages keep plain text.
  codeReviewSpawnConfig: grokCodeReviewSpawnConfig,
  publicReview: {
    [PUBLIC_REVIEW_NO_TOOL_POSTURE]: {
      spawnArgs: grokPublicReviewSpawnArgs,
      matchProvider: (provider) => isProcessProvider(provider) && isGrokCommand(provider?.command),
    },
    [PUBLIC_REVIEW_ACTIONS_POSTURE]: {
      spawnArgs: grokPublicReviewActionsSpawnArgs,
      matchProvider: (provider) => isProcessProvider(provider) && isGrokCommand(provider?.command),
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
  // No tool-disable switch: only the bypass alias is stripped.
  toolFreeOneShot: { matchCommand: isKimiCommand, bypassAliases: ['-y'] },
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
  matchTuiModelProvider: isCursorProvider,
  injectTuiModel(baseArgs, { provider, command, model, effort }) {
    // Cursor's effort is a model-variant parameter, not a flag — fold it in so
    // the TUI honors a pinned level instead of dropping it (buildEffortArgs
    // emits nothing for cursor by design).
    const cursorModel = foldCursorEffortIntoModel(
      resolveCliModel(model),
      resolveCliEffort(effort, { id: provider?.id, command })
    );
    return (cursorModel && !hasModelFlag(baseArgs)) ? [...baseArgs, '--model', cursorModel] : baseArgs;
  },
  id: 'cursor',
  idFragment: 'cursor',
  inferredCommand: CURSOR_COMMAND,
  matchCommand: isCursorCommand,
  // No dedicated matchCliProvider — matches by command, same as matchCommand.
  tuiArgs: ensureCursorTuiArgs,
  cliArgs: cursorCliArgs,
  spawnArgs: defaultSpawnArgs(cursorCliArgs, CURSOR_COMMAND),
  // No tool-disable switch. `--force` also clears cursor's workspace-trust
  // gate, so when a bypass is stripped the narrow `--trust` (which approves
  // nothing) keeps the headless run from exiting on the trust block.
  toolFreeOneShot: {
    matchCommand: isCursorCommand,
    bypassAliases: ['-f'],
    afterStrip: (args) => (argvHasFlag(args, ['--trust']) ? args : [...args, '--trust']),
  },
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

// Pi public review discards configured args and disables every tool/resource
// discovery surface. --no-builtin-tools alone leaves extension tools enabled.
const piCliArgs = (args, { model, effort, provider }) => ensurePiHeadlessArgs(args, model, effort, provider);
const PI = {
  id: 'pi',
  idFragment: 'pi-',
  matchId: (id) => /^pi(?:-|$)/.test(id),
  inferredCommand: PI_COMMAND,
  matchCommand: isPiCommand,
  tuiArgs: ensurePiTuiArgs,
  cliArgs: piCliArgs,
  preparePrompt: preparePiPrompt,
  spawnArgs: defaultSpawnArgs(piCliArgs, PI_COMMAND),
  toolFreeOneShot: { matchCommand: isPiCommand, bypassAliases: ['-a'], toolFreeArgs: piToolFreeArgs },
  publicReview: {
    [PUBLIC_REVIEW_NO_TOOL_POSTURE]: {
      matchProvider: (provider) => isProcessProvider(provider) && isPiCommand(provider?.command),
      spawnArgs: (provider, { effectiveModel, effort } = {}) => ({
        command: provider.command,
        args: ensurePiHeadlessArgs([
          '--no-approve', '--no-tools', '--no-builtin-tools', '--no-extensions',
          '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-session',
        ], effectiveModel, effort),
        stdinMode: 'prompt',
      }),
    },
  },
};

// ─── hermes ─────────────────────────────────────────────────────────────────
//
// Hermes Agent (NousResearch/hermes-agent, binary `hermes`), per its published CLI reference:
//   - Headless: `hermes chat --oneshot --quiet --query-file -` answers one prompt and exits;
//     `--query-file -` reads the prompt from stdin verbatim, so a large prompt never rides argv.
//   - Unattended runs carry `--yolo` (skips dangerous-command approvals); tool-free callers strip it.
//   - Interactive: `hermes --tui`; `--model` is accepted at the top level.
//   - No per-run reasoning-effort flag exists (it is `agent.reasoning_effort` in the user's
//     config.yaml), so no effort is passed and `effortLevelsForProvider` reports no ladder.
//   - No switch disables every tool (`--toolsets` only enables sets), so a one-shot is never
//     tool-free and fails closed through `toolFreeOneShotRefusal`.

const HERMES_APPROVAL_FLAGS = ['--yolo'];

function ensureHermesTuiArgs(baseArgs = []) {
  const args = [...baseArgs];
  if (!argvHasFlag(args, ['--tui', '--cli'])) args.unshift('--tui');
  if (!argvHasFlag(args, HERMES_APPROVAL_FLAGS)) args.push('--yolo');
  return args;
}

const hermesCliArgs = (baseArgs, { model }) => {
  const args = ensureLeadingSubcommand(baseArgs, 'chat');
  if (!argvHasFlag(args, ['--oneshot'])) args.push('--oneshot');
  if (!argvHasFlag(args, ['--quiet', '-Q'])) args.push('--quiet');
  if (!argvHasFlag(args, HERMES_APPROVAL_FLAGS)) args.push('--yolo');
  if (model && !hasModelFlag(args)) args.push('--model', model);
  return args;
};

// `--query-file` replaces any baked query source; stdin carries the prompt.
function prepareHermesPrompt(args = []) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--query-file') { i += 1; continue; }
    if (typeof arg === 'string' && arg.startsWith('--query-file=')) continue;
    out.push(arg);
  }
  return { args: [...out, '--query-file', '-'], useStdin: true, cleanup: () => {} };
}

const HERMES = {
  id: 'hermes',
  idFragment: 'hermes',
  inferredCommand: HERMES_COMMAND,
  matchCommand: isHermesCommand,
  // No dedicated matchCliProvider — matches by command, same as matchCommand.
  tuiArgs: ensureHermesTuiArgs,
  cliArgs: hermesCliArgs,
  preparePrompt: prepareHermesPrompt,
  spawnArgs: defaultSpawnArgs(hermesCliArgs, HERMES_COMMAND),
  // Only the `--yolo` bypass is stripped; no tool-disable switch exists (see above).
  toolFreeOneShot: { matchCommand: isHermesCommand },
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

const CLAUDE_PERMISSION_POSTURE_FLAGS = [
  '--permission-mode', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions',
];

function claudeSpawnArgs(provider, { effectiveModel, effort, systemPromptFile, settingsEnv }) {
  const providerId = provider?.id || 'claude-code';
  const providerArgs = provider?.args || [];
  // A provider that pins its own permission posture (e.g. `--permission-mode auto`)
  // must not also receive the default bypass, which would override it (#10419).
  const hasPosture = argvHasFlag(providerArgs, CLAUDE_PERMISSION_POSTURE_FLAGS);
  const args = applyLeanClaudeArgs(provider, [
    ...(hasPosture ? [] : ['--dangerously-skip-permissions']),
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    ...providerArgs,
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
// written for the headless launch, so the attachable `tuiSpawnArgs` recipe has to
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

const matchClaudeBinary = (provider) => isProcessProvider(provider) && isClaudeCommand(provider?.command);

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
  // Positive binary match: the row's always-true `matchCommand` must never
  // hand an unknown command claude's flags or a tool-free verdict.
  toolFreeOneShot: { matchCommand: isClaudeCommand, toolFreeArgs: claudeToolFreeArgs, imageReadArgs: claudeImageReadArgs },
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
      // One of two posture/vendor pairings that may run as an ATTACHABLE session
      // (OpenCode is the other — see its row).
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
      tuiSpawnArgs: claudePublicReviewSpawnArgsFor(CLAUDE_PUBLIC_REVIEW_ACTIONS_ARGS),
    },
  },
};

export const DEFAULT_TUI_COMMAND = CLAUDE.inferredCommand;

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
export const PROVIDER_VENDORS = [CODEX, ANTIGRAVITY, CURSOR, GEMINI_LEGACY, KIMI, GROK, OPENCODE, KILO, OPENCHAMBER, HERMES, PI, CLAUDE];

/**
 * A row's `matchCliProvider` may be absent when it's identical to
 * `matchCommand(provider?.command)` (true for every vendor except codex,
 * antigravity, and the legacy gemini-cli row, which match by provider id).
 */
export function matchesProvider(vendor, provider) {
  return vendor.matchCliProvider ? vendor.matchCliProvider(provider) : vendor.matchCommand(provider?.command);
}

export function assertExecutionOptionHarness(provider, harnessId) {
  for (const key of Object.keys(validateExecutionOptions(provider?.executionOptions))) {
    if (!EXECUTION_OPTION_DEFINITIONS[key].harnesses.includes(harnessId)) {
      throw executionOptionsError(`Execution option ${key} is unsupported by this harness`);
    }
  }
}
