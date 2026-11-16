/**
 * "Was this module run directly, or imported?", shared by the toolchain gates in scripts/ so each can expose pure helpers to its test while still acting when invoked as `node scripts/<gate>.js`.
 *
 * The naive `import.meta.url === pathToFileURL(process.argv[1]).href` breaks in ways that matter (a gate that silently no-ops is worse than none): Node's ESM loader resolves symlinks in `import.meta.url` while `process.argv[1]` is as typed (symlinked home, /tmp → /private/tmp, symlinked worktree), so both sides are realpath'd;
 * APFS and NTFS are case-insensitive, so those platforms compare case-folded; `fileURLToPath` handles paths with spaces or non-ASCII.
 * Lives in scripts/lib/, not server/lib/, because the CI impact job runs scripts/ci-base-sha.js and scripts/ci-test-plan.js before any `npm ci` and both import this: builtins only (enforced by scripts/pre-install-entrypoints.test.js).
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
