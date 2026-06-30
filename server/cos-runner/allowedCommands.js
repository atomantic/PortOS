/**
 * Command allowlist for the CoS Agent Runner.
 *
 * Extracted from index.js so the pure validation logic can be unit-tested
 * without importing the entire Express + Socket.IO app.
 */

import { basename } from 'path';

/** Commands permitted to be spawned by the runner. */
export const ALLOWED_COMMANDS = new Set([
  'claude',
  'aider',
  'codex',
  'copilot',
  'agy',
  'gemini',
  'opencode'
]);

/**
 * Validate that a command is in the allowlist.
 * Extracts the base command name from the full path using path.basename for
 * cross-platform support. Handles Windows .exe extensions by stripping them
 * before checking.
 *
 * @param {string} command - The command string to validate (may be a full path).
 * @returns {boolean} true if the base name is in the allowlist, false otherwise.
 */
export function isAllowedCommand(command) {
  if (!command || typeof command !== 'string') return false;
  // Extract base command name from full path (e.g., /usr/bin/claude -> claude)
  // Uses path.basename for correct handling on both Unix and Windows
  let baseName = basename(command);
  // Normalize for Windows: strip trailing .exe (case-insensitive). Only .exe —
  // .cmd/.bat npm shims are deliberately NOT accepted because the spawn path runs
  // `spawn(cmd, args, { shell: false })`, which cannot execute a shim batch file;
  // accepting them here would only move the failure to spawn time.
  if (baseName.toLowerCase().endsWith('.exe')) {
    baseName = baseName.slice(0, -4);
  }
  return ALLOWED_COMMANDS.has(baseName);
}
