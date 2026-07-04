import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { delimiter, isAbsolute, join } from 'path';

/**
 * Shared buffered-spawn + Windows kill-tree machinery used by the app build and
 * update services (`server/services/appBuilder.js`, `server/services/appUpdater.js`).
 *
 * The two call sites historically carried near-identical copies of this logic;
 * they differed only in their result contract:
 *   - appBuilder maps failures to HTTP codes without try/catch, so it needs a
 *     structured non-throwing result.
 *   - appUpdater throws on failure.
 *
 * This module provides ONE structured-result core (`bufferedSpawn`) plus a thin
 * throwing adapter (`bufferedSpawnOrThrow`) so both contracts share the same
 * spawn / buffering / timeout / kill-tree code.
 *
 * Pure module-level constants and platform predicates are exported so callers
 * (and tests, on any platform) can reuse the shell-shim / kill decisions.
 */

export const IS_WIN32 = process.platform === 'win32';

// npm/npx are .cmd shims on Windows — enable shell only for these so cmd.exe
// can resolve them, without enabling shell metacharacter interpretation for
// native binaries (xcodebuild, swift, make, cargo, git, …).
export const WIN_CMD_SHIMS = new Set(['npm', 'npx']);

/**
 * True when a command must run through cmd.exe to be resolved on Windows.
 * Pure and platform-independent in shape — the `IS_WIN32` gate keeps it false
 * everywhere else.
 */
export const needsShell = (cmd) => IS_WIN32 && WIN_CMD_SHIMS.has(cmd);

// Extensions Windows can launch directly, checked in cmd.exe's own resolution
// preference (a real .exe wins over a batch shim when both exist). Deliberately
// excludes an extension-less match — npm ships a POSIX shell-script stub
// alongside a package's `.cmd`/`.bat`/`.ps1` Windows wrappers (for Git
// Bash/WSL), and that stub is not natively launchable on Windows.
const WIN_EXECUTABLE_EXTS = ['.exe', '.cmd', '.bat', '.com'];

/**
 * Resolve a bare command name (e.g. "opencode") to its full path WITH
 * extension on Windows, so the caller knows exactly which file (and which
 * kind — `.exe` vs `.cmd`/`.bat`) it's about to launch.
 *
 * A bare command with no extension never resolves on Windows even though
 * typing it at a real cmd.exe prompt works fine: libuv's internal PATHEXT
 * search finds e.g. "opencode.cmd", but `spawn()`'s default `shell: false`
 * doesn't apply that search at all (it targets the literal string given).
 *
 * Deliberately filesystem-only (no `where`/`which` subprocess) so resolution
 * is synchronous and side-effect-free. Pair with `prepareWindowsSafeSpawn`
 * below to get a `{ command, args }` pair that's actually launchable.
 *
 * Searches `searchEnv.PATH`/`.Path`, NOT necessarily `process.env` — pass the
 * actual env object the child will run under (e.g. after merging a
 * provider's `envVars`) so a per-provider `PATH` override is honored. The
 * default is `process.env` for callers that don't customize the child env.
 *
 * @param {string} command - bare command name, or an existing path (returned unchanged)
 * @param {boolean} [isWin32] - injectable for tests; defaults to the real platform
 * @param {NodeJS.ProcessEnv} [searchEnv] - env to read PATH from; defaults to `process.env`
 * @returns {string|null} the resolved absolute path, or null when not found
 *   (off win32, command is already a path, or no match exists on PATH)
 */
