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
  fullTriggersFor, getAlwaysRunTests, hasWindowsRiskFile, isDocumentationOnly, isExecutable, isGateToolingTest, isGeneratedData,
  isLintSurface, isPythonScript, isRouteOnlyAppDiff, isServerRunnerFile, isServerSeed, isSharedClientDependency,
  isTestFile, pathMatchesFeature, runnerForTest, serverSeedTestsFor, splitByRunner,
  structuralTestsFor, toolingTestsFor, touchesJobInputs, uniqueSorted, windowsContractTests, windowsSelectionFor,
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
  NODE_MINIMUM_PATH_RE, SERVER_SEED_OWNERS, SLASHDO_CONTRACT_TEST_FILES, SLASHDO_GITLINK_PATH,
  SUPERCOLLIDER_LIVE_ENTRIES, SUPERCOLLIDER_LIVE_PATH_RE, TOOLING_OWNER_RE, TOOLING_TESTS, WINDOWS_CONTRACT_TESTS,
  WINDOWS_RISK_RULES, PROMPT_STAGE_GUARD, getAlwaysRunTests, getGuardTests, isRouteOnlyAppDiff, isServerSeed, serverSeedTestsFor,
  sourceReferencePattern, splitByRunner, structuralTestsFor,
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
 * Whether a forced-full push to main may run the generated-data plan: the last green run is this push's first parent (`predecessorGreenSha`, from scripts/ci-base-sha.js) and the complete two-tree diff against it lists only generated data. `gatedChangedFiles` is the --no-renames diff, so moving the snapshot to another path lists that path too and keeps the full plan; a missing, empty or unreadable diff does as well.
 */
export function isGeneratedSnapshotPush({
  forceFull = false, gatedBaseSha, predecessorGreenSha, gatedChangedFiles = null,
} = {}) {
  return forceFull && Boolean(gatedBaseSha) && gatedBaseSha === predecessorGreenSha
    && Array.isArray(gatedChangedFiles) && gatedChangedFiles.length > 0
    && gatedChangedFiles.every(isGeneratedData);
}

function snapshotPushPlan({ gatedBaseSha, gatedChangedFiles, trackedFiles = [] }) {
  const plan = buildSuitePlan(gatedChangedFiles, { trackedFiles });
  return { ...plan, reason: `generated snapshot push: only ${plan.changedFiles.join(', ')} changed since the green first parent ${gatedBaseSha.slice(0, 9)}` };
}

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
  const snapshotScoped = isGeneratedSnapshotPush(options);
  const plan = snapshotScoped
    ? snapshotPushPlan(options)
    : buildSuitePlan(changedFiles, options);
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
    snapshotScoped,
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
  dbLiveRestoreInputs = [],
  // Registered suite → reachable files; null retains that suite conservatively.
  browserDependencies = {},
  // Changed dependency manifest → classifyDependencyChange() verdict. A
  // manifest with no verdict escalates Windows (fail closed).
  dependencyChanges = {},
} = {}) {
  const changed = uniqueSorted(changedFiles.filter(Boolean));
  const trackedSet = new Set(trackedFiles);

  const { earlyPlan, relevant } = selectEarlySuitePlan(changed, trackedSet, {
    forceFull, forceFullReason, appRouteOnly, dependencyChanges,
  });
  if (earlyPlan) return earlyPlan;

  const { executable, fixtureTests, unknown, missingFixtureOwners } = classifyNonExecutableChanges(relevant, trackedSet);
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
  const { jsSources, pythonSources, serverSources, clientSources, serverSeeds, unscopedReason } =
    classifySources(executable, trackedSet, clientDependencies);
  if (unscopedReason) return fullPlan(changed, unscopedReason, { appRouteOnly, trackedSet });

  const hasServerSource = serverSources.length > 0;
  const hasClientSource = clientSources.length > 0;
  const hasServerSeed = serverSeeds.length > 0;
  const serverFeatures = uniqueSorted(serverSources.map(featureDirectory).filter(Boolean));
  const clientFeatures = uniqueSorted(clientSources.map(featureDirectory).filter(Boolean));
  const { selectedTests, serverFiles, clientFiles, missingPythonContract } = collectExplicitTests({
    changed, trackedFiles, trackedSet, directTests, fixtureTests, serverSeeds,
    serverFeatures, clientFeatures, pythonSources, jsSources, clientTestDependencies, pathContractTests,
  });
  if (missingPythonContract) {
    return fullPlan(changed, `python script with no parsing contract: ${missingPythonContract}`, { appRouteOnly, trackedSet });
  }

  const server = buildRunnerSelection(serverFiles, serverSources);
  const client = buildRunnerSelection(clientFiles, clientSources);

  const dbTests = new Set(resolveDbTestFiles(trackedFiles));
  const dbLiveRestore = executable.some((path) => DB_RISK_RULES.some((rule) => rule.test(path)))
    || serverSources.some((path) => dbLiveRestoreInputs === null || dbLiveRestoreInputs.includes(path));
  const db = dbLiveRestore || selectedTests.some((path) => dbTests.has(path))
    || serverSources.some((path) => dbDependencies === null || dbDependencies.includes(path));

  const windows = hasWindowsRiskFile(changed);
  const windowsMode = windows ? 'files' : 'skip';

  const reason = selectScopedReason({
    serverFeatures, clientFeatures, serverSources, clientSources, pythonSources, jsSources, fixtureTests, serverSeeds,
  });

  // Deleted paths cannot be passed as exact lint selectors.
  const lintFiles = changed.filter((path) => isLintSurface(path) && trackedSet.has(path));

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
    dbLiveRestore,
    lint: { mode: lintFiles.length > 0 ? 'files' : 'skip', files: lintFiles },
    build: hasClientSource,
    smoke: hasServerSource || hasServerSeed,
    windows,
    windowsMode,
    windowsFiles: windows ? windowsContractTests(trackedSet) : [],
    windowsSources: [],
  }, { appRouteOnly, serverReach, clientReach, clientBrowserReach });
}

