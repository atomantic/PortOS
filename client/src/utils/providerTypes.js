/**
 * What KIND of provider a record is: the `cli`/`tui`/`api` type enum and its
 * predicates, the vendor-harness predicates keyed on the shipped ids plus the
 * launch command's basename (so a path-configured or renamed `codex`/`agy`/
 * `kimi`/`cursor-agent`/`grok`/`claude` still qualifies), and the structural
 * backend markers (`ollamaBacked`, `lmstudioBacked`, …) a wrapper record carries.
 *
 * Browser MIRROR of the predicates in `server/lib/providerModels.js` (the
 * `isXProvider` family, `commandBasename`, `localRuntimeNamespace`),
 * `server/lib/aiToolkit/constants.js#PROVIDER_TYPES` and
 * `server/lib/aiToolkit/providers.js#isOllamaBackedProvider` — keep in lockstep.
 * Every other provider helper module builds on these; this one imports only
 * the gateway registry.
 *
 * Re-exported by `./providers.js` for existing `utils/providers` imports.
 */

import { isGatewayBackedProvider } from './providerGateways.js';

// Copy of server/lib/providerModels.js#commandBasename (the predicates in this
// file are the one provider table still copied rather than re-exported — see
// the header). Strip the directory + a Windows `.exe` suffix so a
// path-configured command (/opt/homebrew/bin/grok) matches the bare vendor name.
// Keep in lockstep with the server helper (only `.exe` is stripped, not `.cmd`).
export const commandBasename = (command) =>
  typeof command === 'string' && command !== ''
    ? command.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '')
    : '';

/**
 * True when a provider is codex-flavored — the shipped `codex`/`codex-tui` ids
 * or any provider whose launch command basename is `codex` (path/exe tolerant).
 * MIRROR of `isCodexProvider` in server/lib/providerModels.js — keep in lockstep.
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @returns {boolean}
 */
export const isCodexProvider = (provider) => {
  const id = String(provider?.id || '').toLowerCase();
  return id === 'codex' || id === 'codex-tui' || commandBasename(provider?.command) === 'codex';
};

/**
 * True when a provider is Grok-Build-flavored. MIRROR of `isGrokProvider` in
 * server/lib/providerModels.js — the shipped `grok-cli`/`grok-tui` ids or a
 * `grok` command basename. The bare `grok` id is the HTTP API provider, which
 * has no CLI flag to carry an effort level, and is excluded.
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @returns {boolean}
 */
export const isGrokProvider = (provider) => {
  const id = String(provider?.id || '').toLowerCase();
  return id === 'grok-cli' || id === 'grok-tui' || commandBasename(provider?.command) === 'grok';
};

/**
 * True when a CLI/TUI record uses Codex's ChatGPT subscription. This mirrors
 * server/lib/codexAccount.js: the command, not an editable provider id, owns
 * the account contract.
 * @param {{type?:string, command?:string}|null|undefined} provider
 * @returns {boolean}
 */
export const isCodexSubscriptionProvider = (provider) =>
  (provider?.type === 'cli' || provider?.type === 'tui')
  && commandBasename(provider?.command) === 'codex'
  // A local-runtime-backed codex record (`codex --oss --local-provider ollama`)
  // generates its tokens on this machine and authenticates against nothing, so
  // it must not be painted "No ChatGPT account is signed in" — or parked in
  // UNKNOWN waiting on an account read that will never matter.
  && localRuntimeNamespace(provider) === null;

/**
 * True when a provider is Kimi-Code-flavored — the shipped `kimi-cli`/`kimi-tui`
 * ids or any provider whose launch command basename is `kimi` (path/exe tolerant).
 * MIRROR of `isKimiProvider` in server/lib/providerModels.js — keep in lockstep.
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @returns {boolean}
 */
export const isKimiProvider = (provider) => {
  const id = String(provider?.id || '').toLowerCase();
  return id === 'kimi-cli' || id === 'kimi-tui' || commandBasename(provider?.command) === 'kimi';
};

/**
 * True when a provider is Antigravity-flavored — the shipped
 * `antigravity-cli`/`antigravity-tui` ids or any provider whose launch command
 * basename is `agy`/`antigravity` (path/exe tolerant). MIRROR of
 * `isAntigravityProvider` in server/lib/providerModels.js — keep in lockstep.
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @returns {boolean}
 */
export const isAntigravityProvider = (provider) => {
  if (!provider) return false;
  const id = String(provider.id || '').toLowerCase();
  if (id === 'antigravity-cli' || id === 'antigravity-tui') return true;
  const base = commandBasename(provider.command);
  return base === 'agy' || base === 'antigravity';
};

