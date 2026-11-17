/**
 * Build "run this command, then close the shell with its exit status" for the shell a PTY session is running.
 *
 * An agent TUI session exists only to host one CLI (`claude`, `codex`, …) and the shell must die with it carrying its status out, else the PTY stays open and the spawner can't see completion until the wall-clock backstop. The POSIX `cmd; exit $?` was applied everywhere and is actively wrong elsewhere: PowerShell's `$?` is a BOOLEAN, so `exit $?` inverts the status (a CLI exiting 0 leaves 1, a failure leaves 0), where `$LASTEXITCODE` is the status (pre-seeded to 1 so a command that never ran, e.g. not on PATH, still exits non-zero); cmd.exe's `;` is an argument separator, so the CLI is handed `;`, `exit` and `$?` as arguments and usually dies (`&` chains unconditionally and a bare `exit` carries ERRORLEVEL). Verified against node-pty on Windows 11 (pwsh 7, PowerShell 5.1, cmd.exe): exit 7 → 7, 0 → 0, command-not-found → non-zero. Renders the LINE only; the Enter byte that submits it is `SUBMIT_KEY` in `tuiHandshake.js`.
 */
import { detectShellFlavor } from './shellCd.js';

/**
 * `commandLine` is already quoted for `shell` (the session's shell binary; see detectShellFlavor); returns one command line, no trailing terminator.
 *
 * @param {string} commandLine - the command to run, already quoted for `shell`
 * @param {string} [shell] - the session's shell binary; see detectShellFlavor
 * @returns {string} a single command line, no trailing terminator
 */
export function buildRunThenExitCommand(commandLine, shell) {
  switch (detectShellFlavor(shell)) {
    case 'cmd': return `${commandLine} & exit`;
    case 'powershell': return `$LASTEXITCODE = 1; ${commandLine}; exit $LASTEXITCODE`;
    default: return `${commandLine}; exit $?`;
  }
}
