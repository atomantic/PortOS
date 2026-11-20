#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, posix, relative } from 'path';
import { fileURLToPath } from 'url';
import { staticImportClosure, toModuleKey } from '../server/lib/staticImportGraph.js';
import { escapeRegExp } from '../server/lib/textUtils.js';
import { moduleImports } from './lib/sourceTokens.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { CATALOG_DIRS } from './lib-catalog.js';
import { SERVER_LINT_RE } from './lib/serverLintSurface.js';
import { writeStepOutput, writeStepSummary } from './lib/githubOutput.js';
import { selectWorkflowFiles } from './lib/actionlint.js';
import { resolveDbTestFiles } from './lib/dbTestFiles.js';
import { guardTestFiles } from './lib/guardScanners.js';
import { BROWSER_SUITES } from './lib/browserSuites.js';
import { formatReachSummary, measureRepoImportReach } from './lib/importReach.js';

const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const MODULE_SOURCE_RE = /\.[cm]?[jt]sx?$/i;
// `git grep` pathspecs matching every extension TEST_FILE_RE recognizes. A
// hardcoded `*.test.js`/`.jsx` pair would silently stop finding a `.test.ts(x)`
// or `.spec.*` contract test added later, reopening the exact under-selection
// bug the basename lookup below exists to close — the later trackedSet +
// runnerForTest(isTestFile) filter already narrows a broad hit back down, so
// over-matching here costs nothing.
const TEST_FILE_GLOBS = ['*.test.*', '*.spec.*'];
// The server rule set lints server/ whole, plus scripts/, lib/ (not the slashdo
// submodule) and autofixer/ (fast, ~1s). SERVER_LINT_RE lives in
// scripts/lib/serverLintSurface.js so the planner and the runner cannot drift,
// and so a pregate fixture can stub the lint runner without unloading the planner.
const CLIENT_LINT_RE = /^client\/src\/.*\.(?:js|jsx)$/i;
const isLintSurface = (path) => CLIENT_LINT_RE.test(path) || SERVER_LINT_RE.test(path);
const EXECUTABLE_RE = /\.(?:cjs|css|html|js|jsx|json|mjs|sql|ts|tsx|ya?ml)$/i;
const MAX_CHANGED_CODE_FILES = 30;
// Explicit selectors one runner carries before its scoped plan fans out across
// the full-suite shard matrix. It used to escalate the whole repository to a
// full plan; over-selection is a capacity limit, not a risk signal, so the
// selection now stays exactly as computed and only execution is partitioned
// (#11871). 125 is that former full-plan threshold (#10312).
export const MAX_TARGETED_TEST_FILES = 125;
// The client runner has no reach measure and its cold-memo cost is about 0.4s per
// file including overhead (#16805 measurements), so one runner absorbs 400 client
// files inside the existing critical path. Fanning out earlier only adds three
// runner starts, Chrome warm-ups and memo restores.
export const CLIENT_FANOUT_TEST_FILES = 400;

// Preserve the planner's public registry export for existing callers.
export { BROWSER_SUITES } from './lib/browserSuites.js';
const browserSuitesIn = (paths) => uniqueSorted(paths.filter((path) => BROWSER_SUITES.includes(path)));

// Python sidecar scripts (`scripts/generate_ltx2.py`, …). Vitest's import graph
// cannot reach into them, but their contracts are pinned by suites that read
// the .py source as text, so main() finds the suites naming each changed script
// with `git grep` and the plan runs exactly those — failing closed to the full
// suite for a script nothing names.
const PYTHON_SCRIPT_RE = /^scripts\/[^/]+\.py$/;

// Contract tests read a subject file with `readFileSync` (a cross-tree mirror
// parity test, `server/lib/navManifest.js` reading 20+ client files by path)
// instead of importing it, so no `vitest related` import edge reaches them
// either. `main()` finds the tests naming a changed file's basename with
// `git grep`, the same mechanism the python case below uses, and generalizes
// it to every changed source — not only `.py` (issue #6363).
/** `git grep -E` pattern for a test that names this one source file by basename. */
export const sourceReferencePattern = (sourcePath) => (
  `(^|[^A-Za-z0-9_])${sourcePath.slice(sourcePath.lastIndexOf('/') + 1).replace(/[.]/g, '\\.')}([^A-Za-z0-9_]|$)`
);

// Parallel runners per test job on a full plan. Decided here rather than in
// ci.yml because a job-level `if` cannot read the matrix context, so the
// planner emits the matrix for scoped plans too. Sizing rationale:
// docs/GITHUB_ACTIONS.md "Full-suite sharding".
export const FULL_SUITE_SHARDS = { server: 2, client: 3, windows: 1 };

/** Matrix values for one runner: every shard on a full run, one otherwise. */
export const shardIndexes = (mode, count) => (
  mode === 'full' ? Array.from({ length: count }, (_, index) => index + 1) : [1]
);

/**
 * Whether a scoped Linux runner fans out across its full-suite shard count.
 *
 * - Over the runner's cap of explicit selectors (MAX_TARGETED_TEST_FILES for the
 *   server, CLIENT_FANOUT_TEST_FILES for the client): either mode.
 * - A server `related` plan whose measured import reach (`serverReach.selected`,
 *   the suites Vitest's related walk will select) exceeds the same cap (#16547):
 *   its explicit selectors stay few, yet one runner would execute ~1,000 suites.
 *   The client has no reach measure, so only the cap applies there.
 * - Everything else stays on one runner. Record-aware selection
 *   (`recordedReach` in lib/testMemo.js, #16424) narrows what a selected test
 *   actually runs; reach is measured, not assumed, so a small graph stays put.
 *
 * No shard-count floor is needed: the runner slices the selection itself and
 * never hands Vitest `--shard`, so a shard whose slice is empty exits green.
 */
const runnerFanOutCap = (runner) => (runner === 'client' ? CLIENT_FANOUT_TEST_FILES : MAX_TARGETED_TEST_FILES);
const fansOut = (runner, { mode, files }, reach = 0) => mode !== 'skip' && mode !== 'full'
  && (files.length > runnerFanOutCap(runner) || (mode === 'related' && reach > MAX_TARGETED_TEST_FILES));

const serverReachCount = (serverReach) => (Number.isFinite(serverReach?.selected) ? serverReach.selected : 0);

const DEPENDENCY_MANIFEST_RE = /^(?:package|server\/package|client\/package|autofixer\/package)(?:-lock)?\.json$/;

// Workspaces the windows-server job installs (`npm ci --prefix <dir>`). Only
// their manifests and .npmrc can change what that job runs, so a dependency or
// npm-config change elsewhere keeps the Windows baseline. ci-test-plan.test.js
// pins this list to the job's install steps in ci.yml.
export const WINDOWS_INSTALLED_WORKSPACES = ['server'];
const windowsInstalls = (path) => WINDOWS_INSTALLED_WORKSPACES.some((dir) => path.startsWith(`${dir}/`));

