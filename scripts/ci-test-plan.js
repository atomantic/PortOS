#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { writeStepOutput } from './lib/githubOutput.js';

const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const CLIENT_LINT_RE = /^client\/src\/.*\.(?:js|jsx)$/i;
const EXECUTABLE_RE = /\.(?:cjs|css|html|js|jsx|json|mjs|sql|ts|tsx|ya?ml)$/i;
const MAX_CHANGED_CODE_FILES = 30;
const MAX_TARGETED_TEST_FILES = 120;

// Python sidecar scripts (`scripts/generate_ltx2.py`, …). Vitest's import graph
// cannot reach into them, but their contracts are pinned by suites that read
// the .py source as text, so main() finds the suites naming each changed script
// with `git grep` and the plan runs exactly those — failing closed to the full
// suite for a script nothing names.
const PYTHON_SCRIPT_RE = /^scripts\/[^/]+\.py$/;
/** `git grep -E` pattern for a test that names this one script. */
export const pythonReferencePattern = (scriptPath) => (
  `(^|[^A-Za-z0-9_])${scriptPath.slice(scriptPath.lastIndexOf('/') + 1).replace(/[.]/g, '\\.')}([^A-Za-z0-9_]|$)`
);

// Parallel runners per test job on a full plan. Decided here rather than in
// ci.yml because a job-level `if` cannot read the matrix context, so the
// planner must emit `[1]` for a scoped plan itself. Sizing rationale:
// docs/GITHUB_ACTIONS.md "Full-suite sharding".
export const FULL_SUITE_SHARDS = { server: 2, client: 3, windows: 3 };

/** Matrix values for one runner: every shard on a full run, one otherwise. */
export const shardIndexes = (mode, count) => (
  mode === 'full' ? Array.from({ length: count }, (_, index) => index + 1) : [1]
);