export function resolveWindowsExecutable(command, isWin32 = IS_WIN32, searchEnv = process.env) {
  if (!isWin32 || !command || isAbsolute(command) || /[\\/]/.test(command)) return null;
  const pathDirs = (searchEnv.PATH || searchEnv.Path || '').split(delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const ext of WIN_EXECUTABLE_EXTS) {
      const candidate = join(dir, `${command}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const WIN_BATCH_EXT_RE = /\.(cmd|bat)$/i;

/**
 * Return the `{ command, args }` pair that's actually safe to hand to
 * `spawn()`/`execFile()` under the default `shell: false`, given a (possibly
 * `resolveWindowsExecutable`-resolved) command.
 *
 * THE ACTUAL FIX FOR #1865. An earlier version of this fix assumed Node's
 * CVE-2024-27980 patch safely auto-escapes a `.bat`/`.cmd` target under
 * `shell: false` once it carries the explicit extension — that's wrong. The
 * shipped patch instead makes `spawn()`/`spawnSync()` **refuse** (an
 * `'error'`/EINVAL-class failure) any `.bat`/`.cmd` target under
 * `shell: false`, full stop; per Node's own docs, `.bat`/`.cmd` files
 * "are not executable on their own... and cannot be launched" that way.
 * Node's documented safe alternative is to spawn `cmd.exe /c <path> <args>`
 * directly: `cmd.exe` is a normal `.exe`, so Node's existing, already-tested
 * non-shell argv→command-line escaping governs the result — correctly
 * preserving spaces/quotes in each arg — with none of `shell: true`'s
 * DEP0190 unescaped-join hazard (a literal `shell: true` + args array does
 * NOT escape arguments, it just space-joins them).
 *
 * A resolved native `.exe`/`.com` target needs no wrapping at all — it's
 * directly launchable, so it's returned unchanged.
 *
 * The resolved path AND each arg are passed through
 * `escapeCmdMetacharsIfUnquoted` (see its docstring) — Node's own
 * argv→command-line quoting only wraps a value in literal double quotes when
 * it contains whitespace/a quote; a value with none of those reaches
 * cmd.exe's raw command line UNQUOTED, so a bare metacharacter like `&` in
 * it would still be interpreted by cmd.exe as a command separator despite
 * `shell:false` — this covers both a metacharacter in an arg AND one in the
 * resolved install path itself (e.g. a custom npm prefix directory named
 * `C:\Tools&CLIs\npm`).
 *
 * @param {string} command - bare name, or a resolveWindowsExecutable result
 * @param {string[]} args
 * @param {boolean} [isWin32] - injectable for tests; defaults to the real platform
 * @returns {{ command: string, args: string[] }}
 */
export function prepareWindowsSafeSpawn(command, args, isWin32 = IS_WIN32) {
  if (isWin32 && WIN_BATCH_EXT_RE.test(command)) {
    return {
      command: 'cmd.exe',
      args: ['/c', escapeCmdMetacharsIfUnquoted(command), ...args.map(escapeCmdMetacharsIfUnquoted)],
    };
  }
  return { command, args };
}

// cmd.exe metacharacters that act as command separators / redirection /
// grouping on its raw command line.
const CMD_METACHAR_RE = /[&|<>^()]/g;
// Node's argv→command-line quoting (CommandLineToArgvW rules, used because
// cmd.exe is a normal executable target from Node's point of view) wraps an
// argument in literal double quotes only when it contains whitespace or a
// `"` — characters inside that quoted span are not re-interpreted by cmd.exe.
const NEEDS_NODE_QUOTING_RE = /[\s"]/;

/**
 * Caret-escape cmd.exe metacharacters in an argument, but ONLY when Node's
 * own quoting (see NEEDS_NODE_QUOTING_RE above) would otherwise leave it
 * unquoted on cmd.exe's raw command line. An argument containing whitespace
 * is deliberately left untouched here — it's already wrapped in literal
 * double quotes by Node, and caret-escaping it too would inject literal `^`
 * characters into the value the target program receives, corrupting it.
 * This is the narrower, conservative fix for the specific gap: an argument
 * with NO whitespace but a metacharacter (e.g. `foo&calc`) reaches cmd.exe
 * unquoted and unprotected without this.
 */
function escapeCmdMetacharsIfUnquoted(value) {
  const str = String(value);
  if (NEEDS_NODE_QUOTING_RE.test(str)) return str;
  return str.replace(CMD_METACHAR_RE, '^$&');
}

// Cap buffered stdout/stderr so a runaway child can't exhaust memory; we only
// ever surface a tail of the output anyway.
export const MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Terminate a child process and its descendants.
 *
 * On Windows, SIGTERM kills the cmd.exe shim but orphans its child (npm), so we
 * use `taskkill /T /F` to take down the whole process tree. The taskkill spawn
 * is fire-and-forget: its own `error` is swallowed and the handle is unref'd so
 * it never keeps the event loop alive. Elsewhere, a plain SIGTERM suffices.
 *
 * `child.killed` is set synchronously on the win32 branch (mirroring what
 * Node's own `child.kill()` does for the POSIX branch) — callers elsewhere
 * gate re-entrant kill/abort handling on `.killed`, and `taskkill` runs in a
 * separate detached process that never touches the original ChildProcess
 * object, so without this the flag would stay `false` for the process's
 * entire lifetime and those guards would never engage on Windows.
 *
 * The win32 branch is gated on `instanceof ChildProcess` — some callers (the
 * aiToolkit runner's `stopRun`, via `registerExternalRun`) pass this a
 * killable that isn't a `child_process` spawn at all, e.g. a node-pty `IPty`
 * TUI session, which also exposes `.kill()`/`.pid`. A raw `taskkill` against
 * a pty's pid bypasses node-pty's own Windows teardown (releasing its native
 * ConPTY handle), leaking it — so any non-ChildProcess killable always uses
 * its own `.kill()` instead, on every platform.
 *
 * @param {import('child_process').ChildProcess} child
 */
export function killProcessTree(child) {
  if (IS_WIN32 && child.pid && child instanceof ChildProcess) {
    child.killed = true;
    spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true })
      .on('error', () => {})
      .unref();
  } else {
    child.kill('SIGTERM');
  }
}

/**
 * Spawn a command, buffer its (capped) stdout/stderr, enforce a timeout, and
 * resolve a structured result. NEVER rejects — every terminal condition
 * (clean exit, non-zero exit, spawn error, timeout) resolves a result object.
 *
 * The result is a superset of what both call sites need:
 *   {
 *     success: boolean,        // true iff the process exited 0 within timeout
 *     code: number|null,       // exit code; -1 for timeout/spawn-error
 *     signal: string|null,     // termination signal, when applicable
 *     stdout: string,          // captured stdout (tail-capped, NOT trimmed)
 *     stderr: string,          // captured stderr (tail-capped, NOT trimmed)
 *     timedOut: boolean,       // true iff the timeout fired
 *     error?: Error,           // present only on a spawn 'error' event
 *   }
 *
 * Callers shape this into their own contract (e.g. an `output` tail string, an
 * `exitCode` alias, or a thrown Error) — see `bufferedSpawnOrThrow` and the
 * appBuilder result mappers.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} options
 * @param {string} [options.cwd]
 * @param {number} [options.timeoutMs] - kill + resolve as timed-out after this
 * @param {boolean} [options.shell] - defaults to `needsShell(cmd)`
 * @returns {Promise<object>} structured result (never rejects)
 */
export function bufferedSpawn(cmd, args, { cwd, timeoutMs, shell } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      windowsHide: true,
      shell: shell === undefined ? needsShell(cmd) : shell,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = timeoutMs
      ? setTimeout(() => {
          if (!settled) {
            settled = true;
            killProcessTree(child);
            resolve({ success: false, code: -1, signal: null, stdout, stderr, timedOut: true });
          }
        }, timeoutMs)
      : null;

    const clear = () => { if (timer) clearTimeout(timer); };

    child.stdout.on('data', (d) => {
      stdout += d;
      if (stdout.length > MAX_OUTPUT_BYTES) stdout = stdout.slice(-MAX_OUTPUT_BYTES);
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > MAX_OUTPUT_BYTES) stderr = stderr.slice(-MAX_OUTPUT_BYTES);
    });
    child.on('close', (code, signal) => {
      if (!settled) {
        settled = true;
        clear();
        resolve({ success: code === 0, code, signal, stdout, stderr, timedOut: false });
      }
    });
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clear();
        resolve({ success: false, code: -1, signal: null, stdout, stderr, timedOut: false, error: err });
      }
    });
  });
}

/**
 * Throwing adapter over `bufferedSpawn` for call sites that want an exception on
 * failure (the appUpdater contract). Resolves `{ stdout, stderr }` on a clean
 * exit; rejects on spawn error, timeout, or non-zero exit.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} options - same as `bufferedSpawn`, plus optional `timeoutLabel`
 * @param {string} [options.timeoutLabel] - prefix for the timeout error message (defaults to `cmd`)
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export async function bufferedSpawnOrThrow(cmd, args, options = {}) {
  const { timeoutLabel = cmd, ...spawnOpts } = options;
  const result = await bufferedSpawn(cmd, args, spawnOpts);
  if (result.error) throw result.error;
  if (result.timedOut) {
    throw new Error(`${timeoutLabel} timed out after ${(spawnOpts.timeoutMs ?? 0) / 1000}s`);
  }
  if (!result.success) {
    throw new Error(result.stderr.trim() || `${cmd} exited with code ${result.code}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}
