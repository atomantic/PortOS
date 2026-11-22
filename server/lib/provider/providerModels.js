/**
 * Shared sentinel and helpers for provider model resolution.
 */

import { gatewayIdForProvider, isGatewayNamespace } from './providerGateways.js';
import { isLocalInstanceEndpoint } from '../localEndpoint.js';
import { isPlainObject } from '../objects.js';
import { isOllamaBackedProvider, ollamaThinkingLevelsForModel } from '../aiToolkit/internal/ollamaBacked.js';

export const CODEX_CONFIGURED_DEFAULT = 'codex-configured-default';
export const ANTIGRAVITY_CONFIGURED_DEFAULT = 'antigravity-configured-default';
// Legacy opt-in sentinel: shipped Grok Build providers now pin a concrete model so displayed
// model, execution, and planner attribution agree.
export const GROK_CONFIGURED_DEFAULT = 'grok-configured-default';
// Kimi Code CLI/TUI: same posture as Grok/Antigravity — PortOS does not select a model; the local
// `kimi` binary uses its own configured default.
export const KIMI_CONFIGURED_DEFAULT = 'kimi-configured-default';

const CONFIGURED_DEFAULT_SENTINELS = new Set([
  CODEX_CONFIGURED_DEFAULT,
  ANTIGRAVITY_CONFIGURED_DEFAULT,
  GROK_CONFIGURED_DEFAULT,
  KIMI_CONFIGURED_DEFAULT,
]);

export const isCodexConfiguredDefault = (model) => model === CODEX_CONFIGURED_DEFAULT;

/** True for any provider "use CLI's own default" sentinel (Codex / Antigravity / Grok Build). */
export const isConfiguredDefaultModel = (model) => CONFIGURED_DEFAULT_SENTINELS.has(model);

/**
 * Normalize a provider `command` to its lowercase binary basename, stripping any directory prefix
 * and a Windows `.exe` suffix — e.g. `/opt/homebrew/bin/Grok.exe` → `grok`. Returns `''` for empty/non-string input.
 * @param {string|null|undefined} command
 * @returns {string}
 */
export function commandBasename(command) {
  if (typeof command !== 'string' || command === '') return '';
  return command.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
}

/**
 * True when argv contains any of `flags`, in either separated (`--flag`) or joined
 * (`--flag=value`) form.
 * @param {unknown[]} args
 * @param {string[]} flags
 * @returns {boolean}
 */
export function argvHasFlag(args = [], flags = []) {
  return args.some((a) => typeof a === 'string' && flags.some((f) => a === f || a.startsWith(`${f}=`)));
}

/**
 * Put a POSITIONAL subcommand at the head of an argv unless it is already there.
 * @param {unknown[]} args
 * @param {string|string[]} subcommand - one word, or the words of a nested one
 * @returns {string[]} a new array; `args` is never mutated
 */
export function ensureLeadingSubcommand(args = [], subcommand) {
  const words = Array.isArray(subcommand) ? subcommand : [subcommand];
  return args.includes(words[0]) ? [...args] : [...words, ...args];
}

/**
 * Returns the model string to pass to a CLI's --model flag, or null if the caller should omit
 * --model entirely (configured-default sentinels — the CLI uses its own default: Codex via
 * ~/.codex/config.toml, Antigravity/Grok Build via the binary's built-in latest model).
 * @param {string|null|undefined} model
 * @returns {string|null}
 */
export const resolveCliModel = (model) => isConfiguredDefaultModel(model) ? null : (model || null);

// --------------------------------------------------------------------------- Reasoning-effort
// levels — Claude Code (`--effort <level>`), Antigravity (`--effort <level>`) and Codex (`-c
// model_reasoning_effort=<level>`) all accept a per-invocation override of how hard the model
// thinks.

export const CLAUDE_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const CODEX_EFFORT_LEVELS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export const CODEX_ULTRA_EFFORT_LEVELS = Object.freeze([...CODEX_EFFORT_LEVELS, 'ultra']);
export const ANTIGRAVITY_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh']);
// Preserve older CLI defaults when no concrete catalog/model proves xhigh support.
const ANTIGRAVITY_FALLBACK_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high']);
// OpenCode forwards this narrow OpenAI-compatible ladder as `reasoningEffort` to whichever local
// backend it is wired to (Ollama, llama.cpp, MTPLX, OrcaRouter).
export const OPENCODE_LOCAL_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high']);

// A model behind that gateway can still refuse a rung of the ladder above: the value is forwarded
// verbatim to the upstream vendor, whose own contract decides.
const OPENCODE_MODEL_EFFORT_LEVELS = Object.freeze([
  Object.freeze([/(^|\/)kimi-k3([.-]|$)/, Object.freeze(['low', 'high', 'max'])]),
]);

/**
 * The effort ladder an OpenCode run offers for one model — the portable low/medium/high set,
 * narrowed for the models whose upstream vendor rejects a rung of it.
 * @param {string|null|undefined} model - bare or namespace-prefixed id
 * @returns {readonly string[]}
 */
export function opencodeEffortLevelsForModel(model) {
  const id = String(model || '').trim().toLowerCase();
  if (!id) return OPENCODE_LOCAL_EFFORT_LEVELS;
  return OPENCODE_MODEL_EFFORT_LEVELS.find(([re]) => re.test(id))?.[1] ?? OPENCODE_LOCAL_EFFORT_LEVELS;
}

// Cursor Agent's ladder.
export const CURSOR_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
// Grok Build CLI.
export const GROK_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh']);

