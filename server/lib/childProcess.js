/**
 * Drop-in `child_process` replacement that defaults every spawn to
 * `windowsHide: true`.
 *
 * ## Why this module exists
 *
 * On Windows, a process that has **no console of its own** — every app PM2
 * forks, which is all of PortOS — must have Windows allocate a brand-new
 * console for any console child it launches (`git`, `gh`, `psql`, `ffmpeg`,
 * `tailscale`, `where`, …). When the "Default terminal application" setting is
 * Windows Terminal (the Windows 11 default, including the `{00000000-…}`
 * "Let Windows decide" value), that allocation is handed off to Windows
 * Terminal over COM: `OpenConsole.exe -Embedding` starts as the COM server and
 * a terminal window appears, takes foreground focus, then dies with the child.
 * At PortOS's background spawn rate that reads as a stream of console windows
 * flickering across the desktop and stealing keystrokes.
 *
 * `windowsHide: true` sets `CREATE_NO_WINDOW`, so the child gets a headless
 * console and the handoff never happens. It is a no-op on POSIX.
 *
 * ## Why a wrapper instead of per-call-site fixes
 *
 * This bug has been fixed twice by sweeping `windowsHide: true` across every
 * call site (v1.5.x: 23 sites / 11 files; v1.6.7: ~20 more) and has regressed
 * twice, because nothing stopped the next `import { spawn } from
 * 'child_process'` from landing without it. Routing every spawn through one
 * module makes the default structural, and `childProcess.guards.test.js`
 * fails the build when server code imports `child_process` directly.
 *
 * An explicit `windowsHide: false` is always respected — the default only
 * fills in the gap, so a caller that genuinely wants a visible console (none
 * today) can still ask for one.
 *
 * Not covered here: node-pty. ConPTY allocates its own console host, but it is
 * always `--headless` and never triggers the terminal handoff, so PTY sessions
 * were never part of this symptom.
 */

import {
  ChildProcess,
  exec as nodeExec,
  execFile as nodeExecFile,
  execFileSync as nodeExecFileSync,
  execSync as nodeExecSync,
  fork as nodeFork,
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
} from 'node:child_process';
import { promisify } from 'node:util';

export { ChildProcess };

// Promisified lazily rather than at module load: a test that partially mocks
// child_process (a factory returning only `spawn`, say) would otherwise crash
// every importer of this module at import time, on a binding it never uses.
let execAsyncCache;
let execFileAsyncCache;
const nodeExecAsync = (...args) => (execAsyncCache ??= promisify(nodeExec))(...args);
const nodeExecFileAsync = (...args) => (execFileAsyncCache ??= promisify(nodeExecFile))(...args);

/**
 * Fill in `windowsHide: true` unless the caller stated an opinion.
 * @param {object} [options]
 * @returns {object}
 */
function withHide(options) {
  if (options && Object.hasOwn(options, 'windowsHide')) return options;
  return { ...options, windowsHide: true };
}

/**
 * Normalize the `(command[, args][, options])` overload shared by
 * `spawn`/`spawnSync`/`fork` into a fixed `[args, options]` pair. The second
 * positional is the arg array only when it actually is an array — otherwise
 * it is the options object, which is the overload Node itself accepts.
 * @param {string[]|object} [argsOrOptions]
 * @param {object} [maybeOptions]
 * @returns {[string[]|undefined, object]}
 */
function splitSpawnArgs(argsOrOptions, maybeOptions) {
  if (Array.isArray(argsOrOptions)) return [argsOrOptions, withHide(maybeOptions)];
  return [undefined, withHide(argsOrOptions)];
}

/**
 * Normalize the `(file[, args][, options][, callback])` overload shared by
 * `execFile`/`execFileSync` into the positional list Node expects, with
 * `windowsHide` injected. Classifying by type rather than by position is what
 * lets one helper serve all eight documented call shapes.
 * @param {Array} rest
 * @returns {Array}
 */
function buildExecFileArgs(rest) {
  let args;
  let options;
  let callback;
  for (const value of rest) {
    if (Array.isArray(value)) args = value;
    else if (typeof value === 'function') callback = value;
    else if (value && typeof value === 'object') options = value;
  }
  const out = args ? [args, withHide(options)] : [withHide(options)];
  if (callback) out.push(callback);
  return out;
}

/**
 * `child_process.spawn` with `windowsHide` defaulted on.
 * @returns {ChildProcess}
 */
export function spawn(command, argsOrOptions, maybeOptions) {
  const [args, options] = splitSpawnArgs(argsOrOptions, maybeOptions);
  return args ? nodeSpawn(command, args, options) : nodeSpawn(command, options);
}

/**
 * `child_process.spawnSync` with `windowsHide` defaulted on.
 */
export function spawnSync(command, argsOrOptions, maybeOptions) {
  const [args, options] = splitSpawnArgs(argsOrOptions, maybeOptions);
  return args ? nodeSpawnSync(command, args, options) : nodeSpawnSync(command, options);
}

/**
 * `child_process.fork` with `windowsHide` defaulted on.
 * @returns {ChildProcess}
 */
export function fork(modulePath, argsOrOptions, maybeOptions) {
  const [args, options] = splitSpawnArgs(argsOrOptions, maybeOptions);
  return args ? nodeFork(modulePath, args, options) : nodeFork(modulePath, options);
}

/**
 * `child_process.exec` with `windowsHide` defaulted on.
 *
 * The `promisify.custom` hook delegates to the *native* promisified `exec`, so
 * `promisify(exec)` keeps resolving to `{ stdout, stderr }` (and keeps the
 * `.child` property on the returned promise). Without it, `promisify` would
 * fall back to generic callback wrapping and resolve to `stdout` alone,
 * silently breaking every `const { stdout } = await execAsync(...)` caller.
 * @returns {ChildProcess}
 */
export const exec = Object.assign(
  function exec(command, options, callback) {
    if (typeof options === 'function') return nodeExec(command, withHide(undefined), options);
    return nodeExec(command, withHide(options), callback);
  },
  { [promisify.custom]: (command, options) => nodeExecAsync(command, withHide(options)) }
);

/**
 * `child_process.execSync` with `windowsHide` defaulted on.
 */
export function execSync(command, options) {
  return nodeExecSync(command, withHide(options));
}

/**
 * `child_process.execFile` with `windowsHide` defaulted on. Carries the same
 * `promisify.custom` delegation as `exec` above.
 * @returns {ChildProcess}
 */
export const execFile = Object.assign(
  function execFile(file, ...rest) {
    return nodeExecFile(file, ...buildExecFileArgs(rest));
  },
  { [promisify.custom]: (file, ...rest) => nodeExecFileAsync(file, ...buildExecFileArgs(rest)) }
);

/**
 * `child_process.execFileSync` with `windowsHide` defaulted on.
 */
export function execFileSync(file, ...rest) {
  return nodeExecFileSync(file, ...buildExecFileArgs(rest));
}
