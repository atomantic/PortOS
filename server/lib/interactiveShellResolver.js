/**
 * Pick the shell binary a PTY session (the Shell page, agent TUI shells) runs.
 *
 * THE PROBLEM (Windows). The default used to be `COMSPEC`, i.e. `cmd.exe`, and
 * `cmd.exe` cannot get you onto another drive by any command a user would
 * reasonably type:
 *
 *   cd I:                     → PRINTS `I:\` and stays put. `cd` without `/d`
 *                               reports the working dir *of* that drive rather
 *                               than switching to it — silent, no error.
 *   I:\  /  I:/               → "is not recognized as an internal or external
 *                               command" (a bare drive letter is a command, not
 *                               a `cd`; only `I:` alone works, and even that
 *                               only changes the drive, not the directory).
 *   cd 'I:\path\to\repo'      → "The filename, directory name, or volume label
 *                               syntax is incorrect" — cmd has no single-quote
 *                               quoting, so the quotes become part of the path.
 *
 * Only `cd /d "I:\path"` works, which is why `buildCdCommand` (lib/shellCd.js)
 * emits that form for the "cd to app" picker. But that fixes only the commands
 * PortOS sends — anything the user types by hand still fails, and a Windows
 * install whose repos live on a second drive is then stuck on `C:`.
 *
 * PowerShell has none of these problems: `cd I:`, `cd I:\path`, `cd 'I:\path'`
 * and `Set-Location` all cross drives, and it accepts both quote styles. So on
 * Windows we prefer PowerShell and keep `cmd.exe` only as a last resort.
 *
 * Resolution order (Windows):
 *   1. PORTOS_SHELL override — explicit escape hatch, always wins.
 *   2. PowerShell 7+ (`pwsh.exe`) at its versioned install dirs, newest major.
 *   3. Any other `pwsh.exe` on PATH — scoop, chocolatey, a custom prefix, or
 *      the winget/Store launcher shim under `WindowsApps`.
 *   4. Windows PowerShell 5.1 (`powershell.exe`) — ships with Windows, so this
 *      is the realistic floor; it crosses drives too, it just loads the user's
 *      profile (slower start) and is stuck on the older engine.
 *   5. `COMSPEC` / `cmd.exe` — only if no PowerShell exists at all.
 *
 * Resolution order (POSIX):
 *   1. PORTOS_SHELL override — same escape hatch as Windows (absolute path must
 *      exist; bare names pass through for PATH).
 *   2. `SHELL` when set — absolute path only if it exists; bare name unchecked.
 *   3. Common absolute candidates that exist on the host, in order:
 *      `/bin/bash`, `/usr/bin/bash`, `/bin/sh`, `/usr/bin/sh`, then zsh if
 *      present (`/bin/zsh`, `/usr/bin/zsh`). Bash/sh first because container and
 *      PM2 hosts often lack zsh; a login-shell `SHELL` already won in step 2 on
 *      macOS where zsh is the default.
 *   4. Bare `bash` / `sh` via `findCommandOnPath` (same PATH helper as Windows).
 *   5. Bare `sh` as the absolute last resort — never a hard-coded `/bin/zsh`
 *      that does not exist (node-pty `execvp`s the missing binary and the Shell
 *      page shows only `execvp(3) failed.: No such file or directory`).
 *
 * Why step 3–5 matter: under PM2 (and many containers) `process.env.SHELL` is
 * unset — the daemon never inherited a login shell — and minimal images ship
 * bash/sh but not zsh. The previous fallback of `/bin/zsh` was therefore a
 * guaranteed spawn failure on those hosts.
 */

import { existsSync, readdirSync } from 'fs';
import { win32 } from 'path';
import { findCommandOnPath } from './processEnv.js';

// The Windows branch below assembles WINDOWS paths, so it joins with win32
// semantics rather than the host's. On Windows the two are identical; off it,
// the platform `join` would splice Windows path fragments with `/` and produce
// `C:\Program Files/PowerShell/7/pwsh.exe` — which never matches a real path and
// makes the win32 branch untestable from a POSIX host, the exact thing the
// injectable `platform` exists to allow. Same reasoning as `win32.basename` in
// shellCd.js.
const { join } = win32;

/**
 * Absolute POSIX shells probed when neither PORTOS_SHELL nor an existing SHELL
 * answered. Bash/sh before zsh: containers and daemonized Node often lack zsh.
 */
const POSIX_SHELL_CANDIDATES = Object.freeze([
  '/bin/bash',
  '/usr/bin/bash',
  '/bin/sh',
  '/usr/bin/sh',
  '/bin/zsh',
  '/usr/bin/zsh',
]);

/**
 * `%ProgramFiles%\PowerShell\<major>\pwsh.exe` for every installed major
 * version, newest first. Enumerated rather than hard-coding `7` so a future
 * PowerShell 8 is picked up without a code change, and so a box with both 7 and
 * 8 gets the newer one.
 */
