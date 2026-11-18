/**
 * `pathWithin(dir, ...segments)` is `path.join(dir, ...segments)` that throws
 * when the result is outside `dir`.
 *
 * Use it where code reads a file whose name is not written out in its source
 * (a name from a table in another module, a value parsed out of a file, a
 * caller's argument). The test memo (scripts/lib/testMemo.js) keys a test on
 * the files its closure names. A plain `join(dir, name)` could name any file in
 * the repository, so the memo refuses every test that reaches it. Through this
 * call a run that passed read nothing outside `dir`, and the memo keys that
 * directory instead (docs/TEST_MEMO.md, "Variable path segments").
 *
 * The check is on the path as written: a symbolic link inside `dir` is
 * followed, as it is when the memo hashes the directory.
 *
 * Shared by `server/` and `scripts/` (re-exported from scripts/lib/pathWithin.js),
 * and imported by name: the memo trusts the call only as imported from one of
 * those two modules. ZERO external dependencies, like the CI helpers that import it.
 */
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export function pathWithin(dir, ...segments) {
  const target = join(dir, ...segments);
  const hop = relative(resolve(dir), resolve(target));
  // Another drive on Windows comes back absolute; `..name` is an entry of `dir`, not a climb.
  if (hop === '..' || hop.startsWith(`..${sep}`) || isAbsolute(hop)) {
    throw new RangeError(`pathWithin: ${segments.join('/')} is outside ${dir}`);
  }
  return target;
}
