/**
 * Whether MTPLX's own Python runtime is on disk yet, decided WITHOUT running it.
 *
 * The Homebrew `mtplx` is a few-line shell wrapper that lazily bootstraps a version-keyed Python venv on first invocation (`VENV="${MTPLX_BREW_VENV:-/opt/homebrew/var/mtplx/venv-<version>}"`; `[ ! -x "$VENV/bin/mtplx" ]` → `python -m venv` + `pip install`), a multi-hundred-MB network install (fastapi, huggingface_hub, numpy/scipy, the MLX stack) that `brew upgrade mtplx` re-arms (the path carries the version). So ANY invocation on a fresh version (a status poll's `mtplx models --json`, a PM2 start judged on an eight-second window) is really a package download budgeted as free and local, reported as a timed-out cache read or crashed daemon. This reads rather than executes: parse the wrapper's `VENV=`, honour `$MTPLX_BREW_VENV` as `${MTPLX_BREW_VENV:-…}` does, test `<venv>/bin/mtplx` for executability (byte-for-byte the wrapper's guard, so they can't disagree). **Anything not a recognisable wrapper reports READY** (a pip install puts the console script on PATH, a future formula may drop the shim, an unreadable script isn't evidence of a missing runtime; "not ready" would block a working install over a parse failure). Rejected: a persisted "PortOS warmed it" flag (stale after `brew upgrade` as the venv path changes, and absent for an `mtplx` installed outside PortOS).
 */

import { constants } from 'fs';
import { access, readFile, stat } from 'fs/promises';
import { isAbsolute, join } from 'path';
import { PATHS } from './paths.js';
import { findCommandOnPath } from './processEnv.js';

/** Above this the file on PATH is a compiled binary or bundled script, not Homebrew's few lines; reading it whole to hunt for `VENV=` would be pointless I/O per status poll. */
const MAX_WRAPPER_BYTES = 64 * 1024;

/** The venv path the wrapper would use, or `null` when this is not a wrapper. `''` (a wrapper naming no default, `VENV="$MTPLX_BREW_VENV"`) is distinct from `null`: the caller still has `$MTPLX_BREW_VENV` to fall back on, whereas `null` means no assignment to honour. */
const parseWrapperVenvDefault = (text) => {
  const match = /^[ \t]*VENV=(.*)$/m.exec(text);
  if (!match) return null;
  let value = match[1].trim();
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\'')))) {
    value = value.slice(1, -1);
  }
  const braced = /^\$\{MTPLX_BREW_VENV:-(.*)\}$/.exec(value);
  if (braced) return braced[1];
  if (value === '$MTPLX_BREW_VENV' || value === '${MTPLX_BREW_VENV}') return '';
  // A literal path (a formula that dropped the env override); any other shape carries shell expansion this parser won't guess at: say "not a wrapper" and keep today's behavior.
  return isAbsolute(value) ? value : null;
};

/**
 * Describe the runtime behind a resolved `mtplx` executable. `wrapper: false` means the probe recognised nothing to check and reports the status quo, NOT that it proved a runtime present.
 *
 * @param {string|null|undefined} binaryPath - what `findCommandOnPath('mtplx')` resolved
 * @param {{env?: object}} [options]
 * @returns {Promise<{ready: boolean, wrapper: boolean, venvPath: string|null}>}
 */
export async function describeMtplxRuntime(binaryPath, { env = process.env } = {}) {
  if (!binaryPath) return { ready: false, wrapper: false, venvPath: null };

  const size = await stat(binaryPath).then((s) => s.size).catch(() => null);
  if (size === null || size > MAX_WRAPPER_BYTES) return { ready: true, wrapper: false, venvPath: null };

  const buffer = await readFile(binaryPath).catch(() => null);
  // A NUL byte means a compiled executable, not a shell script; `includes` on the buffer avoids decoding a binary into a throwaway string.
  if (!buffer || buffer.includes(0)) return { ready: true, wrapper: false, venvPath: null };

  const parsed = parseWrapperVenvDefault(buffer.toString('utf8'));
  if (parsed === null) return { ready: true, wrapper: false, venvPath: null };

  const venvPath = env?.MTPLX_BREW_VENV || parsed;
  if (!venvPath) return { ready: true, wrapper: false, venvPath: null };

  const ready = await access(join(venvPath, 'bin', 'mtplx'), constants.X_OK).then(() => true).catch(() => false);
  return { ready, wrapper: true, venvPath };
}

// New installs are private and locked. Existing user-managed/Homebrew installs
// still work when no private runtime is present; no global PATH mutation.
export const mtplxVenvDir = () => join(PATHS.tools, 'mtplx');
export const mtplxManagedBinary = () => join(mtplxVenvDir(), 'bin', 'mtplx');

let mtplxInstallInProgress = false;
export const setMtplxInstallInProgress = (value) => { mtplxInstallInProgress = value; };

export function resolveMtplxBinary() {
  // uv writes console scripts before its whole sync finishes. Polls, cache
  // reads and starts must keep using any existing external runtime until then.
  return (!mtplxInstallInProgress && findCommandOnPath(mtplxManagedBinary())) || findCommandOnPath('mtplx');
}
