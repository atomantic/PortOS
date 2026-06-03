import { spawn } from 'child_process';

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
 * @param {import('child_process').ChildProcess} child
 */
export function killProcessTree(child) {
  if (IS_WIN32 && child.pid) {
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