/**
 * True when a provider is Cursor-Agent-flavored — the shipped
 * `cursor-cli`/`cursor-tui` ids or any provider whose launch command basename is
 * `cursor-agent` (never a bare `cursor`, which is the GUI editor). MIRROR of
 * `isCursorProvider` in server/lib/providerModels.js — keep in lockstep.
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @returns {boolean}
 */
export const isCursorProvider = (provider) => {
  if (!provider) return false;
  const id = String(provider.id || '').toLowerCase();
  return id === 'cursor-cli' || id === 'cursor-tui' || commandBasename(provider.command) === 'cursor-agent';
};

/**
 * Provider-type enum mirrored from server/lib/aiToolkit/constants.js#PROVIDER_TYPES.
 * The aiToolkit directory is kept self-contained (no imports out to other PortOS
 * modules) so the client cannot import the server copy directly — keep these two
 * in lockstep when adding a type. The provider type predicates below and the
 * Tailwind chip helper read from this object, so a string literal only needs to
 * appear once per side.
 */
export const PROVIDER_TYPES = Object.freeze({
  CLI: 'cli',
  TUI: 'tui',
  API: 'api'
});

// Agent jobs need the CLI/TUI file-writing harnesses. Keep this allowlist in
// lockstep with the api-provider rejection in server/services/agentProviderResolution.js.
export const AGENT_HARNESS_PROVIDER_TYPES = Object.freeze([
  PROVIDER_TYPES.CLI,
  PROVIDER_TYPES.TUI
]);

/**
 * True when an OpenCode process provider runs against one of the local
 * OpenAI-compatible backends (Ollama / LM Studio / MTPLX / llama.cpp / vLLM) or
 * a hosted gateway (OrcaRouter / OpenRouter)
 * rather than a vendor cloud model. MIRROR of `isOpencodeProvider(p) &&
 * getOpencodeLocalProviderNamespace(p)` in server/lib/providerModels.js, which
 * is exactly what gates the effort ladder there — so a backend marker missing
 * here hides the effort picker for a provider the server would happily forward
 * `reasoningEffort` for (#4765).
 */
export const isOpencodeLocalProvider = (provider) =>
  (['opencode', 'opencode-tui'].includes(String(provider?.id || '').toLowerCase())
    || commandBasename(provider?.command) === 'opencode')
  && (localRuntimeNamespace(provider) !== null || isGatewayBackedProvider(provider));

/**
 * Check if a provider is a TUI-backed agent provider. Mirror of
 * `isTuiProvider` in server/services/agentCliSpawning.js.
 */
export const isTuiProvider = (provider) => provider?.type === PROVIDER_TYPES.TUI;

/**
 * Can a human launch this provider at a shell prompt?
 *
 * TUI is the only type that has an interactive form — a `cli` provider's args
 * are headless (`--print`), and an `api` provider has no local binary at all.
 * `tuiCommandLine` is the server's own resolution of what the launch will run
 * (`server/lib/tuiShellLaunch.js`, published by `GET /api/providers`), so a
 * provider it could not resolve a command for is not offered, and an older
 * server that omits the field simply offers nothing.
 *
 * Shared so the AI Providers card's "Launch in Shell" button and the Shell
 * page's launch menu can't disagree about which providers are launchable.
 */
export const isLaunchableTuiProvider = (provider) => isTuiProvider(provider) && Boolean(provider?.tuiCommandLine);

/**
 * Check if a provider is a one-shot CLI agent provider.
 */
export const isCliProvider = (provider) => provider?.type === PROVIDER_TYPES.CLI;

/**
 * Check if a provider is an HTTP-API provider (e.g. OpenAI, Anthropic, LM Studio),
 * as opposed to a process-backed CLI/TUI agent. Use this anywhere you'd write
 * `provider.type === PROVIDER_TYPES.API` against a saved provider.
 */
export const isApiProvider = (provider) => provider?.type === PROVIDER_TYPES.API;

/**
 * Stable, module-scoped filter for `useProviderModels({ filter })` and other
 * call sites that need "enabled HTTP-API providers only". Hoisted so the
 * identity is the same across renders (callers may pass it as a dependency).
 */
export const enabledApiProviderFilter = (provider) => Boolean(provider?.enabled) && isApiProvider(provider);

/**
 * Check if a provider is process-backed (cli or tui), as opposed to an
 * HTTP-API provider. Use this for "shows a Command + args" config predicates.
 */
export const isProcessProvider = (provider) => isCliProvider(provider) || isTuiProvider(provider);

/**
 * Stable, module-scoped filter for `useProviderModels({ filter })` on a manual
 * dispatch picker (a Claim/Replan/Resolve/Review "Run with" control) — only
 * CODING providers (CLI/TUI agents with a file-writing harness) can run one of
 * these agent tasks. Hoisted for the same reason as `enabledApiProviderFilter`
 * above: a stable identity across renders.
 */
