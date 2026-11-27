/**
 * `bufferedSpawn` (non-throwing) and `bufferedSpawnOrThrow` run a child with buffered output;
 * Process-tree helpers signal, escalate, or confirm Windows taskkill completion.
 */

import { spawn, ChildProcess } from './childProcess.js';
import { resolveWindowsExecutable, prepareWindowsSafeSpawn, resolveCmdShimLaunch } from './aiToolkit/internal/windowsSafeSpawn.js';

// Keep the host's public API while sharing the toolkit's self-contained leaf.
export { resolveWindowsExecutable, prepareWindowsSafeSpawn, resolveCmdShimLaunch };
import { withSpawnCwdEnv } from './spawnCwd.js';
import { trackDetachedGroup } from './detachedProcessGroups.js';

/** Shared buffered-spawn + kill-tree core for appBuilder (structured result) and appUpdater (throwing adapter). */

export const IS_WIN32 = process.platform === 'win32';

// npm/npx are .cmd shims on Windows; shell is enabled only for these so native binaries get no metacharacter interpretation.
export const WIN_CMD_SHIMS = new Set(['npm', 'npx']);

/** True when a command must run through cmd.exe to be resolved on Windows. */
export const needsShell = (cmd) => IS_WIN32 && WIN_CMD_SHIMS.has(cmd);

/**
 * Compose `resolveWindowsExecutable` + `prepareWindowsSafeSpawn` into the `{ command, args }` pair to hand to
 * `spawn()` under `shell: false` (a bare npm-installed CLI is a `.cmd` shim on Windows). Off-Windows it is a no-op.
 * Resolution reads `searchEnv.PATH`/`.Path`, so pass the env the child will actually run under.
 *
 * @param {string} command - bare command name, or an existing path
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [searchEnv] - env to read PATH from; defaults to `process.env`
 * @param {boolean} [isWin32] - injectable for tests; defaults to the real platform
 * @returns {{ command: string, args: string[] }} launchable pair for `spawn()`
 */
export function prepareCliSpawn(command, args, searchEnv = process.env, isWin32 = IS_WIN32) {
  const resolved = resolveWindowsExecutable(command, isWin32, searchEnv) || command;
  return prepareWindowsSafeSpawn(resolved, args, isWin32, searchEnv);
}

// Cap buffered output so a runaway child can't exhaust memory; only a tail is ever surfaced.
export const MAX_OUTPUT_BYTES = 64 * 1024;

const WINDOWS_TASKKILL_TIMEOUT_MS = 10000;
const pendingWindowsTreeKills = new WeakMap();

const taskkillArgs = pid => ['/T', '/F', '/PID', String(pid)];

function isWindowsTaskkillTarget(child, isWin32) {
  return isWin32 && child.pid && (child instanceof ChildProcess || typeof child.kill !== 'function');
}

function confirmTaskkill(child) {
  // An exited ChildProcess still has a PID, which Windows may have recycled.
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  const { pid } = child;
  return new Promise((resolve, reject) => {
    const killer = spawn('taskkill', taskkillArgs(pid), {
      stdio: 'ignore',
      signal: AbortSignal.timeout(WINDOWS_TASKKILL_TIMEOUT_MS),
    });
    killer.once('error', error => reject(new Error(`Could not run taskkill for PID ${pid}: ${error.message}`, { cause: error })));
    killer.once('close', (code, signal) => {
      if (code === 0) return resolve();
      if (code != null) {
        // A nonzero exit can mean the target already went away. Access denial
        // and other probe errors leave its liveness unknown.
        try { process.kill(pid, 0); }
        catch (error) { if (error.code === 'ESRCH') return resolve(); }
      }
      reject(new Error(`taskkill failed for PID ${pid} (${signal ?? `exit code ${code}`})`));
    });
  });
}

