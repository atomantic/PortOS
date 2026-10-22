#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, posix, relative } from 'path';
import { staticImportClosure, staticImportSpecifiersFromSource, toModuleKey } from '../server/lib/staticImportGraph.js';
import { escapeRegExp } from '../server/lib/textUtils.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { writeStepOutput } from './lib/githubOutput.js';
import { resolveDbTestFiles } from './lib/dbTestFiles.js';
import { BROWSER_SUITES } from './lib/browserSuites.js';
import { ATTESTABLE_STAGES, selectAttestation } from './lib/pregateAttestation.js';
import { formatReachSummary, measureRepoImportReach } from './lib/importReach.js';
import { declaresPromptHashes, isNumberedMigrationFile } from './migrations/shippedPromptHistory.js';

const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const MODULE_SOURCE_RE = /\.[cm]?[jt]sx?$/i;
// `git grep` pathspecs matching every extension TEST_FILE_RE recognizes. A
// hardcoded `*.test.js`/`.jsx` pair would silently stop finding a `.test.ts(x)`
// or `.spec.*` contract test added later, reopening the exact under-selection
// bug the basename lookup below exists to close — the later trackedSet +
// runnerForTest(isTestFile) filter already narrows a broad hit back down, so
// over-matching here costs nothing.
const TEST_FILE_GLOBS = ['*.test.*', '*.spec.*'];
// The server tree is linted whole (fast, ~1s) by the same Biome the client installs,
// so any server JavaScript or its lint config selects the lint job.
const CLIENT_LINT_RE = /^client\/src\/.*\.(?:js|jsx)$/i;
const SERVER_LINT_RE = /^server\/(?!node_modules\/).*\.(?:m?js)$|^server\/biome\.jsonc$/i;
const isLintSurface = (path) => CLIENT_LINT_RE.test(path) || SERVER_LINT_RE.test(path);
const EXECUTABLE_RE = /\.(?:cjs|css|html|js|jsx|json|mjs|sql|ts|tsx|ya?ml)$/i;
const MAX_CHANGED_CODE_FILES = 30;
// Explicit selectors one runner carries before its scoped plan fans out across
// the full-suite shard matrix. It used to escalate the whole repository to a
// full plan; over-selection is a capacity limit, not a risk signal, so the
// selection now stays exactly as computed and only execution is partitioned
// (#11871). 125 is that former full-plan threshold (#10312).
export const MAX_TARGETED_TEST_FILES = 125;

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
export const FULL_SUITE_SHARDS = { server: 2, client: 3, windows: 3 };

/** Matrix values for one runner: every shard on a full run, one otherwise. */
export const shardIndexes = (mode, count) => (
  mode === 'full' ? Array.from({ length: count }, (_, index) => index + 1) : [1]
);

/**
 * Whether a scoped Linux runner fans out across its full-suite shard count.
 *
 * - Over MAX_TARGETED_TEST_FILES explicit selectors: either runner, either mode.
 * - Server `related` mode: always. Its import-graph fan-out is unbounded by the
 *   explicit count (#9999: 57 selectors became ~941 files), and scoped server
 *   runs took 6.1 min median / 9.4 p90 on one runner. Each shard repeats
 *   Vitest's related-graph pass, which is the Windows job's existing trade.
 *   Client related plans stay on one runner unless over the cap.
 * - Exact-file plans under the cap stay on one runner: they run in seconds.
 *
 * Vitest throws when the shard count exceeds the files it resolved
 * (`--shard <count> must be a smaller than count of test files`). Every
 * explicit selector is in the resolved set — `vitest related` selects a test
 * file passed as input — so the floor counts explicit files the Linux runner
 * does not exclude (DB suites run in their own job, browser suites in theirs).
 * Below the floor the runner stays on one shard.
 */
const fansOut = (runner, { mode, files }, excludedFiles) => {
  if (mode === 'skip' || mode === 'full') return false;
  const runnable = files.filter((path) => !excludedFiles.has(path));
  if (runnable.length < FULL_SUITE_SHARDS[runner]) return false;
  return files.length > MAX_TARGETED_TEST_FILES || (runner === 'server' && mode === 'related');
};

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
 * Should a change to one dependency manifest run the complete Windows suite?
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
  return `${path} ${escalate ? 'escalates Windows' : 'keeps the Windows baseline'}: ${reason}${named ? ` (${named})` : ''}`;
};

