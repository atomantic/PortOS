import { spawn, ChildProcess } from './childProcess.js';
import { existsSync } from 'fs';
import { delimiter, isAbsolute, join } from 'path';
import { withSpawnCwdEnv } from './spawnCwd.js';

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

/**
 * Compose `resolveWindowsExecutable` + `prepareWindowsSafeSpawn` into the single
 * `{ command, args }` pair a caller should hand to `spawn()` under the default
 * `shell: false`. This is the canonical fix for spawning a bare npm-installed
 * CLI provider (`opencode`, `codex`, `claude`, …) — a `.cmd`/`.bat` shim on
 * Windows — safely: resolve the bare name to its explicit-extension path, then
 * wrap a `.cmd`/`.bat` target as `cmd.exe /c <path> <args>` (see the two
 * helpers' docstrings for why a direct `.cmd` spawn fails post-CVE-2024-27980
 * and why `shell:true` is unsafe).
 *
 * Every terminal condition off-Windows is a no-op: `resolveWindowsExecutable`
 * returns `null` (so the bare `command` is kept) and `prepareWindowsSafeSpawn`
 * returns `{ command, args }` unchanged — POSIX callers get exactly what they
 * passed in.
 *
 * Resolution reads `searchEnv.PATH`/`.Path` — pass the actual env the child
 * will run under (after merging a provider's `envVars`) so a per-provider PATH
 * override is honored; defaults to `process.env`.
 *
 * The `server/services/runner.js`, `visionCli.js`, and `cliProviderRun.js`
 * paths pre-date this helper and still inline the two-step form; new callers
 * (the Chief-of-Staff agent spawners) use this instead.
 *
 * @param {string} command - bare command name, or an existing path
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [searchEnv] - env to read PATH from; defaults to `process.env`
 * @param {boolean} [isWin32] - injectable for tests; defaults to the real platform
 * @returns {{ command: string, args: string[] }} launchable pair for `spawn()`
 */
