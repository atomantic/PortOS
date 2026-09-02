#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { writeStepOutput } from './lib/githubOutput.js';

const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const CLIENT_LINT_RE = /^client\/src\/.*\.(?:js|jsx)$/i;
const EXECUTABLE_RE = /\.(?:cjs|css|html|js|jsx|json|mjs|sql|ts|tsx|ya?ml)$/i;
const MAX_CHANGED_CODE_FILES = 30;
const MAX_TARGETED_TEST_FILES = 120;

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
  /^server\/lib\/shell(?:Cd|Exit|LivenessProbe|ReadinessProbe)(?:\.test)?\.js$/,
  /^server\/lib\/agentGuard\//,
  /^server\/cos-runner\//,
  /^server\/services\/(?:shell|pm2|appBuilder)\b/,
  /^server\/services\/agentTuiSpawning(?:\.test)?\.js$/,
  /^server\/services\/autonomousJobs\/execution\.shellSpawn/,
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
  'scripts/direct-invocation-drift.test.js',
  'scripts/node-version-drift.test.js',
  'scripts/repo-scan-guards.test.js',
  'scripts/tailnet-identity-leak.test.js',
  'server/dependency-overrides.test.js',
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
const isExecutable = (path) => EXECUTABLE_RE.test(path);
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
  // responsive-grid guard reads class strings out of both extensions. Neither
  // file has a source sibling or imports an app module, so nothing else selects
  // them — without this entry they only ever run on a full suite.
  if (changedFiles.some((path) => /^client\/src\/.*\.jsx?$/.test(path))) {
    add('client/src/hooks/mountedRefConventions.test.js');
    add('client/src/responsiveGridConventions.test.js');
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
const isStructuralBarrel = (path) => [
  'server/lib/index.js',
  'client/src/lib/index.js',
  'client/src/hooks/index.js',
  'client/src/utils/index.js',
].includes(path);

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
    return { ...plan, suiteReasons: suiteReasonsFor(plan, { appRouteOnly }) };
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
    return { ...plan, suiteReasons: suiteReasonsFor(plan, { appRouteOnly }) };
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
  const features = uniqueSorted(sourceFiles.map(featureDirectory).filter(Boolean));
  const unscopedSources = sourceFiles.filter((path) => !featureDirectory(path));
  const selectedTests = [
    ...directTests,
    ...structuralTestsFor(changed, trackedSet),
    ...alwaysRun,
  ];

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

  const hasServerSource = sourceFiles.some(isServerRunnerFile);
  const hasClientSource = sourceFiles.some((path) => path.startsWith('client/'));
  const hasUnscopedServer = unscopedSources.some(isServerRunnerFile);
  const hasUnscopedClient = unscopedSources.some((path) => path.startsWith('client/'));

  const serverSources = sourceFiles
    .filter(isServerRunnerFile)
    .filter((path) => !isStructuralBarrel(path));
  const clientSources = sourceFiles
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

  const plan = {
    full: false,
    reason: features.length
      ? `targeted features: ${features.join(', ')}`
      : 'Vitest related-test fallback',
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
  };
  return { ...plan, suiteReasons: suiteReasonsFor(plan, { appRouteOnly }) };
}

function fullPlan(changedFiles, reason, options) {
  const plan = {
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
  };
  return { ...plan, suiteReasons: suiteReasonsFor(plan, options) };
}

const gitLines = (args) => execFileSync('git', args, { encoding: 'utf8' })
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

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
    windows: plan.windows,
    windows_mode: plan.windowsMode,
    windows_files: JSON.stringify(plan.windowsFiles),
    windows_sources: JSON.stringify(plan.windowsSources),
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
  emitGitHubPlan(buildCiTestPlan(changedFiles, {
    trackedFiles,
    forceFull,
    forceFullReason,
    appRouteOnly: isRouteOnlyAppDiff(appDiff),
  }));
}

if (isDirectlyInvoked(import.meta.url)) main();
