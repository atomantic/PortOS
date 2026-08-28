/**
 * Coverage guard for repo-scanning guards (issue #5055).
 *
 * A handful of tests assert over the *tracked tree* rather than over anything
 * they import: they shell out to `git grep` / `git ls-files`, read the matched
 * files as text, and fail when some unrelated file anywhere in the repo breaks
 * a convention. `scripts/agent-instructions-files.test.js` is the archetype.
 *
 * CI selects tests by impact (`scripts/ci-test-plan.js`) through Vitest's
 * changed-source import graph or feature-path matching. Neither can reach a
 * scanner: the file that violates the convention
 * is never imported by the guard, so no edge exists to follow. The consequence
 * is not a flaky selection, it is a structural one — a scanner can sit red on
 * `main` indefinitely while every PR reports green, which is exactly what
 * happened to the agent-instructions guard.
 *
 * `ALWAYS_RUN_TESTS` is the only mechanism that can reach them. This test
 * re-derives the scanner set from the tree on every run, so a newly added
 * scanner fails here until it is registered rather than joining the list of
 * guards nobody notices has stopped running.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ALWAYS_RUN_TESTS } from './ci-test-plan.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Scanners that another selector already reaches whenever they can newly fail,
 * so they do not need the always-run list. Each entry names that selector —
 * an entry without a live mechanism behind it is worse than no entry.
 */
const STRUCTURALLY_SELECTED = new Map([
  // structuralTestsFor() in ci-test-plan.js adds these whenever any
  // client/src/**.jsx (a11y) or .js/.jsx (mounted-ref) file changes, which is
  // the only way either can start failing.
  ['client/src/a11yConventions.test.js', 'structuralTestsFor: client/src/**.jsx'],
  ['client/src/hooks/mountedRefConventions.test.js', 'structuralTestsFor: client/src/**.js(x)'],
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

const trackedTests = execFileSync('git', ['ls-files', '*.test.js', '*.test.jsx'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\n')
  .filter(Boolean);

const scanners = trackedTests.filter((rel) => scansTrackedTree(readFileSync(join(REPO_ROOT, rel), 'utf8')));

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

  it('registers every scanner in ALWAYS_RUN_TESTS or names the selector that reaches it', () => {
    const unreachable = scanners.filter((rel) => (
      !ALWAYS_RUN_TESTS.includes(rel) && !STRUCTURALLY_SELECTED.has(rel)
    ));
    expect(
      unreachable,
      'These tests assert over the tracked tree, so CI\'s import-graph selection can never reach them. '
      + 'Add each to ALWAYS_RUN_TESTS in scripts/ci-test-plan.js, or to STRUCTURALLY_SELECTED here with '
      + `the selector that already covers it: ${unreachable.join(', ')}`,
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

  it('does not park a scanner in STRUCTURALLY_SELECTED that is no longer one', () => {
    // An entry here is a claim that some other selector covers the file. Once
    // the file stops scanning the tree the claim is meaningless, and leaving it
    // hides the fact that nothing is being asserted.
    const scannerSet = new Set(scanners);
    const obsolete = [...STRUCTURALLY_SELECTED.keys()].filter((rel) => !scannerSet.has(rel));
    expect(obsolete, `No longer scans the tracked tree — drop the entry: ${obsolete.join(', ')}`).toEqual([]);
  });
});
