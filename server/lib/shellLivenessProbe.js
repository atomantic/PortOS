/**
 * Process-liveness probe for a launched TUI command in a persistent PTY shell.
 *
 * `buildLivenessProbeCommand(shellPid, platform?)` + `parseLivenessProbeOutput(stdout, shellPid)` + `shellHasLiveChild(shellPid, opts?)`.
 *
 * The TUI runs as a CHILD of the shell (`claude` inside `zsh` or `cmd.exe`); when it exits early (bad config, command not found, auth error) the PTY stays open (the shell returns to its prompt, onExit never fires). "The shell PID has no live child" means the command already died, so the spawner skips pasting the prompt into the bare shell and finalizes failure early.
 * Run host-side via `execFile` (not inside the PTY): POSIX `ps -Ao ppid=`; Windows PowerShell `Get-CimInstance Win32_Process | Select-Object -ExpandProperty ParentProcessId`. Resolves true (assume alive) if the probe fails or can't run, so an environment glitch never blocks a healthy run.
 */

import { execFile } from './childProcess.js';

/** Build the file + argv for probing children of `shellPid` (`_shellPid`: hosting shell PID; `platform` defaults to `process.platform`) → `{ file, args }`. */
export function buildLivenessProbeCommand(_shellPid, platform = process.platform) {
  if (platform === 'win32') {
    return {
      file: 'powershell',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object -ExpandProperty ParentProcessId',
      ],
    };
  }
  return {
    file: 'ps',
    args: ['-Ao', 'ppid='],
  };
}

/** Parse the probe's output (lines of PPIDs from `stdout`, for the hosting `shellPid`): true if child process(es) were found. */
export function parseLivenessProbeOutput(stdout, shellPid) {
  if (!stdout || !shellPid) return false;
  return String(stdout)
    .split('\n')
    .some((line) => {
      const num = parseInt(line.trim(), 10);
      return Number.isFinite(num) && num === shellPid;
    });
}

/**
 * Best-effort check if `shellPid` currently has any live child process.
 * Resolves `true` (assume alive) on error or missing PID.
 *
 * @param {number} shellPid
 * @param {{ platform?: string, execFileFn?: typeof execFile }} [options]
 * @returns {Promise<boolean>}
 */
export function shellHasLiveChild(shellPid, { platform = process.platform, execFileFn = execFile } = {}) {
  if (!shellPid) return Promise.resolve(true);
  const { file, args } = buildLivenessProbeCommand(shellPid, platform);
  return new Promise((resolve) => {
    execFileFn(file, args, { timeout: 2000 }, (err, stdout) => {
      if (err) {
        resolve(true);
        return;
      }
      resolve(parseLivenessProbeOutput(stdout, shellPid));
    });
  });
}
