/**
 * Build the display preview and prepare the actual Shell launch for a TUI provider.
 *
 * The Socket.IO handler pairs the shell command with the provider's
 * server-only environment, never with credentials from a URL or client record.
 * OpenCode's installed major is resolved only at launch time.
 */

import { EXECUTION_OPTIONS_ERROR } from './executionOptions.js';
import { PROVIDER_TYPES } from './aiToolkit/constants.js';
import { buildTuiInvocation } from './tuiHandshake.js';
import { formatShellCommandLine } from './shellCd.js';
import { resolveInteractiveShell } from './interactiveShellResolver.js';
import { composeProviderEnv } from './cliChildEnv.js';
import { applyCredentialBootstrap } from './credentialBootstrap.js';
import { commandOutput } from './commandExists.js';
import { findCommandOnPath } from './processEnv.js';
import { argvHasFlag, isOpencodeCommand, parseOpencodeConfigContent } from './provider/providerModels.js';

const OPENCODE_TUI_VALUES = new Map([
  ['--agent', 'default_agent'],
  ['--model', 'model'],
  ['-m', 'model'],
]);

/**
 * The v2 full-screen entry point takes neither --agent nor --model (unlike
 * 'opencode run' and 'opencode mini'). Put the same selections in inline server
 * config, using a private server so the existing shared service cannot ignore
 * the preset's endpoint, model or credentials.
 */
function opencodeV2ShellInvocation(args, env) {
  if (argvHasFlag(args, ['--server'])) {
    throw new Error('OpenCode 2 Shell launcher needs a private server to apply this preset. Remove --server from its TUI arguments, or connect from an ordinary shell.');
  }
  const settings = parseOpencodeConfigContent(env.OPENCODE_CONFIG_CONTENT);
  if (env.OPENCODE_CONFIG_CONTENT && !settings) {
    throw new Error('OpenCode 2 Shell launcher needs OPENCODE_CONFIG_CONTENT to be a JSON object.');
  }
  const config = { ...settings };
  const next = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const key = OPENCODE_TUI_VALUES.get(flag);
    if (!key) {
      next.push(arg);
      continue;
    }
    const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
    if (!value || value.startsWith('-')) throw new Error(`OpenCode TUI argument ${flag} needs a value.`);
    config[key] = value;
  }
  if (!next.includes('--standalone')) next.unshift('--standalone');
  return { args: next, env: { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) } };
}

/**
 *
 * Static preview. The actual launch also resolves host-specific syntax.
 *
 * @param {object|null|undefined} provider - a RAW provider record (unredacted
 *   `envVars` — never a client-sanitized one, whose secrets are `'***'`)
 * @returns {{commandLine: string, env: object}|null} null when the provider is
 *   not a TUI or resolves no launch command, so callers can treat "not
 *   launchable" as one case rather than checking two conditions apiece.
 */
export function buildTuiShellLaunch(provider) {
  const launch = resolveTuiShellInvocation(provider);
  return launch ? formatTuiShellLaunch(provider, launch) : null;
}

function resolveTuiShellInvocation(provider) {
  if (provider?.type !== PROVIDER_TYPES.TUI) return null;
  let invocation;
  try { invocation = buildTuiInvocation(provider, provider.defaultModel); }
  catch (error) {
    if (error.code === EXECUTION_OPTIONS_ERROR) return null;
    throw error;
  }
  if (!invocation.command) return null;
  return { ...invocation, env: composeProviderEnv({ provider, model: provider.defaultModel }) };
}

function formatTuiShellLaunch(provider, invocation) {
  const { command, args } = applyCredentialBootstrap(provider, invocation.command, invocation.args);
  return {
    commandLine: formatShellCommandLine(command, args, resolveInteractiveShell()),
    env: invocation.env,
  };
}

/**
 * Resolve installed OpenCode's syntax on explicit Shell launches only. Listing
 * provider cards remains synchronous and does not run binary probes.
 */
export async function prepareTuiShellLaunch(provider, cwd) {
  const invocation = resolveTuiShellInvocation(provider);
  if (!invocation) return null;
  if (!isOpencodeCommand(invocation.command)) return formatTuiShellLaunch(provider, invocation);
  const env = { ...process.env, ...invocation.env };
  const executable = findCommandOnPath(invocation.command, { env, cwd }) || invocation.command;
  const version = await commandOutput(executable, ['--version'], { env, cwd, timeoutMs: 2_000 });
  if (!/^(?:opencode\s+)?v?2\.\d+\.\d+\b/i.test(version || '')) return formatTuiShellLaunch(provider, invocation);
  return formatTuiShellLaunch(provider, { command: executable, ...opencodeV2ShellInvocation(invocation.args, invocation.env) });
}