export const enabledProcessProviderFilter = (provider) => Boolean(provider?.enabled) && isProcessProvider(provider);

/**
 * Whether `provider` is served by an Ollama daemon rather than its nominal
 * cloud/CLI backend: the built-in `ollama` API provider itself (id match), an
 * `api`-type provider whose `endpoint` points at Ollama, or the Claude-Ollama
 * CLI/TUI pattern — a `claude` process carrying the `ollamaBacked` marker or an
 * `ANTHROPIC_BASE_URL` pointed at Ollama, which runs the Claude Code harness but
 * generates tokens locally, so its model list is refreshed from Ollama
 * (including the TUI variant, which the server refreshes via the
 * `type==='tui' && ollamaBacked` branch). MIRROR of `isOllamaBackedProvider` in
 * server/lib/aiToolkit/providers.js.
 * @param {{id?:string,endpoint?:string,ollamaBacked?:boolean,envVars?:Record<string,string>}} provider
 */
export const isOllamaBackedProvider = (provider) => {
  if (provider?.id === 'ollama') return true;
  if (provider?.ollamaBacked === true) return true;
  const base = String(provider?.envVars?.ANTHROPIC_BASE_URL || provider?.endpoint || '');
  return /:11434\b/.test(base) || /ollama/i.test(base);
};

/**
 * The LOCAL daemon namespace a provider is marked with, or null. Structural
 * markers only — a hosted gateway is an OpenCode namespace and a remote API, so
 * it is deliberately NOT one of these.
 *
 * MIRROR of `localRuntimeNamespace` in server/lib/providerModels.js — keep in
 * lockstep. The order matters: a malformed record carrying two markers keeps its
 * legacy Ollama outcome on both sides.
 * @param {{ollamaBacked?:boolean,mtplxBacked?:boolean,llamaBacked?:boolean,vllmBacked?:boolean,sglangBacked?:boolean}|null|undefined} provider
 * @returns {'ollama'|'mtplx'|'llama'|'vllm'|'sglang'|null}
 */
export const localRuntimeNamespace = (provider) => {
  if (provider?.ollamaBacked === true) return 'ollama';
  if (provider?.lmstudioBacked === true) return 'lmstudio';
  if (provider?.mtplxBacked === true) return 'mtplx';
  if (provider?.llamaBacked === true) return 'llama';
  if (provider?.vllmBacked === true) return 'vllm';
  if (provider?.sglangBacked === true) return 'sglang';
  return null;
};

/**
 * True when a provider launches the Claude Code binary, whatever backend it is
 * pointed at (`claude-code`, `claude-ollama`, `claude-sglang`, or any renamed
 * record whose command resolves to `claude`).
 *
 * The harness — not the backend — is what decides which knobs are forwardable:
 * Claude Code owns its own sampling and speaks the Anthropic wire, so a control
 * that reaches an OpenCode wrapper through `agent.build` has no route here.
 * MIRROR of `isClaudeCommand` in server/lib/providerModels.js.
 * @param {{command?:string}|null|undefined} provider
 */
export const isClaudeCommandProvider = (provider) => commandBasename(provider?.command) === 'claude';

/**
 * Check if a provider is the Grok Build CLI/TUI (the `grok` command harness).
 * Matches the shipped `grok-cli` / `grok-tui` samples or any process provider
 * whose command basename is `grok`; the plain Grok API provider is excluded.
 * Reviewer-model discovery uses this for custom Grok process providers too.
 */
export const isGrokBuildCli = (provider) => {
  if (!isProcessProvider(provider)) return false;
  const id = String(provider?.id || '').toLowerCase();
  return id === 'grok-cli' || id === 'grok-tui' || commandBasename(provider?.command) === 'grok';
};

/**
 * Tailwind chip classes for the provider type badge ('cli' / 'tui' / 'api').
 * Lifted out of AIProviders.jsx so other components can render the same
 * color treatment without redefining it.
 */
export const providerTypeClass = (type) => {
  if (type === PROVIDER_TYPES.CLI) return 'bg-blue-500/20 text-blue-400';
  if (type === PROVIDER_TYPES.TUI) return 'bg-emerald-500/20 text-emerald-400';
  return 'bg-purple-500/20 text-purple-400';
};

// ---------------------------------------------------------------------------
// AI Assignments option helpers — shared by the global AI Assignments table
// (settings/AiAssignmentsTab.jsx) and per-record override drawers (e.g. the
// Creative Director Models drawer). All three consume the `getAiAssignments`
// payload shape (`{ providers, assignments }`), where an assignment `entry` may
// carry `providerTypes` (which provider kinds are eligible) and optional
// pre-baked `providerOptions` / `modelOptions` overrides for runtime call sites.
// ---------------------------------------------------------------------------
