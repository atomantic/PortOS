/**
 * Coverage guard for repo-scanning guards (issue #5055, extended by #6363).
 *
 * A handful of tests assert over the *tracked tree* rather than over anything
 * they import: they shell out to `git grep` / `git ls-files`, read the matched
 * files as text, and fail when some unrelated file anywhere in the repo breaks
 * a convention. `server/test/guards/repo/agent-instructions-files.test.js` is the archetype.
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
 * The planner therefore selects these guards by filename (#16553): every tracked
 * `*.guard.test.js` rides every plan — or, under client/src, any client js(x)
 * change — and the test memo never skips one (`getGuardTests` in
 * ci-test-plan.js). Nearly every scan is a check module in a runner's guard
 * directory instead (#16996): each `server/test/guards/<subject>.guard.test.js`
 * loads every `server/test/guards/<subject>/*.test.js` into one worker over one
 * shared corpus, so placement is the registration there. A registration nobody
 * can forget to make only works if something fails when it is missing, so the
 * content detectors in scripts/lib/guardScanners.js stay as a one-way check
 * here: a test they recognise as a scanner must carry the suffix or live in a
 * guard directory. They select nothing.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import {
  GUARD_CHECK_DIRS, findUnsuffixedScanners, guardCheckModules, guardTestFiles, isGuardCheck, isGuardTest, isTreeScanner,
} from '../../../../scripts/lib/guardScanners.js';
import { globToRegExp, workspaceTestGlobs } from '../../../../scripts/lib/workspaceTests.js';
import { EXPLICIT_ALWAYS_RUN_TESTS, getAlwaysRunTests, getGuardTests, buildCiTestPlan } from '../../../../scripts/ci-test-plan.js';
import { readText, REPO_ROOT, trackedFiles } from '../../../../scripts/lib/guardCorpus.js';

const trackedTests = trackedFiles(REPO_ROOT, ['*.test.js', '*.test.jsx']);
const sourceOf = (rel) => readText(join(REPO_ROOT, rel));

/**
 * Tests the detectors recognise that deliberately carry no suffix. Two kinds:
 * a real scanner another selector already reaches, which must not ride every
 * plan, and a suite whose recursive walk reads a temporary directory it built
 * itself, which is not a tree scan at all. Each entry says which.
 */
const SCANNERS_WITHOUT_SUFFIX = new Map([
  ['scripts/ensure-deps.test.js', 'selected by structuralTestsFor on ENSURE_DEPS_INPUTS; behavioural temp-directory suite (#16086)'],
  // `.ps1` is an unclassified changed file and forces the complete suite.
  ['scripts/ps1-bom.test.js', 'selected by the unclassified-file full-suite trigger for *.ps1'],
  ['server/cos-runner/spawnFailure.test.js', 'walks a temporary runner data root to snapshot it'],
  ['server/services/musicVideo/compositionDocument.lyricType.test.js', 'walks a staged composition document under a temporary data root'],
  ['server/services/worktreeReap.test.js', 'walks temporary git repositories to snapshot them'],
  ['scripts/lib/guardCorpus.test.js', 'lists a temporary git repository it builds to pin the corpus against git; selected by its imports'],
]);

const SERVER_CHECK_DIRS = GUARD_CHECK_DIRS.filter(({ dir }) => dir.startsWith('server/'));
/** The Vitest workspace a guard directory belongs to, and its path inside it (the form the config globs match). */
const workspaceOf = (path) => (path.startsWith('client/') ? 'client' : 'server');
const inWorkspace = (path) => path.slice(workspaceOf(path).length + 1);

/**
 * `*.guard.test.js` files that are not a runner, and why. A new scan belongs in a
 * `<workspace>/…/test/guards/<subject>/` directory: a separate file costs its own
 * worker and its own pass over the tree on every plan (#16996).
 */
