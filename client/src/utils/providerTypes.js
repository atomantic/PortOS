/**
 * Provider kind predicates: `PROVIDER_TYPES`, `isCliProvider`, `isTuiProvider`, `isApiProvider`,
 * `isProcessProvider` and `isClaudeHarnessProvider`.
 *
 * What KIND of provider a record is: the `cli`/`tui`/`api` type enum and predicates, the vendor-harness predicates keyed on shipped ids plus the launch command's basename (so a renamed `codex`/`agy`/`kimi`/`cursor-agent`/`grok`/`claude`
 * still qualifies), and the structural backend markers (`ollamaBacked`, `lmstudioBacked`, …). Everything with a server twin is RE-EXPORTED from the pure server leaves so browser and server classify with the same function;
 * only helpers with no browser-importable twin are declared here (launchability and picker filters, the Grok process composition, Tailwind chip classes).
 *
 * Re-exported by `./providers.js` for existing `utils/providers` imports.
 */

import { isTuiProvider, isApiProvider, isProcessProvider } from '../../../server/lib/provider/providerTypes.js';
import { PROVIDER_TYPES } from '../../../server/lib/aiToolkit/constants.js';

export { PROVIDER_TYPES } from '../../../server/lib/aiToolkit/constants.js';
// The public `aiToolkit/providers.js` barrel reaches `fs` and `child_process`,
// so the browser takes the dependency-free leaf that barrel itself re-exports.
export { isOllamaBackedProvider } from '../../../server/lib/aiToolkit/internal/ollamaBacked.js';
export { hasLocalRuntimeMarker, markedLocalRuntime } from '../../../server/lib/aiToolkit/internal/localRuntimeMarkers.js';
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
} from '../../../server/lib/provider/providerModels.js';

export {
  isCliProvider,
  isTuiProvider,
  isApiProvider,
  isProcessProvider,
  isClaudeHarnessProvider,
  isClaudeHarnessProvider as isClaudeCommandProvider,
  // The Grok Build CLI/TUI predicate lives in the server leaf (#7339): the reviewer -> provider matcher table keys on it and a browser copy is the drift that table removes.
  isGrokBuildCli,
} from '../../../server/lib/provider/providerTypes.js';

/**
 * Can a human launch this provider at a shell prompt? Only TUI has an interactive form (`cli` args are headless, `api` has no binary). `tuiCommandLine` is the server's own resolution of the launch
 * (`server/lib/tuiShellLaunch.js`, published by `GET /api/providers`), so a provider it can't resolve is not offered. Shared so the AI Providers card and the Shell launch menu can't disagree.
 */
export const isLaunchableTuiProvider = (provider) => isTuiProvider(provider) && Boolean(provider?.tuiCommandLine);

/**
 * Stable, module-scoped filter for `useProviderModels({ filter })`: enabled HTTP-API providers only. Hoisted so its identity is stable across renders (callers may pass it as a dependency).
 */
export const enabledApiProviderFilter = (provider) => Boolean(provider?.enabled) && isApiProvider(provider);

/**
 * Stable, module-scoped filter for `useProviderModels({ filter })` on a manual dispatch picker (Claim/Replan/Resolve/Review "Run with"): only CODING providers (CLI/TUI with a file-writing harness) can run those tasks. Hoisted like `enabledApiProviderFilter`.
 */
export const enabledProcessProviderFilter = (provider) => Boolean(provider?.enabled) && isProcessProvider(provider);

/**
 * Tailwind chip classes for the provider type badge ('cli' / 'tui' / 'api'), shared so other components render the same treatment.
 */
export const providerTypeClass = (type) => {
  if (type === PROVIDER_TYPES.CLI) return 'bg-blue-500/20 text-blue-400';
  if (type === PROVIDER_TYPES.TUI) return 'bg-emerald-500/20 text-emerald-400';
  return 'bg-purple-500/20 text-purple-400';
};