export function prepareCliSpawn(command, args, searchEnv = process.env, isWin32 = IS_WIN32) {
  const resolved = resolveWindowsExecutable(command, isWin32, searchEnv) || command;
  return prepareWindowsSafeSpawn(resolved, args, isWin32);
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
 * The win32 branch is gated on the target OWNING a `.kill()` of its own — some
 * callers (the aiToolkit runner's `stopRun`, via `registerExternalRun`) pass
 * this a killable that isn't a `child_process` spawn at all, e.g. a node-pty
 * `IPty` TUI session, which also exposes `.kill()`/`.pid`. A raw `taskkill`
 * against a pty's pid bypasses node-pty's own Windows teardown (releasing its
 * native ConPTY handle), leaking it — so any non-ChildProcess killable that
 * brings its own `.kill()` always uses it instead, on every platform.
 *
 * A bare `{ pid }` target is the third shape: a process this server never held
 * a handle to at all — `spawnDetached`'s Windows supervisor job, and the orphan
 * `reapDetached` finds through a control dir's pid file — so there is no
 * `.kill()` to prefer and the pid is the only address it has. It takes the same
 * tree-kill a ChildProcess does, which is what gives a detached Windows job the
 * "the runner's ffmpeg/python descendants die with it" guarantee POSIX gets
 * from a process-group signal (#4171, #6170).
 *
 * node-pty's Windows backend additionally throws `Signals not supported on
 * windows.` for ANY signal argument, so `kill(signal)` against a pty there never
 * kills anything — it throws past the caller, which typically logs it and moves
 * on while the PTY keeps running. That is why every CoS Runner TUI kill
 * (terminate, force-kill, pause, and the server's post-finalize relay) was a
 * silent no-op on Windows: the codex/claude PTY survived, held its worktree
 * locked, and stayed in the runner's active set — which the PortOS server
 * re-adopted on every orphan sweep and counted against the Update page's
 * "N CoS agents running" gate, pausing updates indefinitely.
 *
 * So a non-ChildProcess killable is offered the caller's signal FIRST and falls
 * back to a bare `kill()` only when the handle rejects it. Dropping the signal
 * unconditionally would be wrong for the other non-ChildProcess killables in
 * this codebase, which do accept one and forward it — `cosRunnerClient`'s TUI
 * proxy relays `{ signal }` over a socket, so an unconditional drop would
 * silently downgrade a force-kill to a graceful one. A bare `kill()` still tears
 * down node-pty's whole console process list, so nothing is lost where the
 * fallback does fire: the graceful/forced distinction simply is not expressible
 * for a Windows pty.
 *
 * `processGroup` is for a child spawned `detached` on POSIX: without it the
 * non-Windows branch signals a single pid, which leaves a shell's own children
 * (the uv / pip / git an installer script shells out to) running. With it the
 * negative pid signals the whole group, falling back to the single pid when the
 * group is already gone. Windows needs no flag — `taskkill /T` is always the
 * tree. Off by default because a non-detached child shares its PARENT's group,
 * where a group signal would reach the wrong processes.
 *
 * `signal` applies to the **POSIX** branch only (`SIGTERM` default → the
 * graceful-then-`SIGKILL`-escalation pattern callers expect). On Windows there
 * is no real POSIX signal — `taskkill /T /F` force-kills the whole tree
 * regardless — so the arg is ignored there. A caller that wraps a `.cmd`/`.bat`
 * shim via `prepareCliSpawn` (its child is a `cmd.exe /c …` parent) MUST use
 * this rather than `child.kill()`, or on Windows only the `cmd.exe` shim dies
 * and the real CLI child is orphaned.
 *
 * @param {import('child_process').ChildProcess|{pid: number, kill?: Function}} child - a ChildProcess, any killable exposing `.pid`/`.kill()`, or a bare `{ pid }`
 * @param {NodeJS.Signals} [signal] - POSIX signal to send (default `SIGTERM`); ignored on Windows
 * @param {{processGroup?: boolean}} [opts] - POSIX: signal the child's process group (it must have been spawned `detached`)
 * @param {boolean} [isWin32] - platform override, injected so the Windows branches are testable off Windows (same shape as `resolveWindowsExecutable`)
 */
export function killProcessTree(child, signal = 'SIGTERM', { processGroup = false } = {}, isWin32 = IS_WIN32) {
  const isChildProcess = child instanceof ChildProcess;
  // A target with no `.kill()` of its own is addressable only by pid — nothing
  // to prefer over the platform's own tree/group kill below.
  const isPidOnly = !isChildProcess && typeof child.kill !== 'function';
  if (isWin32 && child.pid && (isChildProcess || isPidOnly)) {
    child.killed = true;
    spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' })
      .on('error', () => {})
      .unref();
    return;
  }
  if (processGroup && child.pid) {
    try { process.kill(-child.pid, signal); return; }
    catch { /* ESRCH — the group is already gone; fall through to the pid */ }
  }
  if (isPidOnly) {
    // POSIX, pid-only: the group signal above either landed or the group is
    // gone, so this is the plain per-pid signal — swallowing ESRCH exactly as
    // the group attempt does, since a target that already exited is not a
    // failure to report.
    try { process.kill(child.pid, signal); }
    catch { /* ESRCH — already gone */ }
    return;
  }
  if (isWin32 && !isChildProcess) {
    // node-pty rejects the signal outright on Windows (see the note above);
    // every other killable here accepts and forwards it, so ask first and only
    // fall back to the signal-free form for the handle that refuses. Retrying a
    // kill is harmless — the first attempt did nothing.
    try { child.kill(signal); }
    catch { child.kill(); }
    return;
  }
  child.kill(signal);
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
 * @param {NodeJS.ProcessEnv} [options.env] - complete child environment
 * @param {number} [options.timeoutMs] - kill + resolve as timed-out after this
 * @param {number} [options.killGraceMs=8000] - SIGTERM grace period before fire-and-forget SIGKILL cleanup
 * @param {boolean} [options.shell] - defaults to `needsShell(cmd)`
 * @returns {Promise<object>} structured result (never rejects)
 */
export function bufferedSpawn(cmd, args, { cwd, env = process.env, timeoutMs, killGraceMs = 8000, shell } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      // Pin PWD to the spawn cwd — see withSpawnCwdEnv (#3193). Done in this
      // shared wrapper rather than at each caller so every present and future
      // bufferedSpawn user inherits it; `withSpawnCwdEnv` returns an unchanged
      // copy of process.env when no cwd was given, matching the previous
      // implicit-inherit behavior exactly.
      env: withSpawnCwdEnv(env, cwd),
      shell: shell === undefined ? needsShell(cmd) : shell,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = timeoutMs
      ? setTimeout(() => {
          if (!settled) {
            settled = true;
            killProcessTree(child, 'SIGTERM');
            if (!IS_WIN32) {
              const escalationTimer = setTimeout(() => {
                try {
                  if (child.exitCode === null && child.signalCode === null) {
                    console.log(`⚠️ ${cmd} didn't exit on SIGTERM — escalating to SIGKILL`);
                    killProcessTree(child, 'SIGKILL');
                  }
                } catch (err) {
                  console.error(`❌ ${cmd} SIGKILL escalation failed: ${err.message}`);
                }
              }, killGraceMs);
              escalationTimer.unref?.();
            }
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

