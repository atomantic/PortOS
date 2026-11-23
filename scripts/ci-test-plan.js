#!/usr/bin/env node

/**
 * The CI impact planner: builds the test plan for a diff (`buildCiTestPlan`) and emits it for ci.yml.
 *
 * Its path rules, manifest verdicts, repository inputs and output live in
 * `scripts/lib/ciPlan*.js` (#16998); the public names are re-exported here so
 * callers keep one entry point. Builtins only: the planner runs before `npm ci`.
 */

import { isDirectlyInvoked } from './lib/directInvocation.js';
import { resolveDbTestFiles } from './lib/dbTestFiles.js';
import { BROWSER_SUITES } from './lib/browserSuites.js';
import { formatReachSummary, isClientBrowserSuite } from './lib/importReach.js';
import { guardRunnerFor, isGuardCheck } from './lib/guardScanners.js';
import {
  DB_RISK_RULES, DOCKER_CONTAINMENT_LIVE_PATH_RE, LINUX_CONTAINMENT_PATH_RE, MACOS_NATIVE_PATH_RE,
  MAX_CHANGED_CODE_FILES, NODE_MINIMUM_PATH_RE, SLASHDO_CONTRACT_SOURCE_FILES, SLASHDO_CONTRACT_TEST_FILES,
  SLASHDO_GITLINK_PATH, SUPERCOLLIDER_LIVE_PATH_RE, browserSuitesIn, featureDirectory, fixtureOwnerFor,
  fullTriggersFor, getAlwaysRunTests, hasWindowsRiskFile, isDocumentationOnly, isExecutable, isGeneratedData,
  isLintSurface, isPythonScript, isRouteOnlyAppDiff, isServerRunnerFile, isSharedClientDependency, isTestFile,
  TOOLING_TESTS, pathMatchesFeature, runnerForTest, splitByRunner, structuralTestsFor, toolingTestsFor, touchesJobInputs,
  uniqueSorted, windowsContractTests, windowsSelectionFor,
} from './lib/ciPlanRules.js';
import {
  FULL_SUITE_SHARDS, MAX_TARGETED_TEST_FILES, emitGitHubPlan, fansOut, reachCount, shardIndexes,
  suiteReasonsFor,
} from './lib/ciPlanOutput.js';
import { collectPlanInputs } from './lib/ciPlanInputs.js';

// Preserve the planner's public registry export for existing callers.
export { BROWSER_SUITES } from './lib/browserSuites.js';
export {
  DOCKER_CONTAINMENT_LIVE_ENTRIES, DOCKER_CONTAINMENT_LIVE_PATH_RE, EXPLICIT_ALWAYS_RUN_TESTS, FIXTURE_OWNERS,
  LINUX_CONTAINMENT_PATH_RE, LINUX_CONTAINMENT_TESTS, MACOS_NATIVE_PATH_RE, MACOS_NATIVE_TESTS,
  NODE_MINIMUM_PATH_RE, SLASHDO_CONTRACT_TEST_FILES, SLASHDO_GITLINK_PATH, SUPERCOLLIDER_LIVE_ENTRIES,
  SUPERCOLLIDER_LIVE_PATH_RE, TOOLING_OWNER_RE, TOOLING_TESTS, WINDOWS_CONTRACT_TESTS, WINDOWS_RISK_RULES,
  getAlwaysRunTests, getGuardTests, isRouteOnlyAppDiff, sourceReferencePattern, splitByRunner,
  structuralTestsFor,
} from './lib/ciPlanRules.js';
export {
  PLATFORM_PACKAGE_RES, WINDOWS_INSTALLED_WORKSPACES, classifyDependencyChange,
} from './lib/ciPlanDependencies.js';
export {
  CLIENT_BROWSER_FANOUT_SUITES, CLIENT_FANOUT_TEST_FILES, FULL_SUITE_SHARDS, MAX_TARGETED_TEST_FILES, emitGitHubPlan, formatPlanSummary,
  githubPlanOutput, shardIndexes,
} from './lib/ciPlanOutput.js';
export {
  collectDockerContainmentLiveInputs, collectLinuxContainmentInputs, collectPlanInputs,
  collectSuperColliderLiveInputs,
} from './lib/ciPlanInputs.js';

