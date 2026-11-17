/**
 * `buildTuiShellLaunch(provider)` → `{ commandLine, env }` for launching a TUI provider by hand in a
 * Shell session (the AI Providers card's "Launch in Shell" button).
 */

import { EXECUTION_OPTIONS_ERROR } from './executionOptions.js';
/**
 * Resolve everything a TUI provider needs to be launched by hand in a Shell session: the exact command line to type and the environment the PTY must carry. The environment half is why this is server-side, not a `?cmd=<line>` query: a TUI provider's backend and auth live in `provider.envVars` (`ANTHROPIC_BASE_URL` for an Ollama-backed or Bedrock `claude`, `OPENCODE_CONFIG_CONTENT` for an OpenCode wrapper), so a shell running the line WITHOUT that env silently talks to the vendor cloud instead of the chosen local daemon,
 * and those values are secret (the client payload redacts them to `***`) so they can't ride a URL. The command half reuses `buildTuiInvocation` (as the TUI prompt runner does) so posture flags and `--model`/`--effort` injection match what the provider really launches with.
 */

import { PROVIDER_TYPES } from './aiToolkit/constants.js';
import { buildTuiInvocation } from './tuiHandshake.js';
import { formatShellCommandLine } from './shellCd.js';
import { resolveInteractiveShell } from './interactiveShellResolver.js';
import { composeProviderEnv } from './cliChildEnv.js';
import { applyCredentialBootstrap } from './credentialBootstrap.js';

/**
 *
 * @param {object|null|undefined} provider - a RAW provider record (unredacted
 *   `envVars` — never a client-sanitized one, whose secrets are `'***'`)
 * @returns {{commandLine: string, env: object}|null} null when the provider is
 *   not a TUI or resolves no launch command, so callers can treat "not
 *   launchable" as one case rather than checking two conditions apiece.
 */
export function buildTuiShellLaunch(provider) {
  if (provider?.type !== PROVIDER_TYPES.TUI) return null;
  let invocation;
  try { invocation = buildTuiInvocation(provider, provider.defaultModel); }
  catch (error) {
    if (error.code === EXECUTION_OPTIONS_ERROR) return null;
    throw error;
  }
  if (!invocation.command) return null;
  // What the shell types is what every agent spawn runs: the bootstrap CLI in front of the harness for a credential-bootstrap provider (credentialBootstrap.js); a bare harness would run with no credential.
  const { command, args } = applyCredentialBootstrap(provider, invocation.command, invocation.args);
  return {
    commandLine: formatShellCommandLine(command, args, resolveInteractiveShell()),
    env: composeProviderEnv({ provider, model: provider.defaultModel }),
  };
}
