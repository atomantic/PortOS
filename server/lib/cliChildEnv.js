/**
 * Child-environment composition for every AI-CLI spawn.
 *
 * Two entry points:
 *   - `buildCliChildEnv` — a COMPLETE child env, handed straight to `spawn`.
 *   - `composeProviderEnv` — just the ordered provider layers, for sites that
 *     produce a DELTA someone else bases and spawns (CoS runner payload, shell
 *     session env overlay).
 *
 * Layer ORDER is load-bearing: `before` sits below `provider.envVars` (so an
 * explicit provider `GH_TOKEN` overrides the repo-owner-pinned one) and `extra`
 * above it (TERM/COLORTERM for a PTY). `cliChildEnv.test.js` asserts the order.
 *
 * `lib/aiToolkit/runner.js` is vendored (see `lib/aiToolkit/AGENTS.md`) and keeps its own copy.
 */

import { withSpawnCwdEnv } from './spawnCwd.js';
import { buildOpencodeEnvVars } from './opencodeConfig.js';
import { buildPiEndpointEnvVars } from './pi.js';
import {
  localRuntimeNamespace,
  isClaudeCommand,
  parseOpencodeConfigContent,
  opencodeConfigIsLocalOnly,
} from './provider/providerModels.js';
import { isLocalInstanceEndpoint } from './localEndpoint.js';
import { SPLASH_CONTEXT } from './splashRuntime.js';
import { splashHarnessTarget } from './provider/splashHarnessContext.js';
import { agentGuardEnv } from './agentGuard/index.js';
import { join, resolve } from 'path';
import { buildSafeCliBaseEnv, withTorchCompilerCacheEnv } from './processEnv.js';
import { isPublicReviewNoToolProfile, isPublicReviewRestrictedProfile } from './agent/agentExecutionProfiles.js';

// Claude Code defaults to 32K output tokens; thinking-capable local models can
// exceed that and wedge at an empty composer. Widened only for a Claude harness
// pointed at a LOCAL daemon; provider.envVars still wins.
const CLAUDE_LOCAL_MAX_OUTPUT_TOKENS = '65536';

// A local daemon sends nothing until prefill completes (minutes for a Stage 3
// review prompt). Claude Code's first-byte path has four ceilings, all widened:
//   • the Bun `fetch` timeout (~360s): `timeout: false` is passed only when
//     `API_FORCE_IDLE_TIMEOUT` is explicitly `0`; otherwise a silent request is
//     re-sent every ~361s regardless of other knobs.
//   • the first-byte window: `API_TIMEOUT_MS` minus a second.
//   • the byte-stream idle watchdog: `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS`,
//     clamped to 30 minutes.
//   • the stream idle timeout: `CLAUDE_STREAM_IDLE_TIMEOUT_MS`, clamped to 30 minutes.
// A request that never answers still ends (`createRetryStallGate` in
// tuiHandshake.js, run supervision). Cloud Claude keeps stock values.
const CLAUDE_LOCAL_API_TIMEOUT_MS = '3600000';
const CLAUDE_LOCAL_FORCE_IDLE_TIMEOUT = '0';
const CLAUDE_LOCAL_STREAM_IDLE_TIMEOUT_MS = '1800000';

/**
 * True for a Claude Code harness talking to a local OpenAI/Anthropic-compatible
 * daemon (Ollama, SGLang, ...).
 *
 * Keyed on the local-backend marker set, not `ollamaBacked` alone. Hosted gateways
 * (`providerGateways.js`) are excluded; their upstream models own their budgets.
 */
function isLocalBackedClaude(provider) {
  return !!localRuntimeNamespace(provider) && isClaudeCommand(provider?.command);
}

/**
 * Every knob `claudeLocalEnvDefaults` composes for a local-backed Claude
 * harness.
 *
 * Both public-review allowlists must pass all of them, or the stage reaches the
 * local daemon on cloud-shaped ceilings. Keep in lockstep with
 * `claudeLocalEnvDefaults`; `cliChildEnv.test.js` enforces it.
 */