function pwshCandidatePaths(env, readdir) {
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean);
  const found = [];
  for (const root of roots) {
    const base = join(root, 'PowerShell');
    let entries;
    // readdirSync throws when PowerShell 7+ was never installed — the common
    // case on a stock Windows box, not an error worth surfacing.
    try {
      entries = readdir(base);
    } catch {
      continue;
    }
    // Numeric sort, not lexical: '10' must outrank '7'.
    const majors = entries
      .filter(name => /^\d+$/.test(name))
      .sort((a, b) => Number(b) - Number(a));
    for (const major of majors) found.push(join(base, major, 'pwsh.exe'));
  }
  return found;
}

// Probed in order and short-circuited, so the PATH scan only runs on a box with
// no versioned PowerShell 7 install.
function resolveWindowsShell(env, exists, readdir, findOnPath) {
  const versioned = pwshCandidatePaths(env, readdir).find(exists);
  if (versioned) return versioned;

  // Covers every non-standard pwsh install — scoop, chocolatey, a custom
  // prefix, and the winget/Store launcher shim under WindowsApps — rather than
  // hard-coding one more directory per packaging tool.
  const onPath = findOnPath('pwsh.exe', { env });
  if (onPath) return onPath;

  // Windows PowerShell 5.1 — present on every supported Windows.
  const ps5 = join(
    env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
  if (exists(ps5)) return ps5;

  return env.COMSPEC || 'cmd.exe';
}

/**
 * Accept a configured shell path/name the same way PORTOS_SHELL is accepted:
 * bare names pass through for PATH; absolute/relative paths must exist.
 * Returns null when the value is blank or a missing path.
 */
function acceptConfiguredShell(value, exists) {
  const trimmed = (value || '').trim();
  if (!trimmed) return null;
  if (!/[\\/]/.test(trimmed) || exists(trimmed)) return trimmed;
  return null;
}

function resolvePosixShell(env, exists, findOnPath) {
  // Prefer the user's login shell when the process inherited one that still
  // exists. A stale SHELL pointing at a removed binary must not strand the
  // session the way a hard-coded missing zsh used to.
  const fromEnv = acceptConfiguredShell(env.SHELL, exists);
  if (fromEnv) return fromEnv;

  const absolute = POSIX_SHELL_CANDIDATES.find(exists);
  if (absolute) return absolute;

  for (const name of ['bash', 'sh', 'zsh']) {
    const onPath = findOnPath(name, { env });
    if (onPath) return onPath;
  }

  // Bare name last: node-pty will search PATH. Prefer this over inventing an
  // absolute path that does not exist (the previous `/bin/zsh` default).
  console.warn(
    '🐚 No interactive shell binary found on disk or PATH — falling back to bare `sh`. '
    + 'Install bash/zsh or set PORTOS_SHELL to an existing shell.',
  );
  return 'sh';
}

/**
 * Resolve the shell without consulting (or populating) the memo. Exported for
 * tests, which need to drive the Windows branch from a POSIX host.
 *
 * @param {object} [deps]
 * @param {string} [deps.platform] - `process.platform` value
 * @param {NodeJS.ProcessEnv} [deps.env] - environment to read
 * @param {(path: string) => boolean} [deps.exists] - filesystem probe
 * @param {(dir: string) => string[]} [deps.readdir] - directory listing; may throw
 * @param {(name: string, opts: object) => string|null} [deps.findOnPath] - PATH lookup
 * @returns {string} shell binary path (or bare name, on POSIX)
 */
export function resolveInteractiveShellWith({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  readdir = readdirSync,
  findOnPath = findCommandOnPath,
} = {}) {
  // The override wins on every platform, but only if it actually resolves — a
  // stale path in `.env` must not strand every session on a shell that cannot
  // spawn. Bare names (`fish`, `pwsh`) are passed through unchecked and left to
  // PATH, since `exists` can't see them.
  const override = (env.PORTOS_SHELL || '').trim();
  if (override) {
    if (!/[\\/]/.test(override) || exists(override)) return override;
    // Silently auto-detecting past a typo'd override leaves the user with no
    // signal at all about why their setting had no effect.
    console.warn(`🐚 PORTOS_SHELL='${override}' does not exist — auto-detecting instead`);
  }

  if (platform !== 'win32') return resolvePosixShell(env, exists, findOnPath);
  return resolveWindowsShell(env, exists, readdir, findOnPath);
}

let cached;

/**
 * Resolve the interactive shell. Memoized after the first call — the answer is
 * a property of the machine, and every new PTY session would otherwise re-probe
 * the filesystem. Which binary a session actually got is logged by
 * `createShellSession`, per session.
 *
 * The memo captures whatever the first call resolved under the process env and
 * filesystem at that moment. Tests that change those must call
 * `_resetInteractiveShellCache()` (or use `resolveInteractiveShellWith`, which
 * never touches the memo). After this fix ships, the first resolve on a host
 * without zsh / without SHELL picks bash/sh instead of the old missing
 * `/bin/zsh` — restart the server (or reset the cache) so a process that
 * memoized the old answer before upgrade is not stuck on it.
 *
 * @returns {string} shell binary path (or bare name, on POSIX)
 */
export function resolveInteractiveShell() {
  if (cached === undefined) cached = resolveInteractiveShellWith();
  return cached;
}

/**
 * Reset the memoized resolution. Test-only (and post-upgrade recovery if a
 * long-lived process somehow reloads this module without restarting).
 */
export function _resetInteractiveShellCache() {
  cached = undefined;
}
