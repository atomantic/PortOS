/**
 * Coverage guard for repo-scanning guards (issue #5055, extended by #6363).
 *
 * A handful of tests assert over the *tracked tree* rather than over anything
 * they import: they shell out to `git grep` / `git ls-files`, read the matched
 * files as text, and fail when some unrelated file anywhere in the repo breaks
 * a convention. `scripts/agent-instructions-files.guard.test.js` is the archetype.
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
 * ci-test-plan.js). A name is a registration nobody can forget to make only if
 * something fails when the name is missing, so the content detectors in
 * scripts/lib/guardScanners.js stay as a one-way check here: a test they
 * recognise as a scanner must carry the suffix. They select nothing.
 */
import { readFileSync } from 'fs';
import { describe, it, expect } from 'vitest';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { trackedFiles } from './lib/trackedFiles.js';
import { findUnsuffixedScanners, guardTestFiles, isGuardTest, isTreeScanner } from './lib/guardScanners.js';
import { EXPLICIT_ALWAYS_RUN_TESTS, getAlwaysRunTests, getGuardTests, buildCiTestPlan } from './ci-test-plan.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const trackedTests = trackedFiles(REPO_ROOT, ['*.test.js', '*.test.jsx']);
const sourceOf = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');

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
]);

/**
 * The hand-rolled walkers that scanned the tree unseen before #16553, as
 * [the name each had, the guard that holds its walker now].
 */
const ONCE_MISSED_WALKERS = [
  ['server/lib/apiAccessPolicy.test.js', 'server/lib/apiAccessPolicy.guard.test.js'],
  ['server/lib/dynamicImportGlobGuard.test.js', 'server/lib/dynamicImportGlob.guard.test.js'],
  ['server/lib/creativeLatitude.sources.test.js', 'server/lib/creativeLatitude.sources.guard.test.js'],
  ['server/lib/dispatchLabels.audit.test.js', 'server/lib/dispatchLabels.audit.guard.test.js'],
];

describe('tree guards are selected by filename (#5055, #16085, #16553)', () => {
  it('finds tracked test files to scan', () => {
    expect(trackedTests.length).toBeGreaterThan(100);
  });

  it('selects every tracked *.guard.test.js, and only those, as the guard set', () => {
    expect(getGuardTests()).toEqual(guardTestFiles(REPO_ROOT));
    expect(getGuardTests()).toEqual(trackedTests.filter(isGuardTest).sort());
    expect(getGuardTests()).toContain('scripts/agent-instructions-files.guard.test.js');
    expect(getGuardTests()).toContain('scripts/tailnet-identity-leak.guard.test.js');
    expect(getGuardTests()).toContain('server/logLevelConventions.guard.test.js');
    expect(getGuardTests().length).toBeGreaterThanOrEqual(8);
  });

  it('runs every server-side guard on every plan without a registry edit', () => {
    const serverSide = getGuardTests().filter((p) => !p.startsWith('client/src/'));
    expect(serverSide.filter((p) => !getAlwaysRunTests().includes(p))).toEqual([]);
    // A documentation-only change is the plan with the least reason to run anything.
    const plan = buildCiTestPlan(['docs/README.md'], { trackedFiles: [...trackedTests, 'docs/README.md'] });
    expect(serverSide.filter((p) => !plan.server.files.includes(p))).toEqual([]);
    for (const [, guard] of ONCE_MISSED_WALKERS) expect(getAlwaysRunTests()).toContain(guard);
  });

  it('selects every client guard when a client source file changes', () => {
    const plan = buildCiTestPlan(['client/src/components/Foo.jsx'], { trackedFiles: [...trackedTests, 'client/src/components/Foo.jsx'] });
    const clientGuards = getGuardTests().filter((p) => p.startsWith('client/src/'));
    expect(clientGuards).toContain('client/src/numberFormattingConventions.guard.test.js');
    expect(clientGuards.filter((p) => !plan.client.files.includes(p))).toEqual([]);
  });

  it('has no scanner without the suffix', () => {
    const sources = Object.fromEntries(trackedTests.map((rel) => [rel, sourceOf(rel)]));
    expect(
      findUnsuffixedScanners(sources, new Set(SCANNERS_WITHOUT_SUFFIX.keys())),
      'these tests scan the tracked tree but no plan selects them: rename each to <name>.guard.test.js '
      + '(moving a scan out of a behavioural suite into a sibling guard file), or list it in SCANNERS_WITHOUT_SUFFIX with the reason',
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
    expect(entries.filter(isGuardTest), 'a guard needs no exemption').toEqual([]);
    expect(entries.filter((p) => tracked.has(p) && !isTreeScanner(sourceOf(p), p)), 'stale: no longer detected').toEqual([]);
    expect(entries.filter((p) => getAlwaysRunTests().includes(p)), 'exempt yet always-run').toEqual([]);
  });

  it('keeps the explicit list to tracked guards the suffix does not already select', () => {
    const tracked = new Set(trackedTests);
    expect(EXPLICIT_ALWAYS_RUN_TESTS.filter((p) => !tracked.has(p)), 'dead entries').toEqual([]);
    expect(EXPLICIT_ALWAYS_RUN_TESTS.filter(isGuardTest), 'redundant: the suffix already selects it').toEqual([]);
  });
});
