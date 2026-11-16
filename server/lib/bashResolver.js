/**
 * POSIX `bash` resolution for running bundled `*.sh` scripts (notably
 * `scripts/db.sh`) on Windows.
 *
 * On Windows a bare `bash` often resolves (via PM2's PATH) to WSL, which mounts drives at
 * `/mnt/h`, cannot see `H:/...` paths (exit 127), and would use Linux `docker`/`psql`. Git
 * Bash accepts drive paths and runs the Windows toolchain. No single path string works in both,
 * so `resolveBashBinary()` picks Git Bash explicitly: PORTOS_BASH override, standard install
 * dirs, derived from `git` on PATH, then bare `bash`. Always bare `bash` on non-Windows.
 * `toBashPath(p)` is the companion path rule: bash reads backslashes as escapes.
 *
 * Self-contained: no imports out to other PortOS modules.
 */

import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { execFileSync } from './childProcess.js';

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

/**
 * A path in the form bash can open: backslashes are escapes to bash (`H:\repo\x.sh` becomes
 * `H:repox.sh`), while Git Bash accepts forward-slash drive paths. No-op on POSIX.
 * @param {string} p
 * @returns {string}
 */
export const toBashPath = (p) => String(p).replace(/\\/g, '/');

let cached;

/**
 * Resolve the bash binary for `*.sh` scripts; memoized after first call.
 * @returns {string} absolute Git Bash path on Windows when found, else bare `bash`.
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
  // Bare `bash` here yields the WSL drive-path failure if PATH resolves WSL first.
  console.warn('🐚 Git Bash not found; falling back to bare `bash` (set PORTOS_BASH to override). On Windows this may resolve to WSL and fail to see drive paths.');
  cached = 'bash';
  return cached;
}

/** Reset the memoized resolution. Test-only. */
export function _resetBashResolverCache() {
  cached = undefined;
}
