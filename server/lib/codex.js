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
 *
 * The RECORD-CLASSIFICATION half of the local-model backing
 * (`CODEX_OSS_LOCAL_PROVIDERS`, `codexOssLocalProvider`,
 * `codexUnsupportedLocalRuntime`) lives in `providerModels.js` beside the
 * `localRuntimeNamespace` it wraps, for the same reason `isCodexProvider` is
 * defined there rather than here: classifying a provider RECORD is that file's
 * job, and it lets a consumer that only needs the verdict —
 * `providerPrerequisites.js` — skip a vendor's argv module entirely. Argv
 * construction stays here.
 */

import {
  argvHasFlag,
  buildCodexStartupArgs,
  codexOssLocalProvider,
  commandBasename,
} from './providerModels.js';

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
export function ensureCodexTuiArgs(args, provider = null) {
  const prefix = [];
  if (!codexHasApprovalPolicy(args)) {
    prefix.push('--dangerously-bypass-approvals-and-sandbox');
  }
  // Same pin the CLI arm applies: an interactive Codex session reads the user's
  // `~/.codex/config.toml` too, so a provider the user pinned to PortOS's own
  // account must not silently route through a bridge here either.
  if (provider?.ignoreUserConfig === true && !args.includes('--ignore-user-config')) {
    prefix.push('--ignore-user-config');
  }
  prefix.push(...buildCodexStartupArgs(args));
  // The local backing, on the same posture-flag step both TUI spawn paths
  // share — an interactive `codex-ollama` session without it silently reaches
  // the OpenAI cloud instead of the daemon the record names.
  prefix.push(...buildCodexOssArgs(provider, args));
  return prefix.length ? [...prefix, ...args] : args;
}


/**
 * `['--oss', '--local-provider', '<ns>']` for a local-runtime-backed codex
 * record, or `[]`.
 *
 * Skipped when `existingArgs` already pins either flag, so a user who typed the
 * pair into their provider args keeps their own spelling instead of getting a
 * duplicate codex rejects.
 * @param {object|null|undefined} provider
 * @param {string[]} [existingArgs]
 * @returns {string[]}
 */
export function buildCodexOssArgs(provider, existingArgs = []) {
  const localProvider = codexOssLocalProvider(provider);
  if (!localProvider) return [];
  if (argvHasFlag(existingArgs, ['--oss', '--local-provider'])) return [];
  return ['--oss', '--local-provider', localProvider];
}