/** Union of every accepted effort value across effort-capable CLIs, low→high. */
export const EFFORT_LEVELS = Object.freeze([...new Set([
  ...CODEX_ULTRA_EFFORT_LEVELS,
  ...CLAUDE_EFFORT_LEVELS,
  ...ANTIGRAVITY_EFFORT_LEVELS,
  ...CURSOR_EFFORT_LEVELS,
])]);

const CODEX_ULTRA_MODELS = new Set(['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6.2-sol', 'gpt-6.2-astra']);

// Models that REJECT `minimal`.
const CODEX_NO_MINIMAL_MODEL_RE = /^gpt-[6-9]([.-]|$)/;

const withoutMinimal = (levels) => Object.freeze(levels.filter((l) => l !== 'minimal'));
const CODEX_EFFORT_LEVELS_NO_MINIMAL = withoutMinimal(CODEX_EFFORT_LEVELS);
const CODEX_ULTRA_EFFORT_LEVELS_NO_MINIMAL = withoutMinimal(CODEX_ULTRA_EFFORT_LEVELS);

export const codexEffortLevelsForModel = (model) => {
  const id = String(model || '').trim().toLowerCase();
  const ultra = CODEX_ULTRA_MODELS.has(id);
  if (CODEX_NO_MINIMAL_MODEL_RE.test(id)) {
    return ultra ? CODEX_ULTRA_EFFORT_LEVELS_NO_MINIMAL : CODEX_EFFORT_LEVELS_NO_MINIMAL;
  }
  return ultra ? CODEX_ULTRA_EFFORT_LEVELS : CODEX_EFFORT_LEVELS;
};

// --------------------------------------------------------------------------- Antigravity
// base-model ↔ effort-suffix split.

const ANTIGRAVITY_EFFORT_SUFFIX_RE = new RegExp(`-(${ANTIGRAVITY_EFFORT_LEVELS.join('|')})$`);

/**
 * Split an Antigravity model id into its base id and baked-in effort tier —
 * `gemini-3.6-flash-high` → `{ base: 'gemini-3.6-flash', effort: 'high' }`.
 * @param {string|null|undefined} id
 * @returns {{base: string|null|undefined, effort: string|null}}
 */
export function splitAntigravityModel(id) {
  if (typeof id !== 'string' || id === '' || isConfiguredDefaultModel(id)) {
    return { base: id, effort: null };
  }
  const match = ANTIGRAVITY_EFFORT_SUFFIX_RE.exec(id);
  return match
    ? { base: id.slice(0, -match[0].length), effort: match[1] }
    : { base: id, effort: null };
}

/**
 * The user-selectable view of an Antigravity model list: effort suffixes stripped, duplicates
 * collapsed, original order preserved.
 * @param {unknown[]} models
 * @returns {unknown[]}
 */
export function antigravityBaseModels(models) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(models) ? models : []) {
    if (typeof entry !== 'string') {
      out.push(entry);
      continue;
    }
    const { base } = splitAntigravityModel(entry);
    if (seen.has(base)) continue;
    seen.add(base);
    out.push(base);
  }
  return out;
}

/**
 * The effort tiers an Antigravity base model actually offers, read off the provider's own model
 * catalog:
 * - `['low','high']`: the suffixed variants present for that base.
 * - `[]`: the base is in the catalog with no suffixed variants (`claude-sonnet-4-6`); agy has no
 *   effort knob for it.
 * - `null`: the model is UNKNOWN (blank, the configured-default sentinel, or an empty catalog), so
 *   the caller should fall back to the legacy ladder rather than assume none.
 * @param {string|null|undefined} model - base or suffixed model id
 * @param {unknown[]} models - the provider's model list
 * @returns {readonly string[]|null}
 */
export function antigravityModelEffortLevels(model, models) {
  const list = (Array.isArray(models) ? models : []).filter(m => typeof m === 'string');
  if (list.length === 0) return null;
  if (isConfiguredDefaultModel(model)) return null;
  const { base } = splitAntigravityModel(model);
  if (typeof base !== 'string' || base === '') return null;
  return Object.freeze(ANTIGRAVITY_EFFORT_LEVELS.filter(level => list.includes(`${base}-${level}`)));
}

/**
 * Is `id` a model the install's agy catalog still lists?
 * @param {string} id - base or suffixed model id (a blank one reads as unlisted;
 *   callers ask this about a pin they already hold)
 * @param {unknown[]|null|undefined} models - the provider's model catalog
 * @returns {boolean}
 */
export function antigravityCatalogListsModel(id, models) {
  const bases = antigravityBaseModels((Array.isArray(models) ? models : []).filter(m => typeof m === 'string'));
  return !bases.length || bases.includes(splitAntigravityModel(id).base);
}

/**
 * The cheapest catalog entry that can drive an unattended agy relay — the tier to pick on the
 * user's behalf when an agent is needed only to issue one tool call and does no creative work of
 * its own.
 * @param {unknown[]|null|undefined} models - the provider's model catalog
 * @returns {string|null}
 */
export function pickAntigravityRelayModel(models) {
  const cheapest = ANTIGRAVITY_EFFORT_LEVELS[0];
  const tiers = filterSelectableModels((Array.isArray(models) ? models : []).filter(m => typeof m === 'string'))
    .map(id => ({ id, ...splitAntigravityModel(id) }));
  const pick = (match) => tiers.find(match)?.id;
  return pick(m => m.effort === cheapest && m.base.includes('flash'))
    || pick(m => m.effort === cheapest)
    || pick(m => m.base.includes('flash'))
    || null;
}