const CLAUDE_LOCAL_TUNING_ENV_KEYS = [
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'API_TIMEOUT_MS', 'API_FORCE_IDLE_TIMEOUT',
  'CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS', 'CLAUDE_STREAM_IDLE_TIMEOUT_MS', 'MAX_THINKING_TOKENS',
];

function claudeLocalEnvDefaults(provider) {
  if (!isLocalBackedClaude(provider)) return {};
  return {
    // Splash's usual 64K window needs room for prompts and tool results.
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: provider.splashBacked === true ? '8192' : CLAUDE_LOCAL_MAX_OUTPUT_TOKENS,
    ...(provider.splashBacked === true ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(SPLASH_CONTEXT) } : {}),
    API_TIMEOUT_MS: CLAUDE_LOCAL_API_TIMEOUT_MS,
    API_FORCE_IDLE_TIMEOUT: CLAUDE_LOCAL_FORCE_IDLE_TIMEOUT,
    CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: CLAUDE_LOCAL_STREAM_IDLE_TIMEOUT_MS,
    CLAUDE_STREAM_IDLE_TIMEOUT_MS: CLAUDE_LOCAL_STREAM_IDLE_TIMEOUT_MS,
    // Zero makes Claude Code omit the `thinking` field, which Ollama maps to
    // non-thinking mode; unset keeps the adaptive budget. Ollama-only: other
    // local backends take `chat_template_kwargs.enable_thinking`, which the
    // Anthropic wire cannot carry, so the var would be a no-op off switch (see
    // `generationControlsFor` in client/src/utils/providerModels.js).
    ...(provider.ollamaBacked === true && provider.thinking === false
      ? { MAX_THINKING_TOKENS: '0' }
      : {}),
  };
}

function claudeContextOverride(provider, model, splashClaudeMaxTokens) {
  const value = provider?.harnessContext;
  const pinnedContext = !value?.model && Number.isSafeInteger(value?.tokens) && provider?.command && isClaudeCommand(provider.command)
    && (provider.envVars?.ANTHROPIC_BASE_URL || provider.envVars?.CLAUDE_CODE_MAX_CONTEXT_TOKENS);
  const hasSplashBudget = Number.isSafeInteger(splashClaudeMaxTokens) && splashClaudeMaxTokens > 0
    && splashHarnessTarget(provider, model)?.kind === 'claude';
  if (!pinnedContext && !hasSplashBudget) return {};
  const contextEnv = pinnedContext ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(value.tokens) } : {};
  if (provider.envVars?.CLAUDE_CODE_MAX_OUTPUT_TOKENS != null) return contextEnv;
  // Splash clamps a tool-free request to the real context left after its
  // prompt. A harness pin is not evidence of how much the runtime is serving.
  if (hasSplashBudget) {
    return { ...contextEnv, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(splashClaudeMaxTokens) };
  }
  const defaultOutput = provider.splashBacked === true ? 8192 : isLocalBackedClaude(provider) ? Number(CLAUDE_LOCAL_MAX_OUTPUT_TOKENS) : 32000;
  const outputCap = Math.floor(value.tokens / 4);
  return {
    ...contextEnv,
    ...(defaultOutput > outputCap ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(outputCap) } : {}),
  };
}