/**
 * Whether this plan's server job needs `lib/slashdo` initialized.
 *
 * The `changedFiles` check is currently unreachable from `buildCiTestPlan`
 * itself: `SLASHDO_GITLINK_PATH` has no recognized extension, so a real
 * gitlink change already hits the "unclassified changed file" rule and forces
 * `plan.full = true` first, which the `plan.full` clause above already
 * covers. It stays as a direct, defense-in-depth check — independent of that
 * incidental classification — and is what the unit tests below exercise
 * against a hand-built plan.
 *
 * This only catches a literal edit to the two source files, not an indirect
 * one: a shared dependency of `slashdoLoader.js`/`slashdoInvocation.js`
 * changing would not set this, even though Vitest's real `related` selection
 * can still transitively pull the contract tests in — in which case they run
 * without the submodule and take the documented skip. In practice a
 * sufficiently shared dependency changing also tends to select more than
 * MAX_TARGETED_TEST_FILES explicit server tests, which does trigger this (as
 * the full plan that cap used to force did); a narrowly-shared one is the
 * remaining gap.
 */
export const needsSlashdoSubmodule = (plan) => Boolean(
  plan.full
  || plan.server.files.length > MAX_TARGETED_TEST_FILES
  || plan.changedFiles.includes(SLASHDO_GITLINK_PATH)
  || plan.server.files.some((path) => SLASHDO_CONTRACT_TEST_FILES.includes(path))
  || plan.server.sources.some((path) => SLASHDO_CONTRACT_SOURCE_FILES.includes(path))
);

// Guarded by trackedSet like every other selector: an untracked path handed to
// Vitest as an exact selector makes the run exit non-zero.
const alwaysRunTests = (trackedSet) => getAlwaysRunTests([...trackedSet]).filter((path) => trackedSet.has(path));

const skippedRunner = () => ({ mode: 'skip', files: [], sources: [] });

/**
 * Build a conservative PR test plan.
 *
 * "files" mode is used only when every executable change belongs to a
 * directory-scoped feature (for example services/sprites + components/sprites).
 * Flat/shared files fall back to Vitest's import-graph-aware "related" mode,
 * while composition roots and test configuration force the complete suite.
 */
/**
 * The CI plan for a diff: the test-suite selection plus whether each
 * path-gated job (Linux containment, SuperCollider live, Docker containment
 * live, macOS native, Node minimum) runs.
 *
 * The static import closures of the single-purpose jobs come from
 * collectPlanInputs(). A missing closure (null) runs its job.
 *
 * A forced-full plan runs every gated job, except when `gatedChangedFiles` is
 * an array: a push to `main` whose diff against the last green push or
 * schedule run is known (`CI_GATED_BASE_SHA`). Then the gated jobs and the
 * Windows native job are decided from that diff exactly as a pull request
 * would decide them, while the primary suites stay full. null keeps them all.
 */
