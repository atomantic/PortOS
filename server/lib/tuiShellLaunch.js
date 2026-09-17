/**
 * Resolve everything a TUI provider needs to be launched by hand in a Shell
 * session: the exact command line to type, and the environment the PTY must
 * carry for that command to reach the backend the provider is configured for.
 *
 * The environment half is the reason this is a server-side resolution rather
 * than a `?cmd=<line>` query string. A TUI provider's backend and auth live in
 * `provider.envVars` — `ANTHROPIC_BASE_URL` for an Ollama-backed or Bedrock
 * `claude`, `OPENCODE_CONFIG_CONTENT` for an OpenCode wrapper — so a shell that
 * runs the command line WITHOUT that env silently talks to the vendor cloud
 * instead of the local daemon the user picked. Those values are also secret
 * (the client payload redacts them to `***`), so they can never ride a URL.
 *
 * The command half reuses `buildTuiInvocation`, the same builder the TUI prompt
 * runner uses, so the vendor posture flags and the `--model`/`--effort`
 * injection match what the provider really launches with.
 */

import { PROVIDER_TYPES } from './aiToolkit/constants.js';
import { buildTuiInvocation } from './tuiHandshake.js';
import { formatShellCommandLine } from './shellCd.js';
import { resolveInteractiveShell } from './interactiveShellResolver.js';
import { composeProviderEnv } from './cliChildEnv.js';
import { applyCredentialBootstrap } from './credentialBootstrap.js';

/**
 * @param {object|null|undefined} provider - a RAW provider record (unredacted
 *   `envVars` — never a client-sanitized one, whose secrets are `'***'`)
 * @returns {{commandLine: string, env: object}|null} null when the provider is
 *   not a TUI or resolves no launch command, so callers can treat "not
 *   launchable" as one case rather than checking two conditions apiece.
 */
export function buildTuiShellLaunch(provider) {
  if (provider?.type !== PROVIDER_TYPES.TUI) return null;
  const invocation = buildTuiInvocation(provider, provider.defaultModel);
  if (!invocation.command) return null;
  // What the shell must type is what every agent spawn runs: the bootstrap CLI
  // in front of the harness for a credential-bootstrap provider (see
  // credentialBootstrap.js) — a bare harness here would run with no credential.
  const { command, args } = applyCredentialBootstrap(provider, invocation.command, invocation.args);
  return {
    commandLine: formatShellCommandLine(command, args, resolveInteractiveShell()),
    env: composeProviderEnv({ provider, model: provider.defaultModel }),
  };
}