/**
 * The ordered provider env layers, without a base env, PWD pin, or strip.
 *
 * For sites that build a DELTA; sites that spawn directly want `buildCliChildEnv`.
 *
 * @param {object} options
 * @param {object|null} [options.before] - layered first, so `provider.envVars`
 *   overrides it (forgeTokenEnv, claudeSettingsEnv).
 * @param {{command?:string, envVars?:object, models?:string[], defaultModel?:string|null, ollamaBacked?:boolean, lmstudioBacked?:boolean, mtplxBacked?:boolean, llamaBacked?:boolean, vllmBacked?:boolean, sglangBacked?:boolean, gatewayBacked?:string, orcarouterBacked?:boolean, thinking?:boolean}|null} [options.provider]
 * @param {string|null} [options.model] - the model being run this invocation,
 *   unioned into the OpenCode declared-models map. Omit when the site has no
 *   per-call model — `provider.defaultModel` is always declared regardless.
 * @param {object|null} [options.extra] - layered last, so it overrides every
 *   other layer including `provider.envVars` (TERM/COLORTERM for a PTY).
 * @param {string|null} [options.safetyProfile] - a public-review execution
 *   profile, which hardens the OpenCode config (see `buildOpencodeEnvVars`).
 * @param {boolean} [options.toolFree=false] - apply OpenCode tool restrictions for a private one-shot.
 * @param {number} [options.splashClaudeMaxTokens] - output allowance for a managed Splash Claude launch.
 * @returns {object} a fresh object holding only these layers
 */
export function composeProviderEnv({ before = null, provider = null, model = null, extra = null, safetyProfile = null, toolFree = false, splashClaudeMaxTokens } = {}) {
  // `authOnly` is an identity-only provider view (`cliProviderAuthDescriptor`),
  // NOT a record to generate env from: generators below sit ABOVE `before` and
  // would overwrite the already-composed env (e.g. OpenCode's declared-models map).
  if (provider?.authOnly) return { ...(before || {}), ...(extra || {}) };
  return {
    ...(before || {}),
    ...claudeLocalEnvDefaults(provider),
    ...(provider?.envVars || {}),
    ...claudeContextOverride(provider, model, splashClaudeMaxTokens),
    // Rebuilds OPENCODE_CONFIG_CONTENT with a declared models map so the injected
    // namespaced `--model` is accepted; lands after provider.envVars to override
    // the provider's STATIC copy. `safetyProfile` reaches it because OpenCode's
    // tool posture lives in that config (`hardenOpencodeConfigForNoTool`).
    ...buildOpencodeEnvVars(provider, model, { safetyProfile, toolFree }),
    // A Pi record on a custom endpoint hands it to the PortOS endpoint extension.
    ...buildPiEndpointEnvVars(provider, model),
    ...(extra || {}),
  };
}

// Public contributor content runs through a no-tools local harness. Keep only
// runtime essentials plus the local model endpoint; never pass forge, cloud, SSH,
// auth, or arbitrary provider env vars. A second boundary beside the CLI argv.
const PUBLIC_REVIEW_ENV_KEYS = new Set([
  'PATH', 'Path', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LANGUAGE', 'TERM', 'COLORTERM', 'TZ', 'NODE', 'NODE_ENV', 'NODE_PATH',
  'NVM_DIR', 'NVM_BIN', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  'SystemRoot', 'SystemDrive', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'APPDATA',
  'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'HOMEDRIVE', 'HOMEPATH',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_SMALL_FAST_MODEL',
  ...CLAUDE_LOCAL_TUNING_ENV_KEYS,
]);

// A Claude CLI on a LOCAL Anthropic-compatible runtime authenticates with a
// placeholder token, and its `--bare` argv disables the keychain, so without the
// token it exits "Not logged in". Keep the credential only for a local base URL;
// elsewhere it is a real cloud credential and stays stripped. Uses
// `isLocalInstanceEndpoint` so this boundary classifies hosts exactly like the
// runtime resolver (it also counts `0.0.0.0` and `::` as local).
const LOCAL_ANTHROPIC_CREDENTIAL_KEYS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'];

function localAnthropicCredentialEnv(env) {
  if (!isLocalInstanceEndpoint(env?.ANTHROPIC_BASE_URL)) return {};
  return Object.fromEntries(LOCAL_ANTHROPIC_CREDENTIAL_KEYS
    .filter((key) => env[key] != null)
    .map((key) => [key, env[key]]));
}