/**
 * True when a provider is codex-flavored — the shipped `codex`/`codex-tui` provider ids or any
 * provider whose launch command basename is `codex` (path/exe tolerant).
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @returns {boolean}
 */
export function isCodexProvider(provider) {
  const id = String(provider?.id || '').toLowerCase();
  return id === 'codex' || id === 'codex-tui' || commandBasename(provider?.command) === 'codex';
}

/**
 * Keyed on the COMMAND, not the id: a user who cloned `codex` into `codex-review` still runs the
 * same binary against the same ChatGPT sign-in, and hard-coding two ids would leave that card
 * blank.
 * @param {{type?:string, command?:string}|null|undefined} provider
 * @returns {boolean}
 */
export function isCodexSubscriptionProvider(provider) {
  if (provider?.type !== 'cli' && provider?.type !== 'tui') return false;
  const command = typeof provider?.command === 'string' ? provider.command.trim() : '';
  if (command === '') return false;
  if (commandBasename(command) !== 'codex') return false;
  return localRuntimeNamespace(provider) === null;
}

/**
 * True when a provider is Grok-Build-flavored — the shipped `grok-cli`/`grok-tui` ids or any
 * provider whose launch command basename is `grok`.
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @returns {boolean}
 */
export function isGrokProvider(provider) {
  const id = String(provider?.id || '').toLowerCase();
  return id === 'grok-cli' || id === 'grok-tui' || commandBasename(provider?.command) === 'grok';
}

/**
 * True when a provider is Claude-Code-flavored — a `claude-code*` provider id or any provider
 * whose launch command basename is `claude` (path/exe tolerant).
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @returns {boolean}
 */
export function isClaudeProvider(provider) {
  if (!provider) return false;
  return String(provider.id || '').toLowerCase().startsWith('claude-code')
    || commandBasename(provider.command) === 'claude';
}

/**
 * True when a provider is OpenCode-flavored — the shipped `opencode`/`opencode-tui` ids or any
 * provider whose launch command basename is `opencode`.
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @returns {boolean}
 */
export function isOpencodeProvider(provider) {
  const id = String(provider?.id || '').toLowerCase();
  return id === 'opencode' || id === 'opencode-tui' || isOpencodeCommand(provider?.command);
}

/**
 * True when a provider is Kimi-Code-flavored — the shipped `kimi-cli`/`kimi-tui` ids or any
 * provider whose launch command basename is `kimi` (path/exe tolerant).
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @returns {boolean}
 */
export function isKimiProvider(provider) {
  const id = String(provider?.id || '').toLowerCase();
  return id === 'kimi-cli' || id === 'kimi-tui' || commandBasename(provider?.command) === 'kimi';
}

export const HERMES_COMMAND = 'hermes';
export const isHermesCommand = (command) => commandBasename(command) === HERMES_COMMAND;

/**
 * True when a provider is Hermes-Agent-flavored — the shipped `hermes-cli`/`hermes-tui` ids or any
 * provider whose launch command basename is `hermes` (path/exe tolerant).
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @returns {boolean}
 */
export function isHermesProvider(provider) {
  const id = String(provider?.id || '').toLowerCase();
  return id === 'hermes-cli' || id === 'hermes-tui' || isHermesCommand(provider?.command);
}

/**
 * True when a provider is Antigravity-flavored — the shipped `antigravity-cli`/`antigravity-tui`
 * ids or any provider whose launch command basename is `agy`/`antigravity` (path/exe tolerant).
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @returns {boolean}
 */
export function isAntigravityProvider(provider) {
  if (!provider) return false;
  if (provider.harnessId === 'antigravity') return true;
  const id = String(provider.id || '').toLowerCase();
  if (id === 'antigravity-cli' || id === 'antigravity-tui') return true;
  const base = commandBasename(provider.command);
  return base === 'agy' || base === 'antigravity';
}

/**
 * True when a provider is Cursor-Agent-flavored — the shipped `cursor-cli` / `cursor-tui` ids or
 * any provider whose launch command basename is `cursor-agent` (path/exe tolerant).
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @returns {boolean}
 */
export function isCursorProvider(provider) {
  if (!provider) return false;
  const id = String(provider.id || '').toLowerCase();
  return id === 'cursor-cli' || id === 'cursor-tui' || commandBasename(provider.command) === 'cursor-agent';
}

/**
 * Fold a reasoning-effort level into a Cursor model id using Cursor's own model-variant syntax,
 * because `cursor-agent` has NO `--effort` flag and exits non-zero when passed one.
 * @param {string|null|undefined} model
 * @param {string|null|undefined} effort
 * @returns {string|null}
 */
export function foldCursorEffortIntoModel(model, effort) {
  const id = typeof model === 'string' ? model.trim() : '';
  if (!id) return null;
  const level = typeof effort === 'string' ? effort.trim() : '';
  if (!level) return id;
  if (id.includes('effort=')) return id;
  if (id.endsWith(']')) return `${id.slice(0, -1)},effort=${level}]`;
  return `${id}[effort=${level}]`;
}

/**
 * The effort levels a provider's CLI accepts, or null when the provider has no effort control
 * (opencode, grok, kimi, HTTP API providers).
 * @param {{id?:string, command?:string, models?:unknown[]}|null|undefined} provider
 * @param {string|null} [model]
 * @returns {readonly string[]|null}
 */
