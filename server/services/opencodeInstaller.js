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
import { commandExists } from '../lib/commandExists.js';
import { findCommandOnPath, safeChildProcessEnv, safeChildProcessOptions } from '../lib/processEnv.js';

const IS_WIN = process.platform === 'win32';

export const OPENCODE_COMMAND = 'opencode';
export const OPENCODE_NPM_PACKAGE = 'opencode-ai@latest';
export const OPENCODE_NPM_INSTALL_ARGS = Object.freeze([
  'install',
  '--global',
  // npm's carriage-return progress renderer can emit hundreds of repaint
  // frames per second. The installer streams stdout to the browser, so keep
  // the useful package messages without turning the modal into a re-render
  // storm.
  '--no-progress',
  OPENCODE_NPM_PACKAGE,
]);

/**
 * Report only runnable availability, never the discovered absolute paths.
 * Paths can contain the machine account name and are not useful to the browser;
 * the boolean is the exact question the Providers page needs to answer.
 */
export async function getOpenCodeInstallStatus({ findCommand = findCommandOnPath, probeCommand = commandExists } = {}) {
  const [opencode, npm] = await Promise.all([
    findCommand(OPENCODE_COMMAND),
    findCommand('npm'),
  ]);
  // `where opencode` can select npm's extensionless POSIX shim before the
  // working `.cmd` wrapper on Windows. The filesystem resolver gives us the
  // real executable; prepareCliSpawn then probes that same safe launch shape.
  const versionProbe = opencode ? prepareCliSpawn(opencode, ['--version']) : null;
  return {
    installed: Boolean(versionProbe) && Boolean(await probeCommand(versionProbe.command, versionProbe.args)),
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