/**
 * An OpenCode run carries its endpoint, models and (under `no-tool`) tool posture
 * in `OPENCODE_CONFIG_CONTENT`; stripping it would point the child at the user's
 * own `~/.config/opencode`. Keep it only when every declared endpoint is
 * loopback; a config naming a hosted gateway carries a real cloud key and stays
 * stripped (`providerVendors.js` scopes the OpenCode recipe to local namespaces).
 */
function opencodeLocalConfigEnv(env) {
  const raw = env?.OPENCODE_CONFIG_CONTENT;
  // `requireDeclaration`: a value declaring no endpoint was not built by PortOS
  // for an eligible provider, so it is dropped.
  return opencodeConfigIsLocalOnly(parseOpencodeConfigContent(raw), { requireDeclaration: true })
    ? { OPENCODE_CONFIG_CONTENT: raw }
    : {};
}

function allowlistEnv(env, keys) {
  return {
    ...Object.fromEntries(Object.entries(env || {}).filter(([key, value]) => (
      value != null && (keys.has(key) || key.startsWith('LC_'))
    ))),
    ...localAnthropicCredentialEnv(env),
    ...opencodeLocalConfigEnv(env),
  };
}

// Only these keys may come from bootstrap output; PATH, NODE_OPTIONS or config
// could otherwise replace the enforced recipe without changing its argv.
const BOOTSTRAP_REVIEW_AUTH_KEYS = new Set([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_BASE',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_API_KEY',
  'XAI_API_KEY', 'GROK_API_KEY', 'KIMI_API_KEY', 'MOONSHOT_API_KEY', 'CURSOR_API_KEY',
]);

export function buildPublicReviewCliEnv(env = {}) {
  return allowlistEnv(env, PUBLIC_REVIEW_ENV_KEYS);
}

function isolatedMtplxOpenCodeEnv(baseEnv, provider, model, directory, cwd) {
  // OpenCode deep-merges MCP and permissions, so an empty inline map can't
  // clear definitions loaded from user files. Give it fresh config and auth
  // directories and disable project discovery before the CLI can read either.
  const inherited = Object.fromEntries(Object.entries(baseEnv).filter(([key]) => [
    'PATH', 'Path', 'SystemRoot', 'ComSpec', 'PATHEXT', 'ProgramData', 'TMPDIR', 'TMP', 'TEMP', 'LANG',
  ].includes(key)));
  return withSpawnCwdEnv({
    ...inherited,
    HOME: directory,
    USERPROFILE: directory,
    XDG_CONFIG_HOME: join(directory, 'config'),
    XDG_DATA_HOME: join(directory, 'data'),
    XDG_STATE_HOME: join(directory, 'state'),
    XDG_CACHE_HOME: join(directory, 'cache'),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_AUTOCOMPACT: '1',
    ...buildOpencodeEnvVars(provider, model, { toolFree: true, restrictedMtplx: true }),
  }, cwd);
}

// The actions stage may use its vendor's workspace sandbox but must never inherit
// forge credentials, SSH config, cloud keys or arbitrary provider env. An
// allowlist, not a blocklist, so a new server secret never leaks into a
// contributor-controlled review.
const PUBLIC_REVIEW_ACTIONS_ENV_KEYS = new Set([
  'PATH', 'Path', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LANGUAGE', 'TERM', 'COLORTERM', 'TZ', 'NODE', 'NODE_ENV', 'NODE_PATH',
  'NVM_DIR', 'NVM_BIN',
  'SystemRoot', 'SystemDrive', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'APPDATA',
  'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'HOMEDRIVE', 'HOMEPATH',
  // Local Claude wrappers need the endpoint (else they hit the cloud or nothing)
  // and their tuning, which are credential-free numeric knobs.
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_SMALL_FAST_MODEL',
  ...CLAUDE_LOCAL_TUNING_ENV_KEYS,
]);