export function effortLevelsForProvider(provider, model = null) {
  if (!provider) return null;
  const harness = provider.harnessId ?? null;
  if (harness === 'opencode' || isOpencodeLocalProvider(provider)) {
    return isOpencodeLocalProvider(provider) ? opencodeEffortLevelsForModel(model) : null;
  }
  if (harness === 'codex' || isCodexProvider(provider)) return codexEffortLevelsForModel(model);
  if (harness === 'antigravity' || isAntigravityProvider(provider)) {
    const perModel = model ? antigravityModelEffortLevels(model, provider.models) : null;
    if (perModel === null) return ANTIGRAVITY_FALLBACK_EFFORT_LEVELS;
    return perModel.length ? perModel : null;
  }
  if (harness === 'pi' || commandBasename(provider.command) === 'pi') return PI_EFFORT_LEVELS;
  if (harness === 'cursor' || isCursorProvider(provider)) return CURSOR_EFFORT_LEVELS;
  if (harness === 'grok' || isGrokProvider(provider)) return GROK_EFFORT_LEVELS;
  if (harness === 'claude' || isClaudeProvider(provider)) return CLAUDE_EFFORT_LEVELS;
  // An Ollama API provider's effort is the model's thinking level, where its template takes one.
  // An MTPLX provider hands the same level to the chat template (Inkling packs).
  if (provider.type === 'api' && (isOllamaBackedProvider(provider) || provider.mtplxBacked === true)) return ollamaThinkingLevelsForModel(model);
  return null;
}

/** Pi's reasoning ladder (`pi --effort`). */
const PI_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

// Every effort value any CLI accepts, ordered weakest→strongest.
const EFFORT_RANK = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

/**
 * Resolve a stored effort override to the value the provider's CLI actually accepts, or null when
 * the flag should be omitted entirely (no override set, provider has no effort control, or the
 * value isn't a known effort at all).
 * @param {string|null|undefined} effort
 * @param {{id?:string, command?:string, models?:unknown[]}|null|undefined} provider
 * @param {string|null} [model] - narrows the Antigravity ladder (see effortLevelsForProvider)
 * @returns {string|null}
 */
export function resolveCliEffort(effort, provider, model = null) {
  return clampEffortToLadder(effort, effortLevelsForProvider(provider, model));
}

/**
 * The clamp behind `resolveCliEffort`, over an explicit ladder: the effort itself when `levels`
 * has it, else the nearest supported level below it, else the ladder's weakest — or null when
 * there is no effort, no ladder, or the value is not an effort at all.
 * @param {string|null|undefined} effort
 * @param {readonly string[]|null|undefined} levels
 * @returns {string|null}
 */
export function clampEffortToLadder(effort, levels) {
  if (!effort || !levels) return null;
  if (levels.includes(effort)) return effort;
  const requested = EFFORT_RANK.indexOf(effort);
  if (requested === -1) return null; // not an effort value at all
  const supported = levels.map(l => EFFORT_RANK.indexOf(l)).filter(i => i !== -1).sort((a, b) => a - b);
  if (supported.length === 0) return null;
  const below = supported.filter(i => i < requested);
  return EFFORT_RANK[below.length ? below[below.length - 1] : supported[0]];
}

// Codex's config key (set via `-c <key>=<value>`) that carries the reasoning effort.
export const CODEX_EFFORT_KEY = 'model_reasoning_effort';

// Every spelling of the effort flag a provider CLI accepts as a VALUE-taking argument.
const EFFORT_FLAG_NAMES = Object.freeze(['--effort', '--reasoning-effort', '--thinking']);

/** Remove saved model/effort pins only when a caller explicitly owns those selections. */
export function stripProviderPinArgs(args, { model = false, effort = false } = {}) {
  const flags = [...(model ? ['--model', '-m'] : []), ...(effort ? EFFORT_FLAG_NAMES : [])];
  const configPin = value => typeof value === 'string' && ((model && value.startsWith('model=')) || (effort && value.startsWith(`${CODEX_EFFORT_KEY}=`)));
  const result = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (flags.includes(arg)) {
      if (typeof args[i + 1] === 'string' && !args[i + 1].startsWith('-')) i++;
      continue;
    }
    if (flags.some(flag => arg.startsWith(`${flag}=`))) continue;
    if ((arg === '-c' || arg === '--config') && configPin(args[i + 1])) { i++; continue; }
    if ((arg.startsWith('-c=') && configPin(arg.slice(3))) || (arg.startsWith('--config=') && configPin(arg.slice(9)))) continue;
    result.push(arg);
  }
  return result;
}

/**
 * True when the user has already baked an effort override into the provider's args —
 * claude/agy/grok's `--effort <level>` / `--effort=<level>`, grok's `--reasoning-effort` long
 * form, or a codex `-c model_reasoning_effort=…` config pair.
 * @param {unknown[]} args
 * @returns {boolean}
 */
export function hasEffortFlag(args) {
  if (!Array.isArray(args)) return false;
  return args.some((a, i) => {
    if (typeof a !== 'string') return false;
    for (const flag of EFFORT_FLAG_NAMES) {
      if (a.startsWith(`${flag}=`) && a.length > flag.length + 1) return true;
      if (a === flag) {
        const next = args[i + 1];
        if (typeof next === 'string' && next.length > 0 && !next.startsWith('-')) return true;
      }
    }
    return a.startsWith(`${CODEX_EFFORT_KEY}=`);
  });
}

