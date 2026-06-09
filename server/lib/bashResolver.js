/**
 * POSIX `bash` resolution for running bundled `*.sh` scripts (notably
 * `scripts/db.sh`) on Windows.
 *
 * THE PROBLEM. On a typical Windows dev box `bash` resolves, in PATH order, to
 * one of several interpreters:
 *   - C:\Program Files\Git\...\bash.exe  — Git Bash (MSYS2)
 *   - C:\Windows\System32\bash.exe       — WSL
 *   - %LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe — WSL launcher
 * PM2 (which launches the PortOS server) frequently resolves the WSL one first.
 * WSL mounts drives at `/mnt/h/...`, so it CANNOT see a Windows drive path like
 * `H:/.../db.sh` and exits 127 ("No such file or directory"). Even if the path
 * were translated, WSL would run db.sh against Linux `docker`/`psql`, not the
 * Windows toolchain the script expects. Git Bash is the correct interpreter:
 * it accepts `H:/...` drive paths and shells out to the Windows tools.
 *
 * Path-format normalization alone can't fix this — no single drive-path string
 * works in BOTH Git Bash and WSL — so we resolve the Git Bash binary explicitly.
 *
 * Resolution order (Windows):
 *   1. PORTOS_BASH override — explicit escape hatch, always wins.
 *   2. Git Bash at the standard install locations.
 *   3. Git Bash derived from `git` on PATH (…\Git\cmd\git.exe → …\Git\bin\bash.exe).
 *   4. bare `bash` — last resort (preserves prior behavior).
 * On non-Windows there is only one bash; always return bare `bash`.
 *
 * Self-contained: no imports out to other PortOS modules.
 */

import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { execFileSync } from 'child_process';

const IS_WIN32 = process.platform === 'win32';

// Standard Git-for-Windows install locations. `\bin\bash.exe` is the MSYS2
// wrapper (preferred over `\usr\bin\bash.exe`, which skips the launcher env).
function standardGitBashPaths() {
  const candidates = [];
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA;
  candidates.push(join(programFiles, 'Git', 'bin', 'bash.exe'));
  candidates.push(join(programFilesX86, 'Git', 'bin', 'bash.exe'));
  if (localAppData) {
    // Per-user Git install (winget/scoop "Git.Git" user scope).
    candidates.push(join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'));
  }
  return candidates;
}

// Derive Git Bash from wherever `git` resolves on PATH:
// C:\Program Files\Git\cmd\git.exe → C:\Program Files\Git\bin\bash.exe
function gitBashFromPath() {
  let gitExe = '';
  try {
    gitExe = execFileSync('where', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  } catch {
    return null;
  }
  if (!gitExe) return null;
  // …\Git\cmd\git.exe → …\Git → …\Git\bin\bash.exe
  const gitRoot = dirname(dirname(gitExe));
  const bash = join(gitRoot, 'bin', 'bash.exe');
  return existsSync(bash) ? bash : null;
}

let cached;

/**
 * Resolve the bash binary to use for `*.sh` scripts. Memoized after first call.
 *
 * @returns {string} an absolute path to Git Bash on Windows (when found), or
 *   the bare command `bash` (non-Windows, or Windows fallback).
 */
export function resolveBashBinary() {
  if (cached !== undefined) return cached;
  if (!IS_WIN32) {
    cached = 'bash';
    return cached;
  }
  if (process.env.PORTOS_BASH && existsSync(process.env.PORTOS_BASH)) {
    cached = process.env.PORTOS_BASH;
    return cached;
  }
  const found = standardGitBashPaths().find(existsSync) || gitBashFromPath();
  if (found) {
    console.log(`🐚 Using Git Bash for shell scripts: ${found}`);
    cached = found;
    return cached;
  }
  // Nothing found — fall back to bare `bash` and warn, since this is the path
  // that produces the WSL drive-path failure if PATH resolves WSL first.
  console.warn('🐚 Git Bash not found; falling back to bare `bash` (set PORTOS_BASH to override). On Windows this may resolve to WSL and fail to see drive paths.');
  cached = 'bash';
  return cached;
}

/**
 * Reset the memoized resolution. Test-only.
 */
export function _resetBashResolverCache() {
  cached = undefined;
}