// `windowsEscalates` decides whether a trigger widens the WINDOWS job too, not
// only the Linux ones. Three windows-server shards are 3 of a full run's 12
// jobs and 41% of its runner-minutes (58% at GitHub's 2x windows-latest
// multiplier, which this public repo does not pay but a privately-billed fork
// does), so a trigger that widens CI for a reason windows-server cannot
// observe — a client build/lint/test-setup file it never loads — spends that
// on coverage which does not exist. Those run the WINDOWS_CONTRACT_TESTS
// baseline instead, the depth a Windows-risk scoped PR already gets. `true` is
// the fail-closed default for anything unlisted, and a diff touching
// WINDOWS_RISK_RULES escalates regardless of this flag (issue #7440).
//
// `windowsEscalates: 'dependencies'` defers the decision to the diff of the
// manifest itself (classifyDependencyChange): a pure-JS version bump installs
// the same files on every platform, so the full Linux matrix covers it and
// Windows runs the baseline. A native, install-script, os/cpu-gated or optional
// package, an `engines`/`overrides`/non-dependency field change, or a manifest
// the planner could not read and compare escalates Windows.
const FULL_TRIGGER_RULES = [
  // Defines the windows-server job itself.
  { re: /^\.github\/workflows\//, reason: 'workflow definition changed', windowsEscalates: true },
  { re: DEPENDENCY_MANIFEST_RE, reason: 'dependency manifest changed', windowsEscalates: 'dependencies' },
  // Every workspace's .npmrc pins ignore-scripts and install behavior; npm reads
  // it on the Windows install too.
  { re: /(?:^|\/)\.npmrc$/, reason: 'npm configuration changed', windowsEscalates: true },
  { re: /^(?:server|client)\/vitest\.config(?:\.db)?\.js$/, reason: 'test runner configuration changed', windowsEscalates: true },
  { re: /^scripts\/vitestCiPool(?:\.test)?\.js$/, reason: 'test runner pool configuration changed', windowsEscalates: true },
  { re: /^server\/vitest\.setup\.js$/, reason: 'server test setup changed', windowsEscalates: true },
  // Client-only: windows-server never loads the client setup file.
  { re: /^client\/src\/test\/setup\.js$/, reason: 'client test setup changed', windowsEscalates: false },
  // Biome config + its GritQL plugins (the former client/eslint.config.js). The
  // .grit files carry real enforced rules — notably the crypto.randomUUID ban —
  // so a change there is as load-bearing as a change to the config itself. It
  // is still a client-lint surface, and the Windows job runs no lint.
  { re: /^client\/(?:biome\.jsonc|[^/]+\.grit)$/, reason: 'lint configuration changed', windowsEscalates: false },
  // Client-only: the Windows job builds no client bundle.
  { re: /^client\/vite\.config\.js$/, reason: 'client build configuration changed', windowsEscalates: false },
  { re: /^server\/index\.js$/, reason: 'server composition root changed', windowsEscalates: true },
  // Widely imported, but pure cross-platform schema logic: no spawn, path or
  // filesystem semantics that pinPlatform() stubs cannot cover on Linux.
  { re: /^server\/lib\/(?:schemaVersions|validation)\.js$/, reason: 'shared server contract changed', windowsEscalates: false },
  // Measured hotspot (#9999): a two-file worktreeManager change expanded through
  // import consumers to 57 selectors and a ~941-file local run, yet counted as
  // a "scoped" plan because MAX_TARGETED_TEST_FILES only sees explicit selectors.
  // Own the cost honestly: a full plan, sharded in CI. It also owns cross-platform
  // worktree lifecycle, so Windows escalates (matches WINDOWS_RISK_RULES).
  { re: /^server\/services\/worktreeManager\.js$/, reason: 'worktree manager source changed (broad import fanout)', windowsEscalates: true },
  // Measured log socket hotspot (#10030): changing this source fans out through
  // nearly the full server suite, so make the cost explicit in CI. The socket
  // starts and supervises a real PM2 child process; keep Windows at full depth.
  { re: /^server\/sockets\/logs\.js$/, reason: 'log socket source changed (broad import fanout)', windowsEscalates: true },
  // The scripts that decide what CI runs, run it, and gate the release on it.
  // A bug in any of them can make a scoped plan silently test nothing, so they
  // prove themselves against the complete suite rather than their own scope —
  // including on Windows, whose shard matrix ci-test-plan.js itself emits.
  { re: /^scripts\/(?:lib\/githubOutput|ci-base-sha|ci-test-plan|run-ci-(?:lint|tests)|scan-diff-hidden-content|verify-ci-status)(?:\.test)?\.js$/, reason: 'CI pipeline script changed', windowsEscalates: true },
];

// Files whose Windows behavior is not faithfully exercised by pinPlatform()
// stubs on Linux: real .cmd spawn, PowerShell BOM, PTY wrap, path.basename
// on backslashes. A PR that does not touch these still gets a full Windows
// run nightly, on the main -> release PR, and on release.
export const WINDOWS_RISK_RULES = [
  /\.(?:ps1|cmd|bat)$/i,
  /^scripts\/fix-windows-console(?:\.test)?\.js$/,
  /^scripts\/ps1-bom\.test\.js$/,
  /^server\/lib\/(?:bufferedSpawn|detachedSpawn|childProcess|bashResolver|processEnv|platform|spawnCwd|cliProviderRun|grok)\b/,
  // The cmd.exe wrap and npm-shim bypass every Windows CLI launch goes through.
  /^server\/lib\/aiToolkit\/internal\/windowsSafeSpawn\.js$/,
  // Path SEMANTICS differ per platform in ways pinPlatform() cannot fake: NTFS
  // and APFS are case-insensitive while ext4 is not, and git reports paths its
  // own way (drive-letter case, 8.3 short names like C:\Users\RUNNER~1). A
  // case-sensitive containment check therefore passed on Linux while reporting a
  // managed worktree as unmanaged on Windows, and the reaper silently skipped it
  // — green everywhere CI looked. These modules decide containment and worktree
  // identity, so they need a real Windows run.
  /^server\/lib\/(?:pathSafety|worktreeOwnership)(?:\.test)?\.js$/,
  // Fail-fast fixture removal raced continuing writes on Windows (#11641).
  // Exercise the ownership helper and affected fixture on the real filesystem.
  /^server\/lib\/mockPathsDataRoot(?:\.test)?\.js$/,
  /^server\/services\/cosAgentIndex\.completionOrder\.test\.js$/,
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
  /^server\/services\/htmlComposition\/ownedBrowser(?:\.test)?\.js$/,
  /^server\/services\/autonomousJobs\/execution\.shellSpawn/,
  // The voice fine-tuning service spawns a real Python trainer and settles the
  // job from its `close`/`error` events, so its assertions are the child-process
  // contract, not platform-independent logic. Nothing here was Windows-tagged,
  // so the shard only saw it on a full-matrix run — which is where it failed,
  // with an interpreter-startup budget mistaken for a state-machine defect
  // (#6268).
  /^server\/services\/voice\/fineTuning(?:\.test)?\.js$/,
  /^server\/services\/imageGen\/codex(?:\.test)?\.js$/,
  /^server\/routes\/apps\//,
  /^server\/routes\/scaffoldVite\.js$/,
];

// These are the cross-platform contracts that cannot be faithfully simulated
// by pinning process.platform on Linux. For a Windows-risk PR, Vitest also
// adds import-graph-related tests for the diff; this stable baseline catches
// spawn, shell, PowerShell, PTY, and path regressions without rerunning every
// platform-independent server assertion. Full CI still runs the entire suite.
export const WINDOWS_CONTRACT_TESTS = [
  'server/services/htmlComposition/ownedBrowser.test.js',
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
  // Doc-parity guards: each compares a .md next to it against source it reads
  // rather than imports. The .md is documentation-only to the planner and the
  // source has no import edge to the guard, so neither side of the comparison
  // can select it — a docs-only PR that documented a removed endpoint would
  // otherwise merge green.
  'docs/api-doc.test.js',
  'docs/auth-public-paths-doc.test.js',
  'docs/doc-endpoint-methods.test.js',
  'docs/docs-index.test.js',
  'docs/deps-doc.test.js',
  'docs/features/product-surfaces.test.js',
  'scripts/agent-instructions-files.test.js',
  'scripts/doc-code-pointers.test.js',
  // Whole-tree scanner: a new browser suite can adopt the gate with no import
  // edge back to the registry it must join (#10312).
  'scripts/browser-suite-registry.test.js',
  // The union-merged catalogs are `.md` to the planner — documentation-only —
  // so a rebase that doubled a row would otherwise never be re-checked.
  'scripts/catalog-merge-union.test.js',
  // Walks the client→server/lib import graph; any server/lib file can add a
  // Node-only import and break the client build with no edge back to here.
  'scripts/client-server-import-purity.test.js',
  'scripts/direct-invocation-drift.test.js',
  'scripts/ensure-deps.test.js',
  'scripts/migrations/promptBumpMigrations.guard.test.js',
  'scripts/migrations/shippedPromptHistory.guard.test.js',
  // Sweeps every migration export against independent prompt-hash baselines;
  // migration files have no import edge back to this guard.
  'scripts/setup-data-drift.test.js',
  'scripts/node-version-drift.test.js',
  // Whole-tree markdown scanner: a docs-only PR can reintroduce the stale band
  // in prose with no import edge back to this test (#11851).
  'scripts/port-band-docs.test.js',
  'scripts/repo-scan-guards.test.js',
  // Whole-tree scanner: any server file can add an import of client source.
  'scripts/server-imports-no-client.test.js',
  'scripts/tailnet-identity-leak.test.js',
  'server/dependency-overrides.test.js',
  // Whole-tree scanner: a caller can disappear from any file without touching its export.
  'server/deadExports.test.js',
  // Whole-tree scanner: any server file can add a `process.env` read, and
  // `.env.example` itself is not a scope the selector routes to a runner.
  'server/envExampleDrift.test.js',
  // Whole-tree scanner (#12093): any rename or deletion can strand a backticked
  // file name in an AGENTS.md, which is documentation-only to the planner.
  'server/instructionFileReferences.test.js',
  // Whole-tree scanners over the shared collectServerSources/collectClientSources
  // walkers (#8723): the offending file is never imported by the guard, so
  // impact selection only reaches them when the guard itself changes.
  'server/lib/apiRouteGraph.test.js',
  // Whole-tree scanner (#9982): any server module can start taking backup
  // admission with no import edge back to the owner inventory it must join.
  'server/lib/backupAssetOwners.test.js',
  'server/lib/childProcess.guards.test.js',
  'server/lib/cliChildEnv.test.js',
  'server/lib/editorial/proseTics.test.js',
  'server/lib/generatedManifests.test.js',
  // Whole-tree scanner over git-tracked test files (#9000): a suite anywhere
  // in server/scripts/lib/autofixer can add a leaked mkdtemp call with no
  // import edge back to this guard.
  'server/lib/mkdtempCleanup.guards.test.js',
  // Base-relative server import-growth guard (#7993). A new eager edge in a
  // widely reached module multiplies across suites this file does not import,
  // so impact selection would not reach it unless the diff touched this file.
  // Docs-only plans and rebases onto a moved base still need the comparison. It reads
  // CI_BASE_SHA — the same variable main() requires for a pull request that
  // is not forced full — and fails closed when that commit cannot be read.
  // Pregate copies the sha into the test process so the local run uses this
  // plan's base, not a second guess.
  'server/lib/importScoping.test.js',
  // Whole-tree scanner over collectServerSources: every cwd-passing spawn pins PWD (#8723).
  'server/lib/spawnCwd.test.js',
  // Whole-tree scanner: any server/client file can add a hardcoded "Models →"
  // breadcrumb, with no import edge back to this file.
  'server/lib/localProviderRuntime.test.js',
  'server/lib/qwenAgentParsers.test.js',
  'server/lib/testDataIsolation.guards.test.js',
  'server/lib/testHelper.test.js',
  // Whole-tree scanner: any server/client file can re-inline a RegExp escape (#8723).
  'server/lib/textUtils.test.js',
  // Whole-tree scanner: any server file can log a failure through
  // `console.log`, and the guard only ever sees it as a path string.
  'server/logLevelConventions.test.js',
  // Whole-tree scanner: a module moved between directories leaves a stale cited
  // path in some comment, with no import edge to this guard (#12408).
  'server/sourceFileReferences.test.js',
  // Whole-tree scanner: a renamed export in any module leaves a dead key in some
  // suite's vi.mock factory, with no import edge from that suite to this guard (#11891).
  'server/mockContractConventions.test.js',
  // Whole-tree scanner over git-tracked tests (#12047): any suite can add a
  // real sleep before a not-called assertion with no import edge to this guard.
  'server/negativeProofSleepConventions.test.js',
  // Whole-tree scanner: any server file can spawn a child and await before
  // attaching its error/exit listener (#11761), with no import edge to this file.
  'server/childListenerOrderConventions.test.js',
  // Whole-tree scanner: any server/autofixer file can re-implement raw
  // `pm2 jlist` execution/parsing outside the two designated readers (#8164).
  'server/pm2JlistOwnership.guard.test.js',
  'server/services/imageGen/renderTargets.guard.test.js',
  // Whole-tree scanners over collectServerSources (#8723).
  'server/services/gitlab.glabFlags.test.js',
  'server/services/orphanedPartialGc.test.js',
  'server/services/providers.shape.test.js',
  'server/services/taskPromptDefaults.test.js',
  // Base-relative retired history guard: JSON edits have no import edge here.
  // Pregate and CI forward the planner's exact CI_BASE_SHA.
  'server/services/taskPromptDefaults/integritySnapshot.guard.test.js',
  // Whole-tree scanner (#12048): server/index.js can mount a new router that no
  // test imports, with no import edge from that router to this guard.
  'server/routeTestCoverageConventions.test.js',
  // Whole-tree scanner (#12952): server/index.js can mount a mutating route that
  // no host-control classification names, with no import edge to this guard.
  'server/hostControlCoverage.test.js',
  'server/routeValidationConventions.test.js',
  'server/floatingAsyncConventions.test.js',
  'server/timerCallbackConventions.test.js',
  // Whole-tree scanner (#12815): any server file can bind a bare JSON.stringify to
  // a jsonb parameter, with no import edge to this guard.
  'server/pgJsonConventions.test.js',
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
    re: /^server\/services\/promptSections\/__snapshots__\/reviewLoopMatrix\/[^/]+\.txt$/,
    dir: 'server/services/promptSections/__snapshots__/reviewLoopMatrix',
    tests: ['server/services/promptSections/reviewLifecycleMatrix.test.js'],
  },
  // Pip pins consumed only by an explicit Install/Repair (`setup-image-video.sh`).
  // No Vitest suite reads the files; the installer-contract tests are the suites
  // that exercise that script and server/lib/pythonSetup.js.
  {
    re: /^scripts\/requirements-[^/]+\.txt$/,
    dir: 'scripts',
    fileRe: /^requirements-[^/]+\.txt$/,
    tests: [
      'scripts/setup-image-video.test.js',
      'server/lib/pythonSetup.install.test.js',
      'server/lib/pythonSetup.test.js',
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

// Three narrow CI jobs observe a small, enumerable input set, so a pull request
// that touches none of it skips them (non-PR and release-base runs are forced
// full and always run all three). Each gate is the head tree's static import
// closure of the job's entry points, computed per run so it cannot drift from
// a hand-kept list, plus the non-module inputs named by the pattern. ci.yml is
// in both patterns so a workflow edit proves the job still runs.
export const PROMPT_HISTORY_GUARD = 'scripts/migrations/check-shipped-prompt-history.js';
// The guard reads git history of data.reference/prompts/stages and imports the
// migrations that declare prompt hashes. The whole migrations directory is
// listed (not just today's declaring modules) so a diff that removes a
// declaration still runs the guard. taskPromptDefaults and the snapshot
// regenerator are the other half of a prompt-default bump.
export const PROMPT_HISTORY_PATH_RE = /^(?:scripts\/migrations\/|data\.reference\/prompts\/|server\/services\/taskPromptDefaults(?:\/|\.js$)|scripts\/regen-prompt-integrity-snapshot(?:\.test)?\.js$|\.github\/workflows\/ci\.yml$)/;
// The files the `linux-containment` job passes to `npm test --prefix server`.
export const LINUX_CONTAINMENT_TESTS = [
  'autofixer/sandbox.verify.test.js',
  'server/lib/codeAnimationContainment.test.js',
  'server/routes/codeAnimationExecution.test.js',
  'server/services/codeAnimation/containedWorker.test.js',
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
export const LINUX_CONTAINMENT_PATH_RE = /^(?:server\/package(?:-lock)?\.json|\.github\/workflows\/ci\.yml)$/;
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

/** Static closure of the prompt-history guard and every migration it imports. */
export function collectPromptHistoryInputs(files, cwd) {
  try {
    const declaring = files.filter((path) => path.startsWith('scripts/migrations/')
      && !path.slice('scripts/migrations/'.length).includes('/')
      && isNumberedMigrationFile(basenameOf(path))
      && declaresPromptHashes(readFileSync(join(cwd, path), 'utf8')));
    return staticClosureOf([PROMPT_HISTORY_GUARD, ...declaring], cwd);
  } catch {
    return null;
  }
}

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
  '.github/workflows/ci.yml', 'package.json', 'scripts/lib/workspaceCacheFixture.js',
  'scripts/lib/vitestTempRootFixture.js', 'scripts/lib/vitestTempRoot.js',
  'scripts/lib/vitestWatch.js',
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
  'client/vitest.config.js', 'client/src/test/timeouts.js',
  'scripts/dev-start.js', 'scripts/publish-client-build.js',
  'scripts/lib/envFile.cjs', 'scripts/lib/databaseSettings.cjs',
  'lib/portosAuthCore.js', 'server/lib/eidoverseProxyRoutes.js',
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
  if (changedFiles.some((path) => /^server\/lib\//.test(path))) {
    add('server/lib/index.test.js');
  }
  // These guards read the tree rather than importing it, so no import edge
  // selects them: the route-graph guard catches a route file nothing mounts,
  // the parity guard a client wrapper stranded by a renamed mount, and the
  // prompt-stage drift test a stale manifest — which is what a scoped plan
  // let merge before this rule existed (#5898).
  if (changedFiles.some((path) => /^server\/.*\.js$/.test(path) || /^server\/lib\/.*\.generated\.json$/.test(path))) {
    add('server/lib/apiRouteGraph.test.js');
    add('server/lib/apiRouteParity.test.js');
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
  // responsive-grid, popover-clamp, pre-wrap/break, safe-storage, heading-truncation,
  // sub-nav, dashboard-widget container-query, and global-shadow guards read class
  // strings, storage accesses, declarations, and JSX markup out of both extensions.
  // None of these files has a source sibling or imports an app module, so nothing
  // else selects them — without this entry they only ever run on a full suite.
  if (changedFiles.some((path) => /^client\/src\/.*\.jsx?$/.test(path))) {
    add('client/src/apiWrapperOptionsConventions.test.js');
    add('client/src/asyncEffectDisposalConventions.test.js');
    add('client/src/dashboardWidgetContainerConventions.test.js');
    add('client/src/globalShadowConventions.test.js');
    add('client/src/headingTruncationConventions.test.js');
    add('client/src/hooks/mountedRefConventions.test.js');
    add('client/src/listFetchConventions.test.js');
    add('client/src/moduleContractConventions.test.js');
    add('client/src/numberFormattingConventions.test.js');
    add('client/src/pageShellConventions.test.js');
    add('client/src/pollingConventions.test.js');
    add('client/src/popoverClampConventions.test.js');
    add('client/src/preWrapClasses.test.js');
    add('client/src/providerSelectConventions.test.js');
    add('client/src/responsiveGridConventions.test.js');
    add('client/src/socketSubscriptionConventions.test.js');
    add('client/src/storageConventions.test.js');
    add('client/src/subNavConventions.test.js');
    // Same trigger, different subject: this one scans the TEST files for an
    // inline async bound the per-test budget would cut short, and a changed
    // `*.test.jsx` matches the `.jsx?` pattern above.
    add('client/src/test/timeouts.test.js');
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

/**
 * Does this diff touch a surface only a real Windows runner can prove?
 *
 * Deliberately NOT restricted to isExecutable() paths: .ps1/.cmd/.bat are not
 * in EXECUTABLE_RE, so a PowerShell change used to reach the Windows job only
 * as a side effect of being an "unclassified changed file". This answers the
 * question directly, and is what overrides a trigger's windowsEscalates:false.
 */
const hasWindowsRiskFile = (paths) => paths.some((path) => (
  !isDocumentationOnly(path) && WINDOWS_RISK_RULES.some((rule) => rule.test(path))
));

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

// A scoped runner spread over several shards says why, so the summary never
// reads as a full run.
const fanOutNote = (plan, runner) => {
  const count = plan.shards[runner].length;
  if (plan.full || count === 1) return '';
  return plan[runner].files.length > MAX_TARGETED_TEST_FILES
    ? `; ${plan[runner].files.length} selected test files exceed the ${MAX_TARGETED_TEST_FILES}-file cap, sharded ${count} ways`
    : `; related import graph sharded ${count} ways`;
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
        : `client-impacting source changed${fanOutNote(plan, 'client')}`,
  browser: plan.browserFiles.length > 0
    ? (plan.full ? `full matrix: ${plan.reason}` : `${plan.browserFiles.length} cross-workspace browser suite(s) selected`)
    : 'skipped: no cross-workspace browser suite selected',
  db: plan.db ? (plan.full ? `full matrix: ${plan.reason}` : 'database-risk source changed') : 'skipped: no database-risk source changed',
  lint: plan.lint.mode === 'skip' ? 'skipped: no changed client source needs linting' : plan.full ? `full matrix: ${plan.reason}` : 'changed client source',
  build: plan.build ? (plan.full ? `full matrix: ${plan.reason}` : 'client-impacting source changed') : 'skipped: no client-impacting source changed',
  smoke: plan.smoke ? (plan.full ? `full matrix: ${plan.reason}` : 'server-impacting source changed') : 'skipped: no server-impacting source changed',
  // A full plan whose Windows job stayed at the contract baseline says so
  // explicitly, so the CI summary never reads "full matrix" beside a one-shard
  // Windows run (issue #7440).
  // A dependency-manifest plan names the packages behind its Windows decision.
  windows: !plan.windows
    ? 'skipped: no Windows-sensitive surface changed'
    : plan.full
      ? `${plan.windowsMode === 'full'
        ? `full matrix: ${plan.reason}`
        : `Windows contract baseline (full matrix elsewhere): ${plan.reason}`}${plan.windowsNote ? `; ${plan.windowsNote}` : ''}`
      : 'Windows-sensitive surface changed',
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
 * path-gated job (prompt history, Linux containment, SuperCollider live,
 * Docker containment live) runs.
 *
 * `promptHistoryInputs` / `linuxContainmentInputs` / `supercolliderLiveInputs` are the jobs' static
 * import closures from collectPlanInputs(); null (the default) runs the job.
 */
export function buildCiTestPlan(changedFiles, options = {}) {
  const plan = buildSuitePlan(changedFiles, options);
  const {
    forceFull = false, promptHistoryInputs = null, linuxContainmentInputs = null, supercolliderLiveInputs = null,
    dockerContainmentLiveInputs = null, serverReach = null,
  } = options;
  // Informational: names the changed source behind a large related selection
  // (#12285). It never changes what runs.
  const reachNote = !plan.full && plan.server.mode === 'related' ? formatReachSummary(serverReach) : '';
  return {
    ...plan,
    ...(reachNote ? { suiteReasons: { ...plan.suiteReasons, server: `${plan.suiteReasons.server}; ${reachNote}` } } : {}),
    promptHistory: forceFull || touchesJobInputs(plan.changedFiles, promptHistoryInputs, PROMPT_HISTORY_PATH_RE),
    linuxContainment: forceFull
      || touchesJobInputs(plan.changedFiles, linuxContainmentInputs, LINUX_CONTAINMENT_PATH_RE),
    supercolliderLive: forceFull
      || touchesJobInputs(plan.changedFiles, supercolliderLiveInputs, SUPERCOLLIDER_LIVE_PATH_RE),
    dockerContainmentLive: forceFull
      || touchesJobInputs(plan.changedFiles, dockerContainmentLiveInputs, DOCKER_CONTAINMENT_LIVE_PATH_RE),
  };
}

function buildSuitePlan(changedFiles, {
  trackedFiles = [],
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

  // Nightly, the main -> release PR, release, and an explicit "full CI"
  // request keep the complete Windows matrix. ci.yml has no push trigger, so
  // these ARE the discovery net for a Windows regression on a surface nobody
  // has tagged — the same net every PR that touches no WINDOWS_RISK_RULES file
  // already relies on. A downgrade below widens that existing population; it
  // does not invent a new risk class.
  if (forceFull) {
    return fullPlan(changed, forceFullReason, { appRouteOnly, trackedSet, windowsEscalates: true });
  }

  // EVERY matching trigger, not just the reported one, and computed BEFORE the
  // first full-plan branch. The reason line is the first match in sorted-path
  // order, but the Windows decision is the OR over all of them, so a diff that
  // trips two triggers must escalate if EITHER does. Two ways this goes wrong
  // if the OR is skipped: an alphabetically earlier client-only trigger
  // (client/vite.config.js) reported ahead of server/index.js, and the App.jsx
  // branch below returning before the triggers are even looked at — which
  // downgraded Windows for an App.jsx PR that also bumped a lockfile.
  const dependencyVerdicts = [];
  const fullTriggers = changed
    .flatMap((path) => FULL_TRIGGER_RULES
      .filter(({ re }) => re.test(path))
      .map(({ reason, windowsEscalates }) => {
        const scopedToWindows = windowsEscalates === 'dependencies' || (windowsEscalates === true && /(?:^|\/)\.npmrc$/.test(path));
        if (!scopedToWindows) return { path, reason, windowsEscalates };
        if (!windowsInstalls(path)) {
          dependencyVerdicts.push(`${path} keeps the Windows baseline: the Windows job does not install that workspace`);
          return { path, reason, windowsEscalates: false };
        }
        if (windowsEscalates === true) return { path, reason, windowsEscalates };
        const verdict = dependencyChanges[path] ?? escalated('no manifest comparison available');
        dependencyVerdicts.push(describeDependencyVerdict(path, verdict));
        return { path, reason, windowsEscalates: verdict.escalate };
      }));
  const fullTrigger = fullTriggers.at(0);
  const triggersEscalateWindows = fullTriggers.some((trigger) => trigger.windowsEscalates);
  const windowsNote = dependencyVerdicts.join('; ');

  const appCompositionChanged = changed.includes('client/src/App.jsx');
  if (appCompositionChanged && !appRouteOnly) {
    // The composition root itself is client-only, but the rest of the diff may
    // not be.
    return fullPlan(changed, 'client composition root changed: client/src/App.jsx', {
      appRouteOnly,
      trackedSet,
      windowsEscalates: triggersEscalateWindows,
      windowsNote,
    });
  }

  if (fullTrigger) {
    return fullPlan(changed, `${fullTrigger.reason}: ${fullTrigger.path}`, {
      appRouteOnly,
      trackedSet,
      windowsEscalates: triggersEscalateWindows,
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
    return fullPlan(changed, `wide change (${executable.length} executable files)`, { appRouteOnly, trackedSet, windowsEscalates: false });
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

  const serverSources = jsSources
    .filter(isServerRunnerFile)
    .filter((path) => !isStructuralBarrel(path));
  const clientSources = jsSources
    .filter(isClientSource)
    .filter((path) => clientDependencySet.has(path) || !isStructuralBarrel(path));

  // Feature-name matches, basename contracts, direct tests and guards are
  // additive explicit selectors; they never replace import-graph traversal. A
  // nested feature leaf can be consumed by a differently named test in another
  // area, so any behavioral source in a runner takes one 'related' invocation.
  // Only a barrel-only edit (fully covered by the structural export guard) or a
  // test-only diff keeps exact-file selection.
  const serverMode = serverSources.length > 0 ? 'related' : 'files';
  const clientMode = clientSources.length > 0 ? 'related' : 'files';

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

  const dbTests = new Set(resolveDbTestFiles(trackedFiles));
  const db = serverFiles.some((path) => dbTests.has(path))
    || executable.some((path) => DB_RISK_RULES.some((rule) => rule.test(path)))
    || serverSources.some((path) => dbDependencies === null || dbDependencies.includes(path));

  const windows = hasWindowsRiskFile(changed);
  const windowsMode = windows
    ? (serverSources.length > 0 ? 'related' : 'files')
    : 'skip';

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
    windowsFiles: windows ? uniqueSorted([
      ...windowsContractTests(trackedSet),
      // Test-only changes have no source path for `vitest related` to follow.
      // A risk tag must select the changed contract itself as well as baseline.
      ...directTests.filter(path => isServerRunnerFile(path) && hasWindowsRiskFile([path])),
    ]) : [],
    windowsSources: windowsMode === 'related' ? serverSources : [],
  }, { appRouteOnly, linuxRunnerExcludes: new Set([...dbTests, ...BROWSER_SUITES]) });
}

/**
 * The derived fields every plan carries: per-suite reasons and shard matrices.
 *
 * `linuxRunnerExcludes` names selected files the Linux test jobs never run
 * (DB and browser suites have their own jobs); fansOut() keeps them out of the
 * shard-count floor.
 */
const finishPlan = (plan, { linuxRunnerExcludes = new Set(), ...options } = {}) => {
  const linuxShards = (runner) => shardIndexes(
    fansOut(runner, plan[runner], linuxRunnerExcludes) ? 'full' : plan[runner].mode,
    FULL_SUITE_SHARDS[runner],
  );
  const shards = {
    server: linuxShards('server'),
    client: linuxShards('client'),
    // Related mode can reach most of the server graph through one shared
    // source. The explicit selector count does not bound that work: one Windows
    // runner exceeded the unchanged 15-minute step budget on a TUI handshake
    // edit. Split execution across the existing matrix without widening or
    // reducing related-test selection; exact-file plans stay on one runner.
    windows: shardIndexes(plan.windowsMode === 'related' ? 'full' : plan.windowsMode, FULL_SUITE_SHARDS.windows),
  };
  return {
    ...plan,
    slashdo: needsSlashdoSubmodule(plan),
    suiteReasons: suiteReasonsFor({ ...plan, shards }, options),
    shards,
  };
};

/**
 * A full plan for every Linux suite — with the Windows job at the depth the
 * diff actually justifies.
 *
 * `windowsEscalates` (default true, so an unlisted caller fails closed) is
 * false only for a trigger windows-server cannot observe: a client-only
 * surface, pure cross-platform schema logic, a dependency-manifest change
 * classifyDependencyChange() proved platform-neutral, or a CAPACITY escalation
 * (a wide diff) that says the planner ran out of scoping headroom, not that
 * anything risky changed. A touched WINDOWS_RISK_RULES path overrides it back to full.
 *
 * Downgraded does not mean skipped: the job still runs WINDOWS_CONTRACT_TESTS,
 * the curated cross-platform baseline a Windows-risk scoped PR already gets.
 * The complete Windows matrix stays the discovery net for surfaces nobody has
 * tagged yet — it just runs nightly, on the main -> release PR, and on
 * release, instead of on every capacity-widened PR (issue #7440).
 *
 * `options` is also forwarded to finishPlan(), which reads only appRouteOnly.
 */
function fullPlan(changedFiles, reason, options = {}) {
  const { trackedSet = new Set(), windowsEscalates = true, windowsNote = '' } = options;
  // An empty `files` list makes run-ci-tests.js print "No server tests
  // selected" and exit 0 — a green Windows job that ran nothing. So the
  // baseline is only a downgrade while it actually resolves to tracked tests;
  // otherwise this falls back to the complete suite rather than to silence.
  const baseline = windowsContractTests(trackedSet);
  const windowsFull = windowsEscalates || hasWindowsRiskFile(changedFiles) || baseline.length === 0;
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
    windows: true,
    windowsMode: windowsFull ? 'full' : 'files',
    windowsFiles: windowsFull ? [] : baseline,
    windowsSources: [],
    windowsNote,
  }, options);
}

// Git's display output quotes non-ASCII/control characters; trimming also
// changes valid paths. Read raw NUL-delimited paths so selectors stay exact.
const gitPaths = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

/** Tracked test files whose text matches `pattern`; `git grep` exit 1 is "none". */
const gitGrepFiles = (pattern, pathspecs, cwd) => {
  try {
    return gitPaths(['grep', '-z', '-l', '-E', pattern, '--', ...pathspecs], cwd);
  } catch (err) {
    if (err.status === 1) return [];
    throw err;
  }
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
const narrowSharedBasenameHits = (source, hits, cwd) => {
  const dir = posix.dirname(source);
  if (dir === '.' || hits.length === 0) return hits;
  const parent = basenameOf(dir);
  const naming = new Set(gitGrepFiles(
    `(^|[^A-Za-z0-9_])${escapeRegExp(parent)}([^A-Za-z0-9_]|$)`,
    hits.map((path) => `:(literal)${path}`),
    cwd,
  ));
  return hits.filter((path) => path.startsWith(`${dir}/`) || naming.has(path));
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
    browser_files: JSON.stringify(plan.browserFiles),
    db: plan.db,
    lint_mode: plan.lint.mode,
    lint_files: JSON.stringify(plan.lint.files),
    build: plan.build,
    smoke: plan.smoke,
    slashdo: plan.slashdo,
    prompt_history: plan.promptHistory,
    linux_containment: plan.linuxContainment,
    supercollider_live: plan.supercolliderLive,
    docker_containment_live: plan.dockerContainmentLive,
    windows: plan.windows,
    windows_mode: plan.windowsMode,
    windows_files: JSON.stringify(plan.windowsFiles),
    windows_sources: JSON.stringify(plan.windowsSources),
    server_shards: JSON.stringify(plan.shards.server),
    client_shards: JSON.stringify(plan.shards.client),
    windows_shards: JSON.stringify(plan.shards.windows),
    suite_reasons: JSON.stringify(plan.suiteReasons),
    // The pregate attestation this plan honored (see applyAttestation), or
    // why none was: `{"attested": false, "reason": …}` is still a decision.
    attestation: JSON.stringify(plan.attestation ?? { attested: false, reason: 'no attestation resolved' }),
    attested_stages: JSON.stringify(plan.attestedStages ?? []),
  };

  Object.entries(outputs).forEach(([name, value]) => {
    writeStepOutput(name, value);
  });
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

// Start from every browser source, including lazy-loaded pages, then follow
// relative static imports and re-exports across directory boundaries. Parsing
// is shared with the structural graph guards, but unresolved edges must widen
// CI instead of disappearing as they do in that helper's negative graph walk.
function collectClientDependencies(trackedFiles, cwd) {
  const known = new Set(trackedFiles);
  const pending = trackedFiles.filter((path) => path.startsWith('client/src/')
    && MODULE_SOURCE_RE.test(path) && !isTestFile(path));
  const seen = new Set();
  const extensions = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts', '.json'];
  try {
    for (let index = 0; index < pending.length; index++) {
      const file = pending[index];
      if (seen.has(file)) continue;
      seen.add(file);
      if (!MODULE_SOURCE_RE.test(file)) continue;
      for (const specifier of staticImportSpecifiersFromSource(readFileSync(join(cwd, file), 'utf8'))) {
        if (!specifier.startsWith('.')) continue;
        const path = posix.normalize(posix.join(posix.dirname(file), specifier.split(/[?#]/)[0]));
        // Keep every resolvable candidate when extensions collide rather than
        // guessing a bundler-specific precedence and dropping a real consumer.
        const dependencies = [path, ...extensions.map((extension) => `${path}${extension}`),
          ...extensions.map((extension) => `${path}/index${extension}`)].filter((candidate) => known.has(candidate));
        if (dependencies.length === 0) return null;
        pending.push(...dependencies);
      }
    }
  } catch {
    return null;
  }
  return uniqueSorted([...seen].filter((path) => path.startsWith('server/lib/')));
}

// Project DB and browser consumers without importing test code or Vitest (the
// planner runs before npm installation). Include deferred literals; unreadable,
// unresolved and computed imports retain conservative prerequisite coverage.
// Share parsed edges between suite walks so common dependencies are read once.
function collectTestDependencies(entries, files, cwd, importCache) {
  const known = new Set(files);
  const pending = [...entries];
  const seen = new Set();
  const extensions = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts', '.json'];
  let inconclusive = false;
  try {
    for (let index = 0; index < pending.length; index++) {
      const file = pending[index];
      if (seen.has(file)) continue;
      seen.add(file);
      if (!MODULE_SOURCE_RE.test(file)) continue;
      if (!importCache.has(file)) {
        const source = readFileSync(join(cwd, file), 'utf8');
        const specifiers = staticImportSpecifiersFromSource(source);
        let computed = false;
        // A nonliteral cannot prove absence of a dependency; extra matches in
        // comments widen safely. Template literals resolve without interpolation.
        for (const match of source.matchAll(/\bimport\s*\(\s*([^)]*)\)/g)) {
          const literal = match[1].trim().match(/^(['"`])([^'"`]*?)\1\s*(?:,.*)?$/s);
          if (!literal || literal[2].includes('${')) computed = true;
          else specifiers.push(literal[2]);
        }
        importCache.set(file, { specifiers, computed });
      }
      const { specifiers, computed } = importCache.get(file);
      if (computed) inconclusive = true;
      for (const specifier of specifiers) {
        if (!specifier.startsWith('.')) continue;
        const path = posix.normalize(posix.join(posix.dirname(file), specifier.split(/[?#]/)[0]));
        const dependencies = [path, ...extensions.map((extension) => `${path}${extension}`),
          ...extensions.map((extension) => `${path}/index${extension}`)].filter((candidate) => known.has(candidate));
        if (dependencies.length === 0) inconclusive = true;
        pending.push(...dependencies);
      }
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
 */
export function collectPlanInputs({ baseSha, forceFull = false, changedFiles, cwd = process.cwd() }) {
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
  // a basename lookup: `git grep`-ing tracked test files for its filename finds
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
  const pathContractTests = Object.fromEntries(changedSources.map((path) => {
    const hits = gitGrepFiles(sourceReferencePattern(path), TEST_FILE_GLOBS, cwd);
    return [path, sharedBasenames.has(basenameOf(path)) ? narrowSharedBasenameHits(path, hits, cwd) : hits];
  }));

  const clientDependencies = collectedChangedFiles.some((path) => path.startsWith('server/lib/')
    && isExecutable(path) && !isTestFile(path))
    ? collectClientDependencies(hasChangedFilesOverride ? uniqueSorted([...presentFiles, ...untrackedFiles]) : presentFiles, cwd)
    : [];

  const hasRelatedServerSource = collectedChangedFiles.some((path) => isServerRunnerFile(path)
    && MODULE_SOURCE_RE.test(path) && !isTestFile(path) && !isStructuralBarrel(path));
  const dependencyFiles = hasChangedFilesOverride ? uniqueSorted([...presentFiles, ...untrackedFiles]) : presentFiles;
  const importCache = new Map();
  const dbDependencies = hasRelatedServerSource
    ? collectTestDependencies(resolveDbTestFiles(dependencyFiles), dependencyFiles, cwd, importCache)
    : [];
  const browserDependencies = hasRelatedServerSource
    ? Object.fromEntries(browserSuitesIn(presentFiles).map((suite) => [suite,
      collectTestDependencies([suite], dependencyFiles, cwd, importCache)]))
    : {};

  // Each changed manifest at the diff base vs the tree under test (the working
  // tree: HEAD in CI, HEAD plus local edits under pregate). The base commit is
  // inside the depth-2 checkout, so `git show` resolves it; any read failure
  // becomes null, which classifyDependencyChange() treats as escalation.
  const readAtBase = (path) => {
    try {
      return execFileSync('git', ['show', `${baseSha}:${path}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    } catch {
      return null;
    }
  };
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
        sources: collectedChangedFiles.filter((path) => isServerRunnerFile(path)
          && MODULE_SOURCE_RE.test(path) && !isTestFile(path)),
      });
    } catch (err) {
      console.warn(`⚠️ Dynamic-aware reach not measured: ${err.message}`);
    }
  }

  // A forced-full run always runs every gated job, so it skips the walks.
  const promptHistoryInputs = forceFull ? null : collectPromptHistoryInputs(dependencyFiles, cwd);
  const linuxContainmentInputs = forceFull ? null : collectLinuxContainmentInputs(cwd);
  const supercolliderLiveInputs = forceFull ? null : collectSuperColliderLiveInputs(cwd);
  const dockerContainmentLiveInputs = forceFull ? null : collectDockerContainmentLiveInputs(cwd);

  return { changedFiles: collectedChangedFiles, trackedFiles: presentFiles, appDiff, pathContractTests,
    clientDependencies, dbDependencies, browserDependencies, dependencyChanges, promptHistoryInputs, linuxContainmentInputs, supercolliderLiveInputs,
    dockerContainmentLiveInputs, serverReach };
}

// ---------------------------------------------------------------------------
// Pregate attestation (docs/GITHUB_ACTIONS.md "Pregate attestation")
//
// A local `npm run pregate` that ran a stage to green, followed by
// `node scripts/pregate-attest.js` after the push, leaves a `pregate` commit
// status on the head whose description names the validated TREE, the platform
// and Node major it ran on, and the stages that passed
// (scripts/lib/pregateAttestation.js). This section reads that status back
// and lets the plan skip those stages — never Windows, the Linux containment
// job, or the Node-minimum check, which have no local run.
//
// Fail closed at every step: anything other than a same-repository pull
// request into a non-release base, with a head commit the owner attested
// whose tree is exactly the head commit's tree, leaves the plan untouched and
// the reason in the outputs. The planner never has to be right about a fork
// or a bot for this to be safe — a fork's token cannot create a status here
// and a bot's login is not the owner's — but it refuses them explicitly so
// the summary says why.
//
// What the receipt vouches for is the HEAD COMMIT's tree; what CI tests is
// the merge ref, that tree plus whatever the base branch gained since the
// branch forked. `attestationDrift` closes that gap per stage: a base-side
// change that could reach a stage's runner refuses the attestation for that
// stage, and docs-only or other-runner movement keeps it.
// ---------------------------------------------------------------------------

/** Stages a receipt may attest to, mapped to the plan fields they clear. */
const ATTESTATION_SKIPS = Object.freeze({
  lint: (plan) => ({ lint: { ...plan.lint, mode: 'skip' } }),
  client: (plan) => ({ client: { ...plan.client, mode: 'skip' } }),
  build: () => ({ build: false }),
  smoke: () => ({ smoke: false }),
  browser: () => ({ browserFiles: [] }),
  db: () => ({ db: false }),
  'prompt-history': () => ({ promptHistory: false }),
});

/** How long after the head commit a just-posted status may still be on its way. */
const ATTESTATION_YOUNG_HEAD_SECONDS = 300;
const ATTESTATION_POLL_TOTAL_MS = 90_000;
const ATTESTATION_POLL_INTERVAL_MS = 10_000;

/**
 * Whether this run may honor an attestation at all, and the head it would
 * read it from. Reads only the `CI_*` inputs ci.yml passes to the plan step.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{eligible: boolean, reason: string, headSha?: string, repository?: string, owner?: string}}
 */
export function attestationEligibility(env) {
  const trim = (value) => (typeof value === 'string' ? value.trim() : '');
  const eventName = trim(env.CI_EVENT_NAME);
  const repository = trim(env.CI_REPOSITORY);
  const owner = trim(env.CI_REPOSITORY_OWNER);
  const headRepo = trim(env.CI_PR_HEAD_REPO);
  const headSha = trim(env.CI_PR_HEAD_SHA);
  const author = trim(env.CI_PR_AUTHOR);
  if (eventName !== 'pull_request') return { eligible: false, reason: `event ${eventName || '(none)'} is not a pull request` };
  if (env.CI_FORCE_FULL === 'true') return { eligible: false, reason: 'full CI requested' };
  if (trim(env.CI_BASE_REF) === 'release') return { eligible: false, reason: 'release gate: pull request into release' };
  if (!repository || !owner) return { eligible: false, reason: 'repository or owner unknown' };
  if (headRepo.toLowerCase() !== repository.toLowerCase()) return { eligible: false, reason: `head repository ${headRepo || '(unknown)'} is not ${repository}` };
  if (!author || /\[bot\]$/i.test(author)) return { eligible: false, reason: `pull request author ${author || '(unknown)'} is a bot or unknown` };
  if (!/^[0-9a-f]{40}$/.test(headSha)) return { eligible: false, reason: 'head sha unknown' };
  return { eligible: true, reason: 'same-repository pull request', headSha, repository, owner };
}

const isRunnerConfig = (path) => FULL_TRIGGER_RULES.some((rule) => rule.re.test(path)) || WORKSPACE_CACHE_COMMON_INPUTS.has(path);
const isSourceUnder = (path, prefixes) => isExecutable(path) && !isTestFile(path) && !isDocumentationOnly(path)
  && prefixes.some((prefix) => path.startsWith(prefix));

// A full-mode runner selects every test it owns, so `files` is empty there and
// the membership check alone would let a base-side test change slip through.
const selectsTest = (selection, runner, path) => selection.files.includes(path) || (selection.mode === 'full' && runnerForTest(path) === runner);

/**
 * Per stage, whether a base-side path could change that stage's outcome:
 * (a) a test file the plan selected for the runner, (b) a non-test source
 * under the runner's roots, or (c) a runner config or setup file. Each entry
 * is the first offending path, for the refusal reason.
 */
const STAGE_DRIFT_RULES = Object.freeze({
  server: (plan, path) => selectsTest(plan.server, 'server', path) || isSourceUnder(path, RUNNER_ROOTS.server) || WORKSPACE_CACHE_SERVER_INPUTS.has(path),
  client: (plan, path) => selectsTest(plan.client, 'client', path) || isSourceUnder(path, RUNNER_ROOTS.client) || WORKSPACE_CACHE_CLIENT_INPUTS.has(path),
  lint: (plan, path) => isLintSurface(path),
  build: (plan, path) => isSourceUnder(path, ['client/']) || WORKSPACE_CACHE_CLIENT_INPUTS.has(path),
  smoke: (plan, path) => isSourceUnder(path, ['server/']) || path === 'scripts/smoke-boot.js' || WORKSPACE_CACHE_SERVER_INPUTS.has(path),
  browser: (plan, path) => plan.browserFiles.includes(path) || BROWSER_SUITES.includes(path)
    || isSourceUnder(path, ['server/', 'client/src/']) || WORKSPACE_CACHE_SERVER_INPUTS.has(path) || WORKSPACE_CACHE_CLIENT_INPUTS.has(path),
  db: (plan, path) => resolveDbTestFiles([path]).length > 0 || isSourceUnder(path, ['server/']) || WORKSPACE_CACHE_SERVER_INPUTS.has(path),
  'prompt-history': (plan, path) => PROMPT_HISTORY_PATH_RE.test(path),
});

/**
 * The stages a base-side diff refuses, each with the path that refuses it.
 *
 * `driftPaths` is `git diff --name-only HEAD^2 HEAD` on the merge ref: exactly
 * what the base branch added since the branch forked. A runner config or
 * workflow change refuses every stage; otherwise each stage answers for its
 * own runner. Null (the diff could not be read) refuses everything.
 *
 * @param {object} plan - the finished plan
 * @param {string[]|null} driftPaths
 * @returns {Record<string, string>} stage → reason
 */
export function attestationDrift(plan, driftPaths) {
  const refused = {};
  if (!Array.isArray(driftPaths)) {
    for (const stage of Object.keys(STAGE_DRIFT_RULES)) refused[stage] = 'base movement could not be read';
    return refused;
  }
  const paths = uniqueSorted(driftPaths.filter((path) => typeof path === 'string' && path.length > 0));
  const config = paths.find(isRunnerConfig);
  for (const [stage, touches] of Object.entries(STAGE_DRIFT_RULES)) {
    const hit = config ?? paths.find((path) => touches(plan, path));
    if (hit) refused[stage] = `base branch moved: ${hit}`;
  }
  return refused;
}

/**
 * The attestation on the pull request's head, or null and why.
 *
 * The checkout is the merge ref at depth 2, which carries the head commit as
 * `HEAD^2`: that is what makes `<head>^{tree}` resolvable without a wider
 * fetch, and the first check — the event's head must BE that second parent,
 * or the attested tree would be compared with some other commit's. It is NOT
 * the tree under test: the merge ref also carries the base branch's movement,
 * which `attestationDrift` weighs per stage in applyAttestation from the
 * `baseDrift` returned here.
 *
 * A status posted moments after the push can still be on its way when the
 * run starts, so a head younger than five minutes with no `pregate` status
 * is re-read for up to 90 seconds before "no attestation" is concluded.
 *
 * `log` defaults to stderr: the planner's stdout is the JSON plan pregate
 * and the tests parse, so every human-readable line here stays off it.
 *
 * @param {{env?: NodeJS.ProcessEnv, exec?: typeof execFileSync, cwd?: string, log?: (line: string) => void, now?: () => number, sleep?: (ms: number) => void}} [options]
 * @returns {{attested: boolean, reason: string, sha?: string, tree?: string, os?: string, node?: number, stages?: string[], creator?: string, createdAt?: string, baseDrift?: string[]|null, waitedMs?: number}}
 */
export function resolveCiAttestation({ env = process.env, exec = execFileSync, cwd = process.cwd(), log = console.warn, now = Date.now, sleep = sleepMs } = {}) {
  const none = (reason) => {
    log(`⏭️ Pregate attestation not honored: ${reason}.`);
    return { attested: false, reason };
  };
  const eligibility = attestationEligibility(env);
  if (!eligibility.eligible) return none(eligibility.reason);
  const { headSha, repository, owner } = eligibility;
  const capture = (command, args) => {
    try {
      return exec(command, args, { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (error) {
      return { error: error?.stderr?.toString().trim() || error?.message || 'command failed' };
    }
  };
  const mergeHead = capture('git', ['rev-parse', '--verify', '--quiet', 'HEAD^2']);
  if (typeof mergeHead !== 'string' || mergeHead !== headSha) {
    return none(`checkout is not the merge ref of head ${headSha.slice(0, 9)}`);
  }
  const headTree = capture('git', ['rev-parse', '--verify', '--quiet', `${headSha}^{tree}`]);
  if (typeof headTree !== 'string') return none(`cannot resolve the tree of head ${headSha.slice(0, 9)}`);
  const committed = capture('git', ['show', '-s', '--format=%ct', headSha]);
  const headAgeSeconds = typeof committed === 'string' && /^\d+$/.test(committed) ? Math.floor(now() / 1000) - Number(committed) : null;

  const readStatuses = () => {
    const body = capture('gh', ['api', `repos/${repository}/commits/${headSha}/statuses?per_page=100`]);
    if (typeof body !== 'string') return { error: `statuses API failed: ${body.error}` };
    try {
      return { statuses: JSON.parse(body) };
    } catch {
      return { error: 'statuses API returned unreadable JSON' };
    }
  };
  const started = now();
  let waitedMs = 0;
  let selected;
  for (;;) {
    const read = readStatuses();
    if (read.error) return none(read.error);
    selected = selectAttestation(read.statuses, { owner, headTree });
    const missing = !selected.attestation && selected.reason.startsWith('no "');
    const young = headAgeSeconds !== null && headAgeSeconds >= 0 && headAgeSeconds < ATTESTATION_YOUNG_HEAD_SECONDS;
    if (!missing || !young || now() - started >= ATTESTATION_POLL_TOTAL_MS) break;
    sleep(ATTESTATION_POLL_INTERVAL_MS);
    waitedMs = now() - started;
  }
  if (waitedMs > 0) log(`⏳ Waited ${Math.round(waitedMs / 1000)}s for a pregate status on the ${headAgeSeconds}s-old head ${headSha.slice(0, 9)}.`);
  if (!selected.attestation) return none(selected.reason);
  const drift = capture('git', ['diff', '--name-only', 'HEAD^2', 'HEAD']);
  const baseDrift = typeof drift === 'string' ? drift.split('\n').filter(Boolean) : null;
  const { attestation, reason } = selected;
  log(`✅ Pregate attestation on ${headSha.slice(0, 9)} (tree ${attestation.tree.slice(0, 12)}): ${attestation.stages.join(', ')} — ${reason}; base moved by ${baseDrift ? `${baseDrift.length} file(s)` : 'an unreadable diff'}.`);
  return { attested: true, reason, sha: headSha, ...attestation, baseDrift, waitedMs };
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The plan with every attested stage skipped and the decision recorded.
 *
 * Stages the base-side drift refuses (`attestationDrift`) stay as planned and
 * say why. The server job owns the boot smoke (`smoke == 'true' &&
 * matrix.shard == 1` on a job gated by `server_mode != 'skip'`), so `server`
 * is skipped only when the smoke is attested too or was never selected;
 * otherwise skipping the job would drop an unattested smoke on the floor.
 * `full` is forced false so the `Full CI Gate` is never published for a run
 * that skipped anything on the strength of a local receipt. Windows, Linux
 * containment, the Node-minimum check and the shard matrices are left as the
 * plan computed them.
 *
 * @param {object} plan - a finished plan (buildCiTestPlan)
 * @param {{attested: boolean, reason: string, stages?: string[], sha?: string, tree?: string, os?: string, node?: number, creator?: string, createdAt?: string, baseDrift?: string[]|null}} attestation
 */
export function applyAttestation(plan, attestation) {
  const base = { ...plan, attestation, attestedStages: [] };
  if (!attestation?.attested) {
    return { ...base, suiteReasons: { ...plan.suiteReasons, attestation: `not honored: ${attestation?.reason ?? 'unknown'}` } };
  }
  const refused = attestationDrift(plan, attestation.baseDrift ?? null);
  const attested = new Set((attestation.stages ?? []).filter((stage) => !refused[stage]));
  const smokeCovered = attested.has('smoke') || !plan.smoke;
  const skips = { ...ATTESTATION_SKIPS, server: smokeCovered ? (current) => ({ server: { ...current.server, mode: 'skip' } }) : null };
  let next = base;
  const skipped = [];
  for (const stage of ATTESTABLE_STAGES) {
    if (!attested.has(stage) || !skips[stage]) continue;
    next = { ...next, ...skips[stage](next) };
    skipped.push(stage);
  }
  const label = `attested by pregate on ${String(attestation.sha ?? '').slice(0, 9)} (tree ${String(attestation.tree ?? '').slice(0, 12)}, ${attestation.os ?? '?'}/node ${attestation.node ?? '?'})`;
  const driftRefused = Object.fromEntries((attestation.stages ?? []).filter((stage) => refused[stage]).map((stage) => [stage, refused[stage]]));
  const suiteReasons = { ...plan.suiteReasons, attestation: `${label}: skipping ${skipped.join(', ') || 'nothing'}` };
  const reasonKey = (stage) => (stage === 'prompt-history' ? 'promptHistory' : stage);
  for (const stage of skipped) suiteReasons[reasonKey(stage)] = `skipped: ${label}`;
  for (const [stage, reason] of Object.entries(driftRefused)) {
    if (stage !== 'scan') suiteReasons[reasonKey(stage)] = `${plan.suiteReasons[reasonKey(stage)] ?? 'planned'}; attestation refused: ${reason}`;
  }
  if (attested.has('server') && !smokeCovered) {
    suiteReasons.server = `${plan.suiteReasons.server}; server job kept: the boot smoke was not attested`;
  }
  return { ...next, full: false, attestedStages: skipped, attestation: { ...attestation, driftRefused }, suiteReasons };
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
  const {
    changedFiles, trackedFiles, appDiff, pathContractTests, clientDependencies, dbDependencies, browserDependencies,
    dependencyChanges, promptHistoryInputs, linuxContainmentInputs, supercolliderLiveInputs, dockerContainmentLiveInputs, serverReach,
  } = collectPlanInputs({
    baseSha: base,
    forceFull,
    changedFiles: changedFilesOverride,
  });
  const plan = buildCiTestPlan(changedFiles, {
    trackedFiles,
    forceFull,
    forceFullReason,
    appRouteOnly: isRouteOnlyAppDiff(appDiff),
    pathContractTests,
    clientDependencies,
    dbDependencies,
    browserDependencies,
    dependencyChanges,
    promptHistoryInputs,
    linuxContainmentInputs,
    supercolliderLiveInputs,
    dockerContainmentLiveInputs,
    serverReach,
  });
  // Last, over the finished plan: the attestation only ever removes work.
  emitGitHubPlan(applyAttestation(plan, resolveCiAttestation()));
}

if (isDirectlyInvoked(import.meta.url)) main();
