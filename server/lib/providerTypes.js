import { PROVIDER_TYPES } from './aiToolkit/constants.js';
import { isClaudeCommand, isGrokProvider } from './providerModels.js';

/** Provider record types, shared by server dispatch and browser controls. */
export const isCliProvider = (provider) => provider?.type === PROVIDER_TYPES.CLI;
export const isTuiProvider = (provider) => provider?.type === PROVIDER_TYPES.TUI;
export const isApiProvider = (provider) => provider?.type === PROVIDER_TYPES.API;
export const isProcessProvider = (provider) => isCliProvider(provider) || isTuiProvider(provider);

/** Blank process commands default to Claude; API records never launch a harness. */
export const isClaudeHarnessProvider = (provider) => isProcessProvider(provider) && isClaudeCommand(provider?.command);

/**
 * The Grok Build CLI/TUI (the `grok` command harness): a PROCESS provider
 * `isGrokProvider` recognizes — the shipped `grok-cli` / `grok-tui` samples
 * or any process provider whose command basename is `grok`. The plain Grok
 * API provider is excluded on both counts.
 *
 * Lives here rather than in the browser mirror because the reviewer -> provider
 * matcher table (`reviewerProviderMatchers.js`) keys on it, and that table is
 * shared: a second definition is exactly the drift that table exists to remove.
 * `client/src/utils/providerTypes.js` re-exports this one.
 */
export const isGrokBuildCli = (provider) => isProcessProvider(provider) && isGrokProvider(provider);