// Packages whose installed files differ per platform although their lockfile
// entry may carry no os/cpu/install-script metadata: runtime dispatchers that
// pick a prebuilt binary (their per-platform children ARE os/cpu-tagged, and
// usually move with them), browser-binary downloaders, and native addons.
//
// The first row is every TRUSTED_REBUILDS package (scripts/trusted-rebuilds.js).
// It is matched here rather than imported: that module's spawn helpers would
// pull ~20 server modules into a planner that runs before any install.
// ci-test-plan.test.js fails when the allowlist names a package this list misses.
export const PLATFORM_PACKAGE_RES = [
  /^node-pty$/, /^sharp$/, /^onnxruntime-/, /^protobufjs$/,
  /^@img\//, /^esbuild$/, /^@esbuild\//,
  /^rollup$/, /^@rollup\/rollup-/, /^rolldown$/, /^@rolldown\//, /^@biomejs\//,
  /^lightningcss(?:-|$)/, /^@tailwindcss\/oxide/, /^playwright(?:-core)?$/, /^@playwright\//,
  /^@swc\//, /^fsevents$/, /^bufferutil$/, /^utf-8-validate$/,
];
// Lockfile entry metadata npm uses to install a package conditionally per
// platform, or to run code at install time.
const PLATFORM_ENTRY_FIELDS = ['hasInstallScript', 'os', 'cpu', 'libc', 'optional', 'devOptional'];
// package.json fields whose change installs the same files on every platform.
// Dependency maps are checked per changed name; any other field (engines,
// overrides, optionalDependencies, scripts, os, cpu, …) escalates.
const PLATFORM_NEUTRAL_MANIFEST_FIELDS = new Set([
  'name', 'version', 'description', 'keywords', 'author', 'license', 'homepage', 'repository', 'bugs', 'private',
]);
const MANIFEST_DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies'];
// Lockfile root entry ("") fields that mirror the dependency maps; the
// node_modules/* entries carry the real change.
const LOCKFILE_ROOT_NEUTRAL_FIELDS = new Set(['name', 'version', 'license', ...MANIFEST_DEPENDENCY_FIELDS]);

const isPlatformPackageName = (name) => PLATFORM_PACKAGE_RES.some((re) => re.test(name));
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const changedKeys = (base = {}, head = {}) => uniqueSorted([...Object.keys(base), ...Object.keys(head)])
  .filter((key) => !sameJson(base[key], head[key]));
const packageNameFromLockKey = (key, entry) => entry?.name
  ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const escalated = (reason, packages = []) => ({ escalate: true, reason, packages: uniqueSorted(packages) });

function classifyLockfile(base, head) {
  if (!isPlainObject(base.packages) || !isPlainObject(head.packages)) {
    return escalated('lockfile has no packages map to compare');
  }
  const topLevel = changedKeys(base, head).filter((key) => !['packages', 'name', 'version'].includes(key));
  if (topLevel.length > 0) return escalated(`lockfile ${topLevel.join(', ')} changed`);
  const rootFields = changedKeys(base.packages[''], head.packages[''])
    .filter((key) => !LOCKFILE_ROOT_NEUTRAL_FIELDS.has(key));
  if (rootFields.length > 0) return escalated(`root ${rootFields.join(', ')} changed`);

  const changed = changedKeys(base.packages, head.packages).filter((key) => key !== '').map((key) => {
    const entries = [base.packages[key], head.packages[key]].filter(isPlainObject);
    const name = packageNameFromLockKey(key, head.packages[key] ?? base.packages[key]);
    const sensitive = isPlatformPackageName(name) || entries.some((entry) => PLATFORM_ENTRY_FIELDS
      .some((field) => entry[field] !== undefined && entry[field] !== false));
    return { name, sensitive };
  });
  const sensitive = changed.filter((pkg) => pkg.sensitive).map((pkg) => pkg.name);
  if (sensitive.length > 0) return escalated('platform-sensitive package changed', sensitive);
  return { escalate: false, reason: 'no platform-sensitive package changed', packages: uniqueSorted(changed.map((pkg) => pkg.name)) };
}

function classifyManifest(base, head) {
  const fields = changedKeys(base, head).filter((key) => !PLATFORM_NEUTRAL_MANIFEST_FIELDS.has(key));
  const unsafe = fields.filter((key) => !MANIFEST_DEPENDENCY_FIELDS.includes(key));
  if (unsafe.length > 0) return escalated(`${unsafe.join(', ')} changed`);
  const names = uniqueSorted(fields.flatMap((field) => changedKeys(
    isPlainObject(base[field]) ? base[field] : {},
    isPlainObject(head[field]) ? head[field] : {},
  )));
  const sensitive = names.filter(isPlatformPackageName);
  if (sensitive.length > 0) return escalated('platform-sensitive package changed', sensitive);
  return { escalate: false, reason: 'no platform-sensitive package changed', packages: names };
}

/**
 * Does this manifest change require the Windows native contract job?
 *
 * `baseText`/`headText` are the file's contents at the diff base and in the
 * tree under test; null means unavailable (new, deleted, or unreadable). Any
 * input the planner cannot read and compare fails closed to escalation, so
 * only a proven platform-neutral change downgrades Windows.
 *
 * Returns { escalate, reason, packages } — `packages` names what drove the
 * decision: the platform-sensitive packages when escalating, every changed
 * package otherwise.
 */
export function classifyDependencyChange(path, baseText, headText) {
  if (baseText == null) return escalated('base version unavailable');
  if (headText == null) return escalated('removed or unreadable in the tree under test');
  let base;
  let head;
  try {
    base = JSON.parse(baseText);
    head = JSON.parse(headText);
  } catch {
    return escalated('could not be parsed');
  }
  if (!isPlainObject(base) || !isPlainObject(head)) return escalated('could not be parsed');
  return path.endsWith('-lock.json') ? classifyLockfile(base, head) : classifyManifest(base, head);
}

const MAX_NAMED_PACKAGES = 8;
const describeDependencyVerdict = (path, { escalate, reason, packages }) => {
  const named = packages.length > MAX_NAMED_PACKAGES
    ? `${packages.slice(0, MAX_NAMED_PACKAGES).join(', ')} and ${packages.length - MAX_NAMED_PACKAGES} more`
    : packages.join(', ');
  return `${path} ${escalate ? 'selects Windows native contracts' : 'does not select Windows native contracts'}: ${reason}${named ? ` (${named})` : ''}`;
};