/**
 * The argv fragment that applies an effort override to an effort-capable CLI: `['--effort',
 * <level>]` for claude and agy, `['-c', 'model_reasoning_effort=<level>']` for codex, `[]` when
 * the flag should be omitted (no override, provider has no effort control, or a user-baked pin
 * already sits in `existingArgs`).
 * @param {string|null|undefined} effort
 * @param {{id?:string, command?:string, models?:unknown[]}|null|undefined} provider
 * @param {unknown[]} [existingArgs]
 * @param {string|null} [model] - narrows the Antigravity ladder (see effortLevelsForProvider)
 * @returns {string[]}
 */
export function buildEffortArgs(effort, provider, existingArgs = [], model = null) {
  const effectiveEffort = resolveCliEffort(effort, provider, model);
  if (!effectiveEffort || hasEffortFlag(existingArgs)) return [];
  if (commandBasename(provider?.command) === 'pi') return ['--thinking', effectiveEffort];
  if (isCursorProvider(provider)) return []; // rides `--model`, not a flag — see above
  return isCodexProvider(provider)
    ? ['-c', `${CODEX_EFFORT_KEY}=${effectiveEffort}`]
    : ['--effort', effectiveEffort];
}

// Codex's config key (set via `-c <key>=<value>`) that gates its startup update check.
export const CODEX_UPDATE_CHECK_KEY = 'check_for_update_on_startup';
export const CODEX_AGENT_THREADS_KEY = 'agents.max_concurrent_threads_per_session';
export const CODEX_WORKSPACE_NETWORK_KEY = 'sandbox_workspace_write.network_access';
export const CODEX_WORKSPACE_WRITABLE_ROOTS_KEY = 'sandbox_workspace_write.writable_roots';
export const CODEX_PLUGINS_FEATURE_KEY = 'features.plugins';
export const CODEX_APPS_FEATURE_KEY = 'features.apps';
export const CODEX_HOOKS_FEATURE_KEY = 'features.hooks';

/**
 * Give a Codex swarm enough session threads for its root orchestrator plus every configured
 * worker.
 * @param {unknown} maxConcurrentThreads
 * @returns {string[]}
 */
export function buildCodexAgentThreadArgs(maxConcurrentThreads) {
  const limit = Number(maxConcurrentThreads);
  if (!Number.isSafeInteger(limit) || limit < 1) return [];
  return ['-c', `${CODEX_AGENT_THREADS_KEY}=${limit}`];
}

/**
 * True when the codex argv already pins the startup-update-check config, so a caller-supplied
 * value wins over the injected default.
 * @param {unknown[]} args
 * @returns {boolean}
 */
export function hasCodexUpdateCheckConfig(args) {
  if (!Array.isArray(args)) return false;
  const pin = `${CODEX_UPDATE_CHECK_KEY}=`;
  return args.some((a) => {
    if (typeof a !== 'string') return false;
    if (a.startsWith(pin)) return true; // standalone value of `-c`/`--config <key>=<v>`
    // Joined `--config=<key>=<v>` / `-c=<key>=<v>` — strip the flag prefix, then test.
    const joined = a.startsWith('--config=') ? a.slice(9) : a.startsWith('-c=') ? a.slice(3) : null;
    return joined !== null && joined.startsWith(pin);
  });
}

/**
 * The argv fragment that disables codex's interactive startup update check: `['-c',
 * 'check_for_update_on_startup=false']`, or `[]` when a user-baked pin already sits in
 * `existingArgs`.
 * @param {unknown[]} [existingArgs]
 * @returns {string[]}
 */
export function buildCodexStartupArgs(existingArgs = []) {
  if (hasCodexUpdateCheckConfig(existingArgs)) return [];
  return ['-c', `${CODEX_UPDATE_CHECK_KEY}=false`];
}

/** Every CLI config key PortOS itself injects as a `-c <key>=<value>` override. */
export const PORTOS_CLI_CONFIG_KEYS = Object.freeze([
  CODEX_AGENT_THREADS_KEY,
  CODEX_EFFORT_KEY,
  CODEX_UPDATE_CHECK_KEY,
  CODEX_WORKSPACE_NETWORK_KEY,
  CODEX_WORKSPACE_WRITABLE_ROOTS_KEY,
  CODEX_PLUGINS_FEATURE_KEY,
  CODEX_APPS_FEATURE_KEY,
  CODEX_HOOKS_FEATURE_KEY,
]);

/**
 * True when `key` is a startup/effort config key PortOS supplies via `-c` (see
 * PORTOS_CLI_CONFIG_KEYS).
 * @param {unknown} key
 * @returns {boolean}
 */
export function isPortosSuppliedConfigKey(key) {
  return typeof key === 'string' && PORTOS_CLI_CONFIG_KEYS.includes(key.trim());
}

/**
 * True when a provider command points at the OpenCode binary — matching the bare `opencode` on
 * PATH OR an absolute/relative path to it (`/opt/homebrew/bin/opencode`, common when the service
 * PATH can't resolve the CLI), with an optional Windows `.exe` suffix.
 * @param {string|null|undefined} command
 * @returns {boolean}
 */
export function isOpencodeCommand(command) {
  return commandBasename(command) === 'opencode';
}

/** The OpenCode agent a `no-tool` public-review stage runs as (`opencode run --agent …`). */
export const OPENCODE_PUBLIC_REVIEW_AGENT = 'plan';