function selectEarlySuitePlan(changed, trackedSet, {
  forceFull, forceFullReason, appRouteOnly, dependencyChanges,
}) {
  // Full validation widens the primary jobs; Windows still proves only its
  // supported native boundary, including scheduled and release validation.
  if (forceFull) {
    return { earlyPlan: fullPlan(changed, forceFullReason, { appRouteOnly, trackedSet, windowsRelevant: true }) };
  }

  // App.jsx or the first trigger determines the reason; Windows considers all
  // triggers. An App.jsx edit or an earlier client-only trigger must preserve
  // Windows coverage for a lockfile or server entry-point change in the diff.
  const { fullTriggers, windowsNote } = fullTriggersFor(changed, dependencyChanges);
  const fullTrigger = fullTriggers.at(0);
  const appCompositionChanged = changed.includes('client/src/App.jsx') && !appRouteOnly;
  if (appCompositionChanged || fullTrigger) {
    const reason = appCompositionChanged
      ? 'client composition root changed: client/src/App.jsx'
      : `${fullTrigger.reason}: ${fullTrigger.path}`;
    const windowsRelevant = fullTriggers.some((trigger) => trigger.windowsRelevant);
    return { earlyPlan: fullPlan(changed, reason, { appRouteOnly, trackedSet, windowsRelevant, windowsNote }) };
  }

  const relevant = changed.filter((path) => !isDocumentationOnly(path) && !isGeneratedData(path));
  if (relevant.length > 0) return { relevant };

  const dataOnly = changed.length > 0 && changed.every(isGeneratedData);
  const alwaysRun = dataOnly ? [] : alwaysRunTests(trackedSet);

  const { server: alwaysRunServer, client: alwaysRunClient } = splitByRunner(alwaysRun);
  const reason = dataOnly ? 'generated data-only change'
    : changed.length ? 'documentation-only change' : 'no changed files';
  const plan = {
    full: false,
    reason,
    changedFiles: changed,
    server: buildRunnerSelection(alwaysRunServer, []),
    client: buildRunnerSelection(alwaysRunClient, []),
    browserFiles: browserSuitesIn(alwaysRun),
    db: false,
    dbLiveRestore: false,
    lint: { mode: 'skip', files: [] },
    build: false,
    smoke: false,
    windows: false,
    windowsMode: 'skip',
    windowsFiles: [],
    windowsSources: [],
  };
  return { earlyPlan: finishPlan(plan, { appRouteOnly }) };
}

