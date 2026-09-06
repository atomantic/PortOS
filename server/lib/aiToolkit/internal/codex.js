/**
 * Codex constants and command helpers for the aiToolkit.
 *
 * `CODEX_COMMAND` and `isCodexCommand` are duplicated from
 * server/lib/codexAccount.js / server/lib/providerModels.js so the toolkit
 * stays self-contained (no imports out to sibling PortOS modules — see
 * ../AGENTS.md); keep in sync with upstream.
 */

import { commandBasename } from './commandBasename.js';

export const CODEX_CLI_ID = 'codex';
export const CODEX_TUI_ID = 'codex-tui';
export const CODEX_COMMAND = 'codex';

// Match by normalized binary basename so a path- or `.exe`-configured provider
// (`/opt/homebrew/bin/codex`, `codex.exe`, `codex.cmd`) is still recognized.
export function isCodexCommand(command) {
  return commandBasename(command) === CODEX_COMMAND;
}
