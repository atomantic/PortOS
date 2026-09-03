/**
 * Child-environment composition for every AI-CLI spawn.
 *
 * Ten sites independently rebuilt the same env layering, and three separate
 * fixes each paid an N-file sweep to keep them in step: the OpenCode
 * declared-models map (#2190/#2243), the `CLAUDECODE` strip, and the `PWD` pin
 * (#3193). Every time, the guard against missing a site was "a reviewer noticed"
 * or a source-grep test — and one of those sweeps did miss a site (see the
 * comment at `services/agentLifecycle.js#spawnViaRunner`). This module owns the
 * composition so the next env-level concern is a one-file change (#3194).
 *
 * Two entry points, because the sites split into two shapes:
 *
 *   - `buildCliChildEnv` — a COMPLETE child env, handed straight to `spawn`.
 *   - `composeProviderEnv` — just the ordered provider layers, for the sites
 *     that produce a DELTA someone else bases and spawns (the CoS runner
 *     payload, a shell session's env overlay).
 *
 * The layer ORDER is the load-bearing part, and the sites do not all layer the
 * same way — flattening them into one order would silently change which value
 * wins:
 *
 *   - the agent spawners put `forgeTokenEnv`/`claudeSettingsEnv` BEFORE
 *     `provider.envVars`, so an explicit provider `GH_TOKEN` still overrides the
 *     repo-owner-pinned one;
 *   - the PTY runners put `TERM`/`COLORTERM` AFTER everything, so the terminal
 *     is always truecolor regardless of provider config.
 *
 * Hence two distinct slots — `before` (lower precedence than the provider) and
 * `extra` (higher) — rather than one. `cliChildEnv.test.js` asserts the composed
 * order for each call site, and fails when a new site hand-rolls it instead.
 *
 * Deliberately NOT in scope: a `spawnAiCli({ command, args, cwd, env })` wrapper
 * that would also own cwd resolution and the Windows `.cmd` shim. The spawn
 * shapes differ too much (child_process vs node-pty vs an HTTP hand-off to the
 * CoS runner, stdio variants, kill-tree wiring) to fold in the same change.
 * `lib/aiToolkit/runner.js` is also out of scope: it is vendored and must not
 * import out to other PortOS modules (see `lib/aiToolkit/AGENTS.md`), and its
 * spawn is dormant under PortOS's `setCliRunner` override, so it keeps its
 * inline copy.
 */

import { withSpawnCwdEnv } from './spawnCwd.js';
import { buildOpencodeEnvVars } from './opencodeConfig.js';
import { getOpencodeLocalProviderNamespace, isClaudeCommand } from './providerModels.js';
import { isGatewayNamespace } from './providerGateways.js';
import { agentGuardEnv } from './agentGuard/index.js';
import { buildSafeCliBaseEnv } from './processEnv.js';
import { isPublicReviewNoToolProfile, isPublicReviewRestrictedProfile } from './agentExecutionProfiles.js';

// Claude Code defaults to 32K output tokens. Thinking-capable local models can
// legitimately spend more than that before returning their final tool call;
// when they do, Claude Code paints a terminal API Error and waits forever at an
// empty composer. Cloud Claude models own their own output budgets, so widen the
// ceiling only for a Claude harness pointed at a LOCAL daemon. A value in
// provider.envVars still wins below.
const CLAUDE_LOCAL_MAX_OUTPUT_TOKENS = '65536';

/**
 * True for a Claude Code harness talking to a local OpenAI/Anthropic-compatible
 * daemon — `claude-ollama` and `claude-sglang` today, plus any renamed or
 * hand-built provider carrying one of the local-backend markers.
 *
 * Keyed on the marker set rather than `ollamaBacked` alone: SGLang serves an
 * Anthropic-compatible `/v1/messages` endpoint, so a `claude` binary drives it
 * exactly the way it drives Ollama, and the 32K-output wedge above is a
 * property of "local thinking-capable model behind the Claude binary", not of
 * Ollama specifically. Hosted gateways (`providerGateways.js`) are excluded —
 * their upstream models own their own budgets, the same carve-out
 * `localRuntimeKind` makes.
 */
