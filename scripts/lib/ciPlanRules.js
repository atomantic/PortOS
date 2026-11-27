/**
 * Path rules of the CI impact planner: which changed path forces a full plan, selects Windows, a runner, a fixture owner or a guard.
 *
 * Pure data and predicates over repo-relative paths, split out of
 * `scripts/ci-test-plan.js` (#16998), which re-exports the public names.
 * Builtins only: the planner runs before `npm ci`.
 */

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { OPERATOR_SCRIPT_CALLER_FILES } from '../../server/lib/apiRouteCallerAllowlist.js';
import { CATALOG_DIRS } from './moduleCatalog.js';
import { SERVER_LINT_RE } from './serverLintSurface.js';
import { resolveDbTestFiles } from './dbTestFiles.js';
import { guardTestFiles, isGuardTest } from './guardScanners.js';
import { BROWSER_SUITES } from './browserSuites.js';
import { DEPENDENCY_MANIFEST_RE, describeDependencyVerdict, escalated, windowsInstalls } from './ciPlanDependencies.js';
import { escapeRegExp } from '../../server/lib/textUtils.js';

const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
// `git grep` pathspecs matching every extension TEST_FILE_RE recognizes. A
// hardcoded `*.test.js`/`.jsx` pair would silently stop finding a `.test.ts(x)`
// or `.spec.*` contract test added later, reopening the exact under-selection
// bug the basename lookup in ciPlanInputs.js exists to close — the later trackedSet +
// runnerForTest(isTestFile) filter already narrows a broad hit back down, so
// over-matching here costs nothing.
export const TEST_FILE_GLOBS = ['*.test.*', '*.spec.*'];
export const PROMPT_STAGE_GUARD = 'scripts/generate-prompt-stage-call-sites.test.js';
// The server rule set lints server/ whole, plus scripts/, lib/ (not the slashdo
// submodule) and autofixer/ (fast, ~1s). SERVER_LINT_RE lives in
// scripts/lib/serverLintSurface.js so the planner and the runner cannot drift,
// and so a pregate fixture can stub the lint runner without unloading the planner.
const CLIENT_LINT_RE = /^client\/src\/.*\.(?:js|jsx)$/i;
export const isLintSurface = (path) => CLIENT_LINT_RE.test(path) || SERVER_LINT_RE.test(path);
const EXECUTABLE_RE = /\.(?:cjs|css|html|js|jsx|json|mjs|sql|ts|tsx|ya?ml)$/i;
export const MAX_CHANGED_CODE_FILES = 30;

// Python sidecar scripts (`scripts/ml/generate_ltx2.py`, …). Vitest's import graph
// cannot reach into them, but their contracts are pinned by suites that read
// the .py source as text, so collectPlanInputs() finds the suites naming each changed script
// with `git grep` and the plan runs exactly those — failing closed to the full
// suite for a script nothing names.
const PYTHON_SCRIPT_RE = /^scripts\/(?:ml\/)?[^/]+\.py$/;

// Contract tests read a subject file with `readFileSync` (a cross-tree mirror
// parity test, `server/lib/navManifest.js` reading 20+ client files by path)
// instead of importing it, so no `vitest related` import edge reaches them
// either. `collectPlanInputs()` finds the tests naming a changed file's basename,
// the same mechanism the python case above uses, and generalizes
// it to every changed source — not only `.py` (issue #6363).
/** Matches a test that names this source file by its literal basename. */
export const sourceReferencePattern = (sourcePath) => (
  `(^|[^A-Za-z0-9_])${escapeRegExp(sourcePath.slice(sourcePath.lastIndexOf('/') + 1))}([^A-Za-z0-9_]|$)`
);