// A full primary plan selects the Windows native job only when its execution
// inputs are relevant. Dependency verdicts distinguish the workspace Windows
// actually installs; primary-only configuration/schema changes do not need it.
const FULL_TRIGGER_RULES = [
  // ci.yml defines the windows-server job itself. The other workflows (release,
  // acceptance, cancel recovery) never run on windows-latest.
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
  // Biome config + the client's GritQL plugins (the former client/eslint.config.js).
  // The .grit files carry real enforced rules — notably the crypto.randomUUID ban —
  // so a change there is as load-bearing as a change to the config itself. The
  // repo-root biome.jsonc is the same kind of gate for scripts/, lib/ and
  // autofixer/. The Windows job runs no lint.
  { re: /^(?:client\/(?:biome\.jsonc|[^/]+\.grit)|biome\.jsonc)$/, reason: 'lint configuration changed', windowsRelevant: false },
  // Client-only: the Windows job builds no client bundle.
  { re: /^client\/vite\.config\.js$/, reason: 'client build configuration changed', windowsRelevant: false },
  { re: /^server\/index\.js$/, reason: 'server composition root changed', windowsRelevant: true },
  // Widely imported, but pure cross-platform schema logic: no spawn, path or
  // filesystem semantics that pinPlatform() stubs cannot cover on Linux.
  { re: /^server\/lib\/schemaVersions\.js$/, reason: 'shared server contract changed', windowsRelevant: false },
  // Measured hotspot (#9999): a two-file worktreeManager change expanded through
  // import consumers to 57 selectors and a ~941-file local run, yet counted as
  // a "scoped" plan because MAX_TARGETED_TEST_FILES only sees explicit selectors.
  // Own the cost honestly: a full plan, sharded in CI. It also owns cross-platform
  // worktree lifecycle, so Windows escalates (matches WINDOWS_RISK_RULES).
  { re: /^server\/services\/worktreeManager\.js$/, reason: 'worktree manager source changed (broad import fanout)', windowsRelevant: true },
  // Measured log socket hotspot (#10030): changing this source fans out through
  // nearly the full server suite, so make the cost explicit in CI. The socket
  // starts and supervises a real child process; retain the native Windows job.
  { re: /^server\/sockets\/logs\.js$/, reason: 'log socket source changed (broad import fanout)', windowsRelevant: true },
  // The scripts that decide what CI runs, run it, and gate the release on it.
  // A bug in any of them can make a scoped plan silently test nothing, so they
  // prove themselves against the complete suite rather than their own scope.
  // Only the ones the windows-server job itself executes (ci-base-sha,
  // run-ci-tests and the githubOutput helper it imports) escalate Windows; the
  // planner, lint runner, hidden-content scan and status verifier run on Linux
  // jobs only, so a Windows run would observe nothing they change.
  { re: /^scripts\/(?:lib\/githubOutput|ci-base-sha|run-ci-tests)(?:\.test)?\.js$/, reason: 'CI pipeline script changed', windowsRelevant: true },
  { re: /^scripts\/ci-test-plan(?:\.test)?\.js$/, reason: 'CI pipeline script changed', windowsRelevant: true },
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
//      They sat structurally unselectable — `agent-instructions-files.guard.test.js`
//      went red on `main` and stayed there while every PR reported green — and
//      the always-run list is the only mechanism that can reach them at all.
//      This half is selected by filename (#16553): every tracked
//      `*.guard.test.js` (getGuardTests), so a new scanner registers by being
//      named. repo-scan-guards.guard.test.js fails a scanner without the suffix.
//
// Everything here is deliberately cheap: it reads only prompt data or `git`
// output, which is affordable on every PR including documentation-only ones,
// where the alternative is reasoning per-scope about what can reach it. The
// whole set measured ~23s of a 27s focused pregate (#16086), so each guard has
// a per-file budget (GUARD_BUDGET_MS in scripts/lib/guardBudget.js) that
// hosted CI enforces. A behavioural test that no scan needs does not belong
// here: a suite that mixes the two keeps its scan in a sibling
// `<name>.guard.test.js`.
//
// The explicit list holds only what the suffix does not: guards whose file is
// not named as one.
export const EXPLICIT_ALWAYS_RUN_TESTS = [
  // Doc-parity guards: each compares a .md next to it against source it reads
  // rather than imports, so a docs-only PR that documented a removed endpoint
  // would otherwise merge green.
  'docs/api-doc.test.js',
  'docs/doc-endpoint-methods.test.js',
  'docs/docs-index.test.js',
  'docs/deps-doc.test.js',
  'docs/features/product-surfaces.test.js',
  'scripts/doc-code-pointers.test.js',
  // Route policy scans depend on independently changed files (#13224).
  'server/lib/apiRouteParity.test.js',
  'server/lib/hostControlRoutes.test.js',
  // Whole-tree route-mount scan (#12952, #16018).
  'server/hostControlCoverage.test.js',
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

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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
export const getAlwaysRunTests = () => (alwaysRun ??= [...new Set([
  ...EXPLICIT_ALWAYS_RUN_TESTS,
  ...getGuardTests().filter((path) => !isClientGuard(path)),
])].sort());

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
  'scripts/lib/testMemo.test.js',
  'scripts/lib/testMemoRunner.test.js',
  'scripts/pregate.test.js',
  'scripts/run-ci-tests.test.js',
  'scripts/vitestCiPool.test.js',
  'scripts/vitestSiblingSweep.test.js',
  'scripts/vitestTempRoot.test.js',
  'scripts/workspaceCaches.test.js',
];

// Paths whose edit can break a tooling test with no import edge reaching it: the
// scripts and workflows themselves, every dependency manifest, the Vitest configs,
// and the Vitest environment modules the real configs load in the fixtures' child runs.
export const TOOLING_OWNER_RE = /^(?:scripts\/|\.github\/|(?:[^/]+\/)*(?:package(?:-lock)?\.json|\.npmrc)$|(?:server|client)\/vitest[^/]*\.js$|server\/test\/(?:admissionSetup|dbRunExclusivity|mediaRegistryEnvironment|ownedBrowserDiagnostics|runTempRoot)\.js$)/;

const toolingTestsFor = (changedFiles, trackedSet) => (
  changedFiles.some((path) => TOOLING_OWNER_RE.test(path)) ? TOOLING_TESTS.filter((path) => trackedSet.has(path)) : []);

const DB_RISK_RULES = [
  /^scripts\/rehearsal-scratch-db(?:[.\/]|$)/i,
  /^scripts\/generate-init-db-sql(?:[.\/]|$)/i,
  /^scripts\/lib\/migrationFiles(?:[.\/]|$)/i,
  /^scripts\/lib\/dbImage(?:[.\/]|$)/i,
  /^docker-compose\.yml$/i,
  /^server\/lib\/databaseMaintenanceSchema(?:[.\/]|$)/i,
  /^server\/services\/backupDatabaseDump(?:[.\/]|$)/i,
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
    re: /^scripts\/ltx25_cuda_currency\.py$/,
    dir: 'scripts',
    fileRe: /^ltx25_cuda_currency\.py$/,
    tests: ['server/services/videoGen/runtimes.test.js'],
  },
  {
    re: /^scripts\/(?:setup-trellis2-mps\.sh|requirements-trellis2-mps(?:\.lock)?\.txt)$/,
    dir: 'scripts',
    fileRe: /^(?:setup-trellis2-mps\.sh|requirements-trellis2-mps(?:\.lock)?\.txt)$/,
    tests: ['scripts/setup-trellis2-mps.test.js', 'server/routes/imageTo3d.test.js'],
  },
  // Pip pins consumed only by an explicit Install/Repair (`setup-image-video.sh`,
  // and the FLUX.3 and lyric-alignment locks read by flux3Runtime.js and
  // lyricForcedAlign.js). The installer-contract tests exercise those installers.
  {
    re: /^scripts\/requirements-[^/]+\.txt$/,
    dir: 'scripts',
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

const fixtureOwnerFor = (path) => FIXTURE_OWNERS.find(({ re }) => re.test(path));

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
const LINUX_CONTAINMENT_ENTRIES = [
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
// job installs and loads, and ci.yml plus the setup-server action it installs
// through, so a workflow edit proves the job runs.
export const MACOS_NATIVE_PATH_RE = /^(?:server\/lib\/(?:windowsAgentProcess[^/]*\.js|darwinAgentSupervisor\.py)|server\/vitest\.(?:config|setup)\.js|scripts\/vitestTempRootSetup\.js|scripts\/trusted-rebuilds\.js|server\/(?:package(?:-lock)?\.json|\.npmrc)|\.github\/workflows\/ci\.yml|\.github\/actions\/setup-server\/action\.yml)$/;
// The `node-minimum` job installs every workspace and runs the runtime gate on
// the oldest supported Node; only these files can change its answer.
export const NODE_MINIMUM_PATH_RE = /^(?:(?:server\/|client\/|autofixer\/)?(?:package(?:-lock)?\.json|\.npmrc)|\.nvmrc|scripts\/checkNodeVersion(?:\.test)?\.js|scripts\/lib\/directInvocation\.js|scripts\/node-version-drift\.guard\.test\.js|\.github\/workflows\/ci\.yml)$/;

/**
 * Repository-relative static import closure of `entries` in `cwd`, or null
 * when a module cannot be read — the caller then runs the gated job rather
 * than trusting a partial walk. Every entry is an input even when absent, so
 * deleting or renaming one still runs the job that names it.
 */
const staticClosureOf = (entries, cwd) => {
  try {
    const files = new Set(entries);
    for (const entry of entries) {
      if (!existsSync(join(cwd, entry))) continue;
      for (const file of staticImportClosure(join(cwd, entry)).files) files.add(toModuleKey(relative(cwd, file)));
    }
    return uniqueSorted([...files]);
  } catch {
    return null;
  }
};

/** Static closure of the linux-containment tests and their Vitest harness. */
export const collectLinuxContainmentInputs = (cwd) => staticClosureOf(LINUX_CONTAINMENT_ENTRIES, cwd);

/** Static closure of the SuperCollider live suite, its setup script and their Vitest harness. */
export const collectSuperColliderLiveInputs = (cwd) => staticClosureOf(SUPERCOLLIDER_LIVE_ENTRIES, cwd);

/** Static closure of the Docker containment live suite and its Vitest harness. */
export const collectDockerContainmentLiveInputs = (cwd) => staticClosureOf(DOCKER_CONTAINMENT_LIVE_ENTRIES, cwd);

/** True when the diff reaches a gated job's inputs; null inputs fail open to running it. */
const touchesJobInputs = (changed, inputs, pattern) => inputs === null
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

const pathMatchesFeature = (path, feature) => {
  const variants = featureVariants(feature);
  return normalizedPathParts(path).some((part) => variants.has(part));
};

const isTestFile = (path) => TEST_FILE_RE.test(path);
const isPythonScript = (path) => PYTHON_SCRIPT_RE.test(path);
const isExecutable = (path) => EXECUTABLE_RE.test(path) || isPythonScript(path);
// A documentation directory can also contain runnable contracts and helpers.
const isDocumentationOnly = (path) => !isExecutable(path) && DOCUMENTATION_RULES.some((rule) => rule.test(path));
const isGeneratedData = (path) => GENERATED_DATA_RULES.some((rule) => rule.test(path));
const isServerRunnerFile = (path) => RUNNER_ROOTS.server.some((root) => path.startsWith(root));
const isClientRunnerFile = (path) => RUNNER_ROOTS.client.some((root) => path.startsWith(root));

// Model-capability fixtures ship deliberately broken `*.test.mjs` sandboxes that
// a model is asked to repair. They are data, not suites: no runner collects them,
// and a feature-name match ("models") must not hand one to vitest as a target.
const RUNNER_EXCLUDED_FIXTURES = /^server\/fixtures\//;

const runnerForTest = (path) => {
  if (!isTestFile(path) || RUNNER_EXCLUDED_FIXTURES.test(path)) return null;
  if (isClientRunnerFile(path)) return 'client';
  if (resolveDbTestFiles([path]).length > 0) return 'db';
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

// The cache boundary copies configs/helpers into synthetic checkouts and reads
// launcher arguments as data. Those runtime edges are invisible to Vitest's
// import graph; select their shared contract explicitly instead of running its
// subprocesses on every unrelated or documentation-only change.
const WORKSPACE_CACHE_COMMON_INPUTS = new Set([
  '.github/workflows/ci.yml', '.github/actions/setup-server/action.yml', 'package.json', 'scripts/lib/workspaceCacheFixture.js',
  'scripts/lib/vitestTempRootFixture.js', 'scripts/lib/vitestTempRoot.js',
  'scripts/lib/vitestWatch.js', 'scripts/lib/testProcessAttribution.js', 'scripts/lib/testOwnedProcesses.js', 'scripts/lib/darwinTestProcesses.py',
  'scripts/lib/vitestStaleRunRoots.js', 'scripts/lib/dbTestFiles.js', 'scripts/lib/workspaceTests.js',
  'scripts/vitestCiPool.js', 'scripts/vitestTempRootSetup.js', 'server/lib/killWithEscalation.js',
  'server/test/ownedBrowserDiagnostics.js', 'server/lib/mockPathsDataRoot.js',
]);
const WORKSPACE_CACHE_SERVER_INPUTS = new Set([
  'server/package.json', 'server/package-lock.json',
  'server/vitest.config.js', 'server/vitest.config.db.js', 'server/vitest.setup.js',
  'server/test/admissionSetup.js', 'server/test/mediaRegistryEnvironment.js',
]);
const WORKSPACE_CACHE_CLIENT_INPUTS = new Set([
  'ecosystem.config.cjs', 'client/package.json', 'client/package-lock.json',
  'client/vite.config.js', 'client/vite.buildEnv.js', 'client/vite.chunkGroups.js',
  'client/vitest.config.js', 'client/src/test/timeouts.js', 'scripts/vitestProcessEnvironment.js',
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
  // route-graph guard (a route file nothing mounts) is
  // server/lib/apiRouteGraph.guard.test.js and rides every plan by its name.
  if (changedFiles.some((path) => /^server\/.*\.js$/.test(path) || /^server\/lib\/.*\.generated\.json$/.test(path) || /^client\/src\/services\/api.*\.js$/.test(path))) {
    add('server/lib/apiRouteParity.test.js');
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
  if (changedFiles.some((path) => /^client\/src\/.*\.jsx$/.test(path))) {
    add('client/src/a11y/controlNames.conventions.test.js');
    add('client/src/a11y/dnd.conventions.test.js');
    add('client/src/a11y/fileInputsToasts.conventions.test.js');
    add('client/src/a11y/hitAreas.conventions.test.js');
    add('client/src/a11y/landmarks.conventions.test.js');
    add('client/src/a11y/overlays.conventions.test.js');
    add('client/src/a11y/routeHeadings.conventions.test.js');
    add('client/src/a11y/scanner.conventions.test.js');
  }
  // Both `.js` and `.jsx`: the StrictMode mounted-ref bug the first guard covers
  // reached its widest blast radius through a plain-`.js` hook (`useAsyncAction`),
  // so a `.jsx`-only trigger would miss the case that matters most, and the
  // responsive-grid, popover-clamp, pre-wrap/break, safe-storage, heading-truncation,
  // sub-nav, dashboard-widget container-query, and global-shadow guards read class
  // strings, storage accesses, declarations, and JSX markup out of both extensions.
  // None of these files has a source sibling or imports an app module, so nothing
  // else selects them — without this entry they only ever run on a full suite.
  if (changedFiles.some((path) => /^client\/src\/.*\.jsx?$/.test(path))) {
    // Client tree guards are selected by suffix (getGuardTests);
    // timeouts.guard.test.js scans the TEST files, which this pattern also matches.
    for (const path of getGuardTests()) if (isClientGuard(path)) add(path);
  }

  return selected;
};

const uniqueSorted = (values) => [...new Set(values)].sort();

// Guarded by trackedSet like every other selector: an untracked path handed to
// Vitest as an exact selector makes the run exit non-zero.
const alwaysRunTests = (trackedSet) => getAlwaysRunTests().filter((path) => trackedSet.has(path));

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
const windowsContractTests = (trackedSet) => {
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
const hasWindowsRiskFile = (paths) => paths.some((path) => (
  !isDocumentationOnly(path) && WINDOWS_RISK_RULES.some((rule) => rule.test(path))
));

/**
 * Every FULL_TRIGGER_RULES match in `changed`, each with its Windows relevance
 * resolved (a manifest through its dependency verdict), plus the verdict notes.
 */
function fullTriggersFor(changed, dependencyChanges) {
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
const windowsSelectionFor = (changed, dependencyChanges) => {
  const { fullTriggers, windowsNote } = fullTriggersFor(changed, dependencyChanges);
  return {
    windows: fullTriggers.some((trigger) => trigger.windowsRelevant) || hasWindowsRiskFile(changed),
    windowsNote,
  };
};

const skippedRunner = () => ({ mode: 'skip', files: [], sources: [] });

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

// A scoped runner spread over several shards says why, so the summary never
// reads as a full run.
const fanOutNote = (plan, runner) => {
  const count = plan.shards[runner].length;
  if (plan.full || count === 1) return '';
  const cap = runnerFanOutCap(runner);
  if (plan[runner].files.length <= cap) {
    return `; related import reach of ${plan.reachSelected} suites exceeds the ${MAX_TARGETED_TEST_FILES}-file cap, sharded ${count} ways`;
  }
  return `; ${plan[runner].files.length} selected test files exceed the ${cap}-file cap, sharded ${count} ways`;
};

const suiteReasonsFor = (plan, { appRouteOnly = false } = {}) => ({
  server: plan.server.mode === 'skip'
    ? 'skipped: no server-impacting source changed'
    : plan.full
      ? `full matrix: ${plan.reason}`
      : `always-run cross-install and repository guards${fanOutNote(plan, 'server')}`,
  client: plan.client.mode === 'skip'
    ? 'skipped: no client-impacting source changed'
    : appRouteOnly
      ? `route-only client App.jsx change: related client contracts${fanOutNote(plan, 'client')}`
      : plan.full
        ? `full matrix: ${plan.reason}`
        : `${plan.build ? 'client-impacting source changed' : 'client test and contract coverage selected'}${fanOutNote(plan, 'client')}`,
  browser: plan.browserFiles.length > 0
    ? (plan.full ? `full matrix: ${plan.reason}` : `${plan.browserFiles.length} cross-workspace browser suite(s) selected`)
    : 'skipped: no cross-workspace browser suite selected',
  db: plan.db ? (plan.full ? `full matrix: ${plan.reason}` : 'database-risk source changed') : 'skipped: no database-risk source changed',
  lint: plan.lint.mode === 'skip' ? 'skipped: no changed source needs linting' : plan.full ? `full matrix: ${plan.reason}` : 'changed lintable source',
  build: plan.build ? (plan.full ? `full matrix: ${plan.reason}` : 'client-impacting source changed') : 'skipped: no client-impacting source changed',
  smoke: plan.smoke ? (plan.full ? `full matrix: ${plan.reason}` : 'server-impacting source changed') : 'skipped: no server-impacting source changed',
  windows: !plan.windows
    ? `skipped: no Windows native contract changed${plan.windowsNote ? `; ${plan.windowsNote}` : ''}`
    : `Windows native CLI/TUI and filesystem contracts${plan.full ? ` (full primary plan: ${plan.reason})` : ''}${plan.windowsNote ? `; ${plan.windowsNote}` : ''}`,
});

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
    dockerContainmentLiveInputs = null, serverReach = null, trackedFiles = [],
    gatedChangedFiles = null, gatedDependencyChanges = {},
  } = options;
  const gatedFull = forceFull && Array.isArray(gatedChangedFiles);
  const gateFiles = gatedFull ? uniqueSorted(gatedChangedFiles.filter(Boolean)) : plan.changedFiles;
  // Forced full without a known green base: every gated job runs.
  const gate = (decide) => (forceFull && !gatedFull) || decide(gateFiles);
  // Informational: names the changed source behind a large related selection
  // (#12285). It never changes what runs.
  const reachNote = !plan.full && plan.server.mode === 'related' ? formatReachSummary(serverReach) : '';
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
    gatedWindows = { ...fields, suiteReasons: { ...plan.suiteReasons, windows: suiteReasonsFor({ ...plan, ...fields }).windows } };
  }
  return {
    ...plan,
    ...gatedWindows,
    ...(reachNote ? { suiteReasons: { ...plan.suiteReasons, server: `${plan.suiteReasons.server}; ${reachNote}` } } : {}),
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
  // measureRepoImportReach() report; its `selected` count can fan a server
  // related plan out (see fansOut). null keeps the explicit-selector cap only.
  serverReach = null,
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
  for (const source of jsSources) {
    const namedTests = (pathContractTests[source] || [])
      .filter((path) => trackedSet.has(path) && runnerForTest(path));
    selectedTests.push(...namedTests);
  }

  for (const testFile of trackedFiles.filter(isTestFile)) {
    if (features.some((feature) => pathMatchesFeature(testFile, feature))) {
      selectedTests.push(testFile);
    }
  }

  const serverFiles = uniqueSorted(selectedTests.filter((path) => runnerForTest(path) === 'server'));
  const clientFiles = uniqueSorted(selectedTests.filter((path) => runnerForTest(path) === 'client'));

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
  }, { appRouteOnly, serverReach });
}

/** The derived fields every plan carries: per-suite reasons and shard matrices. */
const finishPlan = (plan, options = {}) => {
  const reachSelected = serverReachCount(options.serverReach);
  const linuxShards = (runner) => shardIndexes(
    fansOut(runner, plan[runner], runner === 'server' ? reachSelected : 0) ? 'full' : plan[runner].mode,
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
    suiteReasons: suiteReasonsFor({ ...plan, shards, reachSelected }, options),
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

// Git's display output quotes non-ASCII/control characters; trimming also
// changes valid paths. Read raw NUL-delimited paths so selectors stay exact.
const gitPaths = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const WORD_RUN_RE = /[A-Za-z0-9_]+/g;
const wordRuns = (text) => text.match(WORD_RUN_RE) ?? [];

/**
 * Tracked test files, read once, answering the reference lookups that used to
 * be one repository-wide `git grep` per changed source (#14866: ~600 sources
 * took minutes). Matching semantics are those of the old `git grep -E`: the
 * same patterns run over the working-tree text of tracked files whose path
 * contains `.test.` / `.spec.` (the `*` in a git pathspec crosses `/`).
 *
 * Each test also keeps its set of maximal word runs. Every pattern here is a
 * word-boundary-delimited literal, so each word run of that literal must
 * appear whole in any file it matches — a necessary condition that rejects
 * nearly every file before the regex runs.
 */
const createTestReferenceIndex = (cwd) => {
  const byPath = new Map();
  for (const path of gitPaths(['ls-files', '-z', '--', ...TEST_FILE_GLOBS], cwd)) {
    let text;
    try {
      text = readFileSync(join(cwd, path), 'utf8');
    } catch (err) {
      // Deleted from the working tree, or a submodule gitlink: git grep skips both.
      if (err.code === 'ENOENT' || err.code === 'EISDIR') continue;
      throw err;
    }
    byPath.set(path, { text, words: new Set(wordRuns(text)) });
  }

  const matcher = (pattern, literal) => {
    const regex = new RegExp(pattern);
    const required = wordRuns(literal);
    return ({ text, words }) => required.every((word) => words.has(word)) && regex.test(text);
  };
  const byBasename = new Map();
  const tokenMatchers = new Map();
  return {
    /** Tests naming `sourcePath` by basename (see sourceReferencePattern), in path order. */
    referencing(sourcePath) {
      const name = basenameOf(sourcePath);
      if (!byBasename.has(name)) {
        const matches = matcher(sourceReferencePattern(sourcePath), name);
        byBasename.set(name, [...byPath].filter(([, entry]) => matches(entry)).map(([path]) => path));
      }
      return byBasename.get(name);
    },
    /** Whether the indexed test at `path` names `token` as a whole identifier-delimited token. */
    mentions(path, token) {
      const entry = byPath.get(path);
      if (!entry) return false;
      if (!tokenMatchers.has(token)) {
        tokenMatchers.set(token, matcher(`(^|[^A-Za-z0-9_])${escapeRegExp(token)}([^A-Za-z0-9_]|$)`, token));
      }
      return tokenMatchers.get(token)(entry);
    },
  };
};

const basenameOf = (path) => path.slice(path.lastIndexOf('/') + 1);

/** Basenames carried by more than one present, executable, non-test source. */
const sharedSourceBasenames = (files) => {
  const seen = new Set();
  const shared = new Set();
  for (const path of files) {
    if (!isExecutable(path) || isTestFile(path)) continue;
    const name = basenameOf(path);
    (seen.has(name) ? shared : seen).add(name);
  }
  return shared;
};

/**
 * Keep the basename hits that plausibly mean THIS copy of a shared basename:
 * a test inside the source's directory subtree (it reaches the file as
 * `./name` or `../name`), or one whose text also names the source's parent
 * directory as a token (`cos-runner`, `aiToolkit`, `join(…, 'imageGen', …)`).
 * A test naming only another directory's `index.js` is dropped; Vitest's
 * import graph still selects every real importer. A repo-root source has no
 * parent to tell copies apart, so it keeps every hit (#11870).
 */
const narrowSharedBasenameHits = (source, hits, index) => {
  const dir = posix.dirname(source);
  if (dir === '.' || hits.length === 0) return hits;
  const parent = basenameOf(dir);
  return hits.filter((path) => path.startsWith(`${dir}/`) || index.mentions(path, parent));
};

/**
 * The impact job's `plan` output. Jobs read a decision as
 * `fromJSON(needs.impact.outputs.plan).<key>`, so values keep their JSON types:
 * booleans are compared bare (`== 'true'` would never match a boolean after
 * fromJSON) and file lists arrive as arrays, which a step hands to a script
 * with `toJSON(...)`. scripts/ci-test-plan.test.js fails when ci.yml reads a
 * key this object does not have.
 */
export function githubPlanOutput(plan) {
  return {
    full: plan.full,
    // Rendered into the step summary's inline code span.
    reason: plan.reason.replace(/[`<>\r\n]+/g, ' '),
    server_mode: plan.server.mode,
    server_files: plan.server.files,
    server_sources: plan.server.sources,
    client_mode: plan.client.mode,
    client_files: plan.client.files,
    client_sources: plan.client.sources,
    // A job-level `if` cannot test an array for emptiness without toJSON.
    browser: plan.browserFiles.length > 0,
    browser_files: plan.browserFiles,
    db: plan.db,
    lint_mode: plan.lint.mode,
    lint_files: plan.lint.files,
    workflow_lint: plan.lint.mode === 'full' || selectWorkflowFiles(plan.lint.files).length > 0,
    build: plan.build,
    smoke: plan.smoke,
    slashdo: plan.slashdo,
    linux_containment: plan.linuxContainment,
    supercollider_live: plan.supercolliderLive,
    docker_containment_live: plan.dockerContainmentLive,
    macos_native: plan.macosNative,
    node_minimum: plan.nodeMinimum,
    native_gated: plan.nativeGated,
    windows: plan.windows,
    windows_mode: plan.windowsMode,
    windows_files: plan.windowsFiles,
    windows_sources: plan.windowsSources,
    suite_reasons: plan.suiteReasons,
  };
}

/** The impact job's step summary for one plan; `gatedBaseSha` is the push's last green base, if any. */
export function formatPlanSummary(output, shards, gatedBaseSha) {
  const value = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
  const code = (v) => `\`${value(v)}\``;
  return [
    '### CI impact plan',
    '',
    `- Reason: ${code(output.reason)}`,
    `- Server tests: ${code(output.server_mode)} (shards ${code(shards.server)})`,
    `- Client tests: ${code(output.client_mode)} (shards ${code(shards.client)})`,
    `- DB tests: ${code(output.db)}`,
    `- Cross-workspace browser suites: ${code(output.browser_files)} (shards ${code(shards.browser)})`,
    `- Client lint: ${code(output.lint_mode)}`,
    `- Client build: ${code(output.build)}`,
    `- Server smoke: ${code(output.smoke)}`,
    `- Slashdo submodule: ${code(output.slashdo)}`,
    `- Linux worker containment: ${code(output.linux_containment)}`,
    `- SuperCollider live containment: ${code(output.supercollider_live)}`,
    `- Docker containment live: ${code(output.docker_containment_live)}`,
    `- macOS native release-agent supervision: ${code(output.macos_native)}`,
    `- Node minimum compatibility: ${code(output.node_minimum)}`,
    `- Windows server tests: ${code(output.windows)} (${code(output.windows_mode)}, shards ${code(shards.windows)})`,
    `- Native jobs gated against last green main run: ${code(gatedBaseSha || 'none')}`,
    `- Suite selection reasons: ${code(output.suite_reasons)}`,
  ].join('\n');
}

export function emitGitHubPlan(plan, { gatedBaseSha } = {}) {
  if (plan.windows && plan.windowsFiles.length === 0) throw new Error('Windows native contract inventory is empty');
  if (plan.windows) {
    const missing = WINDOWS_CONTRACT_TESTS.filter(path => !plan.windowsFiles.includes(path));
    if (missing.length) throw new Error(`Windows native contract inventory is missing: ${missing.join(', ')}`);
  }
  const output = githubPlanOutput(plan);
  writeStepOutput('plan', JSON.stringify(output));
  // Separate outputs because `strategy.matrix` needs a bare JSON array: each
  // leaf job's matrix is `fromJSON(needs.impact.outputs.<suite>_shards)`.
  writeStepOutput('server_shards', JSON.stringify(plan.shards.server));
  writeStepOutput('client_shards', JSON.stringify(plan.shards.client));
  writeStepOutput('browser_shards', JSON.stringify(plan.shards.browser));
  writeStepOutput('windows_shards', JSON.stringify(plan.shards.windows));
  writeStepSummary(formatPlanSummary(output, plan.shards, gatedBaseSha));
  console.log(JSON.stringify({
    ...output,
    server_shards: plan.shards.server,
    client_shards: plan.shards.client,
    browser_shards: plan.shards.browser,
    windows_shards: plan.shards.windows,
    changed_files: plan.changedFiles,
  }, null, 2));
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

// Computed `import(expr)` sites whose target set is fixed and enumerable. The
// directory sites contribute every tracked module under the directory as edges;
// `external` sites load a package or untracked submodule, which no tracked-file
// edge can represent. A file with any other computed import stays inconclusive
// only if it is not listed here, so adding a new unbounded site to a listed
// file means extending this table deliberately.
// Numbered migrations only: `_helpers`, fixtures and guard tests share the
// directories but are never loaded by the runners.
const MIGRATION_FILE_RE = /\/\d+-[^/]*\.js$/;
const BOUNDED_DYNAMIC_IMPORTS = {
  'scripts/run-migrations.js': { directory: 'scripts/migrations/', pattern: MIGRATION_FILE_RE },
  'server/scripts/run-db-migrations.js': { directory: 'server/scripts/db-migrations/', pattern: MIGRATION_FILE_RE },
  'server/services/eidoverseControllerRegistry.js': {
    directory: 'server/services/eidoverseControllerDefinitions/', pattern: /\.controller\.js$/,
  },
  'server/lib/slashdoLoader.js': { external: true },
  'server/services/greyboxCapturePage.js': { external: true },
};

// Browser suites resolve vite and its plugins through resolveClientBundler or
// the client's require, i.e. packages outside the tracked-file graph.
const CLIENT_BUNDLER_IMPORT_RE = /\bresolveClientBundler\b|\brequireClient\.resolve\(/;

// A collection owns its snapshot: each source is read and each prerequisite
// edge is resolved once, even when many browser suites reach the same module.
// Never retain this across collections: local pregate must see the next edit.
function createDependencySnapshot(files, cwd) {
  const known = new Set(files);
  const sources = new Map();
  const imports = new Map();
  const staticEdges = new Map();
  const testEdges = new Map();
  const extensions = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts', '.json'];
  const readText = (file) => {
    if (!sources.has(file)) {
      try {
        sources.set(file, { text: readFileSync(join(cwd, file), 'utf8') });
      } catch (error) {
        sources.set(file, { error });
      }
    }
    const source = sources.get(file);
    if (source.error) throw source.error;
    return source.text;
  };
  const resolve = (file, specifiers) => {
    const dependencies = [];
    let inconclusive = false;
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) continue;
      const path = posix.normalize(posix.join(posix.dirname(file), specifier.split(/[?#]/)[0]));
      // Preserve all candidates when extensions collide, not a guessed bundler precedence.
      const candidates = [path, ...extensions.map((extension) => `${path}${extension}`),
        ...extensions.map((extension) => `${path}/index${extension}`)].filter((candidate) => known.has(candidate));
      if (candidates.length === 0) inconclusive = true;
      dependencies.push(...candidates);
    }
    return { dependencies, inconclusive };
  };
  const importsFor = (file) => {
    if (!imports.has(file)) imports.set(file, moduleImports(readText(file), { jsx: !/\.[cm]?ts$/.test(file) }));
    return imports.get(file);
  };
  const staticDependencies = (file) => {
    if (!staticEdges.has(file)) {
      staticEdges.set(file, resolve(file, importsFor(file).statics));
    }
    return staticEdges.get(file);
  };
  const testDependencies = (file) => {
    if (!testEdges.has(file)) {
      const { deferred, computed } = importsFor(file);
      const statics = staticDependencies(file);
      const dynamic = resolve(file, deferred);
      const bounded = computed ? boundedComputedImports(file) : null;
      testEdges.set(file, {
        dependencies: [...statics.dependencies, ...dynamic.dependencies, ...(bounded?.dependencies ?? [])],
        inconclusive: (computed && !bounded) || statics.inconclusive || dynamic.inconclusive,
      });
    }
    return testEdges.get(file);
  };
  const boundedComputedImports = (file) => {
    const site = BOUNDED_DYNAMIC_IMPORTS[file];
    if (site?.directory) {
      return { dependencies: files.filter((path) => path.startsWith(site.directory) && site.pattern.test(path)) };
    }
    if (site?.external || CLIENT_BUNDLER_IMPORT_RE.test(readText(file))) return { dependencies: [] };
    return null;
  };
  return { readText, staticDependencies, testDependencies };
}

function isSharedClientDependency(path) {
  return path.startsWith('server/lib/') || path.startsWith('scripts/lib/');
}

// Start from every browser source, including lazy-loaded pages, then follow
// relative static imports and re-exports across directory boundaries. Unresolved
// edges must widen CI rather than disappearing from a negative graph walk.
function collectClientDependencies(files, snapshot) {
  const entries = files.filter((path) => path.startsWith('client/src/')
    && MODULE_SOURCE_RE.test(path) && !isTestFile(path));
  const closure = collectTestDependencies(entries, snapshot.staticDependencies);
  return closure?.filter((path) => path.startsWith('server/lib/')) ?? null;
}

// Project DB and browser consumers without importing test code or Vitest (the
// planner runs before npm installation). Deferred literals participate; unreadable,
// unresolved and computed imports retain conservative prerequisite coverage.
function collectTestDependencies(entries, dependenciesFor) {
  const pending = [...entries];
  const seen = new Set();
  let inconclusive = false;
  try {
    for (let index = 0; index < pending.length; index++) {
      const file = pending[index];
      if (seen.has(file)) continue;
      seen.add(file);
      if (!MODULE_SOURCE_RE.test(file)) continue;
      const edges = dependenciesFor(file);
      if (edges.inconclusive) inconclusive = true;
      pending.push(...edges.dependencies);
    }
  } catch {
    return null;
  }
  return inconclusive ? null : uniqueSorted([...seen]);
}

/**
 * Collect the repository-derived inputs that surround the pure plan builder.
 *
 * CI leaves `changedFiles` unset and keeps deriving its diff from baseSha. A
 * local caller may supply the complete committed + working-tree path list; in
 * that mode files present but not yet tracked are plan inputs too, while paths
 * deleted from the working tree are deliberately absent from trackedFiles.
 *
 * `gatedBaseSha` (forced-full runs only) is a commit whose tree passed a
 * complete CI run; the path-gated jobs are then decided from the tree diff
 * against it. A diff that git cannot produce leaves `gatedChangedFiles` null,
 * which runs every gated job.
 */
export function collectPlanInputs({ baseSha, forceFull = false, changedFiles, gatedBaseSha, cwd = process.cwd() }) {
  const hasChangedFilesOverride = changedFiles !== undefined;
  const collectedChangedFiles = forceFull
    ? []
    : hasChangedFilesOverride
      ? changedFiles
      : gitPaths(['diff', '-z', '--name-only', '--diff-filter=ACMRD', `${baseSha}...HEAD`], cwd);
  const trackedFiles = gitPaths(['ls-files', '-z'], cwd);
  const presentFiles = hasChangedFilesOverride
    ? uniqueSorted([
      ...trackedFiles,
      ...collectedChangedFiles.filter((path) => existsSync(join(cwd, path))),
    ]).filter((path) => existsSync(join(cwd, path)))
    : trackedFiles;

  // Present, non-ignored untracked sources are real local imports: without them
  // a tracked importer of a not-yet-staged module looks unresolved and the
  // dependency walk fails closed to a full plan. Local override mode only —
  // committed CI inputs stay tracked-only.
  const untrackedFiles = hasChangedFilesOverride
    ? gitPaths(['ls-files', '-z', '--others', '--exclude-standard'], cwd).filter((path) => existsSync(join(cwd, path)))
    : [];

  let appDiff = null;
  if (!forceFull && collectedChangedFiles.includes('client/src/App.jsx')) {
    const committedDiff = execFileSync(
      'git', ['diff', '--unified=0', `${baseSha}...HEAD`, '--', 'client/src/App.jsx'],
      { cwd, encoding: 'utf8' },
    );
    const workingTreeDiff = hasChangedFilesOverride
      ? execFileSync('git', ['diff', '--unified=0', 'HEAD', '--', 'client/src/App.jsx'], { cwd, encoding: 'utf8' })
      : '';
    appDiff = `${committedDiff}${workingTreeDiff}`;
  }

  // Every changed executable, non-test source — not only python scripts — gets
  // a basename lookup: looking up tracked test files that name its filename finds
  // the text-reading contract tests (mirror parity, navManifest.js's 20+ client
  // reads) that no import edge or feature-directory match can reach. Basename
  // matching is deliberate: a mirror test names the client copy only as e.g.
  // 'canonPrompt.js', never by its full path. Under-selection is the bug this
  // closes (issue #6363), but over-selection is not free: every hit is an
  // explicit selector, and a broad selection fans the runner out across shards.
  // A basename several tracked sources share (42 `index.js`) is narrowed by
  // narrowSharedBasenameHits (#11870).
  const changedSources = collectedChangedFiles.filter((path) => isExecutable(path) && !isTestFile(path));
  const sharedBasenames = changedSources.length > 0 ? sharedSourceBasenames(presentFiles) : new Set();
  const testIndex = changedSources.length > 0 ? createTestReferenceIndex(cwd) : null;
  const pathContractTests = Object.fromEntries(changedSources.map((path) => {
    const hits = testIndex.referencing(path);
    return [path, sharedBasenames.has(basenameOf(path)) ? narrowSharedBasenameHits(path, hits, testIndex) : hits];
  }));

  const dependencyFiles = hasChangedFilesOverride ? uniqueSorted([...presentFiles, ...untrackedFiles]) : presentFiles;
  const snapshot = createDependencySnapshot(dependencyFiles, cwd);
  const clientDependencies = collectedChangedFiles.some((path) => path.startsWith('server/lib/')
    && isExecutable(path) && !isTestFile(path))
    ? collectClientDependencies(dependencyFiles, snapshot)
    : [];

  // Include test fixtures and literal deferred imports, unlike the production
  // projection. Keep uncertainty per test so one unresolved/computed fixture
  // retains its consumer without widening every resolved test.
  const clientTestDependencies = collectedChangedFiles.some((path) => isSharedClientDependency(path)
    && isExecutable(path) && !isTestFile(path))
    ? Object.fromEntries(dependencyFiles.filter((path) => path.startsWith('client/src/')
      && isTestFile(path)).map((test) => [test,
      collectTestDependencies([test], snapshot.testDependencies)?.filter(isSharedClientDependency) ?? null]))
    : {};

  const hasRelatedServerSource = collectedChangedFiles.some((path) => isServerRunnerFile(path)
    && MODULE_SOURCE_RE.test(path) && !isTestFile(path));
  const dbDependencies = hasRelatedServerSource
    ? collectTestDependencies(resolveDbTestFiles(dependencyFiles), snapshot.testDependencies)
    : [];
  const browserDependencies = hasRelatedServerSource
    ? Object.fromEntries(browserSuitesIn(presentFiles).map((suite) => [suite,
      collectTestDependencies([suite], snapshot.testDependencies)]))
    : {};

  // Each changed manifest at the diff base vs the tree under test (the working
  // tree: HEAD in CI, HEAD plus local edits under pregate). The base commit is
  // inside the depth-2 checkout, so `git show` resolves it; any read failure
  // becomes null, which classifyDependencyChange() treats as escalation.
  const readAt = (sha, path) => {
    try {
      return execFileSync('git', ['show', `${sha}:${path}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    } catch {
      return null;
    }
  };
  const readAtBase = (path) => readAt(baseSha, path);
  const readInTree = (path) => {
    try {
      return readFileSync(join(cwd, path), 'utf8');
    } catch {
      return null;
    }
  };
  const dependencyChanges = Object.fromEntries(collectedChangedFiles
    .filter((path) => DEPENDENCY_MANIFEST_RE.test(path))
    .map((path) => [path, classifyDependencyChange(path, baseSha ? readAtBase(path) : null, readInTree(path))]));

  // `vitest related` follows dynamic imports too; report that fan-out per
  // changed server source so the selection size is attributable. A failed
  // walk only loses the note.
  let serverReach = null;
  if (hasRelatedServerSource) {
    try {
      serverReach = measureRepoImportReach({
        cwd,
        files: dependencyFiles,
        readText: snapshot.readText,
        sources: collectedChangedFiles.filter((path) => isServerRunnerFile(path)
          && MODULE_SOURCE_RE.test(path) && !isTestFile(path)),
      });
    } catch (err) {
      console.warn(`⚠️ Dynamic-aware reach not measured: ${err.message}`);
    }
  }

  // Two-dot: a tree comparison, so the base need not be an ancestor of HEAD
  // and needs no merge base in the shallow clone. --no-renames lists a renamed
  // file under both paths, so a renamed job entry point still selects its job.
  let gatedChangedFiles = null;
  let gatedDependencyChanges = {};
  if (forceFull && gatedBaseSha) {
    try {
      gatedChangedFiles = gitPaths(['diff', '-z', '--name-only', '--no-renames', gatedBaseSha, 'HEAD'], cwd);
      gatedDependencyChanges = Object.fromEntries(gatedChangedFiles
        .filter((path) => DEPENDENCY_MANIFEST_RE.test(path))
        .map((path) => [path, classifyDependencyChange(path, readAt(gatedBaseSha, path), readInTree(path))]));
    } catch (err) {
      console.warn(`⚠️ No diff against the last green main run (${err.message.split('\n')[0]}); every native job runs`);
      gatedChangedFiles = null;
    }
  }

  // A forced-full run with no gated diff runs every gated job, so it skips the walks.
  const walkGates = !forceFull || gatedChangedFiles !== null;
  const linuxContainmentInputs = walkGates ? collectLinuxContainmentInputs(cwd) : null;
  const supercolliderLiveInputs = walkGates ? collectSuperColliderLiveInputs(cwd) : null;
  const dockerContainmentLiveInputs = walkGates ? collectDockerContainmentLiveInputs(cwd) : null;

  return { changedFiles: collectedChangedFiles, trackedFiles: presentFiles, appDiff, pathContractTests,
    clientDependencies, clientTestDependencies, dbDependencies, browserDependencies, dependencyChanges,
    linuxContainmentInputs, supercolliderLiveInputs, dockerContainmentLiveInputs, serverReach, gatedChangedFiles, gatedDependencyChanges };
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
    gatedChangedFiles, gatedDependencyChanges,
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
    gatedChangedFiles,
    gatedDependencyChanges,
  });
  emitGitHubPlan(plan, { gatedBaseSha });
}

if (isDirectlyInvoked(import.meta.url)) main();
