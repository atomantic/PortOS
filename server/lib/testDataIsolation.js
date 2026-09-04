/**
 * Runtime backstop: no test may WRITE into the checkout's real `data/` tree.
 *
 * ## Why a runtime guard, not another static rule
 *
 * `testDataIsolation.guards.test.js` is the always-on *static* half of this
 * defense: it text-scans every test file for a path spelling that names the
 * install's `data/` directory. Its own header explains the hole it leaves — a
 * suite that imports the real `PATHS` and reads a data-rooted member
 * (`PATHS.brain`, `PATHS.missions`, …) with no redirect is invisible to a text
 * scan, and ~50 of ~1300 scoped test files legitimately use that spelling, so
 * closing it statically would need a 50-entry allowlist that rots.
 *
 * That spelling was covered *empirically* by the two-run read probe (#3687):
 * plant records in the real tree, re-run, and a test that now fails is leaking.
 * A read leak announces itself as a failing assertion. A WRITE leak does not —
 * persisting fixture bytes over the user's records changes nothing about
 * whether assertions pass, so the more damaging half went undetected. PR #6171
 * is the proof it is not hypothetical: `providerUsage.test.js` persisted its
 * fixture quota cards over the machine's real `data/provider-quotas.json` and
 * then invalidated the `usage` sync checksum, federating the fabricated values
 * to subscribed peers.
 *
 * So the write half is closed at RUNTIME instead, in the shared write
 * primitives. This is the filesystem analogue of the database protection in
 * `lib/db.js` — `isTestRunner()` plus the `query()` backstop that refuses row
 * writes to a non-test database — which exists because a suite once wiped real
 * records. A runtime backstop needs no allowlist: it fires on the write that
 * actually reaches the real root, and stays silent for the ~50 suites that
 * name `PATHS.*` but never get there.
 *
 * ## Scope
 *
 * Inert outside an actual Vitest worker — production writes are never
 * touched, and the `isVitestRunner()` check (narrower than `isTestRunner()`:
 * only `process.env.VITEST`, not `NODE_ENV=test` alone — see its doc comment)
 * comes first everywhere so a non-Vitest call costs one `process.env` read and
 * no syscall. `NODE_ENV=test` alone is not enough here: `scripts/smoke-boot.js`
 * sets it on the real server boot to select the file-backend escape hatch, and
 * that boot's writes into the real `data/` tree are correct, not a leak.
 *
 * Under the runner it fires from the shared primitives in `fileCore.js` /
 * `jsonIo.js` (`atomicWrite`, `ensureDir`'s create path, `writeFileGuarded`,
 * `appendFileGuarded`, `copyFileGuarded`, `appendJSONLine`) and from
 * `collectionStore`'s record delete. It is NOT yet universal: roughly forty
 * services still reach `PATHS.*` with raw `fs` calls of their own (see
 * `sharing/importer.js`, `videoUpload.js`, `catalogMedia.js`, `genome.js`),
 * and on a populated install their target directories already exist, so
 * `ensureDir`'s create-path check is a no-op for them. Routing those onto the
 * guarded wrappers is tracked as follow-up work — do not read this module as
 * proof that every write is covered.
 *
 * A suite that genuinely needs a data root redirects it with
 * `createTempDataRoot()` + `makePathsProxy()` from `lib/mockPathsDataRoot.js`;
 * those roots live under `os.tmpdir()`, so they resolve outside the real root
 * and pass untouched.
 *
 * `server/lib/aiToolkit/` deliberately has NO such guard: that tree is vendored
 * and self-contained and must not import out to other PortOS modules (see
 * `aiToolkit/AGENTS.md`).
 */

import { existsSync, lstatSync, readlinkSync } from 'fs';
import { basename, dirname, isAbsolute, join, resolve } from 'path';
import { resolveCodeRootForModule, resolveInstallRoot } from './dataRoot.js';
import { canonicalizePath, isPathAtOrInsideDir } from './pathContainment.js';
import { isVitestRunner } from './runtimeEnv.js';

