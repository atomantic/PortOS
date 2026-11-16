/**
 * Build a `cd` command line for the shell a PTY session is actually running.
 *
 * The Shell page's "cd to app" picker used to send a hard-coded POSIX
 * `cd '<path>'` to every session. On Windows that fails twice over, because the
 * default shell is `cmd.exe` (`COMSPEC`):
 *
 *   1. `cmd.exe` has no single-quote quoting — the quotes become part of the
 *      path, so every managed-app folder answered
 *      "The filename, directory name, or volume label syntax is incorrect."
 *   2. Even correctly quoted, a bare `cd` does NOT switch drives. A session
 *      started in `C:\Users\…` stays there when told to `cd "I:\code\app"`;
 *      `cd /d` is required.
 *
 * So the command is built from the session's real shell binary rather than
 * assumed. Flavors:
 *
 *   • `cmd`        → `cd /d "<path>"`                     (double quotes, /d)
 *   • `powershell` → `Set-Location -LiteralPath '<path>'`  (doubled `'`; crosses
 *                     drives on its own, and -LiteralPath skips glob expansion
 *                     so a `[` in a folder name still resolves)
 *   • `posix`      → `cd '<path>'`                         (shellQuote)
 *
 * A Windows host running a POSIX shell (git-bash `bash.exe`) is detected by the
 * binary name, not the platform, so it keeps POSIX quoting — MSYS translates the
 * Win32 path at the syscall layer.
 */
import { win32 } from 'path';
import { shellQuote } from './shellQuote.js';

/**
 * Which quoting dialect does this shell speak?
 *
 * @param {string} [shell] - the spawned shell binary (path or bare name)
 * @param {string} [platform] - `process.platform` value; only consulted when the shell is unknown
 * @returns {'cmd'|'powershell'|'posix'}
 */
export function detectShellFlavor(shell, platform = process.platform) {
  // win32.basename splits on `/` AND `\` on every host, so it reads a Windows
  // shell path correctly even when PortOS itself is running on macOS/Linux.
  const bin = win32.basename(String(shell ?? '')).toLowerCase().replace(/\.exe$/, '');
  if (bin === 'cmd') return 'cmd';
  if (bin === 'powershell' || bin === 'pwsh') return 'powershell';
  if (bin) return 'posix';
  // No shell recorded — an externally-registered session (a CoS agent's TUI run)
  // hands us its PTY without one. Fall back to the platform default, which is
  // what lib/interactiveShellResolver.js picks: PowerShell on Windows, since
  // cmd.exe is now only reached on a box with no PowerShell at all. Guessing
  // 'cmd' here is not a safe default — its syntax is a hard error under
  // PowerShell (`cd /d` → "positional parameter", `&` → "not allowed"),
  // whereas the PowerShell forms merely fail to parse in the vanishingly rare
  // cmd-only case.
  return platform === 'win32' ? 'powershell' : 'posix';
}

/**
 * Quote one token for a shell dialect.
 *
 * PowerShell and cmd.exe deliberately quote every token so Windows paths and
 * provider arguments are passed literally. PowerShell needs the call operator
 * for a quoted command-position token; quoted arguments do not use it.
 *
 * @param {*} value - token to quote
 * @param {'cmd'|'powershell'|'posix'} flavor - shell dialect
 * @param {'command'|'argument'} [position='argument'] - token position
 * @returns {string}
 */
export function quoteForShell(value, flavor = 'posix', position = 'argument') {
  const text = String(value ?? '');
  switch (flavor) {
    case 'cmd':
      // cmd.exe has no escape for an embedded double quote. Double a trailing
      // backslash so the Windows argv parser does not consume the closing quote.
      return `"${text.replace(/"/g, '').replace(/\\+$/, run => `${run}${run}`)}"`;
    case 'powershell': {
      const quoted = `'${text.replace(/'/g, "''")}'`;
      return position === 'command' ? `& ${quoted}` : quoted;
    }
    default:
      // Keep the established POSIX rendering byte-for-byte identical.
      return shellQuote(text);
  }
}

/**
 * @param {string} dirPath - directory to change into
 * @param {string} [shell] - the session's shell binary; see detectShellFlavor
 * @returns {string} a single command line, no trailing newline
 */
export function buildCdCommand(dirPath, shell) {
  // Control characters are stripped, not escaped: a newline would end the `cd`
  // line and run the rest as its own command, and no directory name has one.
  const path = String(dirPath ?? '').replace(/[\u0000-\u001f\u007f]/g, '');
  switch (detectShellFlavor(shell)) {
    case 'cmd': return `cd /d ${quoteForShell(path, 'cmd')}`;
    case 'powershell': return `Set-Location -LiteralPath ${quoteForShell(path, 'powershell')}`;
    default: return `cd ${quoteForShell(path, 'posix')}`;
  }
}

/**
 * Render a command plus its argv as ONE shell command line, quoted for the
 * dialect that shell speaks. Shared by the CoS TUI spawner
 * (`agentTuiSpawning.js#buildTuiSpawnConfig`) and the AI Providers page's
 * "Launch in Shell" deep link, so a provider launched by hand is quoted exactly
 * the way the agent runner would quote it.
 *
 * @param {string} command - the binary (command position — PowerShell needs `&`)
 * @param {string[]} [args] - argv tokens
 * @param {string} [shell] - the session's shell binary; see detectShellFlavor
 * @returns {string} a single command line, no trailing newline
 */
export function formatShellCommandLine(command, args = [], shell) {
  const flavor = detectShellFlavor(shell);
  return [command, ...args]
    .map((value, index) => quoteForShell(value, flavor, index === 0 ? 'command' : 'argument'))
    .join(' ');
}
