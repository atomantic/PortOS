/**
 * Pick the shell binary a PTY session (the Shell page, agent TUI shells) runs.
 *
 * Windows prefers PowerShell over `cmd.exe`: cmd cannot cross drives by any
 * command a user would type (`cd I:` prints and stays put, `I:\` is "not
 * recognized", single-quoted paths fail), so an install with repos on a second
 * drive would be stuck on `C:`. `buildCdCommand` (lib/shellCd.js) emits
 * `cd /d "I:\path"`, but that only fixes commands PortOS sends.
 *
 * Resolution order (Windows):
 *   1. PORTOS_SHELL override — explicit escape hatch, always wins.
 *   2. PowerShell 7+ (`pwsh.exe`) at its versioned install dirs, newest major.
 *   3. Any other `pwsh.exe` on PATH (scoop, chocolatey, winget/Store shim).
 *   4. Windows PowerShell 5.1 (`powershell.exe`) — the realistic floor.
 *   5. `COMSPEC` / `cmd.exe` — only if no PowerShell exists at all.
 *
 * Resolution order (POSIX):
 *   1. PORTOS_SHELL override (absolute path must exist; bare names pass
 *      through for PATH).
 *   2. `SHELL` when set — absolute path only if it exists; bare name unchecked.
 *   3. Existing absolute candidates: `/bin/bash`, `/usr/bin/bash`, `/bin/sh`,
 *      `/usr/bin/sh`, then zsh. Bash/sh first because container and PM2 hosts
 *      often lack zsh and have no `SHELL`.
 *   4. Bare `bash` / `sh` via `findCommandOnPath`.
 *   5. Bare `sh` as the last resort — never a hard-coded missing `/bin/zsh`
 *      (node-pty `execvp`s it and the Shell page shows only
 *      `execvp(3) failed.: No such file or directory`).
 */

import { existsSync, readdirSync } from 'fs';
import { win32 } from 'path';
import { findCommandOnPath, windowsPowerShell51Path } from './processEnv.js';

// The Windows branch assembles WINDOWS paths, so it joins with win32 semantics
// even on a POSIX host (otherwise `C:\Program Files/PowerShell/7/pwsh.exe`, and
// the injectable `platform` could not test it). Same as `win32.basename` in
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
 * `%ProgramFiles%\PowerShell\<major>\pwsh.exe` for every installed major, newest
 * first. Enumerated so a future major is picked up without a code change.
 */
function pwshCandidatePaths(env, readdir) {
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean);
  const found = [];
  for (const root of roots) {
    const base = join(root, 'PowerShell');
    let entries;
    // readdirSync throws when PowerShell 7+ was never installed — the common case.
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

  // Covers non-standard pwsh installs (scoop, chocolatey, winget/Store shim
  // under WindowsApps) without hard-coding a directory per packaging tool.
  const onPath = findOnPath('pwsh.exe', { env });
  if (onPath) return onPath;

  // Windows PowerShell 5.1 — present on every supported Windows.
  const ps5 = windowsPowerShell51Path(env);
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
  // Prefer the login shell when it still exists; a stale SHELL pointing at a
  // removed binary must not strand the session.
  const fromEnv = acceptConfiguredShell(env.SHELL, exists);
  if (fromEnv) return fromEnv;

  const absolute = POSIX_SHELL_CANDIDATES.find(exists);
  if (absolute) return absolute;

  for (const name of ['bash', 'sh', 'zsh']) {
    const onPath = findOnPath(name, { env });
    if (onPath) return onPath;
  }

  // Bare name last: node-pty will search PATH.
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
  // The override wins everywhere but only if it resolves — a stale path in
  // `.env` must not strand every session. Bare names pass through for PATH.
  const override = (env.PORTOS_SHELL || '').trim();
  if (override) {
    if (!/[\\/]/.test(override) || exists(override)) return override;
    // Say why the setting had no effect rather than silently auto-detecting.
    console.warn(`🐚 PORTOS_SHELL='${override}' does not exist — auto-detecting instead`);
  }

  if (platform !== 'win32') return resolvePosixShell(env, exists, findOnPath);
  return resolveWindowsShell(env, exists, readdir, findOnPath);
}

let cached;

/**
 * Resolve the interactive shell. Memoized after the first call — the answer is
 * a property of the machine. Tests that change the env or filesystem must call
 * `_resetInteractiveShellCache()` (or use `resolveInteractiveShellWith`, which
 * never touches the memo).
 *
 * @returns {string} shell binary path (or bare name, on POSIX)
 */
export function resolveInteractiveShell() {
  if (cached === undefined) cached = resolveInteractiveShellWith();
  return cached;
}

/** Reset the memoized resolution (tests). */
export function _resetInteractiveShellCache() {
  cached = undefined;
}
