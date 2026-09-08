import { PROVIDER_TYPES } from './aiToolkit/constants.js';
import { isClaudeCommand } from './providerModels.js';

/** Provider record types, shared by server dispatch and browser controls. */
export const isCliProvider = (provider) => provider?.type === PROVIDER_TYPES.CLI;
export const isTuiProvider = (provider) => provider?.type === PROVIDER_TYPES.TUI;
export const isApiProvider = (provider) => provider?.type === PROVIDER_TYPES.API;
export const isProcessProvider = (provider) => isCliProvider(provider) || isTuiProvider(provider);

/** Blank process commands default to Claude; API records never launch a harness. */
export const isClaudeHarnessProvider = (provider) => isProcessProvider(provider) && isClaudeCommand(provider?.command);