export function buildCiTestPlan(changedFiles, options = {}) {
  const plan = buildSuitePlan(changedFiles, options);
  const {
    forceFull = false, linuxContainmentInputs = null, supercolliderLiveInputs = null,
    dockerContainmentLiveInputs = null, serverReach = null, clientReach = null, trackedFiles = [],
    gatedChangedFiles = null, gatedDependencyChanges = {},
  } = options;
  const gatedFull = forceFull && Array.isArray(gatedChangedFiles);
  const gateFiles = gatedFull ? uniqueSorted(gatedChangedFiles.filter(Boolean)) : plan.changedFiles;
  // Forced full without a known green base: every gated job runs.
  const gate = (decide) => (forceFull && !gatedFull) || decide(gateFiles);
  // Informational: names the changed source behind a large related selection
  // (#12285). It never changes what runs.
  const reachNote = (runner, report) => (!plan.full && plan[runner].mode === 'related' ? formatReachSummary(report) : '');
  const reachNotes = { server: reachNote('server', serverReach), client: reachNote('client', clientReach) };
  const suiteReasons = Object.fromEntries(Object.entries(plan.suiteReasons).map(([suite, reason]) => [suite,
    reachNotes[suite] ? `${reason}; ${reachNotes[suite]}` : reason]));
  let gatedWindows = {};
  if (gatedFull) {
    const { windows, windowsNote } = windowsSelectionFor(gateFiles, gatedDependencyChanges);
    const fields = {
      windows,
      windowsMode: windows ? 'files' : 'skip',
      windowsFiles: windows ? windowsContractTests(new Set(trackedFiles)) : [],
      windowsNote: [`native jobs gated on ${gateFiles.length} file(s) changed since the last green main run`, windowsNote]
        .filter(Boolean).join('; '),
    };
    gatedWindows = { ...fields, suiteReasons: { ...suiteReasons, windows: suiteReasonsFor({ ...plan, ...fields }).windows } };
  }
  return {
    ...plan,
    suiteReasons,
    ...gatedWindows,
    // A gated push still is not complete-run evidence: ci.yml withholds the
    // Full CI Gate marker that release reuse trusts (scripts/verify-ci-status.js).
    nativeGated: gatedFull,
    linuxContainment: gate((files) => touchesJobInputs(files, linuxContainmentInputs, LINUX_CONTAINMENT_PATH_RE)),
    supercolliderLive: gate((files) => touchesJobInputs(files, supercolliderLiveInputs, SUPERCOLLIDER_LIVE_PATH_RE)),
    dockerContainmentLive: gate((files) => touchesJobInputs(files, dockerContainmentLiveInputs, DOCKER_CONTAINMENT_LIVE_PATH_RE)),
    macosNative: gate((files) => files.some((path) => MACOS_NATIVE_PATH_RE.test(path))),
    nodeMinimum: gate((files) => files.some((path) => NODE_MINIMUM_PATH_RE.test(path))),
  };
}

