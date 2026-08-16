/**
 * OpenCode CLI availability and installation.
 *
 * The Providers page owns the user gesture; this module deliberately exposes
 * only one fixed npm invocation, never a user-supplied package or command.
 * That keeps the install surface as narrow as the agent runner's command
 * allowlist while letting a missing OpenCode provider become self-service.
 */

import { spawn } from '../lib/childProcess.js';
import { killProcessTree, prepareCliSpawn } from '../lib/bufferedSpawn.js';
import { safeChildProcessEnv, safeChildProcessOptions, whichFirst } from '../lib/processEnv.js';

const IS_WIN = process.platform === 'win32';

export const OPENCODE_COMMAND = 'opencode';
export const OPENCODE_NPM_PACKAGE = 'opencode-ai@latest';
export const OPENCODE_NPM_INSTALL_ARGS = Object.freeze([
  'install',
  '--global',
  OPENCODE_NPM_PACKAGE,
]);

/**
 * Report only runnable-path availability, never the discovered absolute paths.
 * Paths can contain the machine account name and are not useful to the browser;
 * the boolean is the exact question the Providers page needs to answer.
 */
export async function getOpenCodeInstallStatus({ findCommand = whichFirst } = {}) {
  const [opencode, npm] = await Promise.all([
    findCommand(OPENCODE_COMMAND),
    findCommand('npm'),
  ]);
  return {
    installed: Boolean(opencode),
    npmAvailable: Boolean(npm),
  };
}

/**
 * Start the one supported OpenCode install command with no shell interpolation.
 * `prepareCliSpawn` handles npm's Windows .cmd shim without falling back to
 * unsafe `shell: true`, and the returned child stays owned by the SSE route.
 */
export function spawnOpenCodeInstaller({ spawnImpl = spawn } = {}) {
  const env = safeChildProcessEnv();
  const { command, args } = prepareCliSpawn('npm', OPENCODE_NPM_INSTALL_ARGS, env);
  return spawnImpl(command, args, safeChildProcessOptions({
    env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    // npm can run package lifecycle children. Give the POSIX install its own
    // group so closing the modal stops that entire install, not just npm.
    detached: !IS_WIN,
  }));
}

/** Terminate the npm child and descendants when the installer modal closes. */
export function stopOpenCodeInstaller(child) {
  if (!child?.pid || child.killed) return;
  killProcessTree(child, 'SIGTERM', { processGroup: !IS_WIN });
}