// A full primary plan selects the Windows native job only when its execution
// inputs are relevant. Dependency verdicts distinguish the workspace Windows
// actually installs; primary-only configuration/schema changes do not need it.
const FULL_TRIGGER_RULES = [
  // ci.yml defines the windows-server job itself. The other workflows (release,
  // acceptance) never run on windows-latest.
  { re: /^\.github\/workflows\/ci\.yml$/, reason: 'workflow definition changed', windowsRelevant: true },
  // ci.yml's composite actions (setup-server, diff-base, test-memo, …) are part
  // of its job definitions, windows-server included.
  { re: /^\.github\/actions\//, reason: 'workflow definition changed', windowsRelevant: true },
  { re: /^\.github\/workflows\//, reason: 'workflow definition changed', windowsRelevant: false },
  { re: DEPENDENCY_MANIFEST_RE, reason: 'dependency manifest changed', windowsRelevant: 'dependencies' },
  // Every workspace's .npmrc pins ignore-scripts and install behavior; npm reads
  // it on the Windows install too.
  { re: /(?:^|\/)\.npmrc$/, reason: 'npm configuration changed', windowsRelevant: true },
  { re: /^server\/vitest\.config(?:\.db)?\.js$/, reason: 'test runner configuration changed', windowsRelevant: true },
  // windows-server uses the server runner; client configuration still gets the
  // complete primary plan; native inputs in the same diff still select Windows.
  { re: /^client\/vitest\.config\.js$/, reason: 'client test runner configuration changed', windowsRelevant: false },
  { re: /^scripts\/vitestCiPool(?:\.test)?\.js$/, reason: 'test runner pool configuration changed', windowsRelevant: true },
  { re: /^server\/vitest\.setup\.js$/, reason: 'server test setup changed', windowsRelevant: true },
  // Client-only: windows-server never loads the client setup file.
  { re: /^client\/src\/test\/setup\.js$/, reason: 'client test setup changed', windowsRelevant: false },
  // Biome configs and their enforced GritQL plugins.
  // The .grit files carry real enforced rules — notably the crypto.randomUUID ban —
  // so a change there is as load-bearing as a change to the config itself. The
  // server and repo-root rules also have fixture coverage in the server suite.
  // The Windows job runs no lint.
  { re: /^(?:(?:client\/|server\/)?biome\.jsonc|client\/[^/]+\.grit|(?:server\/)?lint-[^/]+\.grit)$/, reason: 'lint configuration changed', windowsRelevant: false },
  // Client-only: the Windows job builds no client bundle.
  { re: /^client\/vite\.config\.js$/, reason: 'client build configuration changed', windowsRelevant: false },
  { re: /^server\/index\.js$/, reason: 'server composition root changed', windowsRelevant: true },
  // Widely imported, but pure cross-platform schema logic: no spawn, path or
  // filesystem semantics that pinPlatform() stubs cannot cover on Linux. Only
  // the composer (category registry and gate helpers) is a full trigger; the
  // per-domain version slices under server/lib/schemaVersions/ take the
  // related plan so a routine bump does not run the full matrix (#17460).
  { re: /^server\/lib\/schemaVersions\.js$/, reason: 'shared server contract changed', windowsRelevant: false },
  // Measured hotspot (#9999): a two-file worktreeManager change expanded through
  // import consumers to 57 selectors and a ~941-file local run, yet counted as
  // a "scoped" plan because MAX_TARGETED_TEST_FILES only sees explicit selectors.
  // Own the cost honestly: a full plan, sharded in CI. It also owns cross-platform
  // worktree lifecycle, so Windows escalates (matches WINDOWS_RISK_RULES).
  { re: /^server\/services\/worktree(Manager\.js$|\/)/, reason: 'worktree manager source changed (broad import fanout)', windowsRelevant: true },
  // Measured log socket hotspot (#10030): changing this source fans out through
  // nearly the full server suite, so make the cost explicit in CI. The socket
  // starts and supervises a real child process; retain the native Windows job.
  { re: /^server\/sockets\/logs\.js$/, reason: 'log socket source changed (broad import fanout)', windowsRelevant: true },
  // The scripts that decide what CI runs, run it, and gate the release on it.
  // A bug in any of them can make a scoped plan silently test nothing, so they
  // prove themselves against the complete suite rather than their own scope.
  // The Windows runner executes the diff-base and npm launch code and consumes
  // the planner outputs. Lint, hidden-content scanning and status verification
  // run on Linux only.
  { re: /^scripts\/(?:lib\/(?:githubOutput|ciNpmRunner|ciTestDiagnosticsFormat)|ci-base-sha|run-ci-tests)(?:\.test)?\.js$/, reason: 'CI pipeline script changed', windowsRelevant: true },
  // The planner, the modules it is split into and the module graph it walks (#16998).
  { re: /^scripts\/(?:ci-test-plan|lib\/(?:ciPlan[A-Za-z]+|moduleGraph))(?:\.test)?\.js$/, reason: 'CI pipeline script changed', windowsRelevant: true },
  { re: /^scripts\/(?:run-ci-lint|run-actionlint|scan-diff-hidden-content|verify-ci-status)(?:\.test)?\.js$/, reason: 'CI pipeline script changed', windowsRelevant: false },
  { re: /^scripts\/(?:lib\/actionlint|fixtures\/actionlint\/.+)(?:\.test)?\.(?:js|yml)$/, reason: 'CI pipeline script changed', windowsRelevant: false },
];

// Native Windows coverage is intentionally limited to CLI/TUI execution,
// cmd/PowerShell behavior, process settlement and filesystem/path contracts.
// Platform-neutral application suites stay on the primary server/client jobs.
export const WINDOWS_RISK_RULES = [
  /\.(?:ps1|cmd|bat)$/i,
  /^scripts\/fix-windows-console(?:\.test)?\.js$/,
  /^(?:update\.sh|scripts\/(?:deferred-update\.mjs|update\.mjs|update-(?:headless-recovery|submodules)\.test\.js))$/,
  /^server\/lib\/(?:bufferedSpawn|detachedSpawn|childProcess|bashResolver|processEnv|platform|spawnCwd|cliProviderRun|grok|execGit|windowsGitProcess|windowsGitSupervisor|windowsAgentProcess|windowsAgentSupervisor|nativeTrash|pathSafety|worktreeOwnership|staticImportGraph)\b/,
  /^server\/lib\/aiToolkit\/internal\/windowsSafeSpawn\.js$/,
  /^server\/lib\/shell(?:Cd|Exit|LivenessProbe|ReadinessProbe)(?:\.test)?\.js$/,
  /^server\/lib\/agentGuard\//,
  /^server\/lib\/gitRepositoryIdentity(?:\.test)?\.js$/,
  /^server\/cos-runner\//,
  /^server\/services\/shell\b/,
  /^server\/services\/agentTuiSpawning(?:\/|(?:\.test)?\.js$)/,
  /^server\/services\/tuiPromptRunner(?:\.test)?\.js$/,
  /^server\/services\/(?:releaseCandidateEvidence|releasePreflight)(?:\.test)?\.js$/,
];

// Each entry protects the supported native boundary. No import-graph expansion:
// one shared process helper must not pull all its application consumers onto
// Windows. Full, scheduled and release plans retain this same native set.
export const WINDOWS_CONTRACT_TESTS = [
  'scripts/ci-test-diagnostics.test.js',
  'scripts/update-headless-recovery.test.js',
  'scripts/update-submodules.test.js',
  // Launch, prompt transport, executable discovery and environment/cwd safety.
  'server/cos-runner/allowedCommands.test.js',
  'server/lib/agentGuard/index.test.js',
  'server/lib/bashResolver.test.js',
  'server/lib/bufferedSpawn.test.js',
  'server/lib/cliProviderRun.test.js',
  'server/lib/detachedSpawn.test.js',
  'server/lib/processEnv.spawnOptions.test.js',
  'server/lib/processEnv.test.js',
  'server/lib/spawnCwd.test.js',
  // Shell dialects and the two TUI paths, including real ConPTY submission.
  'server/lib/shellCd.test.js',
  'server/lib/shellExit.test.js',
  'server/lib/shellLivenessProbe.test.js',
  'server/lib/shellReadinessProbe.test.js',
  'server/services/shell.windows.test.js',
  'server/services/tuiPromptRunner.test.js',
  // Real native ownership/cancellation and safe filesystem semantics.
  'server/lib/execGit.test.js',
  'server/lib/windowsAgentProcess.test.js',
  'server/services/releasePreflight.test.js',
  'server/lib/windowsGitProcess.test.js',
  'server/lib/windowsGitProcess.protocol.test.js',
  'server/lib/gitRepositoryIdentity.test.js',
  'server/lib/worktreeOwnership.test.js',
  'server/lib/staticImportGraph.test.js',
  'server/lib/nativeTrash.test.js',
  'server/lib/nativeTrash.smoke.test.js',
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
//      They sat structurally unselectable — the agent-instructions guard
//      went red on `main` and stayed there while every PR reported green — and
//      the always-run list is the only mechanism that can reach them at all.
//      This half is selected by filename (#16553): every tracked
//      `*.guard.test.js` (getGuardTests). Nearly all of them are checks in a
//      `server/test/guards/<subject>/` directory that the subject's runner
//      (`<subject>.guard.test.js` beside it) runs in one worker over one shared
//      corpus (#16996), so a new scanner registers by being placed there; the
//      doc-parity guards, which compare a .md against source they read rather
//      than import, are checks there too.
//      server/test/guards/repo/repo-scan-guards.test.js fails a scanner that is
//      neither suffixed nor in a guard directory.
//
// Everything here is deliberately cheap: it reads only prompt data or `git`
// output, which is affordable on every PR including documentation-only ones,
// where the alternative is reasoning per-scope about what can reach it. The
// separate guard files once measured ~23s of a 27s focused pregate (#16086),
// mostly per-file worker startup and the same tree listed and read dozens of
// times; one runner per subject over one corpus is what keeps the set cheap. A
// behavioural test that no scan needs does not belong here: a suite that mixes
// the two keeps its scan in a check module.
//
// The explicit list holds only what the suffix does not: guards whose file is
// not named as one.
export const EXPLICIT_ALWAYS_RUN_TESTS = [
  // Route policy scans depend on independently changed files (#13224).
  'server/lib/apiRouteParity.test.js',
  'server/lib/hostControlRoutes.test.js',
  // Base-relative server import-growth guard (#7993): a new eager edge in a widely
  // reached module multiplies across suites this file does not import. Reads CI_BASE_SHA
  // and fails closed when that commit cannot be read; pregate forwards the plan's base.
  'server/lib/importScoping.test.js',
  // Prompt-upgrade contract: JSON edits have no import edge here.
  'server/services/taskPromptDefaults.test.js',
  // Size ratchet over rendered claim prompts (#16409): growth comes from edits to any prompt
  // fragment the claim composers import, which no scope reliably selects it for.
  'server/services/taskPromptDefaults/claimPromptSize.test.js',
];

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Tracked tree guards, selected by the `*.guard.test.js` suffix (#16553). One
 * `git ls-files`, no test source read. Lazy and memoized: listing spawns git,
 * and pregate must not start a subprocess before it has validated its arguments.
 */
let guardTests;
export const getGuardTests = () => (guardTests ??= guardTestFiles(REPO_ROOT));

/** Client guards are reached by structuralTestsFor on any client/src js(x) change. */
const isClientGuard = (path) => path.startsWith('client/src/');

let alwaysRun;
const alwaysRunFrom = (guards) => [...new Set([
  ...EXPLICIT_ALWAYS_RUN_TESTS,
  ...guards.filter((path) => !isClientGuard(path)),
])].sort();

export const getAlwaysRunTests = (trackedFiles) => trackedFiles
  ? alwaysRunFrom(trackedFiles.filter(isGuardTest))
  : (alwaysRun ??= alwaysRunFrom(getGuardTests()));

// The gate-tooling suites: tests of the CI/pregate machinery itself. Each spawns git
// or carries `test-memo: never`, so none can earn a narrowing record, and `related`
// selection used to fail closed into every plan whatever the diff touched (#16798).
// The planner now selects them when a diff touches a TOOLING_OWNER_RE path, and
// `planTestMemo` keeps one from the related walk only when a changed source reaches
// its closure or inputs. Full plans and every push to main still run all of them.
// Before adding a file, audit its real-tree reads: each must sit under
// TOOLING_OWNER_RE or inside the test's module closure. A test that asserts over
// other tracked files stays out (runCiTestsClientFixture.test.js is that half of
// run-ci-tests.test.js, split off so the rest can be listed).
export const TOOLING_TESTS = [
  'scripts/ci-test-plan.test.js',
  'scripts/lib/testMemo.test.js',
  'scripts/lib/testMemoRunner.test.js',
  'scripts/pregate.test.js',
  'scripts/run-ci-tests.test.js',
  'scripts/vitestCiPool.test.js',
  'scripts/vitestSiblingSweep.test.js',
  'scripts/vitestTempRoot.test.js',
  'scripts/workspaceCaches.test.js',
];

// Split planner suites contain synthetic path literals like the integration suite.
// Their real dependencies select them; unrelated tooling diffs need no explicit selector.
const PLANNER_MODULE_TEST_RE = /^scripts\/lib\/ciPlan(?:Rules|Inputs|Dependencies|Output)\.test\.js$/;

export const isGateToolingTest = (path) => TOOLING_TESTS.includes(path) || PLANNER_MODULE_TEST_RE.test(path);

// Paths whose edit can break a tooling test with no import edge reaching it: the
// scripts and workflows themselves, every dependency manifest, the Vitest configs,
// and the Vitest environment modules the real configs load in the fixtures' child runs.
export const TOOLING_OWNER_RE = /^(?:scripts\/|\.github\/|(?:[^/]+\/)*(?:package(?:-lock)?\.json|\.npmrc)$|(?:server|client)\/vitest[^/]*\.js$|server\/test\/(?:admissionSetup|dbRunExclusivity|mediaRegistryEnvironment|runTempRoot)\.js$)/;

export const toolingTestsFor = (changedFiles, trackedSet) => (
  changedFiles.some((path) => TOOLING_OWNER_RE.test(path)) ? TOOLING_TESTS.filter((path) => trackedSet.has(path)) : []);

export const DB_RISK_RULES = [
  /^scripts\/rehearsal-scratch-db(?:[./]|$)/i,
  /^scripts\/generate-init-db-sql(?:[./]|$)/i,
  /^scripts\/lib\/migrationFiles(?:[./]|$)/i,
  /^scripts\/lib\/dbImage(?:[./]|$)/i,
  /^docker-compose\.yml$/i,
  /^server\/lib\/databaseMaintenanceSchema(?:[./]|$)/i,
  /^server\/services\/backupDatabaseDump(?:[./]|$)/i,
  /^server\/lib\/db(?:\/|\.|$)/i,
  /^server\/scripts\/.*db/i,
  /^server\/services\/(?:.*\/)?[^/]*DB(?:\/|\.|$)/i,
  /^server\/services\/.*\.db\.test\.js$/i,
  /^server\/routes\/catalog(?:Ingest|Ingredients|Media|Scenes|Stories|Types)?\.js$/i,
  /^scripts\/(?:init-db\.sql|migrations\/.*(?:db|postgres|catalog|privacy))/i,
];

const DOCUMENTATION_RULES = [
  /^\.changelog\//,
  /^docs\//,
  /^(?:README|CHANGELOG|CONTRIBUTING|LICENSE)(?:\.|$)/i,
  /\.(?:md|mdx|png|jpe?g|gif|webp|svg|ico)$/i,
];

// Generated data no code or test reads from this checkout: the repo-root
// `.quality.json` is the numeric snapshot `appQualitySnapshotFile.js` lands
// through its own immediately-merged PR. A PR touching only these skips every
// runner, the always-run guards included — there is nothing for them to check.
// The hidden-content diff scan in the impact job still reads it.
const GENERATED_DATA_RULES = [
  /^\.quality\.json$/,
];

// Text snapshots are executable test inputs, but their extension is deliberately
// outside EXECUTABLE_RE. Keep this mapping explicit rather than treating every
// `.txt` file as a test fixture: an unmapped text artifact must still widen CI.
// `dir` names the directory the test memo (scripts/lib/testMemo.js) hashes for
// an owning test. `fileRe`, when set, keeps only that directory's direct
// children — `scripts/` is past the memo's directory limit, and hashing the
// whole tree would fail the installer suites closed instead of keying the pins.
export const FIXTURE_OWNERS = [
  {
    re: /^docker\/vllm-qwen\/[^/]+$/,
    dir: 'docker/vllm-qwen',
    tests: ['server/services/vllmQwenManager.test.js'],
  },
  // The snapshot contract executes this shell verifier against signed fixtures;
  // neither the planner's import graph nor the test memo can see those reads.
  {
    re: /^docker\/supercollider\/(?:verify-snapshot\.sh|debian-inrelease\.sha256)$/,
    dir: 'docker/supercollider',
    fileRe: /^(?:verify-snapshot\.sh|debian-inrelease\.sha256)$/,
    tests: ['server/lib/superColliderSnapshot.test.js'],
  },
  {
    re: /^server\/test\/fixtures\/supercollider-snapshot\/[^/]+\.InRelease$/,
    dir: 'server/test/fixtures/supercollider-snapshot',
    fileRe: /\.InRelease$/,
    tests: ['server/lib/superColliderSnapshot.test.js'],
  },
  {
    re: /^server\/services\/promptSections\/__snapshots__\/reviewLoopMatrix\/[^/]+\.txt$/,
    dir: 'server/services/promptSections/__snapshots__/reviewLoopMatrix',
    tests: ['server/services/promptSections/reviewLifecycleMatrix.test.js'],
  },
  {
    re: /^scripts\/ml\/ltx25_cuda_currency\.py$/,
    dir: 'scripts/ml',
    fileRe: /^ltx25_cuda_currency\.py$/,
    tests: ['server/services/videoGen/runtimes.test.js'],
  },
  {
    re: /^scripts\/setup-trellis2-mps\.sh$/,
    dir: 'scripts',
    fileRe: /^setup-trellis2-mps\.sh$/,
    tests: ['scripts/ml/setup-trellis2-mps.test.js', 'server/routes/imageTo3d.test.js'],
  },
  {
    re: /^scripts\/ml\/requirements\/requirements-trellis2-mps(?:\.lock)?\.txt$/,
    dir: 'scripts/ml/requirements',
    fileRe: /^requirements-trellis2-mps(?:\.lock)?\.txt$/,
    tests: ['scripts/ml/setup-trellis2-mps.test.js', 'server/routes/imageTo3d.test.js'],
  },
  // Pip pins consumed only by an explicit Install/Repair (`setup-image-video.sh`,
  // and the FLUX.3 and lyric-alignment locks read by flux3Runtime.js and
  // lyricForcedAlign.js). The installer-contract tests exercise those installers.
  {
    re: /^scripts\/ml\/requirements\/requirements-[^/]+\.txt$/,
    dir: 'scripts/ml/requirements',
    fileRe: /^requirements-[^/]+\.txt$/,
    tests: [
      'scripts/setup-image-video.test.js',
      'server/lib/pythonSetup.install.test.js',
      'server/lib/pythonSetup.test.js',
      'server/services/imageGen/flux3Runtime.test.js',
      'server/services/musicVideo/lyricForcedAlign.test.js',
      'server/services/videoGen/runtimes.test.js',
    ],
  },
];

export const fixtureOwnerFor = (path) => FIXTURE_OWNERS.find(({ re }) => re.test(path));

// The bundled slashdo submodule (see AGENTS.md "Slashdo Commands") ships no
// source into the tree the planner scans — `git diff` reports only the gitlink
// pointer at this path, never the files inside it — so it can't be detected the
// way an ordinary source change is. The contract suites below exercise the
// real bundled renderer and only mean anything with the submodule checked out,
// so CI initializes it (see ci.yml) exactly when one of them is set to run.
export const SLASHDO_GITLINK_PATH = 'lib/slashdo';
export const SLASHDO_CONTRACT_TEST_FILES = [
  'server/lib/slashdoLoader.test.js',
  'server/lib/slashdoInvocation.test.js',
  'server/lib/auditCatalog.test.js',
];
export const SLASHDO_CONTRACT_SOURCE_FILES = [
  'server/lib/slashdoLoader.js',
  'server/lib/slashdoInvocation.js',
];

// The narrow CI jobs below observe a small, enumerable input set, so a pull
// request that touches none of it skips them, and so does a push to `main`
// whose tree diff against the last green push or schedule run touches none of
// it (CI_GATED_BASE_SHA). Schedule, dispatch, workflow_call and release-base
// runs always run every one. A gate takes one of two forms:
// - the head tree's static import closure of the job's entry points, computed
//   per run so it cannot drift from a hand-kept list, plus the non-module
//   inputs named by the job's pattern (linux-containment, supercollider-live,
//   docker-containment-live);
// - an explicit path list alone, when the closure would select the job on most
//   diffs (macos-native; see its note).
// Every pattern names ci.yml so a workflow edit proves the job still runs.
// The files the `linux-containment` job passes to `npm test --prefix server`.
export const LINUX_CONTAINMENT_TESTS = [
  'autofixer/sandbox.verify.test.js',
  'server/lib/codeAnimationContainment.test.js',
  'server/routes/codeAnimationExecution.test.js',
  'server/services/codeAnimation/containedWorker.test.js',
  'scripts/ci-install-containment-tools.test.js',
];
// The server Vitest config and its setup files load around every one of those
// tests; vitestTempRootSetup.js is named by URL, not by an import edge.
export const LINUX_CONTAINMENT_ENTRIES = [
  ...LINUX_CONTAINMENT_TESTS,
  'server/vitest.config.js',
  'server/vitest.setup.js',
  'scripts/vitestTempRootSetup.js',
];
// The job installs server dependencies from these before running anything.
export const LINUX_CONTAINMENT_PATH_RE = /^(?:server\/package(?:-lock)?\.json|scripts\/ci-install-containment-tools\.sh|\.github\/workflows\/ci\.yml)$/;
// The `supercollider-live` job builds docker/supercollider/ through the setup
// script and runs the opt-in live suite on native amd64 and arm64 runners. The
// setup script and the live test reach the runtime, render service and the
// spawn/kill plumbing through static imports, so the closure — not a literal
// path list — selects the job. The server Vitest config and setup files load
// around the live test; vitestTempRootSetup.js is named by URL, not import.
export const SUPERCOLLIDER_LIVE_ENTRIES = [
  'server/services/superColliderRender.live.test.js',
  'scripts/setup-supercollider.js',
  'server/vitest.config.js',
  'server/vitest.setup.js',
  'scripts/vitestTempRootSetup.js',
];
// The recipe directory and the dependency manifests the job installs from are
// not modules, so the closure cannot see them.
export const SUPERCOLLIDER_LIVE_PATH_RE = /^(?:docker\/supercollider\/|server\/package(?:-lock)?\.json|package(?:-lock)?\.json|\.github\/workflows\/ci\.yml$)/;
// The `docker-containment-live` job runs the opt-in live suite of the Docker
// containment profile (#12844) against the runner's native Docker Engine. The
// suite reaches the profile, the executor, the egress proxy and the engine
// resolver through static imports, so the closure selects the job.
export const DOCKER_CONTAINMENT_LIVE_ENTRIES = [
  'server/services/dockerContainment.live.test.js',
  'server/vitest.config.js',
  'server/vitest.setup.js',
  'scripts/vitestTempRootSetup.js',
];
// The job installs server dependencies from these before running anything.
export const DOCKER_CONTAINMENT_LIVE_PATH_RE = /^(?:server\/package(?:-lock)?\.json|\.github\/workflows\/ci\.yml)$/;
// The `macos-native` job runs the macOS launchd-coalition release-agent
// boundary (#14781): suites that skip on every other platform, so the Linux
// and Windows jobs can never prove them. macOS runners are the scarcest hosted
// capacity, so the gate is this explicit path list, not an import closure —
// application import closures reach most of the server.
export const MACOS_NATIVE_TESTS = [
  'server/lib/windowsAgentProcess.darwin.test.js',
];
// The supervision path itself, the dependency manifests and Vitest harness the
// job installs and loads, plus the workflow and the server setup and cache
// actions the macOS job uses.
export const MACOS_NATIVE_PATH_RE = /^(?:server\/lib\/(?:windowsAgentProcess[^/]*\.js|darwinAgentSupervisor\.py)|server\/vitest\.(?:config|setup)\.js|scripts\/vitestTempRootSetup\.js|scripts\/trusted-rebuilds\.js|server\/(?:package(?:-lock)?\.json|\.npmrc)|\.github\/workflows\/ci\.yml|\.github\/actions\/(?:setup-server|server-vitest-cache)\/action\.yml)$/;
// The `node-minimum` job installs every workspace and runs the runtime gate on
// the oldest supported Node; only these files can change its answer.
export const NODE_MINIMUM_PATH_RE = /^(?:(?:server\/|client\/)?(?:package(?:-lock)?\.json|\.npmrc)|\.nvmrc|scripts\/checkNodeVersion(?:\.test)?\.js|scripts\/lib\/directInvocation\.js|server\/test\/guards\/repo\/node-version-drift\.test\.js|server\/test\/guards\/repo\.guard\.test\.js|\.github\/workflows\/ci\.yml)$/;

/** True when the diff reaches a gated job's inputs; null inputs fail open to running it. */
export const touchesJobInputs = (changed, inputs, pattern) => inputs === null
  || changed.some((path) => pattern.test(path) || inputs.includes(path));

const RUNNER_ROOTS = {
  server: [
    'server/',
    'scripts/',
    'lib/',
    'autofixer/',
    // server/vitest.config.js globs ../docs/**/*.test.js for the doc-parity
    // guards colocated with the documents they check.
    'docs/',
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

export const pathMatchesFeature = (path, feature) => {
  const variants = featureVariants(feature);
  return normalizedPathParts(path).some((part) => variants.has(part));
};

export const isTestFile = (path) => TEST_FILE_RE.test(path);
export const isPythonScript = (path) => PYTHON_SCRIPT_RE.test(path);
export const isExecutable = (path) => EXECUTABLE_RE.test(path) || isPythonScript(path);
// A documentation directory can also contain runnable contracts and helpers.
export const isDocumentationOnly = (path) => !isExecutable(path) && DOCUMENTATION_RULES.some((rule) => rule.test(path));
export const isGeneratedData = (path) => GENERATED_DATA_RULES.some((rule) => rule.test(path));
export const isServerRunnerFile = (path) => RUNNER_ROOTS.server.some((root) => path.startsWith(root));
const isClientRunnerFile = (path) => RUNNER_ROOTS.client.some((root) => path.startsWith(root));

// Model-capability fixtures ship deliberately broken `*.test.mjs` sandboxes that
// a model is asked to repair. They are data, not suites: no runner collects them,
// and a feature-name match ("models") must not hand one to vitest as a target.
const RUNNER_EXCLUDED_FIXTURES = /^server\/fixtures\//;

export const runnerForTest = (path) => {
  if (!isTestFile(path) || RUNNER_EXCLUDED_FIXTURES.test(path)) return null;
  if (isClientRunnerFile(path)) return 'client';
  if (resolveDbTestFiles([path]).length > 0) return 'db';
  if (isServerRunnerFile(path)) return 'server';
  return null;
};

// Server-owned JSON seeds under `data.reference/` (provider catalog, prompt
// defaults, shipped hashes, starter configs). Neither client production code nor
// native Windows contracts consume them, so updates stay scoped to server
// contract tests + boot smoke rather than forcing a full matrix (#18220).
const SERVER_SEED_RE = /^data\.reference\/.+\.json$/i;
export const isServerSeed = (path) => SERVER_SEED_RE.test(path);

export const SERVER_SEED_OWNERS = [
  {
    re: /^data\.reference\/providers\.json$/i,
    tests: [
      'scripts/generate-provider-samples.test.js',
      'server/cos-runner/allowedCommands.test.js',
      'server/lib/aiToolkit/defaults/providersSeedParity.test.js',
      'server/services/provider/providers.shape.test.js',
      'server/services/provider/providerPresets.test.js',
      'server/services/provider/providerReadiness.test.js',
    ],
  },
  {
    re: /^data\.reference\/prompts\/[^/]+\.json$/i,
    tests: [
      'scripts/migrations/shippedPromptHashes.test.js',
      'scripts/regen-shipped-prompt-hashes.test.js',
      'server/lib/promptSystemStages.test.js',
    ],
  },
];

export const serverSeedTestsFor = (path, trackedSet) => (
  SERVER_SEED_OWNERS
    .filter(({ re }) => re.test(path))
    .flatMap(({ tests }) => tests)
    .filter((test) => trackedSet.has(test) && runnerForTest(test))
);

export const featureDirectory = (path) => {
  for (const rule of FEATURE_DIRECTORY_RULES) {
    const match = path.match(rule);
    if (match) return normalizeFeature(match[1]);
  }
  return null;
};

// The cache boundary copies configs/helpers into synthetic checkouts and reads
// launcher arguments as data. Those runtime edges are invisible to Vitest's
// import graph; select their shared contract explicitly instead of running its
// subprocesses on every unrelated or documentation-only change.
const WORKSPACE_CACHE_COMMON_INPUTS = new Set([
  '.github/workflows/ci.yml', '.github/actions/setup-server/action.yml', 'package.json', 'scripts/lib/workspaceCacheFixture.js',
  'scripts/lib/vitestTempRootFixture.js', 'scripts/lib/vitestTempRoot.js',
  'scripts/lib/vitestWatch.js', 'scripts/lib/testOwnedProcesses.js', 'scripts/lib/darwinTestProcesses.py',
  'scripts/lib/vitestStaleRunRoots.js', 'scripts/lib/dbTestFiles.js', 'scripts/lib/workspaceTests.js',
  'scripts/vitestCiPool.js', 'scripts/vitestTempRootSetup.js', 'server/lib/killWithEscalation.js',
  'server/lib/mockPathsDataRoot.js',
]);
const WORKSPACE_CACHE_SERVER_INPUTS = new Set([
  '.github/actions/server-vitest-cache/action.yml',
  'server/package.json', 'server/package-lock.json',
  'server/vitest.config.js', 'server/vitest.config.db.js', 'server/vitest.setup.js',
  'server/test/admissionSetup.js', 'server/test/mediaRegistryEnvironment.js',
]);
const WORKSPACE_CACHE_CLIENT_INPUTS = new Set([
  'ecosystem.config.cjs', 'client/package.json', 'client/package-lock.json',
  'client/vite.config.js', 'lib/viteBuildEnv.js', 'client/vite.chunkGroups.js',
  'client/vitest.config.js', 'client/src/test/timeouts.js',
  'scripts/dev-start.js', 'scripts/publish-client-build.js',
  'scripts/lib/envFile.cjs', 'scripts/lib/databaseSettings.cjs',
  'lib/portosAuthCore.js', 'server/lib/eidoverseProxyRoutes.js',
]);

const ENSURE_DEPS_INPUTS = new Set([
  'scripts/ensure-deps.js', 'scripts/update.mjs', 'update.sh', 'update.ps1',
  'package-lock.json', 'client/package-lock.json', 'server/package-lock.json',
]);

export const structuralTestsFor = (changedFiles, trackedSet) => {
  const selected = [];
  const add = (path) => {
    if (trackedSet.has(path)) selected.push(path);
  };

  const sharedCacheInputChanged = changedFiles.some((path) => WORKSPACE_CACHE_COMMON_INPUTS.has(path));
  if (sharedCacheInputChanged || changedFiles.some((path) => WORKSPACE_CACHE_SERVER_INPUTS.has(path))) {
    add('scripts/workspaceCaches.test.js');
  }
  if (sharedCacheInputChanged || changedFiles.some((path) => WORKSPACE_CACHE_CLIENT_INPUTS.has(path))) {
    add('client/src/test/workspaceCaches.test.js');
    // The runner's client enumeration is pinned against `vitest list` from the client workspace, where the client job runs it.
    add('client/src/test/workspaceTests.test.js');
  }
  // Behavioural temp-directory test: it imports ensure-deps.js (so the graph
  // selects it for that file) but only reads the update scripts and lockfiles.
  if (changedFiles.some((path) => ENSURE_DEPS_INPUTS.has(path))) {
    add('scripts/ensure-deps.test.js');
  }
  // The module-summary guards readdir-scan their directory instead of importing
  // it, so no import edge selects them for a newly added module.
  for (const dir of CATALOG_DIRS) {
    if (changedFiles.some((path) => path.startsWith(`${dir}/`))) add(`${dir}/moduleSummaries.test.js`);
  }
  // These guards read the tree rather than importing it, so no import edge
  // selects them: the parity guard catches a client wrapper stranded by a
  // renamed mount, and the prompt-stage drift test a stale manifest — which is
  // what a scoped plan let merge before this rule existed (#5898). The
  // route-graph guard (a route file nothing mounts) is a structural guard
  // check (server/test/guards/modules/apiRouteGraph.test.js) and rides every plan.
  const changedApiSources = changedFiles.some((path) => /^server\/.*\.js$/.test(path) || /^server\/lib\/.*\.generated\.json$/.test(path) || /^client\/src\/services\/api.*\.js$/.test(path));
  if (changedApiSources || changedFiles.some((path) => OPERATOR_SCRIPT_CALLER_FILES.includes(path))) {
    add('server/lib/apiRouteParity.test.js');
  }
  if (changedApiSources) {
    add('scripts/generate-prompt-stage-call-sites.test.js');
  }
  // The fresh-install schema check reads init-db.sql and its base file rather
  // than importing them, so a hand edit to either would otherwise select only
  // the DB suite, which never compares the file with its generator (#16092).
  if (changedFiles.some((path) => /^server\/scripts\/init-db(?:\.base)?\.sql$/.test(path))) {
    add('server/lib/db.ddlParity.test.js');
  }
  // The socket guard readdir-scans server/sockets/ rather than importing it, so
  // no import edge reaches it — a handler added there would otherwise only be
  // checked on a full suite.
  if (changedFiles.some((path) => /^server\/sockets\//.test(path))) {
    add('server/sockets/asyncHandlerGuard.test.js');
  }
  // The client structural guard runners (src/test/guards/{a11y,ui}.guard.test.js,
  // #16996) read class strings, storage accesses, declarations, JSX markup and test
  // files out of both extensions; none has a source sibling or imports an app
  // module, so nothing else selects them. Both `.js` and `.jsx`: the StrictMode
  // mounted-ref bug one check covers reached its widest blast radius through a
  // plain-`.js` hook (`useAsyncAction`).
  if (changedFiles.some((path) => /^client\/src\/.*\.jsx?$/.test(path))) {
    for (const path of trackedSet) if (isClientGuard(path) && isGuardTest(path)) add(path);
  }

  return selected;
};

export const uniqueSorted = (values) => [...new Set(values)].sort();

/**
 * Split a set of always-run selectors across the two Vitest runners.
 *
 * The docs-only plan names its files directly instead of going through the
 * runner split the scoped branches use, so it has to do that split itself: an
 * entry added to the always-run set under client/src would otherwise be handed to
 * the server runner, which does not glob client/, and the guard would report
 * green having run nowhere.
 */
export const splitByRunner = (paths) => ({
  server: paths.filter((path) => runnerForTest(path) === 'server'),
  client: paths.filter((path) => runnerForTest(path) === 'client'),
});
export const windowsContractTests = (trackedSet) => {
  return WINDOWS_CONTRACT_TESTS.filter(path => trackedSet.has(path)).sort();
};

/**
 * Does this diff touch a surface only a real Windows runner can prove?
 *
 * Deliberately NOT restricted to isExecutable() paths: .ps1/.cmd/.bat are not
 * in EXECUTABLE_RE, so a PowerShell change used to reach the Windows job only
 * as a side effect of being an "unclassified changed file". This answers the
 * question directly, and is what selects the native job alongside a primary-only trigger.
 */
export const hasWindowsRiskFile = (paths) => paths.some((path) => (
  !isDocumentationOnly(path) && WINDOWS_RISK_RULES.some((rule) => rule.test(path))
));

/**
 * Every FULL_TRIGGER_RULES match in `changed`, each with its Windows relevance
 * resolved (a manifest through its dependency verdict), plus the verdict notes.
 */
export function fullTriggersFor(changed, dependencyChanges) {
  const dependencyVerdicts = [];
  const fullTriggers = changed
    .flatMap((path) => FULL_TRIGGER_RULES
      .filter(({ re }) => re.test(path))
      .map(({ reason, windowsRelevant }) => {
        const scopedToWindows = windowsRelevant === 'dependencies' || (windowsRelevant === true && /(?:^|\/)\.npmrc$/.test(path));
        if (!scopedToWindows) return { path, reason, windowsRelevant };
        if (!windowsInstalls(path)) {
          dependencyVerdicts.push(`${path} does not select Windows native contracts: the Windows job does not install that workspace`);
          return { path, reason, windowsRelevant: false };
        }
        if (windowsRelevant === true) return { path, reason, windowsRelevant };
        const verdict = dependencyChanges[path] ?? escalated('no manifest comparison available');
        dependencyVerdicts.push(describeDependencyVerdict(path, verdict));
        return { path, reason, windowsRelevant: verdict.escalate };
      }));
  return { fullTriggers, windowsNote: dependencyVerdicts.join('; ') };
}

/**
 * Whether a diff selects the native Windows contract job: the same answer a
 * pull request with this diff gets, whatever its primary plan.
 */
export const windowsSelectionFor = (changed, dependencyChanges) => {
  const { fullTriggers, windowsNote } = fullTriggersFor(changed, dependencyChanges);
  return {
    windows: fullTriggers.some((trigger) => trigger.windowsRelevant) || hasWindowsRiskFile(changed),
    windowsNote,
  };
};

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

export function isSharedClientDependency(path) {
  return path.startsWith('server/lib/') || path.startsWith('scripts/lib/');
}

export const browserSuitesIn = (paths) => uniqueSorted(paths.filter((path) => BROWSER_SUITES.includes(path)));