/** Awaitable taskkill for explicit CoS force-kill. Null delegates to the ordinary signal path. */
export function confirmWindowsProcessTreeExit(child, isWin32 = process.platform === 'win32') {
  if (!isWindowsTaskkillTarget(child, isWin32) || typeof child.requestWindowsAgentStop === 'function') return null;
  let termination = pendingWindowsTreeKills.get(child);
  if (!termination) {
    termination = { confirmed: Promise.withResolvers(), attempt: null };
    pendingWindowsTreeKills.set(child, termination);
  }
  termination.attempt ??= confirmTaskkill(child).then(() => {
    child.killed = true;
    pendingWindowsTreeKills.delete(child);
    termination.confirmed.resolve();
  }, error => {
    termination.attempt = null;
    throw error;
  });
  return termination.attempt;
}

/** Keep the root's close finalizer waiting through a failed attempt until a retry confirms termination. */
export function pendingWindowsProcessTreeExit(child) {
  return pendingWindowsTreeKills.get(child)?.confirmed.promise;
}

/**
 * Terminate a child process and its descendants.
 *
 * Windows: SIGTERM kills the cmd.exe shim but orphans its child, so use `taskkill /T /F` (fire-and-forget,
 * unref'd). `child.killed` is set by hand because taskkill never touches the ChildProcess and re-entrancy
 * guards key on it.
 *
 * The win32 taskkill branch applies only to a ChildProcess or a bare `{ pid }` (a process with no handle, e.g.
 * a detached supervisor job). A non-ChildProcess killable with its own `.kill()` (node-pty IPty, the
 * cosRunnerClient TUI proxy) always uses it: raw taskkill would leak the ConPTY handle. node-pty on Windows
 * throws for ANY signal argument, so the signal is offered first and a bare `kill()` is the fallback; dropping
 * it unconditionally would downgrade a proxy's force-kill to a graceful one.
 *
 * `processGroup` (POSIX, child spawned `detached`): signal the negative pid so a shell's own children die,
 * falling back to the single pid. Off by default because a non-detached child shares its parent's group.
 *
 * `signal` is POSIX-only; Windows always force-kills the tree. A caller wrapping a `.cmd`/`.bat` shim via
 * `prepareCliSpawn` MUST use this rather than `child.kill()`, or only the cmd.exe shim dies.
 *
 * @param {import('child_process').ChildProcess|{pid: number, kill?: Function}} child - a ChildProcess, any killable exposing `.pid`/`.kill()`, or a bare `{ pid }`
 * @param {NodeJS.Signals} [signal] - POSIX signal to send (default `SIGTERM`); ignored on Windows
 * @param {{processGroup?: boolean}} [opts] - POSIX: signal the child's process group (it must have been spawned `detached`)
 * @param {boolean} [isWin32] - platform override so the Windows branches are testable elsewhere
 */
export function killProcessTree(child, signal = 'SIGTERM', { processGroup = false } = {}, isWin32 = IS_WIN32) {
  // A supervised release agent (Windows Job or Linux subreaper) is stopped only
  // through its supervisor, never by a group or PID signal that could kill it.
  if (typeof child.requestWindowsAgentStop === 'function') return child.requestWindowsAgentStop();
  const isChildProcess = child instanceof ChildProcess;
  // No own `.kill()`: addressable only by pid.
  const isPidOnly = !isChildProcess && typeof child.kill !== 'function';
  if (isWindowsTaskkillTarget(child, isWin32)) {
    child.killed = true;
    spawn('taskkill', taskkillArgs(child.pid), { stdio: 'ignore' })
      .on('error', () => {})
      .unref();
    return;
  }
  if (processGroup && child.pid) {
    try {
      process.kill(-child.pid, signal);
      // Node sets `.killed` only via `child.kill()`; set it for re-entry guards. Not for an IPty, where an
      // invented flag would short-circuit PTY teardown paths that deliberately re-kill.
      if (isChildProcess) child.killed = true;
      return;
    }
    catch { /* ESRCH — the group is already gone; fall through to the pid */ }
  }
  if (isPidOnly) {
    // POSIX pid-only: plain per-pid signal; an already-exited target is not a failure.
    try { process.kill(child.pid, signal); }
    catch { /* ESRCH — already gone */ }
    return;
  }
  if (isWin32 && !isChildProcess) {
    // node-pty rejects signals on Windows; other killables forward them, so ask first and fall back.
    try { child.kill(signal); }
    catch { child.kill(); }
    return;
  }
  child.kill(signal);
}


