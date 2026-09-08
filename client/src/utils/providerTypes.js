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
 * here: launchability and picker filters, the Grok process composition, and
 * the Tailwind chip classes.
 *
 * Re-exported by `./providers.js` for existing `utils/providers` imports.
 */

import { isTuiProvider, isApiProvider, isProcessProvider } from '../../../server/lib/providerTypes.js';
import { PROVIDER_TYPES } from '../../../server/lib/aiToolkit/constants.js';
import { isGrokProvider } from '../../../server/lib/providerModels.js';

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

export {
  isCliProvider,
  isTuiProvider,
  isApiProvider,
  isProcessProvider,
  isClaudeHarnessProvider,
  isClaudeHarnessProvider as isClaudeCommandProvider,
} from '../../../server/lib/providerTypes.js';

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
 * Stable, module-scoped filter for `useProviderModels({ filter })` and other
 * call sites that need "enabled HTTP-API providers only". Hoisted so the
 * identity is the same across renders (callers may pass it as a dependency).
 */
export const enabledApiProviderFilter = (provider) => Boolean(provider?.enabled) && isApiProvider(provider);

/**
 * Stable, module-scoped filter for `useProviderModels({ filter })` on a manual
 * dispatch picker (a Claim/Replan/Resolve/Review "Run with" control) — only
 * CODING providers (CLI/TUI agents with a file-writing harness) can run one of
 * these agent tasks. Hoisted for the same reason as `enabledApiProviderFilter`
 * above: a stable identity across renders.
 */
export const enabledProcessProviderFilter = (provider) => Boolean(provider?.enabled) && isProcessProvider(provider);

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
