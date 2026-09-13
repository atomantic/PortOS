/**
 * Coverage guard for repo-scanning guards (issue #5055, extended by #6363).
 *
 * A handful of tests assert over the *tracked tree* rather than over anything
 * they import: they shell out to `git grep` / `git ls-files`, read the matched
 * files as text, and fail when some unrelated file anywhere in the repo breaks
 * a convention. `scripts/agent-instructions-files.test.js` is the archetype.
 *
 * A second shape has the same problem from the opposite direction: a test
 * reads ONE specific file from the *other* runner's tree with `readFileSync`
 * (a server test reading a client file, or vice versa) instead of importing
 * it — `server/lib/navManifest.js` reading 20+ client files by path, or any
 * `*.mirror.test.js` / `*.parity.test.js` diffing a server module against its
 * client copy. `pathContractTests` in `ci-test-plan.js` reaches most of these
 * by `git grep`-ing tracked tests for the changed file's basename, but only
 * when the test actually spells that basename out as a literal — a test that
 * instead resolves the path through a bare directory constant (`join(DIR,
 * someVariable)`) never names it and stays as unreachable as a #5055 scanner.
 *
 * CI selects tests by impact (`scripts/ci-test-plan.js`) through Vitest's
 * changed-source import graph, feature-path matching, or (for a named
 * text-reading contract) the basename lookup above. None of those can reach a
 * scanner or an unnamed cross-root reader: the file that violates the
 * convention is never imported by the guard and its basename never appears in
 * the guard's own source, so no edge exists to follow. The consequence is not
 * a flaky selection, it is a structural one — a scanner can sit red on `main`
 * indefinitely while every PR reports green, which is exactly what happened
 * to the agent-instructions guard.
 *
 * `ALWAYS_RUN_TESTS` (or a `STRUCTURALLY_SELECTED` entry naming a real
 * selector) is the only mechanism that can reach either shape. This test
 * re-derives both sets from the tree on every run, so a newly added scanner —
 * or a newly added unnamed cross-root reader — fails here until it is
 * registered, rather than joining the list of guards nobody notices has
 * stopped running.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ALWAYS_RUN_TESTS } from './ci-test-plan.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Scanners/readers that another selector already reaches whenever they can
 * newly fail, so they do not need the always-run list. Each entry names that
 * selector — an entry without a live mechanism behind it is worse than no
 * entry.
 */
const STRUCTURALLY_SELECTED = new Map([
  // structuralTestsFor() in ci-test-plan.js adds these whenever any
  // client/src/**.jsx (a11y) or .js/.jsx (mounted-ref) file changes, which is
  // the only way either can start failing.
  ['client/src/a11yConventions.test.js', 'structuralTestsFor: client/src/**.jsx'],
  ['client/src/asyncEffectDisposalConventions.test.js', 'structuralTestsFor: client/src/**.js(x)'],
  ['client/src/globalShadowConventions.test.js', 'structuralTestsFor: client/src/**.js(x)'],
  ['client/src/headingTruncationConventions.test.js', 'structuralTestsFor: client/src/**.js(x)'],
  ['client/src/hooks/mountedRefConventions.test.js', 'structuralTestsFor: client/src/**.js(x)'],
  ['client/src/pollingConventions.test.js', 'structuralTestsFor: client/src/**.js(x)'],
  ['client/src/popoverClampConventions.test.js', 'structuralTestsFor: client/src/**.js(x)'],
  ['client/src/preWrapClasses.test.js', 'structuralTestsFor: client/src/**.js(x)'],
  ['client/src/responsiveGridConventions.test.js', 'structuralTestsFor: client/src/**.js(x)'],
  ['client/src/storageConventions.test.js', 'structuralTestsFor: client/src/**.js(x)'],
  // `.ps1` is not in EXECUTABLE_RE, so touching one is an "unclassified changed
  // file" and forces the complete suite. The guard also rides the Windows
  // contract list.
  ['scripts/ps1-bom.test.js', 'unclassified-file full-suite trigger: *.ps1'],
]);