function isLocalBackedClaude(provider) {
  const namespace = getOpencodeLocalProviderNamespace(provider);
  return !!namespace && !isGatewayNamespace(namespace) && isClaudeCommand(provider?.command);
}

function claudeLocalEnvDefaults(provider) {
  if (!isLocalBackedClaude(provider)) return {};
  return {
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: CLAUDE_LOCAL_MAX_OUTPUT_TOKENS,
    // Claude Code omits the Anthropic-compatible `thinking` field when this is
    // zero, which Ollama maps to Qwen's non-thinking mode. Do not set a value
    // when enabled: Claude retains its normal adaptive budget.
    //
    // Ollama-only on purpose. Every other local backend takes its thinking
    // switch as `chat_template_kwargs.enable_thinking`, which the Anthropic
    // wire cannot carry — on SGLang an omitted `thinking` field falls through
    // to Qwen3.8's chat-template default, which is thinking ON. Emitting the
    // var there would look like an off switch while changing nothing, so the
    // provider card does not offer the toggle for those records either (see
    // `generationControlsFor` in client/src/utils/providers.js).
    ...(provider.ollamaBacked === true && provider.thinking === false
      ? { MAX_THINKING_TOKENS: '0' }
      : {}),
  };
}

/**
 * The ordered provider env layers, without a base env, PWD pin, or strip.
 *
 * Use this for a site that builds a DELTA — an overlay another layer bases and
 * spawns (`spawnAgentViaRunner`'s `envVars` payload, `createShellSession`'s
 * `env`). Sites that spawn directly want `buildCliChildEnv` instead.
 *
 * @param {object} options
 * @param {object|null} [options.before] - layered first, so `provider.envVars`
 *   overrides it (forgeTokenEnv, claudeSettingsEnv).
 * @param {{command?:string, envVars?:object, models?:string[], defaultModel?:string|null, ollamaBacked?:boolean, mtplxBacked?:boolean, llamaBacked?:boolean, vllmBacked?:boolean, sglangBacked?:boolean, gatewayBacked?:string, orcarouterBacked?:boolean, thinking?:boolean}|null} [options.provider]
 * @param {string|null} [options.model] - the model being run this invocation,
 *   unioned into the OpenCode declared-models map. Omit when the site has no
 *   per-call model — `provider.defaultModel` is always declared regardless.
 * @param {object|null} [options.extra] - layered last, so it overrides every
 *   other layer including `provider.envVars` (TERM/COLORTERM for a PTY).
 * @returns {object} a fresh object holding only these layers
 */
export function composeProviderEnv({ before = null, provider = null, model = null, extra = null } = {}) {
  return {
    ...(before || {}),
    ...claudeLocalEnvDefaults(provider),
    ...(provider?.envVars || {}),
    // Rebuilds OPENCODE_CONFIG_CONTENT with a declared models map for OpenCode
    // local providers (an empty object for everyone else) so the injected
    // namespaced `--model` isn't rejected as "not valid" — see #2190. It lands
    // after provider.envVars to override the provider's STATIC
    // OPENCODE_CONFIG_CONTENT, which it was built from.
    ...buildOpencodeEnvVars(provider, model),
    ...(extra || {}),
  };
}

// Public contributor content is run through a no-tools local Claude wrapper.
// Keep only runtime essentials plus the local Anthropic-compatible endpoint;
// in particular, never pass forge, cloud, SSH, auth, or arbitrary provider env
// vars into the child. This is a second boundary in addition to the CLI argv.
const PUBLIC_REVIEW_ENV_KEYS = new Set([
  'PATH', 'Path', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LANGUAGE', 'TERM', 'COLORTERM', 'TZ', 'NODE', 'NODE_ENV', 'NODE_PATH',
  'NVM_DIR', 'NVM_BIN', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  'SystemRoot', 'SystemDrive', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'APPDATA',
  'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'HOMEDRIVE', 'HOMEPATH',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'MAX_THINKING_TOKENS',
]);