function buildSuitePlan(changedFiles, {
  trackedFiles = [],
  // measureRepoImportReach() reports; each `selected` count can fan its
  // runner's related plan out (see fansOut). null keeps the explicit-selector
  // cap only.
  serverReach = null,
  clientReach = null,
  // clientBrowserSuiteReach(): the real-Chromium client suites the change
  // reaches; at CLIENT_BROWSER_FANOUT_SUITES they fan the client runner out.
  clientBrowserReach = null,
  forceFull = false,
  forceFullReason = 'full CI requested',
  appRouteOnly = false,
  // Changed source path → tracked test files naming its basename (see
  // sourceReferencePattern). Covers every changed source, not only python
  // scripts — see rule 1 of issue #6363.
  pathContractTests = {},
  // Repository-derived browser dependencies; null means discovery failed and
  // a shared-source change must retain conservative full coverage.
  clientDependencies = [],
  // Client test → shared dependencies; null conservatively retains that test.
  // Kept separate from production dependencies so fixtures never force a build.
  clientTestDependencies = {},
  // Includes literal deferred imports; null means discovery was inconclusive.
  dbDependencies = [],
  // Registered suite → reachable files; null retains that suite conservatively.
  browserDependencies = {},
  // Changed dependency manifest → classifyDependencyChange() verdict. A
  // manifest with no verdict escalates Windows (fail closed).
  dependencyChanges = {},
} = {}) {
  const changed = uniqueSorted(changedFiles.filter(Boolean));
  const trackedSet = new Set(trackedFiles);

  // Full validation widens the primary jobs; Windows still proves only its
  // supported native boundary, including scheduled and release validation.
  if (forceFull) {
    return fullPlan(changed, forceFullReason, { appRouteOnly, trackedSet, windowsRelevant: true });
  }

  // EVERY matching trigger, not just the reported one, and computed BEFORE the
  // first full-plan branch. The reason line is the first match in sorted-path
  // order, but the Windows decision is the OR over all of them, so a diff that
  // trips two triggers must escalate if EITHER does. Two ways this goes wrong
  // if the OR is skipped: an alphabetically earlier client-only trigger
  // (client/vite.config.js) reported ahead of server/index.js, and the App.jsx
  // branch below returning before the triggers are even looked at — which
  // downgraded Windows for an App.jsx PR that also bumped a lockfile.
  const { fullTriggers, windowsNote } = fullTriggersFor(changed, dependencyChanges);
  const fullTrigger = fullTriggers.at(0);
  const triggersEscalateWindows = fullTriggers.some((trigger) => trigger.windowsRelevant);

  const appCompositionChanged = changed.includes('client/src/App.jsx');
  if (appCompositionChanged && !appRouteOnly) {
    // The composition root itself is client-only, but the rest of the diff may
    // not be.
    return fullPlan(changed, 'client composition root changed: client/src/App.jsx', {
      appRouteOnly,
      trackedSet,
      windowsRelevant: triggersEscalateWindows,
      windowsNote,
    });
  }

  if (fullTrigger) {
    return fullPlan(changed, `${fullTrigger.reason}: ${fullTrigger.path}`, {
      appRouteOnly,
      trackedSet,
      windowsRelevant: triggersEscalateWindows,
      windowsNote,
    });
  }

  const dataOnly = changed.length > 0 && changed.every(isGeneratedData);
  const alwaysRun = dataOnly ? [] : alwaysRunTests(trackedSet);

  const relevant = changed.filter((path) => !isDocumentationOnly(path) && !isGeneratedData(path));
  if (relevant.length === 0) {
    const { server: alwaysRunServer, client: alwaysRunClient } = splitByRunner(alwaysRun);
    const reason = dataOnly ? 'generated data-only change'
      : changed.length ? 'documentation-only change' : 'no changed files';
    const plan = {
      full: false,
      reason,
      changedFiles: changed,
      server: alwaysRunServer.length > 0 ? { mode: 'files', files: alwaysRunServer, sources: [] } : skippedRunner(),
      client: alwaysRunClient.length > 0 ? { mode: 'files', files: alwaysRunClient, sources: [] } : skippedRunner(),
      browserFiles: browserSuitesIn(alwaysRun),
      db: false,
      lint: { mode: 'skip', files: [] },
      build: false,
      smoke: false,
      windows: false,
      windowsMode: 'skip',
      windowsFiles: [],
      windowsSources: [],
    };
    return finishPlan(plan, { appRouteOnly });
  }

  const executable = relevant.filter(isExecutable);
  const fixtureTests = [];
  const unknown = [];
  const missingFixtureOwners = [];
  for (const path of relevant) {
    if (isExecutable(path)) continue;
    const owner = fixtureOwnerFor(path);
    if (!owner) {
      unknown.push(path);
      continue;
    }
    if (owner.tests.some((test) => !trackedSet.has(test) || !runnerForTest(test))) {
      missingFixtureOwners.push(path);
      continue;
    }
    fixtureTests.push(...owner.tests);
  }
  if (unknown.length > 0) {
    return fullPlan(changed, `unclassified changed file: ${unknown[0]}`, { appRouteOnly, trackedSet });
  }
  if (missingFixtureOwners.length > 0) {
    return fullPlan(changed, `fixture owner not tracked: ${missingFixtureOwners[0]}`, { appRouteOnly, trackedSet });
  }
  if (executable.length > MAX_CHANGED_CODE_FILES) {
    return fullPlan(changed, `wide change (${executable.length} executable files)`, { appRouteOnly, trackedSet, windowsRelevant: false });
  }

  // `changed` includes deleted paths (diff-filter ACMRD), but a deleted test
  // file passed as an exact Vitest selector makes the runner exit non-zero on
  // an otherwise-valid deletion PR — trackedSet (git ls-files) excludes it.
  const directTests = executable.filter(isTestFile).filter((path) => trackedSet.has(path));
  const sourceFiles = executable.filter((path) => !isTestFile(path));
  const unsupportedSources = sourceFiles.filter((path) => (
    !isServerRunnerFile(path) && !path.startsWith('client/')
  ));
  if (unsupportedSources.length > 0) {
    return fullPlan(changed, `unmapped executable surface: ${unsupportedSources[0]}`, { appRouteOnly, trackedSet });
  }
  const deletedSources = sourceFiles.filter((path) => !trackedSet.has(path));
  if (deletedSources.length > 0) {
    // `vitest related` needs a real source path. A deleted module can still
    // affect importers, so widening is safer than silently dropping its side of
    // the graph.
    return fullPlan(changed, `deleted executable source: ${deletedSources[0]}`, { appRouteOnly, trackedSet });
  }
  // Python scripts never enter the import graph or a feature directory: their
  // only selector is the per-script contract list, so they leave the JS-only
  // scoping below.
  const pythonSources = sourceFiles.filter(isPythonScript);
  const jsSources = sourceFiles.filter((path) => !isPythonScript(path));
  if (clientDependencies === null && jsSources.some((path) => path.startsWith('server/lib/'))) {
    return fullPlan(changed, 'client dependency discovery unresolved', { appRouteOnly, trackedSet });
  }
  const clientDependencySet = new Set(clientDependencies || []);
  const isClientSource = (path) => path.startsWith('client/') || clientDependencySet.has(path);
  const features = uniqueSorted(jsSources.map(featureDirectory).filter(Boolean));
  const selectedTests = [
    ...directTests,
    ...fixtureTests,
    ...structuralTestsFor(changed, trackedSet),
    ...alwaysRun,
    ...toolingTestsFor(changed, trackedSet),
    ...Object.entries(clientTestDependencies)
      .filter(([test, dependencies]) => trackedSet.has(test) && runnerForTest(test) === 'client'
        && jsSources.some((source) => isSharedClientDependency(source)
          && (dependencies === null || dependencies.includes(source))))
      .map(([test]) => test),
  ];

  for (const script of pythonSources) {
    const pythonTests = (pathContractTests[script] || [])
      .filter((path) => trackedSet.has(path) && runnerForTest(path));
    if (pythonTests.length === 0) {
      return fullPlan(changed, `python script with no parsing contract: ${script}`, { appRouteOnly, trackedSet });
    }
    selectedTests.push(...pythonTests);
  }

  // Every other changed source rides the same basename `git grep` lookup, but
  // additively: unlike python, a JS/TS source is already reachable through the
  // import graph or a feature directory, so an empty hit list here is not an
  // error — it just means nothing reads this file as text.
  // Gate-tooling suites name many paths while proving the planner. Basename
  // selection would run them on those diffs; toolingTestsFor and the memo
  // closure are the selectors that actually own them.
  for (const source of jsSources) {
    const namedTests = (pathContractTests[source] || [])
      .filter((path) => trackedSet.has(path) && runnerForTest(path) && !TOOLING_TESTS.includes(path));
    selectedTests.push(...namedTests);
  }

  for (const testFile of trackedFiles.filter(isTestFile)) {
    if (features.some((feature) => pathMatchesFeature(testFile, feature))) {
      selectedTests.push(testFile);
    }
  }

  // A structural guard check runs only inside its runner (#16996): the Vitest
  // configs exclude its directory, so a selector that names one means the runner.
  const runnable = selectedTests.map((path) => (isGuardCheck(path) ? guardRunnerFor(path) : path))
    .filter((path) => trackedSet.has(path));
  const serverFiles = uniqueSorted(runnable.filter((path) => runnerForTest(path) === 'server'));
  const clientFiles = uniqueSorted(runnable.filter((path) => runnerForTest(path) === 'client'));

  const hasServerSource = jsSources.some(isServerRunnerFile);
  const hasClientSource = jsSources.some(isClientSource);

  const serverSources = jsSources.filter(isServerRunnerFile);
  const clientSources = jsSources.filter(isClientSource);

  // Feature-name matches, basename contracts, direct tests and guards are
  // additive explicit selectors; they never replace import-graph traversal. A
  // nested feature leaf can be consumed by a differently named test in another
  // area, so any behavioral source in a runner takes one 'related' invocation.
  // Only a test-only diff keeps exact-file selection.
  const serverMode = serverSources.length > 0 ? 'related' : 'files';
  const clientMode = clientSources.length > 0 ? 'related' : 'files';

  const server = serverFiles.length > 0
    ? { mode: serverMode, files: serverFiles, sources: serverMode === 'related' ? serverSources : [] }
    : hasServerSource
      ? { mode: 'related', files: [], sources: serverSources }
      : skippedRunner();
  const client = clientFiles.length > 0
    ? { mode: clientMode, files: clientFiles, sources: clientMode === 'related' ? clientSources : [] }
    : hasClientSource
      ? { mode: 'related', files: [], sources: clientSources }
      : skippedRunner();

  const dbTests = new Set(resolveDbTestFiles(trackedFiles));
  const db = selectedTests.some((path) => dbTests.has(path))
    || executable.some((path) => DB_RISK_RULES.some((rule) => rule.test(path)))
    || serverSources.some((path) => dbDependencies === null || dbDependencies.includes(path));

  const windows = hasWindowsRiskFile(changed);
  const windowsMode = windows ? 'files' : 'skip';

  let reason = 'Vitest related-test fallback';
  if (features.length) reason = `targeted features: ${features.join(', ')}`;
  else if (jsSources.length === 0 && pythonSources.length > 0) reason = 'python script parsing contracts';
  else if (jsSources.length === 0 && fixtureTests.length > 0) reason = 'text fixture owners';

  return finishPlan({
    full: false,
    reason,
    changedFiles: changed,
    server,
    client,
    browserFiles: browserSuitesIn([
      ...serverFiles,
      ...BROWSER_SUITES.filter((suite) => trackedSet.has(suite)
        && serverSources.some((source) => browserDependencies[suite] === null
          || browserDependencies[suite]?.includes(source))),
    ]),
    db,
    lint: {
      // Same deleted-path guard as directTests above — ESLint given a
      // nonexistent explicit path exits non-zero instead of skipping it.
      mode: changed.some((path) => isLintSurface(path) && trackedSet.has(path)) ? 'files' : 'skip',
      files: changed.filter((path) => isLintSurface(path) && trackedSet.has(path)),
    },
    build: hasClientSource,
    smoke: hasServerSource,
    windows,
    windowsMode,
    windowsFiles: windows ? windowsContractTests(trackedSet) : [],
    windowsSources: [],
  }, { appRouteOnly, serverReach, clientReach, clientBrowserReach });
}