/** A `git` invocation… */
const GIT_CALL = /execFileSync\(\s*['"]git['"]/;
/** …carrying a tree-enumerating subcommand. */
const GIT_ENUMERATION = /['"](?:ls-files|grep)['"]/;
/** The client's shared enumerator, which shells out to `git ls-files` for them. */
const TRACKED_HELPER = /from\s+['"][^'"]*test\/trackedFiles\.js['"]/;

/** True when `source` asserts over the tracked tree instead of over its imports. */
export const scansTrackedTree = (source) => (
  (GIT_CALL.test(source) && GIT_ENUMERATION.test(source)) || TRACKED_HELPER.test(source)
);

/** Which runner owns `relPath` (a `git ls-files`-relative path): 'client' or 'server'. */
const ownerRootFor = (relPath) => (relPath.startsWith('client/src/') ? 'client' : 'server');

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

const trackedTests = execFileSync('git', ['ls-files', '*.test.js', '*.test.jsx'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\n')
  .filter(Boolean);

const testSources = new Map(trackedTests.map((rel) => [rel, readFileSync(join(REPO_ROOT, rel), 'utf8')]));

const scanners = trackedTests.filter((rel) => scansTrackedTree(testSources.get(rel)));
const crossRootReaders = trackedTests.filter((rel) => readsUnnamedCrossRootFile(testSources.get(rel), rel));

describe('repo-scanning guards are reachable by CI selection (#5055)', () => {
  it('finds tracked test files to scan', () => {
    // Fails loudly if the glob or the cwd stops matching, rather than reporting
    // a vacuous pass over zero files.
    expect(trackedTests.length).toBeGreaterThan(100);
  });

  it('detects the scan shape it registers, and leaves ordinary tests alone', () => {
    // Bypass probe: proves the detector bites, so the assertion below cannot
    // pass because the regexes quietly stopped matching anything.
    expect(scansTrackedTree("const files = execFileSync('git', ['ls-files', '*.js'], opts);")).toBe(true);
    expect(scansTrackedTree("execFileSync(\n  'git',\n  ['grep', '-n', 'x'],\n);")).toBe(true);
    expect(scansTrackedTree("import { trackedSourceFiles } from './test/trackedFiles.js';")).toBe(true);
    expect(scansTrackedTree("import { thing } from './thing.js';\nexpect(thing()).toBe(1);")).toBe(false);
    // A comment mentioning the command is not an invocation.
    expect(scansTrackedTree('// enumerated via git ls-files rather than a walk')).toBe(false);
  });

  it('finds the known scanners', () => {
    expect(scanners).toContain('scripts/agent-instructions-files.test.js');
    expect(scanners).toContain('scripts/tailnet-identity-leak.test.js');
    expect(scanners.length).toBeGreaterThanOrEqual(8);
  });

  it('detects the unnamed-cross-root-read shape it registers, and leaves a named read alone (#6363)', () => {
    // Bypass probe: proves the detector bites before the assertions below rely
    // on it having stopped matching anything.
    expect(readsUnnamedCrossRootFile(
      "const DIR = join(here, '../../client/src/lib');\nreadFileSync(join(DIR, name), 'utf8');",
      'server/lib/example.test.js',
    )).toBe(true);
    // Same directory constant, but the file IS named as one literal elsewhere —
    // that literal is what the basename `git grep` lookup matches.
    expect(readsUnnamedCrossRootFile(
      "const DIR = join(here, '../../client/src/lib');\n"
      + "readFileSync(join(DIR, name), 'utf8');\n"
      + "readFileSync(join(here, '../../client/src/lib/x.js'), 'utf8');",
      'server/lib/example.test.js',
    )).toBe(false);
    // No readFileSync at all — an ordinary import-graph-reachable test.
    expect(readsUnnamedCrossRootFile(
      "import { x } from '../../client/src/lib/x.js';",
      'server/lib/example.test.js',
    )).toBe(false);
    // readFileSync of a same-root file is not a cross-root read.
    expect(readsUnnamedCrossRootFile(
      "readFileSync(join(here, 'sibling.js'), 'utf8');",
      'server/lib/example.test.js',
    )).toBe(false);
  });

  it('finds the known unnamed cross-root readers', () => {
    expect(crossRootReaders).toContain('scripts/agent-instructions-files.test.js');
  });

  it('registers every scanner and unnamed cross-root reader in ALWAYS_RUN_TESTS or names the selector that reaches it', () => {
    const unreachable = [...scanners, ...crossRootReaders].filter((rel) => (
      !ALWAYS_RUN_TESTS.includes(rel) && !STRUCTURALLY_SELECTED.has(rel)
    ));
    expect(
      unreachable,
      'These tests assert over the tracked tree, or read a cross-root file without naming it, so CI\'s '
      + 'import-graph and basename selection can never reach them. Add each to ALWAYS_RUN_TESTS in '
      + 'scripts/ci-test-plan.js, or to STRUCTURALLY_SELECTED here with the selector that already covers it: '
      + `${unreachable.join(', ')}`,
    ).toEqual([]);
  });

  it('keeps both registries free of paths that no longer exist', () => {
    const tracked = new Set(trackedTests);
    const stale = [...ALWAYS_RUN_TESTS, ...STRUCTURALLY_SELECTED.keys()].filter((rel) => !tracked.has(rel));
    expect(
      stale,
      `These registered paths are not tracked test files — a renamed or deleted guard left a dead entry, and `
      + `ALWAYS_RUN_TESTS silently drops anything untracked: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('does not park a scanner or cross-root reader in STRUCTURALLY_SELECTED that is no longer one', () => {
    // An entry here is a claim that some other selector covers the file. Once
    // the file stops matching either shape the claim is meaningless, and
    // leaving it hides the fact that nothing is being asserted.
    const stillMatches = new Set([...scanners, ...crossRootReaders]);
    const obsolete = [...STRUCTURALLY_SELECTED.keys()].filter((rel) => !stillMatches.has(rel));
    expect(obsolete, `No longer scans the tracked tree or reads an unnamed cross-root file — drop the entry: ${obsolete.join(', ')}`).toEqual([]);
  });
});
