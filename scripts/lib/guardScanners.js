/**
 * Detectors for tests that assert over the tracked tree (#5055, #6363, #8723).
 * CI's impact selection follows imports and named basenames; a scanner reads
 * files it never imports, so only an always-run registration can reach it.
 * The planner derives that set from these detectors instead of a hand list.
 * Builtins only: ci-test-plan.js imports this before `npm ci` runs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedFiles } from './trackedFiles.js';

/** A `git` invocation… */
const GIT_CALL = /execFileSync\(\s*['"]git['"]/;
/** …carrying a tree-enumerating subcommand. */
const GIT_ENUMERATION = /['"](?:ls-files|grep)['"]/;
/**
 * The client's shared enumerator, which shells out to `git ls-files` for them.
 * The `test/` segment is optional because a guard living INSIDE client/src/test/
 * imports it as './trackedFiles.js' — a scanner the narrower pattern missed
 * entirely, so it registered as a non-scanner and this whole file passed on it.
 */
const TRACKED_HELPER = /from\s+['"](?:[^'"]*\/)?trackedFiles\.js['"]/;

/**
 * A recursive directory walk (#8723): a call to one of the shared source
 * walkers in server/lib/testHelper.js, or a `readdirSync(…, { recursive: true })`.
 * Matched against comment-stripped source so a comment describing a walk
 * does not register one.
 */
const SHARED_WALKER_CALL = /\bcollect(?:Server|Client)Sources\s*\(|\bread(?:Server|Client)Source\s*\(\s*[^'"`)\s]/;
const RECURSIVE_READDIR = /readdirSync\s*\([^)]*\brecursive\s*:\s*true/;
const stripLineComments = (source) => source.replace(/^\s*(?:\/\/|\*|\/\*).*$/gm, '');

/** True when `source` asserts over the tracked tree instead of over its imports. */
export const scansTrackedTree = (source) => {
  const code = stripLineComments(source);
  return (GIT_CALL.test(source) && GIT_ENUMERATION.test(source)) || TRACKED_HELPER.test(source)
    || SHARED_WALKER_CALL.test(code) || RECURSIVE_READDIR.test(code);
};

/** Which runner owns `relPath` (a `git ls-files`-relative path): 'client' or 'server'. */
export const ownerRootFor = (relPath) => (relPath.startsWith('client/src/') ? 'client' : 'server');

/** The directory prefix, as a regex fragment, of the *other* runner's tree. */
const OPPOSITE_ROOT_PREFIX = {
  server: 'client\\/src\\/',
  client: '(?:server|scripts|autofixer)\\/',
};

/** A quoted/backtick string literal containing a cross-root directory reference. */
const crossRootLiteral = (ownRoot) => new RegExp(`(['"\`])(?:\\.\\.\\/)*${OPPOSITE_ROOT_PREFIX[ownRoot]}[^'"\`]*\\1`);
/** Same, but the literal also names a file (ends in an extension) before the closing quote. */
const crossRootNamedFile = (ownRoot) => new RegExp(
  `(['"\`])(?:\\.\\.\\/)*${OPPOSITE_ROOT_PREFIX[ownRoot]}[^'"\`]*\\.[A-Za-z0-9]+\\1`,
);

/**
 * True when `source` (the test at `relPath`) reads a file from the *other*
 * runner's tree with `readFileSync` but never spells that file's name out as
 * a single literal anywhere in its own source — the shape `pathContractTests`
 * (ci-test-plan.js, #6363) cannot reach by `git grep`-ing for a basename that
 * is never written down. A test that instead names the target directly
 * (`join(here, '../../client/src/lib/x.js')`, one literal carrying both the
 * cross-root prefix and the extension) passes, because that literal is
 * exactly what the basename lookup matches.
 */
export const readsUnnamedCrossRootFile = (source, relPath) => {
  if (!/readFileSync\s*\(/.test(source)) return false;
  const ownRoot = ownerRootFor(relPath);
  return crossRootLiteral(ownRoot).test(source) && !crossRootNamedFile(ownRoot).test(source);
};


/** Tracked test files (relative paths) that scan the tree or read an unnamed cross-root file. */
export const detectTreeGuards = (repoRoot) => {
  const found = [];
  for (const rel of trackedFiles(repoRoot, ['*.test.js', '*.test.jsx'])) {
    const source = readFileSync(join(repoRoot, rel), 'utf8');
    if (scansTrackedTree(source) || readsUnnamedCrossRootFile(source, rel)) found.push(rel);
  }
  return found.sort();
};
