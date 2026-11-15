/**
 * `buildTuiShellLaunch(provider)` → `{ commandLine, env }` for launching a TUI provider by hand in a
 * Shell session (the AI Providers card's "Launch in Shell" button).
 *
 * Resolves the command via `tuiHandshake.js#buildTuiInvocation` (so the vendor posture flags and
 * `--model`/`--effort` injection match a real TUI spawn) and the env via
 * `cliChildEnv.js#composeProviderEnv`. **The env is why this is server-side and the deep link carries
 * only a provider ID**: a TUI provider's backend lives in `envVars` (`ANTHROPIC_BASE_URL` for an
 * Ollama-backed or Bedrock `claude`, `OPENCODE_CONFIG_CONTENT` for an OpenCode wrapper), so a shell
 * handed only the command line would run the right binary against the vendor cloud instead of the
 * local daemon the user configured — and those values are secret, so they can't ride a URL. Returns
 * null for a non-TUI provider. Must be given a RAW provider, never a client-sanitized one (redacted
 * `'***'` env reads truthy).
 */

import { EXECUTION_OPTIONS_ERROR } from './executionOptions.js';
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
  let invocation;
  try { invocation = buildTuiInvocation(provider, provider.defaultModel); }
  catch (error) {
    if (error.code === EXECUTION_OPTIONS_ERROR) return null;
    throw error;
  }
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
