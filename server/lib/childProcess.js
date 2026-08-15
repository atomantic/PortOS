/**
 * Drop-in `child_process` replacement that defaults every spawn to
 * `windowsHide: true` (`CREATE_NO_WINDOW`), so a console-less PM2 fork never
 * makes Windows allocate a visible console for a child. An explicit
 * `windowsHide: false` is always respected — the default only fills the gap.
 *
 * Server runtime code must import from here rather than `child_process`;
 * `childProcess.guards.test.js` enforces that. Why a wrapper instead of another
 * per-call-site sweep, what the console handoff actually is, and what is out of
 * scope: docs/WINDOWS_CONSOLE.md.
 *
 * Note `CREATE_NO_WINDOW` is ignored for `detached: true` spawns — those are
 * safe because `DETACHED_PROCESS` gives the child no console at all, not
 * because this default is doing the work.
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
 * Normalize any of node's `(…[, args][, options][, callback])` overloads into
 * the positional list it expects, with `windowsHide` injected. Classifying by
 * type rather than position is what lets one helper serve all of them — the
 * spawn family simply never passes a callback.
 * @param {Array} rest - every argument after the command/file/module
 * @returns {Array}
 */
function normalize(rest) {
  let args;
  let options;
  let callback;
  for (const value of rest) {
    if (Array.isArray(value)) args = value;
    else if (typeof value === 'function') callback = value;
    else if (value && typeof value === 'object') options = value;
  }
  return [...(args ? [args] : []), withHide(options), ...(callback ? [callback] : [])];
}

/**
 * `child_process.spawn` with `windowsHide` defaulted on.
 * @returns {ChildProcess}
 */
export const spawn = (command, ...rest) => nodeSpawn(command, ...normalize(rest));

/** `child_process.spawnSync` with `windowsHide` defaulted on. */
export const spawnSync = (command, ...rest) => nodeSpawnSync(command, ...normalize(rest));

/**
 * `child_process.fork` with `windowsHide` defaulted on.
 * @returns {ChildProcess}
 */
export const fork = (modulePath, ...rest) => nodeFork(modulePath, ...normalize(rest));

/** `child_process.execSync` with `windowsHide` defaulted on. */
export const execSync = (command, options) => nodeExecSync(command, withHide(options));

/** `child_process.execFileSync` with `windowsHide` defaulted on. */
export const execFileSync = (file, ...rest) => nodeExecFileSync(file, ...normalize(rest));

/**
 * `child_process.exec` with `windowsHide` defaulted on.
 *
 * The `promisify.custom` hook delegates to the *native* promisified `exec`, so
 * `promisify(exec)` keeps resolving to `{ stdout, stderr }` (and keeps the
 * `.child` property on the returned promise). Without it, `promisify` would
 * fall back to generic callback wrapping and resolve to `stdout` alone,
 * silently breaking every `const { stdout } = await execAsync(...)` caller.
 *
 * Both hooks promisify at call time rather than at module load, so a test that
 * partially mocks child_process can't crash every importer on a binding it
 * never uses.
 * @returns {ChildProcess}
 */
export const exec = Object.assign(
  function exec(command, ...rest) {
    return nodeExec(command, ...normalize(rest));
  },
  { [promisify.custom]: (command, options) => promisify(nodeExec)(command, withHide(options)) }
);

/**
 * `child_process.execFile` with `windowsHide` defaulted on. Carries the same
 * `promisify.custom` delegation as `exec` above.
 * @returns {ChildProcess}
 */
export const execFile = Object.assign(
  function execFile(file, ...rest) {
    return nodeExecFile(file, ...normalize(rest));
  },
  { [promisify.custom]: (file, ...rest) => promisify(nodeExecFile)(file, ...normalize(rest)) }
);
