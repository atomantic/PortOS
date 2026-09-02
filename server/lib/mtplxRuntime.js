/**
 * Whether MTPLX's own Python runtime is on disk yet — decided WITHOUT running it.
 *
 * The `mtplx` Homebrew installs is not MTPLX. It is a few-line shell wrapper
 * that lazily bootstraps a version-keyed Python venv the first time anybody
 * invokes it:
 *
 *   VENV="${MTPLX_BREW_VENV:-/opt/homebrew/var/mtplx/venv-<version>}"
 *   if [ ! -x "$VENV/bin/mtplx" ]; then
 *     ... python -m venv "$VENV" && pip install <the real package tarball>
 *   fi
 *   exec "$VENV/bin/mtplx" "$@"
 *
 * That bootstrap is a multi-hundred-megabyte network install (fastapi,
 * huggingface_hub, numpy/scipy, the MLX stack), and `brew upgrade mtplx` re-arms
 * it, because the venv path carries the version. So ANY invocation of the
 * wrapper on a fresh version — a status poll running `mtplx models --json`, a
 * PM2 start judged on an eight-second window — is really a package download,
 * budgeted as if it were free and local. It reliably outruns both, and the
 * failure is reported as a timed-out cache read or a crashed daemon.
 *
 * This module answers the question the wrapper itself asks, by reading rather
 * than executing: parse the wrapper's own `VENV=` assignment, honour
 * `$MTPLX_BREW_VENV` exactly as `${MTPLX_BREW_VENV:-…}` does, and test
 * `<venv>/bin/mtplx` for executability — byte-for-byte the wrapper's
 * `[ ! -x "$VENV/bin/mtplx" ]` guard, so the two cannot disagree.
 *
 * **Anything that is not a recognisable wrapper reports READY.** A pip install
 * puts the real console script on PATH, a future Homebrew formula may drop the
 * shim entirely, and a script this parser cannot read is not evidence of a
 * missing runtime. Reporting "not ready" there would block a working install
 * over a parse failure; reporting "ready" is exactly today's behaviour.
 *
 * Rejected alternative: a persisted "PortOS warmed it" flag. It goes stale on
 * the next `brew upgrade` (new version ⇒ new venv path ⇒ the bootstrap is armed
 * again while the flag still says warmed) and is simply absent for an `mtplx`
 * the user installed outside PortOS.
 */

import { constants } from 'fs';
import { access, readFile, stat } from 'fs/promises';
import { isAbsolute, join } from 'path';

/**
 * Above this, the file on PATH is a compiled binary or a bundled script, not
 * the handful of lines Homebrew writes — reading it whole to hunt for `VENV=`
 * would be pointless I/O on every status poll.
 */
const MAX_WRAPPER_BYTES = 64 * 1024;

/**
 * The venv path the wrapper would use, or `null` when this is not a wrapper.
 *
 * Returns `''` for a wrapper that names no default (`VENV="$MTPLX_BREW_VENV"`),
 * which is distinct from `null`: the caller still has `$MTPLX_BREW_VENV` to
 * fall back on, whereas `null` means there was no assignment to honour at all.
 */
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
  // A literal path (a formula that dropped the env override). Any other shape
  // carries shell expansion this parser will not guess at — say "not a wrapper"
  // and let the caller keep today's behaviour.
  return isAbsolute(value) ? value : null;
};

/**
 * Describe the runtime behind a resolved `mtplx` executable.
 *
 * @param {string|null|undefined} binaryPath - what `findCommandOnPath('mtplx')` resolved
 * @param {{env?: object}} [options]
 * @returns {Promise<{ready: boolean, wrapper: boolean, venvPath: string|null}>}
 *   `wrapper: false` means the probe recognised nothing to check and is
 *   reporting the status quo, NOT that it proved a runtime present.
 */
export async function describeMtplxRuntime(binaryPath, { env = process.env } = {}) {
  if (!binaryPath) return { ready: false, wrapper: false, venvPath: null };

  const size = await stat(binaryPath).then((s) => s.size).catch(() => null);
  if (size === null || size > MAX_WRAPPER_BYTES) return { ready: true, wrapper: false, venvPath: null };

  const buffer = await readFile(binaryPath).catch(() => null);
  // A NUL byte anywhere means a compiled executable, not a shell script — and
  // `includes` on the buffer avoids decoding a binary into a throwaway string.
  if (!buffer || buffer.includes(0)) return { ready: true, wrapper: false, venvPath: null };

  const parsed = parseWrapperVenvDefault(buffer.toString('utf8'));
  if (parsed === null) return { ready: true, wrapper: false, venvPath: null };

  const venvPath = env?.MTPLX_BREW_VENV || parsed;
  if (!venvPath) return { ready: true, wrapper: false, venvPath: null };

  const ready = await access(join(venvPath, 'bin', 'mtplx'), constants.X_OK).then(() => true).catch(() => false);
  return { ready, wrapper: true, venvPath };
}
