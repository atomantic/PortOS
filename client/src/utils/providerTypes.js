/**
 * What KIND of provider a record is: the `cli`/`tui`/`api` type enum and its
 * predicates, the vendor-harness predicates keyed on the shipped ids plus the
 * launch command's basename (so a path-configured or renamed `codex`/`agy`/
 * `kimi`/`cursor-agent`/`grok`/`claude` still qualifies), and the structural
 * backend markers (`ollamaBacked`, `lmstudioBacked`, …) a wrapper record carries.
 *
 * Everything with a server twin is RE-EXPORTED from the pure server leaves
 * below rather than copied, so the browser and the server classify a record
 * with the same function and a vendor added on one side cannot be missing on
 * the other. Only helpers with no browser-importable server twin are declared
 * here: the type predicates a sanitized inventory still answers (their server
 * copies live under `services/` — #6605 gives them a pure-leaf home), the
 * launchability and picker filters, and the Tailwind chip classes.
 *
 * Re-exported by `./providers.js` for existing `utils/providers` imports.
 */

import { PROVIDER_TYPES } from '../../../server/lib/aiToolkit/constants.js';
import { commandBasename, isGrokProvider } from '../../../server/lib/providerModels.js';

export { PROVIDER_TYPES } from '../../../server/lib/aiToolkit/constants.js';
// The public `aiToolkit/providers.js` barrel reaches `fs` and `child_process`,
// so the browser takes the dependency-free leaf that barrel itself re-exports.
export { isOllamaBackedProvider } from '../../../server/lib/aiToolkit/internal/ollamaBacked.js';
export {
  commandBasename,
  isAntigravityProvider,
  isCodexProvider,
  isCodexSubscriptionProvider,
  isCursorProvider,
  isGrokProvider,
  isKimiProvider,
  isOpencodeLocalProvider,
  localRuntimeNamespace,
} from '../../../server/lib/providerModels.js';

// Agent jobs need the CLI/TUI file-writing harnesses. Keep this allowlist in
// lockstep with the api-provider rejection in server/services/agentProviderResolution.js.
export const AGENT_HARNESS_PROVIDER_TYPES = Object.freeze([
  PROVIDER_TYPES.CLI,
  PROVIDER_TYPES.TUI
]);

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
 * True when a provider launches the Claude Code binary, whatever backend it is
 * pointed at (`claude-code`, `claude-ollama`, `claude-sglang`, or any renamed
 * record whose command resolves to `claude`).
 *
 * The harness — not the backend — is what decides which knobs are forwardable:
 * Claude Code owns its own sampling and speaks the Anthropic wire, so a control
 * that reaches an OpenCode wrapper through `agent.build` has no route here.
 *
 * Not the server's `isClaudeCommand`: that counts a BLANK command as Claude
 * because the spawners default one to `claude`, which is right for a process
 * record and wrong for the `api` records this also classifies — they carry no
 * command at all, and `generationControlsFor` would strip the sampling controls
 * off the native Ollama API provider. The type-gated form the server uses lives
 * in `providerFamilies.js`, which is not browser-safe, so this stays
 * command-only until the type predicates have a pure-leaf home.
 * @param {{command?:string}|null|undefined} provider
 */
export const isClaudeCommandProvider = (provider) => commandBasename(provider?.command) === 'claude';

/**
 * Check if a provider is the Grok Build CLI/TUI (the `grok` command harness):
 * a PROCESS provider `isGrokProvider` recognizes — the shipped `grok-cli` /
 * `grok-tui` samples or any process provider whose command basename is `grok`.
 * The plain Grok API provider is excluded on both counts. Reviewer-model
 * discovery uses this for custom Grok process providers too.
 */
export const isGrokBuildCli = (provider) => isProcessProvider(provider) && isGrokProvider(provider);

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
