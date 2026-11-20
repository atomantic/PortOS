/**
 * Runtime backstop: no test may WRITE into the checkout's real `data/` tree.
 *
 * `server/test/guards/repo/testDataIsolation.test.js` is the static half (text-scans tests for a spelling naming `data/`), but a suite that imports the real `PATHS` and reads a data-rooted member with no redirect is invisible
 * to a text scan (~50 of ~1300 suites do, so a static allowlist would rot). The two-run read probe (#3687) catches READ leaks as failing assertions; a WRITE leak changes no assertion (#6171:
 * `providerUsage.test.js` persisted fixture quota cards over the real `data/provider-quotas.json` and federated them to peers). So writes are closed at RUNTIME in the shared write primitives, the
 * filesystem analogue of `lib/db.js`'s `isTestRunner()` + `query()` backstop. It fires only on a write that reaches the real root.
 *
 * Inert outside a Vitest worker: `isVitestRunner()` (narrower than `isTestRunner()`: only `process.env.VITEST`) comes first everywhere so a non-Vitest call costs one env read. `NODE_ENV=test` alone is not
 * enough: `scripts/smoke-boot.js` sets it on the real server boot, whose writes to the real `data/` are correct.
 *
 * Under the runner it fires from `fileCore.js` / `jsonIo.js` (`atomicWrite`, `ensureDir`'s create path, `writeFileGuarded`, `appendFileGuarded`, `copyFileGuarded`, `rmGuarded`, `unlinkGuarded`,
 * `createWriteStreamGuarded`, `appendJSONLine`) and `collectionStore`'s record delete; all services mutating `data/` route through them (#6203). A suite needing a data root redirects it with
 * `createTempDataRoot()` + `makePathsProxy()` from `lib/mockPathsDataRoot.js` (roots under `os.tmpdir()` pass untouched).
 * `server/lib/aiToolkit/` has NO such guard: it is vendored, self-contained, and must not import out (see `aiToolkit/AGENTS.md`).
 */

import { existsSync, lstatSync, readlinkSync } from 'fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'path';
import { isWorktreeRoot, resolveCodeRootForModule, resolveInstallRoot } from './dataRoot.js';
import { canonicalizePath, isPathAtOrInsideDir } from './pathContainment.js';
import { isVitestRunner } from './runtimeEnv.js';

// Resolved lazily so the realpath below sees an existing tree, via `resolveCodeRootForModule`/`resolveInstallRoot` (as `lib/paths.js` does) rather than importing `PATHS`:
// a suite that redirects `PATHS.data` to a temp root must not also redirect the guard's idea of the real root, or it would approve every write it should refuse.
let cachedRoots = null;
const WORKTREE_SEGMENT = join('data', 'cos', 'worktrees');

/**
 * The protected data root plus the checkout exempted from it. A CoS worktree lives at `<install>/data/cos/worktrees/<name>`, so its own (empty, git-tracked-only) `data/` is nested under the install's live
 * data tree; from there the guard must protect the real `<install>/data` while letting the suite use the worktree's scratch tree (#14074). Outside a worktree there is no exemption.
 * Exported for tests: the live module location cannot be varied in-process.
 *
 * @param {string} codeRoot - the executing checkout's root
 * @returns {{ root: string, exempt: string|null }}
 */
export function _resolveGuardRoots(codeRoot) {
  const installRoot = resolveInstallRoot(codeRoot);
  if (!isWorktreeRoot(installRoot)) {
    return { root: canonicalizePath(join(installRoot, 'data')), exempt: null };
  }
  const resolved = resolve(installRoot);
  const at = resolved.indexOf(`${sep}${WORKTREE_SEGMENT}${sep}`);
  const primary = at < 0 ? null : (at === 0 ? sep : resolved.slice(0, at));
  return {
    root: canonicalizePath(join(primary ?? resolved, 'data')),
    exempt: primary ? canonicalizePath(resolved) : null,
  };
}

const guardRoots = () => (cachedRoots ??= _resolveGuardRoots(resolveCodeRootForModule(import.meta.url)));
const realDataRoot = () => guardRoots().root;

// Memo of canonicalized DIRECTORIES: each guarded write would otherwise re-walk its path with `realpathSync` (misses go through a thrown ENOENT, ~0.9ms for a six-deep target).
// Only successes are cached: a not-yet-created directory could still be created as a symlink.
const resolvedDirs = new Map();