/**
 * The most useful sentence from a FAILED `bufferedSpawn` result.
 *
 * Callers of a `--json` CLI need this rather than a bare exit code, and the
 * naive "last line of stderr, else stdout" walk gets it wrong for exactly those
 * tools: they print their payload to stdout even when they exit non-zero, so the
 * last stdout line is a closing `}` or `]`. Prefers the spawn error, then a
 * stderr line, then a stdout line that isn't just JSON punctuation.
 *
 * @param {{error?: Error, stderr?: string, stdout?: string}} result - a `bufferedSpawn` result
 * @param {string} fallback - used when the command failed without saying anything
 * @returns {string}
 */
export function spawnFailureDetail(result, fallback) {
  if (result?.error?.message) return result.error.message;
  const lastLine = (text) => String(text || '').trim().split(/\r?\n/).filter(Boolean).pop();
  const stderrTail = lastLine(result?.stderr);
  if (stderrTail) return stderrTail;
  const stdoutTail = lastLine(result?.stdout);
  if (stdoutTail && !/^[}\]]+,?$/.test(stdoutTail)) return stdoutTail;
  return fallback;
}

/**
 * Attach the no-op `'error'` listener every spawned child's `stdin` needs before
 * anything writes to it.
 *
 * A child that dies before reading its stdin (a CLI that isn't on PATH, or one
 * that exits on a bad flag) makes the pipe emit `EPIPE`. A stream `'error'` with
 * no listener is re-thrown by Node, and every spawn site here runs OUTSIDE the
 * Express request lifecycle — there is no `next(err)` to bubble to, so the throw
 * takes down the single server process that owns every live agent run, PTY
 * shell, media job and socket. Swallowing it is correct: the child's own
 * `'error'`/`'exit'`/`'close'` handler is the authoritative settle point and
 * reports the real cause. It is logged rather than dropped, because a child
 * that exits 0 after refusing its prompt would otherwise be recorded as a clean
 * run with no trace of the prompt never having been delivered.
 *
 * A crash guard must never be the crash: a `spawn()` that failed command lookup
 * hands back a handle with no stdio at all, and a child configured with a
 * non-pipe stdin has no emitter to listen on either. Both are a no-op here
 * rather than a `TypeError` thrown from the very line meant to prevent one.
 *
 * @param {import('child_process').ChildProcess} child
 * @returns {import('child_process').ChildProcess} the same child, for chaining
 */
export function guardChildStdin(child) {
  if (typeof child?.stdin?.on === 'function') {
    child.stdin.on('error', (err) => {
      console.warn(`⚠️ child stdin closed before the prompt was delivered: ${err?.code || err?.message || err}`);
    });
  }
  return child;
}

/**
 * Deliver a prompt on a guarded child's `stdin` and close the pipe.
 *
 * Pair with `guardChildStdin`, which must already have run — this covers the
 * OTHER half of the same hazard, a `write()` that throws *synchronously* (an
 * already-destroyed pipe, or a payload that isn't a string/Buffer). That throw
 * escapes the spawn site the same way an unlistened `'error'` does, so it is
 * caught here.
 *
 * Two things then have to happen, and both were missed by the naive
 * swallow-and-continue: the pipe is destroyed, so a child that IS still reading
 * stdin sees EOF instead of waiting forever on a write that never lands; and
 * the failure is logged, because a provider that gets an empty prompt and exits
 * 0 would otherwise be filed as a clean run with nothing to explain the empty
 * output. The child's own `'error'`/`'close'` handler stays the authoritative
 * settle point, so this deliberately does not rethrow or settle anything.
 *
 * @param {import('child_process').ChildProcess} child
 * @param {string|Buffer|null} payload - written when non-null; pass null when the
 *   prompt was already delivered by argv or a temp file and stdin only needs closing
 * @param {string} label - names the run/agent in the failure log
 * @returns {boolean} true when the prompt was handed off cleanly
 */
export function deliverChildStdin(child, payload, label) {
  if (!child?.stdin) {
    console.error(`❌ ${label} has no stdin pipe — the prompt was not delivered`);
    return false;
  }
  try {
    if (payload != null) child.stdin.write(payload);
    child.stdin.end();
    return true;
  } catch (err) {
    console.error(`❌ ${label} stdin write failed, closing the pipe: ${err?.code || err?.message || err}`);
    child.stdin?.destroy();
    return false;
  }
}
