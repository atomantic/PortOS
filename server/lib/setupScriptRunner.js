/**
 * Spawn (and cancel) `scripts/setup-image-video.sh` — the single installer the
 * Video Gen BYOV runtimes, the music engines and the MuScriptor MIDI venv all
 * shell out to, each with a different `INSTALL_*` env var set.
 *
 * The three routes that do this were each spawning a bare `bash`, which on
 * Windows resolves through PM2's PATH and is often WSL rather than the Git Bash
 * the script's own `is_windows()` is written for (see `bashResolver.js` for that
 * whole failure mode). Beyond picking the interpreter, running the script on
 * Windows needs two more things this owns: `toBashPath` on the script path, and
 * a `PYTHON_BIN` — the script defaults to `python3`, which on Windows is either
 * absent or the WindowsApps stub that opens the Microsoft Store instead of
 * creating a venv.
 */

import { spawn } from 'child_process';
import { join } from 'path';
import { PATHS } from './fileUtils.js';
import { resolveBashBinary, toBashPath } from './bashResolver.js';
import { safeChildProcessEnv } from './processEnv.js';
import { detectVenvBasePythonSync } from './pythonSetup.js';
import { killProcessTree } from './bufferedSpawn.js';

const IS_WIN = process.platform === 'win32';

export const SETUP_IMAGE_VIDEO_SCRIPT = join(PATHS.root, 'scripts', 'setup-image-video.sh');

/**
 * Spawn the installer with `INSTALL_*` env vars pre-set. Takes no script path:
 * `PYTHON_BIN` is setup-image-video.sh's own variable, so this is that script's
 * runner, not a general `.sh` spawner.
 *
 * @param {Record<string,string>} [envVars] - extra env for the child
 * @returns {import('child_process').ChildProcess} stdout/stderr piped, stdin ignored
 */
export function spawnSetupScript(envVars = {}) {
  const env = { ...envVars };
  // An explicit PYTHON_BIN — from the caller or the environment — is the
  // documented override and wins over anything detected here.
  if (IS_WIN && !env.PYTHON_BIN && !process.env.PYTHON_BIN) {
    // Venv-base picker, not the pip-target picker: everything this script does
    // with PYTHON_BIN is `python -m venv`, and a conda base yields a venv whose
    // torch cannot load. See detectVenvBasePythonSync.
    const python = detectVenvBasePythonSync();
    if (python) env.PYTHON_BIN = toBashPath(python);
  }
  return spawn(resolveBashBinary(), [toBashPath(SETUP_IMAGE_VIDEO_SCRIPT)], {
    env: safeChildProcessEnv(env),
    stdio: ['ignore', 'pipe', 'pipe'],
    // POSIX only: its own process group is what lets a cancel reach uv / pip /
    // git (stopSetupScript signals the group). On Windows `detached` instead
    // means "own console window" and buys nothing — taskkill /T is the tree.
    detached: !IS_WIN,
    windowsHide: true,
  });
}

/**
 * Terminate a running installer and its descendants. Safe to call on an
 * already-dead or never-spawned child.
 *
 * @param {import('child_process').ChildProcess|null} child
 * @param {NodeJS.Signals} [signal] - POSIX signal; ignored on Windows
 */
export function stopSetupScript(child, signal = 'SIGTERM') {
  if (!child?.pid || child.killed) return;
  killProcessTree(child, signal, { processGroup: true });
}