/** The derived fields every plan carries: per-suite reasons and shard matrices. */
const finishPlan = (plan, options = {}) => {
  const reachSelected = { server: reachCount(options.serverReach), client: reachCount(options.clientReach) };
  // Explicit real-Chromium selectors, plus the ones a related walk reaches.
  const browserSuites = {
    server: 0,
    client: new Set([
      ...plan.client.files.filter(isClientBrowserSuite),
      ...(plan.client.mode === 'related' ? options.clientBrowserReach?.suites ?? [] : []),
    ]).size,
  };
  const linuxShards = (runner) => shardIndexes(
    fansOut(runner, plan[runner], reachSelected[runner], browserSuites[runner]) ? 'full' : plan[runner].mode,
    FULL_SUITE_SHARDS[runner],
  );
  const shards = {
    server: linuxShards('server'),
    client: linuxShards('client'),
    browser: plan.browserFiles.length > 1 ? [1, 2] : [1],
    // The native contract set stays on one runner and never follows the
    // application import graph, even when the primary jobs run full suites.
    windows: [1],
  };
  return {
    ...plan,
    slashdo: needsSlashdoSubmodule(plan),
    suiteReasons: suiteReasonsFor({ ...plan, shards, reachSelected, browserSuites }, options),
    shards,
  };
};