/**
 * OpenCode's built-in tool-enabled agent — the one an attachable Stage 3 session runs as
 * (`providerVendors.js`) and the one `hardenOpencodeConfigForNoTool` must still empty.
 */
export const OPENCODE_BUILD_AGENT = 'build';

/**
 * OpenCode addresses models as `provider/model` (e.g. `ollama/qwen2.5:7b`); the bare Ollama id stored in `defaultModel` must be namespaced
 * with `ollama/` before it is passed to `opencode -m`. Idempotent.
 * @param {{command?:string, ollamaBacked?:boolean, lmstudioBacked?:boolean, mtplxBacked?:boolean, llamaBacked?:boolean, vllmBacked?:boolean, sglangBacked?:boolean, orcarouterBacked?:boolean}} provider
 * @param {string|null|undefined} model
 * @returns {string|null|undefined}
 */
export function prefixOpencodeModel(provider, model) {
  const namespace = getOpencodeLocalProviderNamespace(provider);
  if (!isOpencodeCommand(provider?.command) || !namespace || !model) return model;
  const id = String(model);
  if (isGatewayNamespace(namespace)) {
    // A gateway model id is ALREADY `vendor/model` (`anthropic/claude-sonnet-4`,
    // `orcarouter/auto`), and OpenCode splits provider/model on the FIRST slash only — so the
    // namespaced form is legitimately doubled (`openrouter/anthropic/claude-sonnet-4`,
    // `openrouter/openrouter/auto`).
    return id.startsWith(`${namespace}/${namespace}/`) ? id : `${namespace}/${id}`;
  }
  return id.startsWith(`${namespace}/`) ? id : `${namespace}/${id}`;
}

/**
 * The inverse of {@link prefixOpencodeModel} for a KNOWN runtime kind: one model id as the
 * daemon's own listing spells it, with the `<kind>/` namespace stripped.
 * @param {string|null|undefined} model
 * @param {string} kind - the local runtime kind (`llama`, `vllm`, `ollama`, …)
 * @returns {string|null}
 */
export function bareLocalModelId(model, kind) {
  if (typeof model !== 'string' || model.trim() === '' || isConfiguredDefaultModel(model)) return null;
  const trimmed = model.trim();
  return trimmed.startsWith(`${kind}/`) ? trimmed.slice(kind.length + 1) : trimmed;
}

/**
 * OpenCode's local OpenAI-compatible provider namespace, if this provider has opted into one.
 * @param {{ollamaBacked?:boolean, lmstudioBacked?:boolean, mtplxBacked?:boolean, llamaBacked?:boolean, vllmBacked?:boolean, sglangBacked?:boolean, gatewayBacked?:string, orcarouterBacked?:boolean}|null|undefined} provider
 * @returns {'ollama'|'lmstudio'|'mtplx'|'llama'|'vllm'|'sglang'|string|null}
 */
export function getOpencodeLocalProviderNamespace(provider) {
  if (provider?.ollamaBacked === true) return 'ollama';
  if (provider?.lmstudioBacked === true) return 'lmstudio';
  if (provider?.mtplxBacked === true) return 'mtplx';
  if (provider?.llamaBacked === true) return 'llama';
  if (provider?.vllmBacked === true) return 'vllm';
  if (provider?.sglangBacked === true) return 'sglang';
  // Hosted gateways (`providerGateways.js`) come LAST so a malformed record carrying both a local
  // marker and a gateway marker keeps its legacy local outcome, exactly as the old if-chain did
  // with `orcarouterBacked`.
  return gatewayIdForProvider(provider);
}

/**
 * The namespace above, but only when it names a LOCAL daemon — a hosted gateway
 * (`providerGateways.js`) is an OpenCode namespace and a remote API, so every consumer asking "is
 * there a daemon on this machine behind this provider?" has to exclude it.
 * @param {object|null|undefined} provider
 * @returns {'ollama'|'lmstudio'|'mtplx'|'llama'|'vllm'|'sglang'|null}
 */
export function localRuntimeNamespace(provider) {
  const namespace = getOpencodeLocalProviderNamespace(provider);
  return namespace && !isGatewayNamespace(namespace) ? namespace : null;
}

/**
 * True when an OpenCode process provider runs against a local OpenAI-compatible backend or a
 * hosted gateway — any namespace `getOpencodeLocalProviderNamespace` resolves — rather than a
 * vendor cloud model.
 * @param {object|null|undefined} provider
 * @returns {boolean}
 */
export function isOpencodeLocalProvider(provider) {
  return isOpencodeProvider(provider) && getOpencodeLocalProviderNamespace(provider) !== null;
}

/**
 * The Codex CLI's own `--local-provider` values, mapped from PortOS's local-runtime marker axis
 * (`localRuntimeNamespace` in providerModels.js).
 */
export const CODEX_OSS_LOCAL_PROVIDERS = Object.freeze({ ollama: 'ollama', lmstudio: 'lmstudio' });

/** The first Codex CLI release that ships `--oss` / `--local-provider`. */
export const CODEX_OSS_MIN_VERSION = '0.153.0';

/**
 * The `--local-provider` value for `provider`, or `null` when this record is not backed by a local
 * runtime Codex can serve.
 * @param {object|null|undefined} provider
 * @returns {string|null}
 */
export function codexOssLocalProvider(provider) {
  const namespace = localRuntimeNamespace(provider);
  return (namespace && CODEX_OSS_LOCAL_PROVIDERS[namespace]) || null;
}

