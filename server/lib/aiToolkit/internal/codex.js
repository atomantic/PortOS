/** Codex provider identity and configured-model sentinel. */

import { commandBasename } from './commandBasename.js';

export const CODEX_CLI_ID = 'codex';
export const CODEX_TUI_ID = 'codex-tui';
export const CODEX_COMMAND = 'codex';
export const CODEX_CONFIGURED_DEFAULT = 'codex-configured-default';

// Match by normalized binary basename so a path- or `.exe`-configured provider
// (`/opt/homebrew/bin/codex`, `codex.exe`) is still recognized.
export function isCodexCommand(command) {
  return commandBasename(command) === CODEX_COMMAND;
}