// Resolved lazily, not at module load, so the realpath below sees a tree that
// exists. Derived through `resolveCodeRootForModule`/`resolveInstallRoot` — the
// same helpers `lib/paths.js` itself uses, so the two can't silently drift —
// rather than by importing `PATHS`. That is deliberate: a suite that redirects
// `PATHS.data` to a temp root (which is exactly what a well-behaved suite does)
// must not also be able to redirect the guard's idea of what the real root is,
// or the guard would approve every write it is supposed to refuse.
let cachedRoot = null;
const realDataRoot = () => (cachedRoot ??= canonicalizePath(
  join(resolveInstallRoot(resolveCodeRootForModule(import.meta.url)), 'data'),
));

// Memo of already-canonicalized DIRECTORIES. Without it every guarded write
// re-walks its whole path with `realpathSync`, and the misses go through a
// thrown-and-caught ENOENT — ~0.9ms for a six-deep target, paid by every write
// in a ~1300-file suite. Only successful resolutions are cached: an existing
// directory's realpath is stable, while a not-yet-created one could still be
// created as a symlink, and caching that guess would go stale.
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

// Bound on how many symlink hops to follow. Deep chains do not occur in a test
// fixture; the cap just keeps a cyclic link from spinning.
const MAX_LINK_HOPS = 8;

/**
 * Where a follow-the-link write would actually land, or null when `abs` is not
 * a symlink. Resolved through `canonicalizePath` rather than `realpathSync` so
 * a DANGLING link still reports its target — a fixture link pointing at a file
 * the real tree has not created yet is exactly the case that would otherwise
 * slip through, because `realpathSync` throws ENOENT on it.
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
 * A write target has TWO possible landing sites, and the guard must refuse if
 * either is in the real tree, because the primitives disagree about symlinks:
 *
 *  - `atomicWrite` REPLACES a symlinked destination with a regular file rather
 *    than following it (see its header), so the bytes land at the link's own
 *    location — ancestors resolved, final component not.
 *  - `writeFile` / `appendFile` / `copyFile` FOLLOW a symlinked destination, so
 *    the bytes land wherever the link points.
 *
 * Checking only the first spelling would let a fixture symlink inside a temp
 * root point at `data/provider-quotas.json` and write straight through — the
 * exact #6171 leak this guard exists to stop.
 */
const canonicalTargets = (target) => {
  const abs = resolve(target);
  const parent = dirname(abs);
  const viaAncestors = parent === abs ? abs : join(canonicalDir(parent), basename(abs));
  // Only does work when the destination IS a symlink; an ordinary first write
  // costs one lstat and nothing more.
  const followed = followLinks(abs);
  return followed && followed !== viaAncestors ? [viaAncestors, followed] : [viaAncestors];
};

/**
 * Does `target` resolve to the real `data/` root or anything beneath it?
 *
 * Containment goes through `isPathAtOrInsideDir`, so it picks up that helper's
 * case-folding on case-insensitive filesystems — a hand-rolled `relative()`
 * test would read `…/Data/x.json` on macOS as outside the root it is in fact
 * inside. Relative paths and `..` climbs are resolved first, so neither can
 * walk in sideways, and a symlinked destination is judged at BOTH the locations
 * a write could land on (see `canonicalTargets`).
 *
 * @param {string} target - path to test
 * @returns {boolean}
 */
export function isInsideRealDataRoot(target) {
  if (typeof target !== 'string' || target === '') return false;
  const root = realDataRoot();
  return canonicalTargets(target).some((candidate) => isPathAtOrInsideDir(root, candidate));
}

/**
 * Throw when a test is about to write into the real `data/` tree.
 *
 * No-op outside the test runner, so production writes are unaffected.
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
 * `assertNotRealDataWrite` for `ensureDir`, which is a no-op on a directory
 * that already exists.
 *
 * Only the CREATE path is refused. Plenty of read-only suites `ensureDir` a
 * real data subdirectory on their way to reading it, and `mkdir -p` mutates
 * nothing there — faulting that would be noise, not a leak. Materializing a NEW
 * directory in the developer's tree IS a write, and it is the step every raw-fs
 * writer takes before its own `writeFile`.
 *
 * Lives here rather than as an `isTestRunner() && !existsSync(dir)` condition
 * spelled out at the call site, so `fileCore.js` imports one symbol and the
 * reasoning stays beside the logic.
 *
 * @param {string} dir - the directory `ensureDir` is about to create
 */
export function assertNotNewRealDataDir(dir) {
  if (!isVitestRunner() || existsSync(dir)) return;
  assertNotRealDataWrite(dir, 'ensureDir');
}
