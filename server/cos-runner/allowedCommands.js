/**
 * Command allowlist for the CoS Agent Runner.
 *
 * Extracted from index.js so the pure validation logic can be unit-tested
 * without importing the entire Express + Socket.IO app.
 */

import { basename } from 'path';
import { PROVIDER_VENDORS, EXTRA_ALLOWED_COMMANDS } from '../lib/providerVendors.js';

/**
 * Every `command` of a shipped provider (`data.reference/providers.json`, the toolkit's
 * `providers.sample.json`) MUST appear here or `/spawn-tui` 400s; `allowedCommands.test.js`
 * enforces parity. Derived from PROVIDER_VENDORS including `commandAliases` (a vendor's
 * second spelling must also be spawnable), plus EXTRA_ALLOWED_COMMANDS for vendor-less
 * commands (aider, copilot).
 */
export const ALLOWED_COMMANDS = new Set([
  ...PROVIDER_VENDORS.flatMap((vendor) => [vendor.inferredCommand, ...(vendor.commandAliases || [])]),
  ...EXTRA_ALLOWED_COMMANDS,
]);

/** Whether the base name of `command` (path and Windows .exe stripped) is allowlisted. */
export function isAllowedCommand(command) {
  if (!command || typeof command !== 'string') return false;
  let baseName = basename(command);
  // Only .exe is accepted: .cmd/.bat npm shims can't run under `shell: false`.
  if (baseName.toLowerCase().endsWith('.exe')) {
    baseName = baseName.slice(0, -4);
  }
  return ALLOWED_COMMANDS.has(baseName);
}