/**
 * Stop a child gracefully with forced escalation: SIGTERM now, SIGKILL after `graceMs` if it has not exited,
 * so a child that ignores SIGTERM (npm wrapper, docker compose) cannot outlive "stopped".
 *
 * Returns a cancel function for the `close`/`error` handler so an exited child never gets a SIGKILL aimed at a
 * reused pid. Windows `killProcessTree` is already `taskkill /F`, so the cancel is a no-op there.
 *
 * @param {import('child_process').ChildProcess|{pid: number, kill?: Function}} child
 * @param {{ graceMs?: number, label?: string, processGroup?: boolean }} [opts]
 * @param {boolean} [isWin32] - platform override for tests
 * @returns {() => void} cancel the pending SIGKILL escalation
 */
export function terminateWithEscalation(child, { graceMs = 5000, label = 'child process', processGroup = false } = {}, isWin32 = IS_WIN32) {
  killProcessTree(child, 'SIGTERM', { processGroup }, isWin32);
  if (isWin32) return () => {};
  const timer = setTimeout(() => {
    try {
      if (processGroup && child.pid && typeof child.requestWindowsAgentStop !== 'function') {
        // The group can outlive its leader. Address only the group to avoid
        // falling back to a pid that may have been reused after the leader exited.
        process.kill(-child.pid, 'SIGKILL');
      } else {
        if (child.exitCode !== null || child.signalCode !== null) return;
        killProcessTree(child, 'SIGKILL', { processGroup }, isWin32);
      }
      console.warn(`⚠️ ${label} ignored SIGTERM for ${graceMs}ms — escalating to SIGKILL`);
    } catch (err) {
      if (err.code !== 'ESRCH') console.error(`❌ ${label} SIGKILL escalation failed: ${err.message}`);
    }
  }, graceMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

// A closed leader and drained pipes do not prove the whole group is gone.
function hasProcessGroup(pid) {
  if (!pid) return false;
  try { return process.kill(-pid, 0); }
  catch (err) { return err.code !== 'ESRCH'; }
}

/**
 * Spawn a command, buffer its (capped) stdout/stderr, enforce a timeout, and resolve a structured result.
 * NEVER rejects: every terminal condition resolves a result object.
 *
 *   success: true iff exit 0 within timeout; code: exit code, -1 for timeout/spawn-error;
 *   signal; stdout/stderr: tail-capped, NOT trimmed; timedOut; error?: present only on a spawn 'error' event.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} options
 * @param {string} [options.cwd]
 * @param {NodeJS.ProcessEnv} [options.env] - complete child environment
 * @param {number} [options.timeoutMs] - begin teardown after this; group runs settle by the end of the grace period
 * @param {number} [options.killGraceMs=8000] - SIGTERM grace period before SIGKILL
 * @param {boolean} [options.shell] - defaults to `needsShell(cmd)`
 * @param {boolean} [options.processGroup] - isolate and stop the POSIX group; on Windows use taskkill
 * @param {AbortSignal} [options.signal] - request cancellation; returns aborted: true
 * @param {(chunk: Buffer, stream: string) => void} [options.onOutput] - observe raw output chunks
 * @returns {Promise<object>} structured result (never rejects)
 */
export function bufferedSpawn(cmd, args, {
  cwd, env = process.env, timeoutMs, killGraceMs = 8000, shell, processGroup = false, signal, onOutput,
} = {}) {
  const aborted = { success: false, code: -1, signal: null, timedOut: false, aborted: true };
  if (signal?.aborted) return Promise.resolve({ ...aborted, stdout: '', stderr: '' });
  return new Promise((resolve) => {
    const detached = processGroup && !IS_WIN32;
    const child = trackDetachedGroup(spawn(cmd, args, {
      cwd,
      // Pin PWD to the spawn cwd (see withSpawnCwdEnv); unchanged copy of env when no cwd.
      env: withSpawnCwdEnv(env, cwd),
      shell: shell === undefined ? needsShell(cmd) : shell,
      ...(processGroup && { detached, stdio: ['ignore', 'pipe', 'pipe'] }),
    }), detached);
    let stdout = '';
    let stderr = '';
    let settled = false;
    let stopped;
    let stopTimer;
    let cancelEscalation;
    let liveError;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(stopTimer);
      signal?.removeEventListener('abort', abort);
      if (stopped && processGroup) {
        child.stdout?.destroy?.();
        child.stderr?.destroy?.();
      }
      resolve({ stdout, stderr, ...result });
    };

    const stop = (result) => {
      if (settled || stopped) return;
      stopped = result;
      clearTimeout(timer);
      try {
        cancelEscalation = terminateWithEscalation(child, { graceMs: killGraceMs, label: cmd, processGroup: detached });
      } catch (err) {
        console.error(`❌ ${cmd} termination failed: ${err.message}`);
      }
      if (processGroup && child.pid && (IS_WIN32 || hasProcessGroup(child.pid))) {
        // Keep the operation reserved during teardown, then settle even if
        // an inherited pipe is still open.
        stopTimer = setTimeout(() => finish(result), killGraceMs);
      } else {
        finish(result);
      }
    };
    const abort = () => stop(aborted);
    const timer = timeoutMs
      ? setTimeout(() => stop({ success: false, code: -1, signal: null, timedOut: true }), timeoutMs)
      : null;

    const collect = (stream, chunk) => {
      if (settled) return;
      const text = chunk.toString();
      if (stream === 'stdout') stdout = (stdout + text).slice(-MAX_OUTPUT_BYTES);
      else stderr = (stderr + text).slice(-MAX_OUTPUT_BYTES);
      try { onOutput?.(chunk, stream); }
      catch (err) { console.error(`❌ ${cmd} output hook failed: ${err.message}`); }
    };
    child.stdout?.on('data', (chunk) => collect('stdout', chunk));
    child.stderr?.on('data', (chunk) => collect('stderr', chunk));
    child.on('close', (code, exitSignal) => {
      if (stopped) {
        if (!detached || !hasProcessGroup(child.pid)) {
          if (detached) cancelEscalation?.();
          finish(stopped);
        }
        return;
      }
      if (liveError) return finish(liveError);
      finish({ success: code === 0, code, signal: exitSignal, timedOut: false });
    });
    child.on('error', (error) => {
      if (stopped) return;
      const result = { success: false, code: -1, signal: null, timedOut: false, error };
      // A live process can emit an error when a kill fails; keep its deadline.
      if (processGroup && child.pid) liveError = result;
      else finish(result);
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
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
  if (result.aborted) throw new Error(`${timeoutLabel} cancelled`);
  if (result.timedOut) {
    throw new Error(`${timeoutLabel} timed out after ${(spawnOpts.timeoutMs ?? 0) / 1000}s`);
  }
  if (!result.success) {
    throw new Error(result.stderr.trim() || `${cmd} exited with code ${result.code}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

/**
 * The most useful sentence from a FAILED `bufferedSpawn` result. `--json` CLIs print their payload to stdout
 * even on non-zero exit, so the last stdout line is a closing `}`/`]`. Prefers the spawn error, then a stderr
 * line, then a stdout line that isn't JSON punctuation.
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
 * Attach the no-op `'error'` listener every spawned child's `stdin` needs before anything writes to it.
 *
 * A child that dies before reading stdin emits `EPIPE`; an unlistened stream error is re-thrown, and spawn
 * sites run outside the Express lifecycle, so it would take down the single server process. The child's own
 * `'error'`/`'close'` handler is the authoritative settle point. Logged, not dropped, so a child that exits 0
 * after refusing its prompt leaves a trace. A handle with no stdin (failed lookup, non-pipe stdio) is a no-op.
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
 * Deliver a prompt on a guarded child's `stdin` and close the pipe. Pair with `guardChildStdin`.
 *
 * Catches a *synchronous* `write()` throw (destroyed pipe, non-string payload), destroys the pipe so a
 * still-reading child sees EOF, and logs, since an empty-prompt exit 0 would look like a clean run. The child's
 * own `'error'`/`'close'` handler stays the settle point, so this never rethrows or settles.
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