function classifyNonExecutableChanges(relevant, trackedSet) {
  const executable = [];
  const fixtureTests = [];
  const unknown = [];
  const missingFixtureOwners = [];
  for (const path of relevant) {
    if (isExecutable(path)) {
      executable.push(path);
      continue;
    }
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
  return { executable, fixtureTests, unknown, missingFixtureOwners };
}

function classifySources(executable, trackedSet, clientDependencies) {
  const sourceFiles = executable.filter((path) => !isTestFile(path));
  const unsupportedSource = sourceFiles.find((path) => (
    !isServerRunnerFile(path) && !isServerSeed(path) && !path.startsWith('client/')
  ));
  if (unsupportedSource) {
    return { unscopedReason: `unmapped executable surface: ${unsupportedSource}` };
  }
  const deletedSource = sourceFiles.find((path) => !trackedSet.has(path));
  if (deletedSource) {
    // `vitest related` needs a real source path. A deleted module can still
    // affect importers, so widening is safer than silently dropping its side of
    // the graph.
    return { unscopedReason: `deleted executable source: ${deletedSource}` };
  }
  // Python scripts never enter the import graph or a feature directory: their
  // only selector is the per-script contract list, so they leave the JS-only
  // scoping below.
  const pythonSources = sourceFiles.filter(isPythonScript);
  const jsSources = sourceFiles.filter((path) => !isPythonScript(path));
  if (clientDependencies === null && jsSources.some((path) => path.startsWith('server/lib/'))) {
    return { unscopedReason: 'client dependency discovery unresolved' };
  }
  const clientDependencySet = new Set(clientDependencies || []);
  return {
    jsSources,
    pythonSources,
    serverSources: jsSources.filter(isServerRunnerFile),
    clientSources: jsSources.filter((path) => path.startsWith('client/') || clientDependencySet.has(path)),
    serverSeeds: jsSources.filter(isServerSeed),
  };
}

function collectExplicitTests({
  changed, trackedFiles, trackedSet, directTests, fixtureTests, serverSeeds,
  serverFeatures, clientFeatures, pythonSources, jsSources, clientTestDependencies, pathContractTests,
}) {
  const selectedTests = [
    ...directTests,
    ...fixtureTests,
    ...serverSeeds.flatMap((seed) => serverSeedTestsFor(seed, trackedSet)),
    ...structuralTestsFor(changed, trackedSet),
    ...alwaysRunTests(trackedSet),
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
      return { missingPythonContract: script };
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
      .filter((path) => trackedSet.has(path) && runnerForTest(path) && !isGateToolingTest(path));
    selectedTests.push(...namedTests);
  }

  // Scope feature-directory matching by workspace (#17895): a client-only
  // component edit must not select server/DB/browser suites, and a server-only
  // service edit must not fan out client tests. Cross-workspace edges stay
  // explicit through pathContractTests, clientDependencies and clientTestDependencies.
  for (const testFile of trackedFiles.filter(isTestFile)) {
    const runner = runnerForTest(testFile);
    if ((runner === 'server' || runner === 'db')
      && serverFeatures.some((feature) => pathMatchesFeature(testFile, feature))) {
      selectedTests.push(testFile);
    } else if (runner === 'client'
      && clientFeatures.some((feature) => pathMatchesFeature(testFile, feature))) {
      selectedTests.push(testFile);
    }
  }

  // A structural guard check runs only inside its runner (#16996): the Vitest
  // configs exclude its directory, so a selector that names one means the runner.
  const runnable = selectedTests.map((path) => (isGuardCheck(path) ? guardRunnerFor(path) : path))
    .filter((path) => trackedSet.has(path));
  const serverFiles = uniqueSorted(runnable.filter((path) => runnerForTest(path) === 'server'));
  const clientFiles = uniqueSorted(runnable.filter((path) => runnerForTest(path) === 'client'));

  return { selectedTests, serverFiles, clientFiles };
}

// Explicit selectors are additive to import-graph traversal. Any behavioral
// source needs a related invocation, even without an explicit test match.
function buildRunnerSelection(files, sources) {
  if (sources.length > 0) return { mode: 'related', files, sources };
  if (files.length > 0) return { mode: 'files', files, sources: [] };
  return skippedRunner();
}

function selectScopedReason({
  serverFeatures, clientFeatures, serverSources, clientSources, pythonSources, jsSources, fixtureTests, serverSeeds,
}) {
  const features = uniqueSorted([...serverFeatures, ...clientFeatures]);
  if (features.length) return `targeted features: ${features.join(', ')}`;
  if (jsSources.length === 0 && pythonSources.length > 0) return 'python script parsing contracts';
  if (jsSources.length === 0 && fixtureTests.length > 0) return 'text fixture owners';
  if (serverSources.length === 0 && clientSources.length === 0 && pythonSources.length === 0 && serverSeeds.length > 0) {
    return 'server seed contracts';
  }
  return 'Vitest related-test fallback';
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
  const browserSuitesSelected = plan.browserFiles.length;
  const browserShardCount = browserSuitesSelected >= FULL_SUITE_SHARDS.browser ? FULL_SUITE_SHARDS.browser
    : browserSuitesSelected >= 4 ? 4
      : browserSuitesSelected > 1 ? 2 : 1;
  const shards = {
    server: linuxShards('server'),
    client: linuxShards('client'),
    browser: shardIndexes('full', browserShardCount),
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
    dbLiveRestore: true,
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
  const predecessorGreenSha = process.env.CI_PREDECESSOR_GREEN_SHA || undefined;
  const {
    changedFiles, trackedFiles, appDiff, pathContractTests, clientDependencies, clientTestDependencies,
    dbDependencies, dbLiveRestoreInputs, browserDependencies,
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
    dbLiveRestoreInputs,
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
    gatedBaseSha,
    predecessorGreenSha,
  });
  emitGitHubPlan(plan, { gatedBaseSha });
}

if (isDirectlyInvoked(import.meta.url)) main();