/**
 * The local runtime this codex record is marked with but Codex cannot serve (`vllm`, `sglang`, …),
 * or `null`.
 * @param {object|null|undefined} provider
 * @returns {string|null}
 */
export function codexUnsupportedLocalRuntime(provider) {
  const namespace = localRuntimeNamespace(provider);
  return namespace && !CODEX_OSS_LOCAL_PROVIDERS[namespace] ? namespace : null;
}

/**
 * Shared because four call sites read the same variable and must agree on what counts as unusable:
 * `opencodeConfig.js`'s merge base, `localProviderRuntime.js`'s endpoint lookup,
 * `cliChildEnv.js`'s public-review allowlist, and the locality predicate below.
 * @param {unknown} value
 * @returns {object|null}
 */
export function parseOpencodeConfigContent(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const parsed = JSON.parse(value);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Every provider endpoint an OpenCode config object declares is on this machine.
 * @param {object|null|undefined} config - a parsed OpenCode config
 * @param {{requireDeclaration?: boolean}} [options]
 * @returns {boolean}
 */
export function opencodeConfigIsLocalOnly(config, { requireDeclaration = false } = {}) {
  if (!isPlainObject(config)) return false;
  const declared = isPlainObject(config.provider) ? Object.values(config.provider) : [];
  if (declared.length === 0) return !requireDeclaration;
  return declared.every((entry) => isLocalInstanceEndpoint(entry?.options?.baseURL));
}

/**
 * The same question asked of a PROVIDER RECORD, before its config has been built.
 * @param {object|null|undefined} provider
 * @returns {boolean}
 */
export function opencodeProviderIsLocalOnly(provider) {
  const stored = parseOpencodeConfigContent(provider?.envVars?.OPENCODE_CONFIG_CONTENT);
  return stored === null || opencodeConfigIsLocalOnly(stored);
}

/**
 * Claude Code on AWS Bedrock wants region-prefixed model ids (`global.anthropic.claude-opus-5`,
 * `us.anthropic.claude-opus-4-1-...-v1:0`).
 */

// Family → the env var Claude Code reads for that tier's resolved model.
const BEDROCK_FAMILY_ENV = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
};

/** True when the box is in Claude-Code-on-Bedrock mode. */
export const isBedrockEnabled = (env = process.env) => {
  const v = env?.CLAUDE_CODE_USE_BEDROCK;
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s !== '' && s !== '0' && s !== 'false' && s !== 'no';
};

/**
 * True when an id already carries a Bedrock region prefix (`global.anthropic.…`, `us.anthropic.…`,
 * `eu.anthropic.…`, `apac.anthropic.…`) or the bare `anthropic.…` form.
 */
export const hasBedrockRegionPrefix = (id) =>
  typeof id === 'string' && (/^[a-z]+\.anthropic\./i.test(id) || /^anthropic\./i.test(id));

const detectClaudeFamily = (id) => {
  if (typeof id !== 'string') return null;
  const lower = id.toLowerCase();
  return Object.keys(BEDROCK_FAMILY_ENV).find((fam) => lower.includes(fam)) || null;
};

/**
 * Map a bare Claude model id to its Bedrock form when (and only when) Bedrock mode is on.
 * @param {string|null|undefined} id
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null|undefined} the mapped id (or the input unchanged)
 */
export function toBedrockModelId(id, env = process.env) {
  if (!isBedrockEnabled(env)) return id;
  if (typeof id !== 'string' || !id) return id;
  if (hasBedrockRegionPrefix(id)) return id;
  if (!/claude/i.test(id)) return id; // not a Claude id — leave alone
  const family = detectClaudeFamily(id);
  if (family) {
    const override = env?.[BEDROCK_FAMILY_ENV[family]];
    if (hasBedrockRegionPrefix(override)) return override;
  }
  return `global.anthropic.${id}`;
}

// Dedup so the auto-correction notice prints once per (provider, model) per process rather than on
// every run.
const _warnedBareBedrockModels = new Set();

/**
 * One-time (per process, per provider+model) notice that a stored Claude-Code model id reads
 * non-Bedrock while the box is in Bedrock mode and is being auto-corrected for this run.
 */
export function warnBareBedrockModel(providerId, originalId, mappedId) {
  const key = `${providerId || 'claude-code'}::${originalId}`;
  if (_warnedBareBedrockModels.has(key)) return;
  _warnedBareBedrockModels.add(key);
  console.error(
    `⚠️ Provider '${providerId || 'claude-code'}' model '${originalId}' is bare but CLAUDE_CODE_USE_BEDROCK is set — auto-correcting to Bedrock id '${mappedId}' for this run (stored config unchanged; set a global.anthropic.* / us.anthropic.* model to silence).`,
  );
}

/**
 * Side-effecting convenience used at CLI-argv build time: map a bare Claude id to its Bedrock form
 * and emit the one-time auto-correction notice when the map actually changed the id.
 */
export function resolveBedrockCliModel(id, { env = process.env, providerId } = {}) {
  const mapped = toBedrockModelId(id, env);
  if (mapped !== id) warnBareBedrockModel(providerId, id, mapped);
  return mapped;
}

/**
 * Claude Code's first-party model ids spell a version with DASHES (`claude-fable-5-1`,
 * `claude-opus-4-8`), while the release is spoken and written with a dot ("Fable 5.1").
 * @param {string|null|undefined} id
 * @returns {string|null|undefined} the canonical id (or the input unchanged)
 */
