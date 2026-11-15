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
 * The planner therefore derives these guards from the tree (`getTreeGuards`
 * in ci-test-plan.js, detectors in scripts/lib/guardScanners.js) and adds them
 * to every plan — or, for client scanners, to any client/src js(x) change — so
 * a new scanner needs no registry edit. This test pins that derivation.
 */
import { describe, it, expect } from 'vitest';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { trackedFiles } from './lib/trackedFiles.js';
import { detectTreeGuards } from './lib/guardScanners.js';
import {
  EXPLICIT_ALWAYS_RUN_TESTS, TREE_GUARDS_SELECTED_ELSEWHERE, getAlwaysRunTests, getTreeGuards,
  buildCiTestPlan,
} from './ci-test-plan.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const trackedTests = trackedFiles(REPO_ROOT, ['*.test.js', '*.test.jsx']);

describe('tree-scanning guards are derived into CI selection (#5055, #16085)', () => {
  it('finds tracked test files to scan', () => {
    expect(trackedTests.length).toBeGreaterThan(100);
  });

  it('finds the known scanners', () => {
    expect(getTreeGuards()).toEqual(detectTreeGuards(REPO_ROOT));
    expect(getTreeGuards()).toContain('scripts/agent-instructions-files.test.js');
    expect(getTreeGuards()).toContain('scripts/tailnet-identity-leak.test.js');
    expect(getTreeGuards()).toContain('server/lib/textUtils.test.js');
    expect(getTreeGuards().length).toBeGreaterThanOrEqual(8);
  });

  it('selects every detected scanner without a registry edit', () => {
    const derived = getTreeGuards().filter((p) => !p.startsWith('client/src/') && !TREE_GUARDS_SELECTED_ELSEWHERE.has(p));
    expect(derived.filter((p) => !getAlwaysRunTests().includes(p))).toEqual([]);
  });

  it('selects a client scanner when a client source file changes', () => {
    const plan = buildCiTestPlan(['client/src/components/Foo.jsx'], { trackedFiles: [...trackedTests, 'client/src/components/Foo.jsx'] });
    expect(plan.client.files).toContain('client/src/storageConventions.test.js');
  });

  it('keeps the explicit list to entries the detector cannot see, all still tracked', () => {
    const tracked = new Set(trackedTests);
    const detected = new Set(getTreeGuards());
    expect(EXPLICIT_ALWAYS_RUN_TESTS.filter((p) => !tracked.has(p)), 'dead entries').toEqual([]);
    expect(EXPLICIT_ALWAYS_RUN_TESTS.filter((p) => detected.has(p)), 'redundant: already detected').toEqual([]);
    expect([...TREE_GUARDS_SELECTED_ELSEWHERE.keys()].filter((p) => !detected.has(p)), 'stale exemption').toEqual([]);
  });
});
