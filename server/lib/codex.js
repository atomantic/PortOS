/**
 * OpenAI Codex CLI provider helpers: command/id constants, `isCodexCommand`, vision-capability
 * predicate, and `ensureCodexTuiArgs` for TUI launch arguments.
 */

import { isCodexCommand } from './aiToolkit/internal/codex.js';
import { executionOptionsError } from './executionOptions.js';
/**
 * Dependency-light (only `providerModels.js` helpers) so it stays importable from
 * the standalone autofixer. Provider-RECORD classification of the local-model
 * backing (`codexOssLocalProvider` etc.) lives in `providerModels.js` so
 * consumers needing only the verdict skip this argv module; argv construction stays here.
 */

import {
  argvHasFlag,
  buildCodexStartupArgs,
  codexOssLocalProvider,
} from './provider/providerModels.js';

export { CODEX_COMMAND, CODEX_CLI_ID, isCodexCommand } from './aiToolkit/internal/codex.js';

/** The interactive Codex runner forwards images with its native --image flag. */
export const isVisionCapableCodexTuiProvider = (provider) =>
  provider?.type === 'tui' && isCodexCommand(provider.command);

// Approval/sandbox flags a user may already have pinned.
const APPROVAL_POLICY_FLAGS = [
  '--ask-for-approval', '-a',
  '--sandbox', '-s',
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
];

function codexHasApprovalPolicy(args) {
  return argvHasFlag(args, APPROVAL_POLICY_FLAGS);
}

// Prepends the startup update-check disable (see buildCodexStartupArgs) and the full-yolo bypass.
// The update-check disable is independent of approval posture; the bypass is
// skipped when the argv already declares one.
export function ensureCodexTuiArgs(args, provider = null) {
  const prefix = [...buildCodexExecutionOptionArgs(provider, args)];
  if (!codexHasApprovalPolicy(args)) {
    prefix.push('--dangerously-bypass-approvals-and-sandbox');
  }
  // An interactive session reads `~/.codex/config.toml` too, so honor the same pin as the CLI arm.
  if (provider?.ignoreUserConfig === true && !args.includes('--ignore-user-config')) {
    prefix.push('--ignore-user-config');
  }
  prefix.push(...buildCodexAuthModeArgs(provider, args));
  prefix.push(...buildCodexStartupArgs(args));
  // Without this, an interactive `codex-ollama` session silently reaches the OpenAI cloud.
  prefix.push(...buildCodexOssArgs(provider, args));
  return prefix.length ? [...prefix, ...args] : args;
}


export const CODEX_AUTH_MODES = Object.freeze(['chatgpt', 'api']);

/**
 * `["-c", "forced_login_method=\"<mode>\""]` when the provider pins Codex to
 * one authentication method, else `[]` (Codex picks from its own login state).
 *
 * ChatGPT-subscription and API-key access are separate auth/billing modes and
 * some models are only available to one. Skipped when the argv already sets the key.
 * @param {object|null|undefined} provider
 * @param {string[]} [existingArgs]
 * @returns {string[]}
 */
export function buildCodexAuthModeArgs(provider, existingArgs = []) {
  const mode = provider?.codexAuthMode;
  if (!CODEX_AUTH_MODES.includes(mode)) return [];
  if (existingArgs.some((arg) => typeof arg === 'string' && arg.includes('forced_login_method'))) return [];
  return ['-c', `forced_login_method="${mode}"`];
}

/**
 * `['--oss', '--local-provider', '<ns>']` for a local-runtime-backed codex record, or `[]`
 * (also when existingArgs pins either flag, to avoid a duplicate codex rejects).
 * Argv flags only; the user's ~/.codex/config.toml is never rewritten.
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

/**
 * Per-run tier config overrides user config without writing it. Standard is
 * Codex's explicit `default` request value, not an absent setting. A pinned
 * provider argv is refused rather than claiming a conflicting option applied.
 * This builds requested syntax, including previews. Execution entrypoints must
 * validate current account/model capabilities before launching it.
 */
export function buildCodexExecutionOptionArgs(provider, existingArgs = []) {
  const options = provider?.executionOptions;
  if (!options || Object.keys(options).length === 0) return [];
  const tier = options.serviceTier;
  if (Object.keys(options).some((key) => key !== 'serviceTier') || !['standard', 'fast'].includes(tier)) {
    throw executionOptionsError('Unsupported Codex execution options');
  }
  if (!isCodexCommand(provider?.command) || !['cli', 'tui'].includes(provider?.type)
      || (provider?.codexAuthMode && provider.codexAuthMode !== 'chatgpt') || codexOssLocalProvider(provider)) {
    throw executionOptionsError('Codex speed requires a ChatGPT-authenticated Codex CLI or TUI route');
  }
  if (existingArgs.some((arg) => /(?:forced_login_method|model_provider|service_tier|features\.(?:fast_mode|ultrafast_mode)|fast_default_opt_out)/.test(arg))) {
    throw executionOptionsError('Execution speed conflicts with provider args; remove the baked speed configuration');
  }
  return ['-c', `service_tier="${tier === 'standard' ? 'default' : 'fast'}"`,
    ...(tier === 'fast' ? ['-c', 'features.fast_mode=true'] : [])];
}