export function normalizeClaudeModelId(id) {
  if (typeof id !== 'string' || !id) return id;
  if (hasBedrockRegionPrefix(id)) return id;
  if (!/^claude-(?:opus|sonnet|haiku|fable)-/i.test(id)) return id;
  return id.replace(/(\d)\.(?=\d)/g, '$1-');
}

// Dedup so the canonicalization notice prints once per (provider, model) per process rather than
// on every run, matching `warnBareBedrockModel`.
const _warnedDottedClaudeModels = new Set();

/**
 * The model string a Claude Code spawn should pass to `--model`: canonicalize a dotted first-party
 * id, then map it to its Bedrock form when the box is in Bedrock mode.
 * @param {string|null|undefined} id
 * @param {{env?:NodeJS.ProcessEnv, providerId?:string}} [opts]
 * @returns {string|null|undefined}
 */
export function resolveClaudeCliModel(id, { env = process.env, providerId } = {}) {
  const canonical = normalizeClaudeModelId(id);
  if (canonical !== id) {
    const key = `${providerId || 'claude-code'}::${id}`;
    if (!_warnedDottedClaudeModels.has(key)) {
      _warnedDottedClaudeModels.add(key);
      console.error(
        `⚠️ Provider '${providerId || 'claude-code'}' model '${id}' spells its version with a dot — Claude Code only serves the dashed id, using '${canonical}' for this run (update the provider's model list to silence).`,
      );
    }
  }
  return resolveBedrockCliModel(canonical, { env, providerId });
}

/**
 * The model string a TUI spawn should actually pass to `--model`, given the resolved launch
 * command.
 * @param {string} model - the already-resolved (non-sentinel) model id
 * @param {{id?:string, command?:string, ollamaBacked?:boolean, mtplxBacked?:boolean, envVars?:Record<string,string>}|null|undefined} provider
 * @param {string} [command] - resolved launch command (may differ from provider.command)
 * @returns {string}
 */
export function resolveInjectedTuiModel(model, provider, command = provider?.command) {
  if (isOpencodeCommand(command)) return prefixOpencodeModel(provider, model);
  if (!isClaudeCommand(command)) return model;
  return resolveClaudeCliModel(model, {
    env: { ...process.env, ...provider?.envVars },
    providerId: provider?.id,
  });
}

/**
 * Strip configured-default sentinels from a model list — the user-selectable view.
 * @param {string[]} models
 * @returns {string[]}
 */
export const filterSelectableModels = (models) =>
  (models || []).filter(m => !isConfiguredDefaultModel(m));

/** Detects whether the provider's stored argv already pins a model with a usable value. */
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
 * Strip dangling/empty `--model` / `-m` tokens (no value follows, or the joined form has an empty
 * value).
 * @param {unknown[]} args
 * @returns {unknown[]}
 */
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

/**
 * True when a provider command points at the Claude Code binary — the bare `claude` on PATH, an
 * absolute/relative path to it, or an optional Windows `.exe` suffix (same matching rules as
 * `isOpencodeCommand`).
 * @param {string|null|undefined} command
 * @returns {boolean}
 */
export function isClaudeCommand(command) {
  // An empty/blank command also counts as Claude: `buildCliSpawnConfig`'s default branch and the
  // TUI `inferTuiCommand` fallback both resolve a blank command to `claude` — a policy that
  // differs from the other predicates, so it stays here.
  if (command == null || command === '') return true;
  return commandBasename(command) === 'claude';
}

/**
 * True for an Ollama-backed provider that launches the Claude Code binary (`claude-ollama` /
 * `claude-ollama-tui`).
 * @param {{command?:string, ollamaBacked?:boolean}|null|undefined} provider
 * @param {string} [command] - resolved launch command when it differs from
 *   `provider.command` (the TUI path may infer it from the provider id)
 * @returns {boolean}
 */
export function isOllamaClaudeProvider(provider, command = provider?.command) {
  return provider?.ollamaBacked === true && isClaudeCommand(command);
}

/**
 * True when a provider explicitly configures its own GitHub credential (`GH_TOKEN` or
 * `GITHUB_TOKEN`) in `envVars`.
 * @param {{envVars?: Record<string,unknown>}} provider
 * @returns {boolean}
 */
export function providerSuppliesGithubToken(provider) {
  const env = provider?.envVars;
  return !!env && ('GH_TOKEN' in env || 'GITHUB_TOKEN' in env);
}

/**
 * Lean-context flags for local-model Claude Code sessions: - `--bare` — skip hooks, plugin sync,
 * auto-memory, and AGENTS.md auto-discovery (the user's personal environment derails small
 * models). - `--strict-mcp-config` — with no `--mcp-config` given, load zero MCP servers (their
 * tool schemas alone can blow a small Ollama context).
 */
export const LEAN_CLAUDE_ARGS = ['--bare', '--strict-mcp-config'];

/**
 * Append the lean-context flags for Ollama-backed Claude providers.
 * @param {{command?:string, ollamaBacked?:boolean, args?:string[]}} provider
 * @param {string[]} args - argv built so far
 * @param {string} [command] - resolved launch command (see isOllamaClaudeProvider)
 * @returns {string[]}
 */
export function applyLeanClaudeArgs(provider, args, command = provider?.command) {
  if (!isOllamaClaudeProvider(provider, command)) return args;
  return [...args, ...LEAN_CLAUDE_ARGS.filter(flag => !args.includes(flag))];
}

/** Extract the pinned model id from provider.args when a model flag is baked in. */
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