const STANDALONE_GUARDS = new Map([
  ['scripts/node-version-drift.guard.test.js', "ci.yml's minimum-Node job runs it by path on the lowest supported Node line"],
]);

/**
 * The hand-rolled walkers that scanned the tree unseen before #16553, as
 * [the name each had, the check that holds its walker now].
 */
const ONCE_MISSED_WALKERS = [
  ['server/lib/apiAccessPolicy.test.js', 'server/test/guards/modules/apiAccessPolicy.test.js'],
  ['server/lib/dynamicImportGlobGuard.test.js', 'server/test/guards/modules/dynamicImportGlob.test.js'],
  ['server/lib/creativeLatitude.sources.test.js', 'server/test/guards/modules/creativeLatitude.sources.test.js'],
  ['server/lib/dispatchLabels.audit.test.js', 'server/test/guards/modules/dispatchLabels.audit.test.js'],
];

describe('tree guards are selected by filename (#5055, #16085, #16553)', () => {
  it('finds tracked test files to scan', () => {
    expect(trackedTests.length).toBeGreaterThan(100);
  });

  it('selects every tracked *.guard.test.js, and only those, as the guard set', () => {
    expect(getGuardTests()).toEqual(guardTestFiles(REPO_ROOT));
    expect(getGuardTests()).toEqual(trackedTests.filter(isGuardTest).sort());
    for (const { runner } of GUARD_CHECK_DIRS) expect(getGuardTests()).toContain(runner);
    expect(getGuardTests()).toContain('scripts/node-version-drift.guard.test.js');
  });

  it('runs every check inside a subject runner and keeps other guards to the reviewed list', () => {
    const checksIn = ({ dir }) => guardCheckModules(join(REPO_ROOT, dir)).map((name) => `${dir}/${name}`);
    const checks = GUARD_CHECK_DIRS.flatMap(checksIn);
    for (const check of ['server/test/guards/repo/agent-instructions-files.test.js', 'server/test/guards/runtime/logLevelConventions.test.js',
      'client/src/test/guards/a11y/controlNames.test.js', 'client/src/test/guards/ui/timeouts.test.js']) {
      expect(checks).toContain(check);
    }
    expect(checks.length).toBeGreaterThanOrEqual(90);
    for (const { dir } of GUARD_CHECK_DIRS) expect(guardCheckModules(join(REPO_ROOT, dir)).length, dir).toBeGreaterThan(0);
    const trackedChecks = trackedTests.filter((p) => GUARD_CHECK_DIRS.some(({ runner }) => p.startsWith(`${runner.slice(0, runner.lastIndexOf('/'))}/`)));
    expect(trackedChecks.filter((p) => !isGuardCheck(p) && !isGuardTest(p)), 'outside a subject directory, so no runner loads it').toEqual([]);
    expect(trackedChecks.filter((p) => isGuardCheck(p) && !checks.includes(p)), 'tracked but not loaded').toEqual([]);
    const runners = new Set(GUARD_CHECK_DIRS.map(({ runner }) => runner));
    expect(getGuardTests().filter((p) => !runners.has(p) && !STANDALONE_GUARDS.has(p)),
      'move the scan into a test/guards/<subject>/ directory, or list it in STANDALONE_GUARDS with the reason').toEqual([]);
    expect([...STANDALONE_GUARDS.keys()].filter((p) => !getGuardTests().includes(p)), 'dead entries').toEqual([]);
  });

  it('collects every runner, and no check module, as a suite', () => {
    const collects = (path) => {
      const { include, exclude } = workspaceTestGlobs(workspaceOf(path));
      const rel = inWorkspace(path);
      return include.some((glob) => globToRegExp(glob).test(rel)) && !exclude.some((glob) => globToRegExp(glob).test(rel));
    };
    for (const { dir, runner } of GUARD_CHECK_DIRS) {
      expect(collects(runner), runner).toBe(true);
      expect(guardCheckModules(join(REPO_ROOT, dir)).filter((name) => collects(`${dir}/${name}`)), dir).toEqual([]);
    }
  });

  it('runs every server-side guard on every plan without a registry edit', () => {
    const serverSide = getGuardTests().filter((p) => !p.startsWith('client/src/'));
    expect(serverSide.filter((p) => !getAlwaysRunTests().includes(p))).toEqual([]);
    // A documentation-only change is the plan with the least reason to run anything.
    const plan = buildCiTestPlan(['docs/README.md'], { trackedFiles: [...trackedTests, 'docs/README.md'] });
    expect(serverSide.filter((p) => !plan.server.files.includes(p))).toEqual([]);
    for (const { runner } of SERVER_CHECK_DIRS) expect(getAlwaysRunTests()).toContain(runner);
    // Each former walker is a check its subject runner loads, not just a check-shaped path.
    for (const [, check] of ONCE_MISSED_WALKERS) {
      const dir = SERVER_CHECK_DIRS.find(({ dir: checkDir }) => check.startsWith(`${checkDir}/`));
      expect(isGuardCheck(check) && dir !== undefined, check).toBe(true);
      expect(guardCheckModules(join(REPO_ROOT, dir.dir)), check).toContain(check.slice(dir.dir.length + 1));
    }
  });

  it('selects every client guard when a client source file changes', () => {
    const plan = buildCiTestPlan(['client/src/components/Foo.jsx'], { trackedFiles: [...trackedTests, 'client/src/components/Foo.jsx'] });
    const clientGuards = getGuardTests().filter((p) => p.startsWith('client/src/'));
    expect(clientGuards).toEqual(GUARD_CHECK_DIRS.filter(({ dir }) => dir.startsWith('client/')).map(({ runner }) => runner).sort());
    expect(clientGuards.filter((p) => !plan.client.files.includes(p))).toEqual([]);
  });

  it('has no scanner without the suffix', () => {
    const sources = Object.fromEntries(trackedTests.map((rel) => [rel, sourceOf(rel)]));
    expect(
      findUnsuffixedScanners(sources, new Set(SCANNERS_WITHOUT_SUFFIX.keys())),
      'these tests scan the tracked tree but no plan selects them: move each scan into server/test/guards/ '
      + '(client/src/test/guards/ for a client scan), out of any behavioural suite, or list it in SCANNERS_WITHOUT_SUFFIX with the reason',
    ).toEqual([]);
  });

  it('would fail each walker the detector once missed, were it un-renamed', () => {
    for (const [formerName, guard] of ONCE_MISSED_WALKERS) {
      const source = sourceOf(guard);
      expect(findUnsuffixedScanners({ [formerName]: source }), formerName).toEqual([formerName]);
      expect(findUnsuffixedScanners({ [guard]: source }), guard).toEqual([]);
    }
  });

  it('keeps the exemptions to tracked, unsuffixed tests the detector still recognises', () => {
    const tracked = new Set(trackedTests);
    const entries = [...SCANNERS_WITHOUT_SUFFIX.keys()];
    expect(entries.filter((p) => !tracked.has(p)), 'dead entries').toEqual([]);
    expect(entries.filter((p) => isGuardTest(p) || isGuardCheck(p)), 'a guard needs no exemption').toEqual([]);
    expect(entries.filter((p) => tracked.has(p) && !isTreeScanner(sourceOf(p), p)), 'stale: no longer detected').toEqual([]);
    expect(entries.filter((p) => getAlwaysRunTests().includes(p)), 'exempt yet always-run').toEqual([]);
  });

  it('keeps the explicit list to tracked guards the suffix does not already select', () => {
    const tracked = new Set(trackedTests);
    expect(EXPLICIT_ALWAYS_RUN_TESTS.filter((p) => !tracked.has(p)), 'dead entries').toEqual([]);
    expect(EXPLICIT_ALWAYS_RUN_TESTS.filter(isGuardTest), 'redundant: the suffix already selects it').toEqual([]);
  });
});
