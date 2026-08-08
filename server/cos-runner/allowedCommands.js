/**
 * Command allowlist for the CoS Agent Runner.
 *
 * Extracted from index.js so the pure validation logic can be unit-tested
 * without importing the entire Express + Socket.IO app.
 */

import { basename } from 'path';
import { PROVIDER_VENDORS, EXTRA_ALLOWED_COMMANDS } from '../lib/providerVendors.js';

/**
 * Commands permitted to be spawned by the runner.
 *
 * Every `command` of a shipped provider in `data.reference/providers.json` (and
 * the toolkit's `providers.sample.json`) MUST appear here — a provider whose
 * command is missing 400s at `/spawn-tui` and the agent dies before it ever gets
 * a shell. `allowedCommands.test.js` enforces that parity.
 *
 * Derived from PROVIDER_VENDORS (#3618) so a new vendor row automatically
 * becomes spawnable here without a second hand-maintained list, plus
 * EXTRA_ALLOWED_COMMANDS for legacy/custom commands with no vendor row
 * (aider, copilot).
 */
export const ALLOWED_COMMANDS = new Set([
  ...PROVIDER_VENDORS.map((vendor) => vendor.inferredCommand),
  ...EXTRA_ALLOWED_COMMANDS,
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
