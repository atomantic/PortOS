/**
 * Build "run this command, then close the shell with its exit status" for the
 * shell a PTY session is actually running.
 *
 * An agent TUI session exists only to host one CLI (`claude`, `codex`, …). The
 * shell must die when that CLI does, carrying its status out — otherwise the
 * shell returns to its prompt, the PTY stays open, and the spawner can't see
 * completion until the wall-clock backstop fires.
 *
 * The POSIX form `cmd; exit $?` was applied to every platform, and it is not
 * merely unsupported elsewhere — it is wrong in an actively misleading way:
 *
 *   • PowerShell — `$?` is a BOOLEAN (did the last command succeed), not a
 *     status. `exit $?` coerces it, so a CLI that exited 0 leaves the shell
 *     with 1 and one that failed leaves 0. Exactly inverted. `$LASTEXITCODE`
 *     is the actual status, pre-seeded to 1 so a command that never ran (typo,
 *     not on PATH) still exits non-zero instead of leaving it unset → 0.
 *   • cmd.exe — `;` is an argument separator, not a command separator, so the
 *     CLI is handed `;`, `exit` and `$?` as extra arguments and usually dies on
 *     them. `&` chains unconditionally, and a bare `exit` carries ERRORLEVEL.
 *
 * Verified against node-pty on Windows 11 for pwsh 7, Windows PowerShell 5.1
 * and cmd.exe: exit 7 → 7, exit 0 → 0, command-not-found → non-zero.
 *
 * Renders the LINE only; the Enter byte that submits it is `SUBMIT_KEY` in
 * `tuiHandshake.js`.
 */
import { detectShellFlavor } from './shellCd.js';

/**
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