export function buildPublicReviewActionsCliEnv(env = {}) {
  return allowlistEnv(env, PUBLIC_REVIEW_ACTIONS_ENV_KEYS);
}

/**
 * Compose the complete environment an AI-CLI child process is spawned with.
 *
 * Layering, lowest precedence first: `baseEnv` → the `composeProviderEnv` layers
 * → then `PWD` pinned to `cwd`, `CLAUDECODE` stripped, and — only when `guard`
 * is true — the pm2 guard shim prepended to the final `PATH`.
 *
 * @param {object} options
 * @param {NodeJS.ProcessEnv|object} [options.baseEnv=process.env] - env to
 *   start from. It is filtered through `buildSafeCliBaseEnv`; every later
 *   explicit layer still overlays it.
 * @param {object|null} [options.before] - see `composeProviderEnv`.
 * @param {object|null} [options.provider] - see `composeProviderEnv`.
 * @param {string|null} [options.model] - see `composeProviderEnv`.
 * @param {string|undefined|null} options.cwd - the directory being handed to
 *   `spawn`/`pty.spawn`; `PWD` is pinned to it (see `withSpawnCwdEnv`). Pass it
 *   whenever the spawn names a cwd; `server/test/guards/runtime/spawnCwd.test.js` only counts such a call.
 * @param {object|null} [options.extra] - see `composeProviderEnv`.
 * @param {object|null} [options.bootstrapEnv] - Explicit credential-command output; only recognized auth keys pass, in ordinary runs or an opted-in no-tool review.
 * @param {boolean} [options.toolFree=false] - see `composeProviderEnv`.
 * @param {number} [options.splashClaudeMaxTokens] - output allowance for a managed Splash Claude launch.
 * @param {string} [options.openCodeIsolationDir] - private per-run directory for the restricted MTPLX OpenCode recipe.
 * @param {boolean} [options.guard=false] - prepend the pm2 guard shim onto the
 *   final `PATH` so an unrestricted agent can't `pm2 kill` the shared daemon.
 *   Only agent-spawning sites opt in.
 * @returns {object} a fresh env object safe to hand straight to `spawn`
 */
export function buildCliChildEnv({
  baseEnv = process.env,
  before = null,
  provider = null,
  model = null,
  cwd,
  extra = null,
  guard = false,
  bootstrapEnv = null,
  safetyProfile = null,
  toolFree = false,
  splashClaudeMaxTokens,
  openCodeIsolationDir,
} = {}) {
  if (toolFree && openCodeIsolationDir) return isolatedMtplxOpenCodeEnv(baseEnv, provider, model, openCodeIsolationDir, cwd);
  const composed = withTorchCompilerCacheEnv(withSpawnCwdEnv(
    { ...buildSafeCliBaseEnv(baseEnv, provider), ...composeProviderEnv({ before, provider, model, extra, safetyProfile, toolFree, splashClaudeMaxTokens }) },
    cwd,
  ), join(resolve(cwd || process.cwd()), '.cache'));

  const env = isPublicReviewNoToolProfile(safetyProfile)
    ? buildPublicReviewCliEnv(composed)
    : isPublicReviewRestrictedProfile(safetyProfile)
      ? buildPublicReviewActionsCliEnv(composed)
      : composed;

  if ((!safetyProfile || isPublicReviewNoToolProfile(safetyProfile)) && provider?.credentialBootstrap?.envCommand) {
    Object.assign(env, Object.fromEntries(Object.entries(bootstrapEnv || {})
      .filter(([key, value]) => BOOTSTRAP_REVIEW_AUTH_KEYS.has(key) && typeof value === 'string')));
  }

  // Else a spawned Claude CLI thinks it is nested in the session PortOS runs in.
  delete env.CLAUDECODE;

  // Applied to the FINAL PATH, or a provider-configured PATH drops the shim.
  if (guard) Object.assign(env, agentGuardEnv(env));

  return env;
}
