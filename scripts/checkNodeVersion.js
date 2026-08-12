/**
 * Single source of truth for the Node.js version floor (issue #3863).
 *
 * The floor used to be copied into five places that could drift independently
 * (setup.sh, setup.ps1, .nvmrc, the CI workflows, README prose) while the
 * primary install path — `npm run setup` && `npm start`, straight out of the
 * README — enforced none of them. On an unsupported Node the install would
 * succeed, several minutes would pass, and the run would die inside Vite with
 * an error that never names the cause.
 *
 * MIN_NODE below is now the only place the floor is written down:
 *   - the four `engines` fields declare it machine-readably (npm warns on a
 *     mismatch; `engine-strict` is deliberately NOT set — see the .npmrc note,
 *     it would make one dependency's narrow range break every install),
 *   - `npm run setup` / `npm start` / `npm run dev` run this file first, so an
 *     unsupported Node fails in the first second instead of the fifth minute,
 *   - scripts/node-version-drift.test.js fails if any of the other sites is
 *     left behind when MIN_NODE moves.
 *
 * Why 22.12 and not Vite's own `^20.19 || >=22.12`: nothing here is tested on
 * 20 (.nvmrc and every CI job are 24), so advertising 20 would promise a
 * configuration that never actually runs. `.nvmrc`/CI at 24 is a *preference*
 * and is asserted to be >= this floor, not equal to it.
 */

import { realpathSync } from 'fs';
import { fileURLToPath } from 'url';

/** The hard floor. Changing the version means changing exactly this string. */
export const MIN_NODE = '22.12.0';

/** Parse `v22.12.0` / `22.12` / `22` into a [major, minor, patch] tuple. */
export function parseVersion(version) {
  const parts = String(version)
    .trim()
    .replace(/^v/, '')
    .split('-')[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/** -1 / 0 / 1, comparing `a` against `b` semver-numerically. */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

/** True when `version` is at or above the floor. */
export function satisfiesMinNode(version = process.versions.node) {
  return compareVersions(version, MIN_NODE) >= 0;
}

/** The one-line failure message, mirroring the shape the shell gates print. */
export function unsupportedNodeMessage(version = process.versions.node) {
  return `Node.js ${MIN_NODE}+ required (found v${String(version).replace(/^v/, '')}) — see .nvmrc`;
}

/**
 * Exit non-zero with `unsupportedNodeMessage` when the running Node is below
 * the floor. Injectable so the test can exercise both branches without
 * spawning a second interpreter or tearing down the runner.
 */
export function assertNodeVersion({
  version = process.versions.node,
  onFail = (message) => {
    console.error(`❌ ${message}`);
    process.exit(1);
  },
} = {}) {
  if (satisfiesMinNode(version)) return true;
  onFail(unsupportedNodeMessage(version));
  return false;
}

// Runnable directly: `node scripts/checkNodeVersion.js`.
//
// Both sides are realpath'd before comparing. Node's ESM loader resolves
// symlinks when it builds `import.meta.url`, but `process.argv[1]` is whatever
// the caller typed — so a repo reached through a symlinked parent (a checkout
// under a symlinked home, /tmp → /private/tmp on macOS, a symlinked worktree)
// makes the two spellings differ and the gate would silently no-op, exiting 0
// on an unsupported Node. fileURLToPath/realpathSync also handle paths with
// spaces or non-ASCII characters, which a `file://` string template does not.
const invokedPath = process.argv[1];
if (invokedPath) {
  const resolve = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  // Case-fold on the case-insensitive filesystems (APFS, NTFS): there the two
  // spellings can differ only in case and still name the same file, and a
  // strict comparison would silently skip the check.
  const caseFold = process.platform === 'win32' || process.platform === 'darwin';
  const normalize = (p) => (caseFold ? resolve(p).toLowerCase() : resolve(p));
  if (normalize(fileURLToPath(import.meta.url)) === normalize(invokedPath)) {
    assertNodeVersion();
  }
}
