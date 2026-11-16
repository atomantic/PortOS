/**
 * Build a `cd` command line for the shell a PTY session is actually running.
 *
 * The Shell page's "cd to app" picker once sent a hard-coded POSIX `cd '<path>'`, which fails twice on Windows' default `cmd.exe` (`COMSPEC`): it has no single-quote quoting (the quotes became part of the path: "The filename, directory name, or volume label syntax is incorrect."), and a bare `cd` doesn't switch drives (`cd /d` is required). So the command is built from the session's real shell binary: • `cmd` → `cd /d "<path>"` (double quotes, /d); • `powershell` → `Set-Location -LiteralPath '<path>'` (doubled `'`; crosses drives itself, -LiteralPath skips glob expansion so `[` in a folder name resolves); • `posix` → `cd '<path>'` (shellQuote). A Windows host running a POSIX shell (git-bash `bash.exe`) is detected by binary name, not platform, so it keeps POSIX quoting (MSYS translates the Win32 path at the syscall layer).
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
  // win32.basename splits on `/` AND `\` on every host, so a Windows shell path reads correctly even when PortOS runs on macOS/Linux.
  const bin = win32.basename(String(shell ?? '')).toLowerCase().replace(/\.exe$/, '');
  if (bin === 'cmd') return 'cmd';
  if (bin === 'powershell' || bin === 'pwsh') return 'powershell';
  if (bin) return 'posix';
  // No shell recorded (an externally-registered session, e.g. a CoS agent's TUI run): fall back to the platform default of lib/interactiveShellResolver.js (PowerShell on Windows; cmd.exe only on a box with no PowerShell).
  // Guessing 'cmd' isn't safe: its syntax is a hard error under PowerShell (`cd /d`, `&`), whereas the PowerShell forms merely fail to parse in the rare cmd-only case.
  return platform === 'win32' ? 'powershell' : 'posix';
}

/** Quote one token for a shell dialect. PowerShell and cmd.exe quote every token so Windows paths and provider arguments pass literally; PowerShell needs the call operator for a quoted command-position token, not for arguments. */
export function quoteForShell(value, flavor = 'posix', position = 'argument') {
  const text = String(value ?? '');
  switch (flavor) {
    case 'cmd':
      // cmd.exe has no escape for an embedded double quote; double a trailing backslash so the Windows argv parser doesn't consume the closing quote.
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

export function buildCdCommand(dirPath, shell) {
  // Control characters are stripped, not escaped: a newline would end the `cd` line and run the rest as its own command, and no directory name has one.
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
 */
export function formatShellCommandLine(command, args = [], shell) {
  const flavor = detectShellFlavor(shell);
  return [command, ...args]
    .map((value, index) => quoteForShell(value, flavor, index === 0 ? 'command' : 'argument'))
    .join(' ');
}
