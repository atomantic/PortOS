/**
 * `spawnSetupScript(envVars)` / `stopSetupScript(child)` / `SETUP_IMAGE_VIDEO_SCRIPT`.
 *
 * the one way to run `scripts/setup-image-video.sh`, the installer the Video Gen BYOV runtimes, the music engines and the MuScriptor MIDI venv shell out to (each with a different `INSTALL_*` env var).
 *
 * Three routes each spawned a bare `bash`, which on Windows resolves via PM2's PATH and is often WSL rather than the Git Bash the script's `is_windows()` targets (see `bashResolver.js`). So it runs under `resolveBashBinary()` with a `toBashPath` script path and, on Windows, presets `PYTHON_BIN` (the script defaults to `python3`, absent or the WindowsApps stub that opens the Microsoft Store). Cancel via `stopSetupScript`, which tree-kills so uv / pip / git die with bash.
 */

import { spawn } from './childProcess.js';
import { join } from 'path';
import { PATHS } from './fileUtils.js';
import { resolveBashBinary, toBashPath } from './bashResolver.js';
import { safeChildProcessEnv, safeChildProcessOptions } from './processEnv.js';
import { detectVenvBasePythonSync } from './pythonSetup.js';
import { killProcessTree } from './bufferedSpawn.js';

const IS_WIN = process.platform === 'win32';

export const SETUP_IMAGE_VIDEO_SCRIPT = join(PATHS.root, 'scripts', 'setup-image-video.sh');

/** Spawn the installer with `INSTALL_*` env vars pre-set. Takes no script path (`PYTHON_BIN` is this script's own variable, so this is its runner, not a general `.sh` spawner). `envVars`: extra env for the child → ChildProcess, stdout/stderr piped, stdin ignored. */
export function spawnSetupScript(envVars = {}) {
  const env = { ...envVars };
  // An explicit PYTHON_BIN (caller or environment) is the documented override and wins over anything detected.
  if (IS_WIN && !env.PYTHON_BIN && !process.env.PYTHON_BIN) {
    // Venv-base picker, not the pip-target picker: the script only does `python -m venv`, and a conda base yields a venv whose torch can't load (see detectVenvBasePythonSync).
    const python = detectVenvBasePythonSync();
    if (python) env.PYTHON_BIN = toBashPath(python);
  }
  return spawn(resolveBashBinary(), [toBashPath(SETUP_IMAGE_VIDEO_SCRIPT)], safeChildProcessOptions({
    env: safeChildProcessEnv(env),
    stdio: ['ignore', 'pipe', 'pipe'],
    // POSIX only: its own process group lets a cancel reach uv / pip / git (stopSetupScript signals the group); on Windows `detached` means "own console window" and buys nothing (taskkill /T is the tree).
    detached: !IS_WIN,
  }));
}

/** Terminate a running installer and its descendants; safe on an already-dead or never-spawned child (`signal`: POSIX signal, ignored on Windows). */
export function stopSetupScript(child, signal = 'SIGTERM') {
  if (!child?.pid || child.killed) return;
  killProcessTree(child, signal, { processGroup: true });
}