function canonicalDir(dir) {
  const cached = resolvedDirs.get(dir);
  if (cached !== undefined) return cached;
  const resolved = canonicalizePath(dir);
  if (existsSync(dir)) resolvedDirs.set(dir, resolved);
  return resolved;
}

/** The link's target if `path` is a symlink, else null. Never throws. */
function readLinkTarget(path) {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null;
    return readlinkSync(path);
  } catch {
    return null;
  }
}

// Bound on symlink hops; the cap just keeps a cyclic link from spinning.
const MAX_LINK_HOPS = 8;

/**
 * Where a follow-the-link write would land, or null when `abs` is not a symlink. Goes through `canonicalizePath` rather than `realpathSync` so a DANGLING link still reports its target
 * (a fixture link to a file the real tree hasn't created yet would otherwise slip through on ENOENT).
 */
function followLinks(abs) {
  let current = abs;
  for (let hop = 0; hop < MAX_LINK_HOPS; hop += 1) {
    const link = readLinkTarget(current);
    if (!link) return hop === 0 ? null : current;
    current = canonicalizePath(isAbsolute(link) ? link : join(dirname(current), link));
  }
  return current;
}

/**
 * A write target has TWO possible landing sites and the guard refuses if either is in the real tree, because primitives disagree about symlinks: `atomicWrite` REPLACES a symlinked destination
 * (bytes land at the link's own location: ancestors resolved, final component not), while `writeFile`/`appendFile`/`copyFile` FOLLOW it. Checking only the first would let a fixture symlink
 * to `data/provider-quotas.json` write straight through (the #6171 leak).
 */
const canonicalTargets = (target) => {
  const abs = resolve(target);
  const parent = dirname(abs);
  const viaAncestors = parent === abs ? abs : join(canonicalDir(parent), basename(abs));
  // Only does work when the destination IS a symlink; an ordinary first write costs one lstat.
  const followed = followLinks(abs);
  return followed && followed !== viaAncestors ? [viaAncestors, followed] : [viaAncestors];
};

/**
 * Does `target` resolve to the real `data/` root or anything beneath it? Containment uses `isPathAtOrInsideDir` (case-folding on case-insensitive filesystems, which a hand-rolled `relative()`
 * would get wrong); relative paths and `..` climbs resolve first, and a symlinked destination is judged at BOTH landing sites (see `canonicalTargets`).
 *
 * @param {string} target - path to test
 * @returns {boolean}
 */
export function isInsideRealDataRoot(target) {
  if (typeof target !== 'string' || target === '') return false;
  const { root, exempt } = guardRoots();
  return canonicalTargets(target).some(
    (candidate) => isPathAtOrInsideDir(root, candidate) && !(exempt && isPathAtOrInsideDir(exempt, candidate)),
  );
}

/**
 * Throw when a test is about to write into the real `data/` tree; no-op outside the test runner.
 *
 * @param {string} target - the path about to be written, created, or removed
 * @param {string} operation - what the caller was about to do, named in the
 *   error (e.g. `'atomicWrite'`) so the failure text alone identifies it
 * @throws {Error} when the runner is active and `target` lands in the real root
 */
export function assertNotRealDataWrite(target, operation) {
  if (!isVitestRunner() || !isInsideRealDataRoot(target)) return;
  throw new Error(
    `${operation} refused: this test tried to write ${target} inside the install's real data/ tree ` +
      `(${realDataRoot()}). A test must never write into the developer's live data — see ` +
      'server/lib/testDataIsolation.js. Redirect the data root first: `createTempDataRoot()` + ' +
      "`makePathsProxy()` from server/lib/mockPathsDataRoot.js, via `vi.mock('<rel>/lib/fileUtils.js', ...)`. " +
      'If the write comes from a collaborator the suite forgot to mock (a store, a sync/federation ' +
      'path, a usage recorder), mock that collaborator instead of pointing it at the real tree.',
  );
}

/**
 * `assertNotRealDataWrite` for `ensureDir`, a no-op on an existing directory. Only the CREATE path is refused: read-only suites `ensureDir` a real subdirectory on the way to reading it (`mkdir -p`
 * mutates nothing there), while materializing a NEW directory in the developer's tree IS a write, the step every raw-fs writer takes first. Lives here so `fileCore.js` imports one symbol.
 *
 * @param {string} dir - the directory `ensureDir` is about to create
 */
export function assertNotNewRealDataDir(dir) {
  if (!isVitestRunner() || existsSync(dir)) return;
  assertNotRealDataWrite(dir, 'ensureDir');
}