/** Full primary coverage, with native Windows contracts only when relevant. */
function fullPlan(changedFiles, reason, options = {}) {
  const { trackedSet = new Set(), windowsRelevant = true, windowsNote = '' } = options;
  const windows = windowsRelevant || hasWindowsRiskFile(changedFiles);
  return finishPlan({
    full: true,
    reason,
    changedFiles,
    server: { mode: 'full', files: [], sources: [] },
    client: { mode: 'full', files: [], sources: [] },
    browserFiles: browserSuitesIn([...trackedSet]),
    db: true,
    lint: { mode: 'full', files: [] },
    build: true,
    smoke: true,
    windows,
    windowsMode: windows ? 'files' : 'skip',
    windowsFiles: windows ? windowsContractTests(trackedSet) : [],
    windowsSources: [],
    windowsNote,
  }, options);
}

/**
 * Why this run cannot be scoped, or null when it can be.
 *
 * A pull request into `release` is the single gate a release ships behind —
 * release.yml skips its own suite on the strength of it — so it always runs
 * complete, whatever its diff touches.
 */
export function forceFullReasonFor({ forceFull, baseRef }) {
  if (forceFull) return 'full CI requested';
  if (baseRef === 'release') return 'release gate: pull request into release';
  return null;
}

function main() {
  const forceFullReason = forceFullReasonFor({
    forceFull: process.env.CI_FORCE_FULL === 'true',
    baseRef: process.env.CI_BASE_REF,
  });
  const forceFull = Boolean(forceFullReason);
  // scripts/ci-base-sha.js exports this from the checkout: on a pull request
  // HEAD is the merge ref and CI_BASE_SHA is its first parent, so the
  // three-dot diff below resolves against a commit git already has. That is
  // what lets every job clone at depth 2 instead of full history.
  const base = process.env.CI_BASE_SHA;
  if (!forceFull && !base) {
    throw new Error('CI_BASE_SHA is required unless the run is forced full (CI_FORCE_FULL=true or CI_BASE_REF=release).');
  }
  const changedFilesOverride = process.env.CI_CHANGED_FILES === undefined
    ? undefined
    : JSON.parse(process.env.CI_CHANGED_FILES);
  if (changedFilesOverride !== undefined
    && (!Array.isArray(changedFilesOverride) || changedFilesOverride.some((path) => typeof path !== 'string'))) {
    throw new Error('CI_CHANGED_FILES must be a JSON array of repository-relative path strings.');
  }
  const gatedBaseSha = process.env.CI_GATED_BASE_SHA || undefined;
  const {
    changedFiles, trackedFiles, appDiff, pathContractTests, clientDependencies, clientTestDependencies, dbDependencies, browserDependencies,
    dependencyChanges, linuxContainmentInputs, supercolliderLiveInputs, dockerContainmentLiveInputs, serverReach,
    clientReach, clientBrowserReach, gatedChangedFiles, gatedDependencyChanges,
  } = collectPlanInputs({
    baseSha: base,
    forceFull,
    changedFiles: changedFilesOverride,
    // scripts/ci-base-sha.js exports it on a push to main only; a release
    // pull request is forced full by CI_BASE_REF and never gets one.
    gatedBaseSha,
  });
  const plan = buildCiTestPlan(changedFiles, {
    trackedFiles,
    forceFull,
    forceFullReason,
    appRouteOnly: isRouteOnlyAppDiff(appDiff),
    pathContractTests,
    clientDependencies,
    clientTestDependencies,
    dbDependencies,
    browserDependencies,
    dependencyChanges,
    linuxContainmentInputs,
    supercolliderLiveInputs,
    dockerContainmentLiveInputs,
    serverReach,
    clientReach,
    clientBrowserReach,
    gatedChangedFiles,
    gatedDependencyChanges,
  });
  emitGitHubPlan(plan, { gatedBaseSha });
}

if (isDirectlyInvoked(import.meta.url)) main();
