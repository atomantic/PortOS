/**
 * Per-CLI conventions for OpenAI's Codex CLI (binary: `codex`).
 *
 * Extracted from `tuiHandshake.js` (where `ensureCodexTuiArgs` used to live as a
 * private helper) so codex has the same one-file-per-vendor shape as
 * antigravity.js / grok.js / kimi.js / cursor.js — the shape `providerVendors.js`
 * consumes as its `PROVIDER_VENDORS` registry rows (#3618).
 *
 * Dependency-light on purpose: imports only `providerModels.js` helpers,
 * mirroring the other vendor files so it stays importable from the standalone
 * autofixer.
 */

import { argvHasFlag, buildCodexStartupArgs, commandBasename } from './providerModels.js';

export const CODEX_COMMAND = 'codex';
export const CODEX_CLI_ID = 'codex';

/**
 * Match by normalized binary basename (like isGrokCommand/isKimiCommand) so a
 * path- or `.exe`-configured provider is still recognized.
 * @param {string|null|undefined} command
 * @returns {boolean}
 */
export function isCodexCommand(command) {
  return commandBasename(command) === CODEX_COMMAND;
}

// An approval/sandbox posture already pinned by the user (separated or
// joined `flag=value` form, via the shared argvHasFlag scan) — codex has no
// joined form for the two boolean flags, but checking for one is harmless.
const APPROVAL_POLICY_FLAGS = [
  '--ask-for-approval', '-a',
  '--sandbox', '-s',
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
];

// True when the codex argv already declares an approval/sandbox posture, so
// injecting `--dangerously-bypass-approvals-and-sandbox` would collide with it.
function codexHasApprovalPolicy(args) {
  return argvHasFlag(args, APPROVAL_POLICY_FLAGS);
}

// Disable codex's startup update check (see buildCodexStartupArgs in
// providerModels.js for the full "Update available!" modal failure mode) and
// inject the full-yolo bypass. Both are prepended; the update-check disable is
// independent of the approval posture (the modal is orthogonal to sandboxing),
// so it rides even when a provider pins its own policy, while the bypass flag is
// skipped when the argv already declares an approval/sandbox posture.
export function ensureCodexTuiArgs(args) {
  const prefix = [];
  if (!codexHasApprovalPolicy(args)) {
    prefix.push('--dangerously-bypass-approvals-and-sandbox');
  }
  prefix.push(...buildCodexStartupArgs(args));
  return prefix.length ? [...prefix, ...args] : args;
}