// A Claude CLI pointed at a LOCAL Anthropic-compatible runtime (the Ollama and
// SGLang wrappers) authenticates with a placeholder token that means nothing
// outside that loopback endpoint, and its lean argv passes `--bare`, which
// disables the keychain — so without the token the CLI exits "Not logged in"
// before reading the prompt. Keep the credential only for a loopback base URL;
// against any other host it is a real cloud credential and stays stripped.
const LOCAL_ANTHROPIC_CREDENTIAL_KEYS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'];
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function localAnthropicCredentialEnv(env) {
  let hostname;
  try {
    hostname = new URL(env?.ANTHROPIC_BASE_URL).hostname.toLowerCase();
  } catch {
    return {};
  }
  if (!LOOPBACK_HOSTNAMES.has(hostname) && !hostname.startsWith('127.')) return {};
  return Object.fromEntries(LOCAL_ANTHROPIC_CREDENTIAL_KEYS
    .filter((key) => env[key] != null)
    .map((key) => [key, env[key]]));
}

function allowlistEnv(env, keys) {
  return {
    ...Object.fromEntries(Object.entries(env || {}).filter(([key, value]) => (
      value != null && (keys.has(key) || key.startsWith('LC_'))
    ))),
    ...localAnthropicCredentialEnv(env),
  };
}

export function buildPublicReviewCliEnv(env = {}) {
  return allowlistEnv(env, PUBLIC_REVIEW_ENV_KEYS);
}

// The actions stage is allowed to use its vendor's own workspace sandbox for
// repository inspection and tests, but it must never inherit forge credentials, SSH
// configuration, cloud-provider keys, or arbitrary provider env vars. This is
// deliberately a second strict allowlist rather than a blocklist: a new secret
// added to the server or provider environment must not silently become visible
// to a contributor-controlled review. The deterministic output hook owns every
// forge mutation after the model exits.
const PUBLIC_REVIEW_ACTIONS_ENV_KEYS = new Set([
  'PATH', 'Path', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LANGUAGE', 'TERM', 'COLORTERM', 'TZ', 'NODE', 'NODE_ENV', 'NODE_PATH',
  'NVM_DIR', 'NVM_BIN',
  'SystemRoot', 'SystemDrive', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'APPDATA',
  'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'HOMEDRIVE', 'HOMEPATH',
  // The local Claude wrappers are eligible for this stage too; without the
  // endpoint they would talk to the cloud (or, with `--bare`, to nothing).
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_SMALL_FAST_MODEL',
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
 *   `spawn`/`pty.spawn`; `PWD` is pinned to it (see `withSpawnCwdEnv`, #3193).
 *   Pass it whenever the spawn names a cwd — omitting it silently reopens #3193,
 *   which is why `spawnCwd.test.js` only counts a call carrying `cwd` as a pin.
 * @param {object|null} [options.extra] - see `composeProviderEnv`.
 * @param {boolean} [options.guard=false] - prepend the pm2 guard shim onto the
 *   final `PATH` so an unrestricted agent can't `pm2 kill` the shared daemon.
 *   Only the agent-spawning sites opt in; the Run Prompt / fire-and-collect
 *   paths keep today's unguarded behavior.
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
  safetyProfile = null,
} = {}) {
  const composed = withSpawnCwdEnv(
    { ...buildSafeCliBaseEnv(baseEnv, provider), ...composeProviderEnv({ before, provider, model, extra }) },
    cwd,
  );

  const env = isPublicReviewNoToolProfile(safetyProfile)
    ? buildPublicReviewCliEnv(composed)
    : isPublicReviewRestrictedProfile(safetyProfile)
      ? buildPublicReviewActionsCliEnv(composed)
      : composed;

  // CLAUDECODE is set when PortOS itself runs inside Claude Code; passing it
  // through would make a spawned Claude CLI think it's nested in that session.
  delete env.CLAUDECODE;

  // Must be applied to the FINAL PATH (after every override above), or a
  // provider-configured PATH would drop the shim back off the front.
  if (guard) Object.assign(env, agentGuardEnv(env));

  return env;
}
