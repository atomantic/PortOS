/**
 * "Was this module run directly, or imported?" — shared by the toolchain gates
 * in scripts/ so each one can expose pure helpers to its test while still
 * acting when invoked as `node scripts/<gate>.js`.
 *
 * The naive `import.meta.url === pathToFileURL(process.argv[1]).href` breaks in
 * ways that matter here, because a gate that silently no-ops is worse than no
 * gate at all:
 *   - Node's ESM loader resolves symlinks when it builds `import.meta.url`,
 *     while `process.argv[1]` is whatever the caller typed. A repo reached
 *     through a symlinked parent (a checkout under a symlinked home,
 *     /tmp → /private/tmp on macOS, a symlinked worktree) makes the two
 *     spellings differ, so both sides are realpath'd first.
 *   - APFS and NTFS are case-insensitive: two spellings can differ only in case
 *     and still name the same file, so those platforms compare case-folded.
 *   - fileURLToPath (rather than a `file://` string template) is what handles
 *     paths containing spaces or non-ASCII characters.
 *
 * Lives in scripts/lib/, not server/lib/ with the other pure helpers, because
 * the CI impact job runs scripts/ci-base-sha.js and scripts/ci-test-plan.js
 * before any `npm ci` — both import this, so it has to load from a bare
 * checkout. Builtins only; scripts/pre-install-entrypoints.test.js enforces it.
 */

import { realpathSync } from 'fs';
import { fileURLToPath } from 'url';

const resolve = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * True when `moduleUrl` names the script node was asked to run.
 * @param {string} moduleUrl - The module's own `import.meta.url`
 * @param {string} [invokedPath] - Defaults to `process.argv[1]`
 */
export function isDirectlyInvoked(moduleUrl, invokedPath = process.argv[1]) {
  if (!invokedPath) return false;
  const caseFold = process.platform === 'win32' || process.platform === 'darwin';
  const normalize = (path) => (caseFold ? resolve(path).toLowerCase() : resolve(path));
  return normalize(fileURLToPath(moduleUrl)) === normalize(invokedPath);
}
