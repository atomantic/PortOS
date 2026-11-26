/** Cursor Agent command identity and catalog parsing. */

import { commandBasename } from './commandBasename.js';

export const CURSOR_TUI_ID = 'cursor-tui';

/** The binary basename. Deliberately NOT `cursor` — that is the GUI editor. */
export const CURSOR_COMMAND = 'cursor-agent';

export function isCursorCommand(command) {
  return commandBasename(command) === CURSOR_COMMAND;
}

// `cursor-agent models` prints `<id> - <Label>` rows between an "Available
// models" header and a trailing `Tip:` paragraph. Anchoring on the ` - `
// separator rejects that prose (an id is one space-free lowercase token), and a
// LABEL containing its own ` - ` still yields the id alone.
const CURSOR_MODEL_LINE = /^([a-z0-9][a-z0-9._:/-]*) - .+$/;

/**
 * Parse the id column out of `cursor-agent models` output.
 * @param {string} stdout - raw stdout from `cursor-agent models`
 * @returns {string[]} deduped ids, in the order the binary listed them
 */
export function parseCursorModelList(stdout) {
  const ids = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = CURSOR_MODEL_LINE.exec(line.trim());
    if (match) ids.push(match[1]);
  }
  return [...new Set(ids)];
}