const FULL_TRIGGER_RULES = [
  { re: /^\.github\/workflows\//, reason: 'workflow definition changed' },
  { re: /^(?:package|server\/package|client\/package|autofixer\/package)(?:-lock)?\.json$/, reason: 'dependency manifest changed' },
  { re: /^(?:server|client)\/vitest\.config(?:\.db)?\.js$/, reason: 'test runner configuration changed' },
  { re: /^scripts\/vitestCiPool(?:\.test)?\.js$/, reason: 'test runner pool configuration changed' },
  { re: /^server\/vitest\.setup\.js$/, reason: 'server test setup changed' },
  { re: /^client\/src\/test\/setup\.js$/, reason: 'client test setup changed' },
  // Biome config + its GritQL plugins (the former client/eslint.config.js). The
  // .grit files carry real enforced rules — notably the crypto.randomUUID ban —
  // so a change there is as load-bearing as a change to the config itself.
  { re: /^client\/(?:biome\.jsonc|[^/]+\.grit)$/, reason: 'lint configuration changed' },
  { re: /^client\/vite\.config\.js$/, reason: 'client build configuration changed' },
  { re: /^server\/index\.js$/, reason: 'server composition root changed' },
  { re: /^server\/lib\/(?:schemaVersions|validation)\.js$/, reason: 'shared server contract changed' },
  // The scripts that decide what CI runs, run it, and gate the release on it.
  // A bug in any of them can make a scoped plan silently test nothing, so they
  // prove themselves against the complete suite rather than their own scope.
  { re: /^scripts\/(?:lib\/githubOutput|ci-base-sha|ci-test-plan|run-ci-(?:lint|tests)|verify-ci-status)(?:\.test)?\.js$/, reason: 'CI pipeline script changed' },
];

// Files whose Windows behavior is not faithfully exercised by pinPlatform()
// stubs on Linux: real .cmd spawn, PowerShell BOM, PTY wrap, path.basename
// on backslashes. A PR that does not touch these still gets a full Windows
// run nightly, on the main -> release PR, and on release.
const WINDOWS_RISK_RULES = [
  /\.(?:ps1|cmd|bat)$/i,
  /^scripts\/fix-windows-console(?:\.test)?\.js$/,
  /^scripts\/ps1-bom\.test\.js$/,
  /^server\/lib\/(?:bufferedSpawn|detachedSpawn|childProcess|bashResolver|processEnv|platform|spawnCwd|cliProviderRun|grok)\b/,
  // Path SEMANTICS differ per platform in ways pinPlatform() cannot fake: NTFS
  // and APFS are case-insensitive while ext4 is not, and git reports paths its
  // own way (drive-letter case, 8.3 short names like C:\Users\RUNNER~1). A
  // case-sensitive containment check therefore passed on Linux while reporting a
  // managed worktree as unmanaged on Windows, and the reaper silently skipped it
  // — green everywhere CI looked. These modules decide containment and worktree
  // identity, so they need a real Windows run.
  /^server\/lib\/(?:pathSafety|worktreeOwnership)(?:\.test)?\.js$/,
  // Same class, different mechanism: staticImportGraph keys its module map by
  // string-concatenating entry names with "/" but resolves edge targets with
  // path.relative, which answers with "\\" on Windows. Every edge into a
  // subdirectory module then missed the lookup and vanished — reddening the
  // cluster guards' positive assertions while their acyclicity assertions
  // passed VACUOUSLY. Nothing here was Windows-risk-tagged, so the Windows job
  // skipped the PR that introduced it and main went red for every later PR
  // (#5909). The graph's consumers ride along: their expectations are spelled
  // in "/" and only a real Windows run can tell.
  /^server\/lib\/staticImportGraph(?:\.test)?\.js$/,
  /^server\/services\/(?:agent|twin)ImportCycles\.test\.js$/,
  /^server\/services\/worktree(?:Manager|Reap)\b/,
  /^server\/lib\/shell(?:Cd|Exit|LivenessProbe|ReadinessProbe)(?:\.test)?\.js$/,
  /^server\/lib\/agentGuard\//,
  /^server\/cos-runner\//,
  /^server\/services\/(?:shell|pm2|appBuilder)\b/,
  /^server\/services\/agentTuiSpawning(?:\.test)?\.js$/,
  /^server\/services\/autonomousJobs\/execution\.shellSpawn/,
  // The voice fine-tuning service spawns a real Python trainer and settles the
  // job from its `close`/`error` events, so its assertions are the child-process
  // contract, not platform-independent logic. Nothing here was Windows-tagged,
  // so the shard only saw it on a full-matrix run — which is where it failed,
  // with an interpreter-startup budget mistaken for a state-machine defect
  // (#6268).
  /^server\/services\/voice\/fineTuning(?:\.test)?\.js$/,
  /^server\/routes\/apps\//,
  /^server\/routes\/scaffoldVite\.js$/,
];

// These are the cross-platform contracts that cannot be faithfully simulated
// by pinning process.platform on Linux. For a Windows-risk PR, Vitest also
// adds import-graph-related tests for the diff; this stable baseline catches
// spawn, shell, PowerShell, PTY, and path regressions without rerunning every
// platform-independent server assertion. Full CI still runs the entire suite.
export const WINDOWS_CONTRACT_TESTS = [
  'scripts/ps1-bom.test.js',
  'server/cos-runner/allowedCommands.parity.test.js',
  'server/cos-runner/allowedCommands.test.js',
  'server/cos-runner/index.test.js',
  'server/cos-runner/processStats.test.js',
  'server/cos-runner/runnerState.test.js',
  'server/cos-runner/streamJsonParser.test.js',
  'server/lib/agentGuard/index.test.js',
  'server/lib/bashResolver.test.js',
  'server/lib/bufferedSpawn.test.js',
  'server/lib/childProcess.guards.test.js',
  'server/lib/childProcess.promisify.test.js',
  'server/lib/childProcess.test.js',
  'server/lib/cliProviderRun.test.js',
  'server/lib/detachedSpawn.test.js',
  'server/lib/grok.test.js',
  'server/lib/grokVideoClip.test.js',
  'server/lib/platform.test.js',
  'server/lib/processEnv.spawnOptions.test.js',
  'server/lib/processEnv.test.js',
  'server/lib/spawnCwd.test.js',
  'server/lib/staticImportGraph.test.js',
  'server/lib/shellCd.test.js',
  'server/routes/apps/crud.test.js',
  'server/routes/apps/icons.test.js',
  'server/routes/apps/issues.test.js',
  'server/routes/apps/launch.test.js',
  'server/routes/apps/lifecycle.test.js',
  'server/routes/apps/taskTypes.test.js',
  'server/routes/apps/viteTls.test.js',
  'server/routes/apps/xcode.test.js',
  'server/services/appBuilder.test.js',
  'server/services/autonomousJobs/execution.shellSpawn.test.js',
  'server/services/pm2.launch.test.js',
  'server/services/pm2.parseJlist.test.js',
  'server/services/pm2Standardizer.test.js',
  'server/services/shell.test.js',
  'server/services/shellImageDrop.test.js',
  'server/services/agentTuiSpawning.test.js',
  'server/services/agentImportCycles.test.js',
  'server/services/twinImportCycles.test.js',
  'server/services/voice/fineTuning.test.js',
];

// Contract guards that run on EVERY plan, whatever the impact scope selects.
//
// Two kinds of test land here, and both share one property: no impact scope can
// be trusted to select them, because what they assert is not reachable through
// the import graph the scoped modes walk.
//
//   1. Cross-install contract snapshots. `taskPromptDefaults.test.js` pins the
//      prompt-upgrade contract (AGENTS.md "Distribution model"): edit a
//      preserved historical default and other installs stop recognizing their
//      stored prompt, so they are treated as having customized it and stay on
//      it forever. Nothing else in the suite notices.
//
//   2. Repo-hygiene guards that enumerate the tracked tree with `git grep` /
//      `git ls-files` and assert over files they never import (issue #5055).
//      Impact selection is import-graph-driven by construction, so it has no
//      edge that can reach them: the violating file is some *other* file, in
//      some other directory, that the guard only ever sees as a path string.
//      They sat structurally unselectable — `agent-instructions-files.test.js`
//      went red on `main` and stayed there while every PR reported green — and
//      the always-run list is the only mechanism that can reach them at all.
//      `repo-scan-guards.test.js` keeps this half of the list honest: it
//      re-derives the scanner set from the tree and fails when a new one is
//      added without being registered here or named as structurally selected.
//
// Everything here is deliberately cheap — the whole set runs in ~3s and reads
// only prompt data or `git` output, which is affordable on every PR including
// documentation-only ones, where the alternative is reasoning per-scope about
// what can reach it.
export const ALWAYS_RUN_TESTS = [
  'scripts/agent-instructions-files.test.js',
  // The union-merged catalogs are `.md` to the planner — documentation-only —
  // so a rebase that doubled a row would otherwise never be re-checked.
  'scripts/catalog-merge-union.test.js',
  'scripts/direct-invocation-drift.test.js',
  'scripts/ensure-deps.test.js',
  'scripts/node-version-drift.test.js',
  'scripts/repo-scan-guards.test.js',
  'scripts/tailnet-identity-leak.test.js',
  'server/dependency-overrides.test.js',
  // Whole-tree scanner: any server file can add a `process.env` read, and
  // `.env.example` itself is not a scope the selector routes to a runner.
  'server/envExampleDrift.test.js',
  'server/lib/generatedManifests.test.js',
  'server/lib/qwenAgentParsers.test.js',
  'server/lib/testDataIsolation.guards.test.js',
  'server/lib/testHelper.test.js',
  'server/services/imageGen/renderTargets.guard.test.js',
  'server/services/taskPromptDefaults.test.js',
  'server/timerCallbackConventions.test.js',
];

const DB_RISK_RULES = [
  /^server\/lib\/db(?:\/|\.|$)/i,
  /^server\/scripts\/.*db/i,
  /^server\/services\/(?:.*\/)?[^/]*DB(?:\/|\.|$)/i,
  /^server\/services\/.*\.db\.test\.js$/i,
  /^server\/routes\/catalog\.js$/i,
  /^scripts\/(?:init-db\.sql|migrations\/.*(?:db|postgres|catalog|privacy))/i,
];

const DOCUMENTATION_RULES = [
  /^\.changelog\//,
  /^docs\//,
  /^(?:README|CHANGELOG|CONTRIBUTING|LICENSE)(?:\.|$)/i,
  /\.(?:md|mdx|png|jpe?g|gif|webp|svg|ico)$/i,
];

// The bundled slashdo submodule (see AGENTS.md "Slashdo Commands") ships no
// source into the tree the planner scans — `git diff` reports only the gitlink
// pointer at this path, never the files inside it — so it can't be detected the
// way an ordinary source change is. The two contract suites below exercise the
// real bundled renderer and only mean anything with the submodule checked out,
// so CI initializes it (see ci.yml) exactly when one of them is set to run.
export const SLASHDO_GITLINK_PATH = 'lib/slashdo';
export const SLASHDO_CONTRACT_TEST_FILES = [
  'server/lib/slashdoLoader.test.js',
  'server/lib/slashdoInvocation.test.js',
];
const SLASHDO_CONTRACT_SOURCE_FILES = [
  'server/lib/slashdoLoader.js',
  'server/lib/slashdoInvocation.js',
];

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
 * sufficiently shared dependency changing also tends to select enough tests
 * to exceed MAX_TARGETED_TEST_FILES and force a full plan, which does trigger
 * this; a narrowly-shared one is the remaining gap.
 */
export const needsSlashdoSubmodule = (plan) => Boolean(
  plan.full
  || plan.changedFiles.includes(SLASHDO_GITLINK_PATH)
  || plan.server.files.some((path) => SLASHDO_CONTRACT_TEST_FILES.includes(path))
  || plan.server.sources.some((path) => SLASHDO_CONTRACT_SOURCE_FILES.includes(path))
);

const RUNNER_ROOTS = {
  server: [
    'server/',
    'scripts/',
    'lib/',
    'autofixer/',
  ],
  client: ['client/src/'],
};

const FEATURE_DIRECTORY_RULES = [
  /^server\/(?:integrations|lib|routes|services|sockets)\/([^/]+)\//,
  /^client\/src\/components\/([^/]+)\//,
];

const normalizeFeature = (value) => String(value || '')
  .replace(/\.(?:test|spec)$/i, '')
  .replace(/[^a-z0-9]/gi, '')
  .toLowerCase();

const featureVariants = (feature) => {
  const normalized = normalizeFeature(feature);
  const singular = normalized.endsWith('s') ? normalized.slice(0, -1) : normalized;
  return new Set([normalized, singular].filter(Boolean));
};

const normalizedPathParts = (path) => path
  .split('/')
  .flatMap((part) => {
    const withoutExt = part.replace(/\.[^.]+$/, '').replace(/\.(?:test|spec)$/i, '');
    const camelParts = withoutExt.split(/[-_.]|(?=[A-Z])/).filter(Boolean);
    const normalized = normalizeFeature(withoutExt);
    const withoutPrefix = normalizeFeature(withoutExt.replace(/^(?:api|use)/i, ''));
    return [normalized, withoutPrefix, ...camelParts.map(normalizeFeature)].filter(Boolean);
  });

const pathMatchesFeature = (path, feature) => {
  const variants = featureVariants(feature);
  return normalizedPathParts(path).some((part) => variants.has(part));
};

const isTestFile = (path) => TEST_FILE_RE.test(path);
const isDocumentationOnly = (path) => DOCUMENTATION_RULES.some((rule) => rule.test(path));
const isPythonScript = (path) => PYTHON_SCRIPT_RE.test(path);
const isExecutable = (path) => EXECUTABLE_RE.test(path) || isPythonScript(path);
const isServerRunnerFile = (path) => RUNNER_ROOTS.server.some((root) => path.startsWith(root));
const isClientRunnerFile = (path) => RUNNER_ROOTS.client.some((root) => path.startsWith(root));

const runnerForTest = (path) => {
  if (!isTestFile(path)) return null;
  if (isClientRunnerFile(path)) return 'client';
  if (isServerRunnerFile(path)) return 'server';
  return null;
};

const featureDirectory = (path) => {
  for (const rule of FEATURE_DIRECTORY_RULES) {
    const match = path.match(rule);
    if (match) return normalizeFeature(match[1]);
  }
  return null;
};

const structuralTestsFor = (changedFiles, trackedSet) => {
  const selected = [];
  const add = (path) => {
    if (trackedSet.has(path)) selected.push(path);
  };

  if (changedFiles.some((path) => /^server\/lib\//.test(path))) {
    add('server/lib/index.test.js');
  }
  // The generated-manifest drift tests regenerate from the tree and compare;
  // they import neither the route modules nor the stage call sites they scan,
  // so no import edge selects them. Without this rule a route added on a
  // scoped plan merged with a stale catalog (#5898), and every later full-plan
  // PR inherited the red drift test until someone committed a regeneration.
  if (changedFiles.some((path) => /^server\/.*\.js$/.test(path) || /^server\/lib\/.*\.generated\.json$/.test(path))) {
    add('scripts/generate-api-route-catalog.test.js');
    add('scripts/generate-prompt-stage-call-sites.test.js');
  }
  // The socket guard readdir-scans server/sockets/ rather than importing it, so
  // no import edge reaches it — a handler added there would otherwise only be
  // checked on a full suite.
  if (changedFiles.some((path) => /^server\/sockets\//.test(path))) {
    add('server/sockets/asyncHandlerGuard.test.js');
  }
  if (changedFiles.some((path) => /^client\/src\/lib\//.test(path))) {
    add('client/src/lib/index.test.js');
  }
  if (changedFiles.some((path) => /^client\/src\/hooks\//.test(path))) {
    add('client/src/hooks/index.test.js');
  }
  if (changedFiles.some((path) => /^client\/src\/utils\//.test(path))) {
    add('client/src/utils/index.test.js');
  }
  if (changedFiles.some((path) => /^client\/src\/.*\.jsx$/.test(path))) {
    add('client/src/a11yConventions.test.js');
  }
  // Both `.js` and `.jsx`: the StrictMode mounted-ref bug the first guard covers
  // reached its widest blast radius through a plain-`.js` hook (`useAsyncAction`),
  // so a `.jsx`-only trigger would miss the case that matters most, and the
  // responsive-grid, popover-clamp, pre-wrap/break, safe-storage,
  // heading-truncation, and global-shadow guards read class strings, storage
  // accesses, declarations, and JSX markup out of both extensions.
  // None of these files has a source sibling or imports an app module, so nothing
  // else selects them — without this entry they only ever run on a full suite.
  if (changedFiles.some((path) => /^client\/src\/.*\.jsx?$/.test(path))) {
    add('client/src/globalShadowConventions.test.js');
    add('client/src/headingTruncationConventions.test.js');
    add('client/src/hooks/mountedRefConventions.test.js');
    add('client/src/pollingConventions.test.js');
    add('client/src/popoverClampConventions.test.js');
    add('client/src/preWrapClasses.test.js');
    add('client/src/responsiveGridConventions.test.js');
    add('client/src/storageConventions.test.js');
  }

  return selected;
};

const uniqueSorted = (values) => [...new Set(values)].sort();

// Guarded by trackedSet like every other selector: an untracked path handed to
// Vitest as an exact selector makes the run exit non-zero.
const alwaysRunTests = (trackedSet) => ALWAYS_RUN_TESTS.filter((path) => trackedSet.has(path));

/**
 * Split a set of always-run selectors across the two Vitest runners.
 *
 * The docs-only plan names its files directly instead of going through the
 * runner split the scoped branches use, so it has to do that split itself: an
 * entry added to ALWAYS_RUN_TESTS under client/src would otherwise be handed to
 * the server runner, which does not glob client/, and the guard would report
 * green having run nowhere.
 */
export const splitByRunner = (paths) => ({
  server: paths.filter((path) => runnerForTest(path) === 'server'),
  client: paths.filter((path) => runnerForTest(path) === 'client'),
});
const windowsContractTests = (trackedSet) => WINDOWS_CONTRACT_TESTS.filter((path) => trackedSet.has(path));

const skippedRunner = () => ({ mode: 'skip', files: [], sources: [] });

// Catalog barrels are validated by structural export guards. Feeding one to
// Vitest's import graph selects nearly every consumer even though the barrel
// contains no behavior; PR #5296 changed server/lib/index.js and consequently
// selected 1,244 files / 27,491 tests. Behavioral source files in the same diff
// still drive related-test selection normally.
//
// Also the set `.gitattributes` merges with `union` — scripts/catalog-merge-union.test.js
// pins the two lists to each other.
export const STRUCTURAL_BARRELS = [
  'server/lib/index.js',
  'client/src/lib/index.js',
  'client/src/hooks/index.js',
  'client/src/utils/index.js',
];
const isStructuralBarrel = (path) => STRUCTURAL_BARRELS.includes(path);

/**
 * A route declaration is a safe, client-only subset of the App composition
 * root. Everything else in App.jsx can alter providers, boot hooks, lazy
 * imports, or authentication boundaries and must retain the complete matrix.
 *
 * This intentionally accepts only one-line Route additions/removals. Unknown
 * diff shapes (including comments, formatting, or multiline JSX) are unsafe
 * by default, so a future route style cannot silently narrow CI.
 */
export const isRouteOnlyAppDiff = (diff) => {
  if (typeof diff !== 'string' || !diff.trim()) return false;
  const changedLines = diff.split('\n').filter((line) => /^[+-]/.test(line) && !/^(?:\+\+\+|---)/.test(line));
  return changedLines.length > 0 && changedLines.every((line) => /^[-+]\s*<\/?Route\b.*>(?:\s*)$/.test(line));
};

const suiteReasonsFor = (plan, { appRouteOnly = false } = {}) => ({
  server: plan.server.mode === 'skip'
    ? 'skipped: no server-impacting source changed'
    : plan.full
      ? `full matrix: ${plan.reason}`
      : 'always-run cross-install and repository guards',
  client: plan.client.mode === 'skip'
    ? 'skipped: no client-impacting source changed'
    : appRouteOnly
      ? 'route-only client App.jsx change: related client contracts'
      : plan.full
        ? `full matrix: ${plan.reason}`
        : 'client-impacting source changed',
  db: plan.db ? (plan.full ? `full matrix: ${plan.reason}` : 'database-risk source changed') : 'skipped: no database-risk source changed',
  lint: plan.lint.mode === 'skip' ? 'skipped: no changed client source needs linting' : plan.full ? `full matrix: ${plan.reason}` : 'changed client source',
  build: plan.build ? (plan.full ? `full matrix: ${plan.reason}` : 'client-impacting source changed') : 'skipped: no client-impacting source changed',
  smoke: plan.smoke ? (plan.full ? `full matrix: ${plan.reason}` : 'server-impacting source changed') : 'skipped: no server-impacting source changed',
  windows: plan.windows ? (plan.full ? `full matrix: ${plan.reason}` : 'Windows-sensitive surface changed') : 'skipped: no Windows-sensitive surface changed',
});

/**
 * Build a conservative PR test plan.
 *
 * "files" mode is used only when every executable change belongs to a
 * directory-scoped feature (for example services/sprites + components/sprites).
 * Flat/shared files fall back to Vitest's import-graph-aware "related" mode,
 * while composition roots and test configuration force the complete suite.
 */
export function buildCiTestPlan(changedFiles, {
  trackedFiles = [],
  forceFull = false,
  forceFullReason = 'full CI requested',
  appRouteOnly = false,
  // Changed python script → tracked test files naming it (see PYTHON_SCRIPT_RE).
  pythonContractTests = {},
} = {}) {
  const changed = uniqueSorted(changedFiles.filter(Boolean));
  const trackedSet = new Set(trackedFiles);

  if (forceFull) {
    const plan = {
      full: true,
      reason: forceFullReason,
      changedFiles: changed,
      server: { mode: 'full', files: [], sources: [] },
      client: { mode: 'full', files: [], sources: [] },
      db: true,
      lint: { mode: 'full', files: [] },
      build: true,
      smoke: true,
      windows: true,
      windowsMode: 'full',
      windowsFiles: [],
      windowsSources: [],
    };
    return finishPlan(plan, { appRouteOnly });
  }

  const appCompositionChanged = changed.includes('client/src/App.jsx');
  if (appCompositionChanged && !appRouteOnly) {
    return fullPlan(changed, 'client composition root changed: client/src/App.jsx', { appRouteOnly });
  }

  const fullTrigger = changed
    .flatMap((path) => FULL_TRIGGER_RULES
      .filter(({ re }) => re.test(path))
      .map(({ reason }) => ({ path, reason })))
    .at(0);

  if (fullTrigger) {
    return fullPlan(changed, `${fullTrigger.reason}: ${fullTrigger.path}`, { appRouteOnly });
  }

  const alwaysRun = alwaysRunTests(trackedSet);

  const relevant = changed.filter((path) => !isDocumentationOnly(path));
  if (relevant.length === 0) {
    const { server: alwaysRunServer, client: alwaysRunClient } = splitByRunner(alwaysRun);
    const plan = {
      full: false,
      reason: changed.length ? 'documentation-only change' : 'no changed files',
      changedFiles: changed,
      server: alwaysRunServer.length > 0 ? { mode: 'files', files: alwaysRunServer, sources: [] } : skippedRunner(),
      client: alwaysRunClient.length > 0 ? { mode: 'files', files: alwaysRunClient, sources: [] } : skippedRunner(),
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
  const unknown = relevant.filter((path) => !isExecutable(path));
  if (unknown.length > 0) {
    return fullPlan(changed, `unclassified changed file: ${unknown[0]}`, { appRouteOnly });
  }
  if (executable.length > MAX_CHANGED_CODE_FILES) {
    return fullPlan(changed, `wide change (${executable.length} executable files)`, { appRouteOnly });
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
    return fullPlan(changed, `unmapped executable surface: ${unsupportedSources[0]}`, { appRouteOnly });
  }
  const deletedSources = sourceFiles.filter((path) => !trackedSet.has(path));
  if (deletedSources.length > 0) {
    // `vitest related` needs a real source path. A deleted module can still
    // affect importers, so widening is safer than silently dropping its side of
    // the graph.
    return fullPlan(changed, `deleted executable source: ${deletedSources[0]}`, { appRouteOnly });
  }
  // Python scripts never enter the import graph or a feature directory: their
  // only selector is the per-script contract list, so they leave the JS-only
  // scoping below.
  const pythonSources = sourceFiles.filter(isPythonScript);
  const jsSources = sourceFiles.filter((path) => !isPythonScript(path));
  const features = uniqueSorted(jsSources.map(featureDirectory).filter(Boolean));
  const unscopedSources = jsSources.filter((path) => !featureDirectory(path));
  const selectedTests = [
    ...directTests,
    ...structuralTestsFor(changed, trackedSet),
    ...alwaysRun,
  ];

  for (const script of pythonSources) {
    const pythonTests = (pythonContractTests[script] || [])
      .filter((path) => trackedSet.has(path) && runnerForTest(path));
    if (pythonTests.length === 0) {
      return fullPlan(changed, `python script with no parsing contract: ${script}`, { appRouteOnly });
    }
    selectedTests.push(...pythonTests);
  }

  for (const testFile of trackedFiles.filter(isTestFile)) {
    if (features.some((feature) => pathMatchesFeature(testFile, feature))) {
      selectedTests.push(testFile);
    }
  }

  const serverFiles = uniqueSorted(selectedTests.filter((path) => runnerForTest(path) === 'server'));
  const clientFiles = uniqueSorted(selectedTests.filter((path) => runnerForTest(path) === 'client'));

  if (serverFiles.length > MAX_TARGETED_TEST_FILES || clientFiles.length > MAX_TARGETED_TEST_FILES) {
    return fullPlan(changed, 'targeted test set exceeded safety cap', { appRouteOnly });
  }

  const hasServerSource = jsSources.some(isServerRunnerFile);
  const hasClientSource = jsSources.some((path) => path.startsWith('client/'));
  const hasUnscopedServer = unscopedSources.some(isServerRunnerFile);
  const hasUnscopedClient = unscopedSources.some((path) => path.startsWith('client/'));

  const serverSources = jsSources
    .filter(isServerRunnerFile)
    .filter((path) => !isStructuralBarrel(path));
  const clientSources = jsSources
    .filter((path) => path.startsWith('client/'))
    .filter((path) => !isStructuralBarrel(path));

  // Feature-directory plans already enumerate their boundary tests. Flat and
  // shared modules use Vitest's import graph, except a barrel-only edit whose
  // contract is completely covered by the structural export guard.
  const serverMode = hasUnscopedServer && serverSources.length > 0 ? 'related' : 'files';
  const clientMode = hasUnscopedClient && clientSources.length > 0 ? 'related' : 'files';

  const server = serverFiles.length > 0
    ? { mode: serverMode, files: serverFiles, sources: serverMode === 'related' ? serverSources : [] }
    : hasServerSource
      ? { mode: serverSources.length > 0 ? 'related' : 'files', files: [], sources: serverSources }
      : skippedRunner();
  const client = clientFiles.length > 0
    ? { mode: clientMode, files: clientFiles, sources: clientMode === 'related' ? clientSources : [] }
    : hasClientSource
      ? { mode: clientSources.length > 0 ? 'related' : 'files', files: [], sources: clientSources }
      : skippedRunner();

  const windows = executable.some((path) => WINDOWS_RISK_RULES.some((rule) => rule.test(path)));
  const windowsMode = windows
    ? (serverSources.length > 0 ? 'related' : 'files')
    : 'skip';

  let reason = 'Vitest related-test fallback';
  if (features.length) reason = `targeted features: ${features.join(', ')}`;
  else if (jsSources.length === 0 && pythonSources.length > 0) reason = 'python script parsing contracts';

  return finishPlan({
    full: false,
    reason,
    changedFiles: changed,
    server,
    client,
    db: executable.some((path) => DB_RISK_RULES.some((rule) => rule.test(path))),
    lint: {
      // Same deleted-path guard as directTests above — ESLint given a
      // nonexistent explicit path exits non-zero instead of skipping it.
      mode: changed.some((path) => CLIENT_LINT_RE.test(path) && trackedSet.has(path)) ? 'files' : 'skip',
      files: changed.filter((path) => CLIENT_LINT_RE.test(path) && trackedSet.has(path)),
    },
    build: hasClientSource,
    smoke: hasServerSource,
    windows,
    windowsMode,
    windowsFiles: windows ? windowsContractTests(trackedSet) : [],
    windowsSources: windowsMode === 'related' ? serverSources : [],
  }, { appRouteOnly });
}

/** The derived fields every plan carries: per-suite reasons and shard matrices. */
const finishPlan = (plan, options) => ({
  ...plan,
  slashdo: needsSlashdoSubmodule(plan),
  suiteReasons: suiteReasonsFor(plan, options),
  shards: {
    server: shardIndexes(plan.server.mode, FULL_SUITE_SHARDS.server),
    client: shardIndexes(plan.client.mode, FULL_SUITE_SHARDS.client),
    windows: shardIndexes(plan.windowsMode, FULL_SUITE_SHARDS.windows),
  },
});

function fullPlan(changedFiles, reason, options) {
  return finishPlan({
    full: true,
    reason,
    changedFiles,
    server: { mode: 'full', files: [], sources: [] },
    client: { mode: 'full', files: [], sources: [] },
    db: true,
    lint: { mode: 'full', files: [] },
    build: true,
    smoke: true,
    windows: true,
    windowsMode: 'full',
    windowsFiles: [],
    windowsSources: [],
  }, options);
}

const gitLines = (args) => execFileSync('git', args, { encoding: 'utf8' })
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

/** Tracked test files whose text matches `pattern`; `git grep` exit 1 is "none". */
const gitGrepFiles = (pattern, pathspecs) => {
  try {
    return gitLines(['grep', '-l', '-E', pattern, '--', ...pathspecs]);
  } catch (err) {
    if (err.status === 1) return [];
    throw err;
  }
};

export function emitGitHubPlan(plan) {
  const outputs = {
    full: plan.full,
    reason: plan.reason.replace(/[`<>\r\n]+/g, ' '),
    server_mode: plan.server.mode,
    server_files: JSON.stringify(plan.server.files),
    server_sources: JSON.stringify(plan.server.sources),
    client_mode: plan.client.mode,
    client_files: JSON.stringify(plan.client.files),
    client_sources: JSON.stringify(plan.client.sources),
    db: plan.db,
    lint_mode: plan.lint.mode,
    lint_files: JSON.stringify(plan.lint.files),
    build: plan.build,
    smoke: plan.smoke,
    slashdo: plan.slashdo,
    windows: plan.windows,
    windows_mode: plan.windowsMode,
    windows_files: JSON.stringify(plan.windowsFiles),
    windows_sources: JSON.stringify(plan.windowsSources),
    server_shards: JSON.stringify(plan.shards.server),
    client_shards: JSON.stringify(plan.shards.client),
    windows_shards: JSON.stringify(plan.shards.windows),
    suite_reasons: JSON.stringify(plan.suiteReasons),
  };

  Object.entries(outputs).forEach(([name, value]) => writeStepOutput(name, value));
  console.log(JSON.stringify({ ...outputs, changed_files: plan.changedFiles }, null, 2));
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
  const changedFiles = forceFull
    ? []
    : gitLines(['diff', '--name-only', '--diff-filter=ACMRD', `${base}...HEAD`]);
  const trackedFiles = gitLines(['ls-files']);
  const appDiff = forceFull || !changedFiles.includes('client/src/App.jsx')
    ? null
    : execFileSync('git', ['diff', '--unified=0', `${base}...HEAD`, '--', 'client/src/App.jsx'], { encoding: 'utf8' });
  const pythonContractTests = Object.fromEntries(changedFiles.filter(isPythonScript).map((script) => [
    script,
    gitGrepFiles(pythonReferencePattern(script), ['*.test.js', '*.test.jsx']),
  ]));
  emitGitHubPlan(buildCiTestPlan(changedFiles, {
    trackedFiles,
    forceFull,
    forceFullReason,
    appRouteOnly: isRouteOnlyAppDiff(appDiff),
    pythonContractTests,
  }));
}

if (isDirectlyInvoked(import.meta.url)) main();
