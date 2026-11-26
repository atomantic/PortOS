/**
 * Test memo orchestration for `scripts/run-ci-tests.js`: decide which of the
 * plan's selected files a trusted green run already verified, and record the
 * new green results afterwards. The same code runs under `npm run pregate`
 * and in CI, so there is one opinion about what the memo covers.
 *
 * Selection is closure-based (`testMemo.js`): in `related` mode a test is
 * selected when a changed source is in its module closure, or when its edges
 * could not all be resolved. A test with a version 2 memo record (per-module
 * digests) is narrowed: lazy `import()` edges count only where the record
 * cannot vouch for them (`recordedReach`), so a hub's lazy fan-out no longer
 * selects every suite. The planner's explicit files are always added. A
 * gate-tooling test (`TOOLING_TESTS`) can never earn a record, so it is kept
 * from the walk only when a changed source reaches its closure; otherwise the
 * planner selects it through the tooling owner paths.
 * Vitest then receives the exact list through a selection file
 * (`vitestRunnerSelection` in `scripts/vitestCiPool.js`).
 *
 * Recording: Vitest's `experimental.recordDependencies` depfile names the
 * modules each test actually loaded. A passed file gets a memo record (that
 * list) and an entry under its recorded key, plus an entry under its floor
 * key when the static closure is fully resolvable — so the next run can hit
 * either. Entries come only from a run whose process exited 0 and whose
 * run-level report shows no unhandled error, and only when the inputs hash
 * the same after the run as before it. A passed file that gets no entry is
 * reported with the reason each key was refused (`recordTestMemo`), and a
 * run under a browser profile's name pattern is seeded so Vitest records it
 * at all (`seedVitestDependencies`). A real-Chromium suite's record also
 * names what its fixture's Vite server served (`readServedFiles` in
 * `browserServedFiles.js`), which
 * narrows the root it hands to Vite to those files (`servedTree`).
 *
 * Sharding: the runner partitions the memo-independent candidate inventory
 * (`serverShardSlice` pins costly server and client suites over the hash),
 * then evaluates related reach and memo hits within the owned slice. Each
 * file has one owner across shards even when their memo records differ.
 * Vitest itself never receives `--shard`.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { resolveTestChrome } from './testChrome.js';
import { TOOLING_TESTS, getAlwaysRunTests } from './ciPlanRules.js';
import { FULL_SUITE_SHARDS } from './ciPlanOutput.js';
import { isGuardTest } from './guardScanners.js';
import { NEVER_MARKER, TEST_MEMO_NEVER, WORKSPACE_BASE_INPUTS, WORKSPACE_SETUP_ENTRIES, createDiskFs, createTestMemoAnalyzer, relatedTests } from './testMemo.js';
import { loadFactsCache } from './testMemo/factsCache.js';
import { memoDirs, pruneMemoStore, readMemoEntry, readMemoRecord, writeMemoEntry, writeMemoRecord } from './testMemoStore.js';
import { TEST_SCOPES, listWorkspaceTests, toRepoPath, toWorkspacePath, workspaceOf } from './workspaceTests.js';

const uniqueSorted = (values) => [...new Set(values)].sort();
const VIRTUAL_MODULE = /(?:^|\/)@vite\/|^\0|^virtual:/;

/**
 * True when the analyzer could only conclude "not memoizable" for `test`: it is
 * a tree guard (`*.guard.test.js`) or another always-run test, is named in
 * `TEST_MEMO_NEVER`, or carries the
 * `// test-memo: never` marker itself. Deciding that here is what spares a
 * full or files plan of tree-wide guards the closure walk (seconds per stage)
 * whose only possible answer is "run it". An unreadable file is not decided
 * here; the analyzer reports it.
 */
const neverMemoized = (test, repoRoot, alwaysRun) => {
  if (alwaysRun.has(test) || isGuardTest(test) || TEST_MEMO_NEVER[test]) return true;
  try { return NEVER_MARKER.test(readFileSync(join(repoRoot, ...test.split('/')), 'utf8')); } catch { return false; }
};

/** True when a changed source is a member or a non-module input of the verdict's closure. */
const reachesClosure = (info, sources) => sources.some((rel) => info.closure.has(rel) || info.inputs.has(rel));

function createMemoRunAnalysis({ scope, repoRoot, env = process.env, platform, arch, nodeVersion, toolVersion, freshToolVersion = toolVersion,
  requireToolVersions, planBeforeClientSetup, caseFilter = [], acceptVerdictsFrom, listFiles = listRepositoryFiles, factsCache }) {
  const options = { fs: createDiskFs(repoRoot, nodeFs, nodePath), workspaceRel: workspaceOf(scope), env, platform, arch, nodeVersion, toolVersion, requireToolVersions, planBeforeClientSetup, caseFilter, acceptVerdictsFrom, listFiles: () => listFiles(repoRoot), factsCache };
  // Built on first use: a plan whose candidates are all unmemoizable never pays for the base closure.
  let primary = null;
  const analyze = (test, recorded, digests = null, served = null) => {
    if (!primary) {
      const analyzer = createTestMemoAnalyzer(options);
      primary = { analyzer, baseClosure: analyzer.workspaceBase(WORKSPACE_BASE_INPUTS[scope], WORKSPACE_SETUP_ENTRIES[scope]) };
    }
    return primary.analyzer.analyzeTest(test, { baseClosure: primary.baseClosure, recorded, digests, served });
  };
  // A second analyzer with empty caches re-reads every input after the run,
  // so an entry is written only for inputs that did not change meanwhile.
  let fresh = null;
  const freshAnalyze = (test, recorded, served = null) => {
    if (!fresh) {
      const again = createTestMemoAnalyzer({ ...options, toolVersion: freshToolVersion });
      fresh = { analyzer: again, baseClosure: again.workspaceBase(WORKSPACE_BASE_INPUTS[scope], WORKSPACE_SETUP_ENTRIES[scope]) };
    }
    return fresh.analyzer.analyzeTest(test, { baseClosure: fresh.baseClosure, recorded, served });
  };
  // Digests for a new record come from the post-run analyzer, whose key matched the pre-run one.
  const moduleDigest = (rel) => fresh?.analyzer.moduleDigest(rel) ?? null;

  return { analyze, freshAnalyze, moduleDigest, caseFiltered: caseFilter.length > 0 };
}

/**
 * A browser recheck has already selected this shard. Snapshot only the
 * suites that will execute, using the installed tools and client packages
 * before running Vitest so trusted CI can still verify and record results.
 */
export function prepareMemoRun(run, { memoDir, ...options }) {
  if (!memoDir) return { run };
  const { scope, repoRoot } = options;
  const factsCache = loadFactsCache(memoDir, scope);
  const analysis = createMemoRunAnalysis({ ...options, factsCache });
  const alwaysRun = new Set(getAlwaysRunTests());
  const unmemoizable = new Set();
  const verdicts = new Map();
  for (const test of run) {
    if (neverMemoized(test, repoRoot, alwaysRun)) {
      unmemoizable.add(test);
      continue;
    }
    const record = readMemoRecord(memoDir, scope, test);
    const info = analysis.analyze(test, record?.modules ?? null, null, record?.served ?? null);
    // Capture the static floor now. recordTestMemo compares it after Vitest.
    verdicts.set(test, { floor: info.floor });
  }
  return { ...analysis, run, unmemoizable, verdicts, factsCache };
}

/**
 * The runner's selection and memo verdicts for one workspace. Verdicts cover
 * only owned candidates. For related plans, selection is also local to the
 * shard because reach is determined from those verdicts.
 *
 * @param {object} options
 * @param {'server'|'client'|'db'} options.scope
 * @param {'full'|'files'|'related'} options.mode
 * @param {string[]} options.repoFiles planner-selected test files (repo-relative)
 * @param {string[]} options.repoSources changed sources for related mode (repo-relative)
 * @param {string|string[]|null} options.memoDir null when the memo is off; several directories read in order (`testMemoStore.js`)
 * @param {object|null} [options.factsCache] parsed file facts from earlier runs (`factsCache.js`); loaded from the store by default
 * @param {Array<{label: string, env: object, caseFilter: string[]}>} [options.acceptVerdictsFrom]
 *   settings whose green entry may also skip a file here (`createTestMemoAnalyzer`)
 * @param {string} [options.provisionableTool] tool that setup can change, for counting misses that may still become hits
 * @returns {{ selected: string[], run: string[], skipped: Array<{test: string, via: 'recorded'|'floor', from?: string}>,
 *   unsettled: number, unmemoizable: Set<string>, analyze: (test: string, recorded: string[]) => object, verdicts: Map }}
 */
export function planTestMemo({ scope, mode, repoFiles, repoSources, memoDir, repoRoot, shard = null, env = process.env, platform, arch, nodeVersion, toolVersion = () => null, freshToolVersion = toolVersion, requireToolVersions = false, provisionableTool, planBeforeClientSetup = false, caseFilter = [], acceptVerdictsFrom = [], listFiles = listRepositoryFiles, shardSlice = serverShardSlice, listTests = listWorkspaceTests, readRecord = readMemoRecord, readEntry = readMemoEntry, factsCache = memoDir ? loadFactsCache(memoDir, scope) : null }) {
  const candidates = mode === 'files' ? uniqueSorted(repoFiles)
    : uniqueSorted([...listTests(scope, { repoRoot, platform, env }).map((rel) => toRepoPath(scope, rel)), ...repoFiles]);
  // Related reach can differ between sibling shards with different memo records.
  // Partition the complete inventory first so this cannot move a test's owner.
  const owned = shard ? shardSlice(candidates, { repoRoot, scope, ...shard }) : candidates;
  // Full and files modes already know what to run without analyzing never-memoized tests.
  const alwaysRun = new Set(getAlwaysRunTests());
  const unmemoizable = new Set(mode === 'files' || (mode === 'full' && memoDir)
    ? owned.filter((test) => neverMemoized(test, repoRoot, alwaysRun)) : []);
  const analysis = createMemoRunAnalysis({ scope, repoRoot, env, platform, arch, nodeVersion, toolVersion, freshToolVersion,
    requireToolVersions, planBeforeClientSetup, caseFilter, acceptVerdictsFrom, listFiles, factsCache });
  const { analyze } = analysis;

  // Closures are needed to look up memo entries and to resolve a related
  // plan. With the memo off, a full or files plan is just its list — the
  // analysis of a whole workspace (~10s) must not sit in front of Vitest,
  // least of all for a launcher the browser supervisor holds to a deadline.
  const verdicts = new Map();
  if (memoDir || mode === 'related') {
    for (const test of owned) {
      if (unmemoizable.has(test)) continue;
      const record = memoDir ? readRecord(memoDir, scope, test) : null;
      // Digests only matter to related selection; other modes skip the narrowed walk.
      verdicts.set(test, analyze(test, record?.modules ?? null, mode === 'related' ? record?.digests ?? null : null, record?.served ?? null));
    }
  }

  let selected = candidates;
  if (mode === 'related') {
    const ownedTests = new Set(owned);
    const explicit = repoFiles.filter((test) => ownedTests.has(test));
    // A gate-tooling test never earns a narrowing record, so the walk would select it on any
    // diff (an unresolved edge or open read fails closed). It stays only when a changed
    // source is in its closure or inputs; otherwise the planner's explicit files carry it.
    const reached = relatedTests(verdicts, repoSources)
      .filter((test) => !TOOLING_TESTS.includes(test) || reachesClosure(verdicts.get(test), repoSources));
    selected = uniqueSorted([...reached, ...explicit]);
  }
  const slice = mode === 'related' ? selected : owned;

  const skipped = [];
  const run = [];
  let unsettled = 0;
  let unanalyzed = 0;
  // This run's own entry first, then one written under settings whose verdict
  // also proves this run's cases (`acceptVerdictsFrom`); `from` names those.
  const hit = (test, verdict) => {
    if (!verdict?.memoizable) return null;
    const meta = { test, workspace: scope };
    if (readEntry(memoDir, verdict.key, meta)) return {};
    const accepted = verdict.acceptedKeys.find(({ key }) => readEntry(memoDir, key, meta));
    return accepted ? { from: accepted.label } : null;
  };
  for (const test of slice) {
    const info = verdicts.get(test);
    if (unmemoizable.has(test)) unanalyzed += 1;
    // The recorded key first: `info.floor` walks the whole static closure on
    // first read (`analyzeTest`), so a recorded hit never pays for it. Every
    // file that runs has had its floor read here, before Vitest starts, which
    // `recordTestMemo`'s changed-during-the-run check relies on.
    const recorded = memoDir && info ? hit(test, info.recorded) : null;
    if (recorded) { skipped.push({ test, via: 'recorded', ...recorded }); continue; }
    const floor = memoDir && info ? hit(test, info.floor) : null;
    if (floor) { skipped.push({ test, via: 'floor', ...floor }); continue; }
    run.push(test);
    if (provisionableTool && memoDir && info && [info.recorded, info.floor].some(verdict =>
      verdict?.tools?.has(provisionableTool) && !verdict.unavailableTools?.some(tool => tool !== provisionableTool))) {
      unsettled += 1;
    }
  }
  const narrowed = mode === 'related' ? [...verdicts.values()].filter((info) => info.narrowed).length : 0;
  return { selected, slice, run, skipped, unsettled, unmemoizable, unanalyzed, narrowed, ...analysis, verdicts, factsCache };
}

export function memoSummaryLine(plan) {
  const facts = plan.factsCache?.stats();
  return `🧠 Test memo: skipped ${plan.skipped.length} of ${plan.slice.length} selected files (closure unchanged); running ${plan.run.length}.${plan.unanalyzed ? ` ${plan.unanalyzed} never-memoized guards not analyzed.` : ''}${plan.narrowed ? ` Related selection used ${plan.narrowed} digest records.` : ''}${facts && (facts.hits || facts.misses) ? ` Parsed ${facts.misses} files, reused ${facts.hits}.` : ''}`;
}

/** Vitest's `BaseSequencer.calculateShardRange`: the [start, end) slice of `count` hash-sorted files for shard `index` of `total`. */
export function vitestShardRange(count, index, total) {
  const base = Math.floor(count / total);
  const remainder = count % total;
  if (remainder >= index) {
    const size = base + 1;
    return [size * (index - 1), size * index];
  }
  const start = remainder * (base + 1) + (index - remainder - 1) * base;
  return [start, start + base];
}

/**
 * The string Vitest hashes for a test file when sharding (`BaseSequencer.shard`
 * in vitest/dist/chunks/index.*.js): `resolve(slash(root), slash(moduleId))`
 * with pathe's forward-slash `resolve`, sliced at `root.length` (the
 * unslashed root has the same length). So on every platform an in-workspace
 * file hashes as `/lib/x.test.js` and a file outside the workspace hashes the
 * forward-slashed tail of its absolute path. `path` is injectable so a
 * Windows-shaped root is pinned in the tests.
 */
export function vitestShardHashInput(rel, { repoRoot, scope, path = nodePath }) {
  const slash = (value) => value.replace(/\\/g, '/');
  const root = path.resolve(repoRoot, workspaceOf(scope));
  return slash(path.resolve(repoRoot, ...rel.split('/'))).slice(root.length);
}

/**
 * The files shard `index` of `count` runs, mirroring Vitest's
 * `BaseSequencer.shard`: sort by the sha1 of `vitestShardHashInput`, then
 * take `vitestShardRange`. Pinned against a real `vitest run --shard` in
 * the tests.
 */
export function vitestShardSlice(files, { repoRoot, scope, index, count, path = nodePath }) {
  const hashed = files.map((rel) => ({
    rel,
    hash: createHash('sha1').update(vitestShardHashInput(rel, { repoRoot, scope, path })).digest('hex'),
  })).sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  const [start, end] = vitestShardRange(hashed.length, index, count);
  return hashed.slice(start, end).map(({ rel }) => rel);
}

// Balance heavy suites, always-run guards and the non-capture serial tail
// across the two server jobs (#18336). The duration budget includes shard 1's
// 7s Smoke-boot step. Other files keep their hash owner and memo cache lineage.
export const SERVER_HEAVY_SHARD_OWNERS = {
  'server/test/guards/repo.guard.test.js': 1,
  'server/test/guards/runtime.guard.test.js': 1,
  'server/scripts/run-local-code-review.test.js': 1,
  'server/lib/workTracker.trackerInstructions.test.js': 1,
  'server/services/databaseMaintenanceCutover.test.js': 1,
  'server/services/creativeDirector/videoAssembly.test.js': 1,
  'scripts/workspaceCaches.test.js': 1,
  'scripts/pregate.test.js': 1,
  'scripts/setup-image-video.test.js': 1,
  'scripts/lib/testMemo.test.js': 1,
  'scripts/vitestSiblingSweep.test.js': 1,
  'scripts/update-headless-recovery.test.js': 1,
  'server/services/updateExecutor.deferred.test.js': 1,
  'scripts/runCiTestsClientFixture.test.js': 1,
  'server/services/musicVideo/castAndSetsService.test.js': 1,
  'server/services/musicVideo/audioAnalysis.test.js': 1,
  'server/lib/databaseMaintenanceWorker.test.js': 1,
  'server/test/guards/modules.guard.test.js': 2,
  'scripts/ci-test-plan.test.js': 2,
  'server/routes/cosAgentRoutes.ownershipResponse.test.js': 2,
  'server/services/git.sharedRecovery.test.js': 2,
  'server/services/musicVideo/publishKit.test.js': 2,
  'server/services/musicVideo/sharingCopy.test.js': 2,
  'scripts/run-ci-tests.test.js': 2,
  'server/services/repoRepairCompletion.test.js': 2,
  'scripts/lib/testMemoRunner.test.js': 2,
  'scripts/vitestTempRoot.test.js': 2,
  'scripts/generate_ltx2.test.js': 2,
  'server/services/claimBranchCleanup.integration.test.js': 2,
  'server/routes/musicVideoBlender.test.js': 2,
  'server/services/eidoverseWorld.runtime.test.js': 2,
  'scripts/setup-voice.ps1.test.js': 2,
  'server/routes/musicVideoDcp.test.js': 2,
};

/**
 * Pin 5–6 real-Chromium suites per client shard. The assignments use hosted
 * durations from four-shard runs to balance the browser load against each
 * shard's hashed non-browser files (#18795). New suites stay on the hash
 * until they are pinned.
 */
export const CLIENT_BROWSER_SHARD_OWNERS = Object.freeze({
  'client/src/components/DownloadManager.browser.test.js': 1,
  'client/src/components/media/MediaLightbox.browser.test.js': 1,
  'client/src/components/musicVideo/BlenderFilmPanel.browser.test.js': 1,
  'client/src/components/musicVideo/CastAndSetsGreybox.browser.test.js': 1,
  'client/src/components/ui/InfoTooltip.browser.test.js': 1,
  'client/src/lib/musicVideoFlyer.browser.test.js': 1,
  'client/src/components/ProviderModelSelector.browser.test.js': 2,
  'client/src/components/brain/tabs/InboxTab.browser.test.js': 2,
  'client/src/components/cos/tabs/AgentCard.touch.browser.test.js': 2,
  'client/src/components/cos/tabs/RunsTab.browser.test.js': 2,
  'client/src/pages/Loras.browser.test.js': 2,
  'client/src/pages/PageLayout.browser.test.js': 2,
  'client/src/components/catalog/GenerateImageControl.browser.test.js': 3,
  'client/src/components/catalog/GreyboxPanel.browser.test.js': 3,
  'client/src/components/cos/tabs/PreflightProgress.browser.test.js': 3,
  'client/src/components/goals/GoalsOrganization.browser.test.js': 3,
  'client/src/main.browser.test.js': 3,
  'client/src/pages/MoodBoardDetail.browser.test.js': 3,
  'client/src/components/CmdKSearch.browser.test.js': 4,
  'client/src/components/Drawer.browser.test.js': 4,
  'client/src/components/catalog/CatalogMergePanel.browser.test.js': 4,
  'client/src/components/catalog/GreyboxGlb.browser.test.js': 4,
  'client/src/components/musicVideo/SceneClipCoverageLayout.browser.test.js': 4,
  'client/src/components/catalog/CatalogCard.browser.test.js': 5,
  'client/src/components/catalog/CatalogReferenceVideo.browser.test.js': 5,
  'client/src/components/media/AssetReferences.browser.test.js': 5,
  'client/src/components/musicVideo/SceneCard.browser.test.js': 5,
  'client/src/components/settings/AiAssignmentsTab.layout.browser.test.js': 5,
  'client/src/pages/PromptManager.browser.test.js': 5,
  'client/src/components/ThemeSwitcher.browser.test.js': 6,
  'client/src/components/goals/GoalsTreeView.browser.test.js': 6,
  'client/src/components/ui/OverflowMenu.browser.test.js': 6,
  'client/src/pages/FableLoomStory.browser.test.js': 6,
  'client/src/pages/Shell.browser.test.js': 6,
  'client/src/pages/StoryBuilder.browser.test.js': 6,
});

/**
 * Shard `index` of `count`. Server with two shards moves `SERVER_HEAVY_SHARD_OWNERS`
 * and the client matrix moves `CLIENT_BROWSER_SHARD_OWNERS` off the hash. Every
 * other file stays where `vitestShardSlice` of the full list put it. Any other
 * shape is that hash alone, so Vitest's own sequencer stays aligned.
 */
export function serverShardSlice(files, options) {
  const { index, count, scope } = options;
  const owners = scope === 'client' && count === FULL_SUITE_SHARDS.client ? CLIENT_BROWSER_SHARD_OWNERS
    : scope !== 'client' && count === 2 ? SERVER_HEAVY_SHARD_OWNERS : null;
  if (!owners) return vitestShardSlice(files, options);
  const pinned = new Set(files.filter((file) => Number.isInteger(owners[file])));
  if (pinned.size === 0) return vitestShardSlice(files, options);
  const hashed = vitestShardSlice(files, options).filter((file) => !pinned.has(file));
  const owned = files.filter((file) => owners[file] === index).sort();
  return [...hashed, ...owned];
}

/**
 * Write the selection Vitest will read (`PORTOS_CI_TEST_SELECTION`). `include`
 * null keeps the config's globs (a full run with memo-excluded files).
 */
export function writeSelectionFile({ scope, include, exclude }) {
  const dir = mkdtempSync(join(tmpdir(), 'portos-test-selection-'));
  const path = join(dir, 'selection.json');
  writeFileSync(path, JSON.stringify({
    include: include === null ? null : include.map((test) => toWorkspacePath(scope, test)),
    exclude: exclude.map((test) => toWorkspacePath(scope, test)),
  }));
  return { dir, path };
}

/**
 * Per-file outcomes from Vitest's JSON report: `{ file, status, durationMs, passed, failed, skipped }`.
 * Any read or schema problem yields an empty list — nothing gets memoized.
 */
export function fileResultsFromReport(reportPath) {
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    if (!Array.isArray(report?.testResults)) return [];
    return report.testResults.map((suite) => {
      const assertions = Array.isArray(suite.assertionResults) ? suite.assertionResults : [];
      const count = (status) => assertions.filter((assertion) => assertion?.status === status).length;
      // Summed test time per top-level describe: a structural guard runner's checks (#16996).
      const checks = {};
      for (const { ancestorTitles, duration } of assertions) {
        if (Array.isArray(ancestorTitles) && ancestorTitles.length > 0 && Number.isFinite(duration)) {
          checks[ancestorTitles[0]] = (checks[ancestorTitles[0]] ?? 0) + duration;
        }
      }
      return { file: String(suite.name ?? ''), status: suite.status, durationMs: Number.isFinite(suite.endTime - suite.startTime) ? suite.endTime - suite.startTime : null, checks, passed: count('passed'), failed: count('failed'), skipped: assertions.length - count('passed') - count('failed') };
    }).filter((result) => result.file);
  } catch {
    return [];
  }
}

/**
 * Files a run proved green: the Vitest process exited 0 and its run-level
 * report (`scripts/vitestRunDiagnostics.js`) ended `passed` with no
 * unhandled error — a late rejection after the last test still marks every
 * file `passed` in the JSON report — then per file: status passed, at least
 * one passed case, no failed case, and no skipped case unless a name pattern
 * deliberately skips cases (a browser profile). A capability-gated skip is
 * otherwise invisible to the key, so a file that skipped anything is not
 * recorded.
 */
export function passedTestFiles(fileResults, { repoRoot, namePattern = false, status, runReport }) {
  if (status !== 0 || !runReport || runReport.reason !== 'passed' || runReport.errorCount !== 0) return [];
  const out = [];
  for (const result of fileResults) {
    if (result.status !== 'passed' || result.passed < 1 || result.failed > 0) continue;
    if (result.skipped > 0 && !namePattern) continue;
    const rel = relative(repoRoot, result.file).split(sep).join('/');
    if (rel.startsWith('..') || nodePath.isAbsolute(rel)) continue;
    out.push(rel);
  }
  return out;
}

/**
 * Vitest's recorded depfile: test -> modules it loaded, both repo-relative.
 * A test recorded by several projects gets the union, so a stale project
 * entry can only widen a record. Null when absent, unreadable, or a format
 * this reader does not know. Version 1 maps a test to its module indexes;
 * version 2 (Vitest 5.1's `DependenciesCache`) to `{ at, deps }`. Reading
 * only version 1 silently stopped every record and recorded-key entry after
 * the 5.1 bump, so the runner tests pin the installed Vitest's real output.
 */
export function readVitestDependencies(path, scope) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (![1, 2].includes(parsed?.version) || typeof parsed.projects !== 'object') return null;
    const out = new Map();
    for (const project of Object.values(parsed.projects)) {
      if (!Array.isArray(project?.modules) || typeof project.files !== 'object') continue;
      for (const [test, entry] of Object.entries(project.files)) {
        const indexes = parsed.version === 1 ? entry : entry?.deps;
        if (!Array.isArray(indexes)) continue;
        // Vite's own virtual modules (`/@vite/client` under happy-dom) are not files.
        const modules = indexes.map((index) => project.modules[index])
          .filter((module) => typeof module === 'string' && !VIRTUAL_MODULE.test(module))
          .map((module) => toRepoPath(scope, module));
        const key = toRepoPath(scope, test);
        out.set(key, uniqueSorted([...(out.get(key) ?? []), ...modules]));
      }
    }
    // A file Vitest loaded always names itself and the setup files. An empty
    // list is a seed (`seedVitestDependencies`) the run never filled in, and
    // keying on it would hash nothing but the test file.
    for (const [test, modules] of out) if (modules.length === 0) out.delete(test);
    return out;
  } catch {
    return null;
  }
}

/**
 * Remove every depfile under the workspace's Vitest cache before recording, so
 * the records read afterwards come from this run alone: Vitest merges the
 * file across runs, and CI restores it through a near-miss cache key.
 */
export function clearVitestDependencies(repoRoot, scope) {
  for (;;) {
    const path = findVitestDependenciesFile(repoRoot, scope);
    if (!path) return;
    rmSync(path, { force: true });
  }
}

/** Every project name a workspace config runs files under: the root, and `vitestCaptureProjects`' two. */
export const VITEST_PROJECT_NAMES = Object.freeze(['', 'parallel', 'capture']);

/**
 * Where Vitest keeps a workspace's depfile: `<cacheDir>/vitest/<sha1 of the
 * root project name>/dependencies.json` (`resolveTestCacheDir` in Vitest;
 * no workspace config names its root project).
 */
export function vitestDependenciesPath(repoRoot, scope) {
  return join(repoRoot, workspaceOf(scope), TEST_SCOPES[scope]?.cacheDir ?? '.cache/vitest', 'vitest', createHash('sha1').update('').digest('hex'), 'dependencies.json');
}

/**
 * Give every file about to run an empty previous record, for a run with a
 * case filter (a browser profile's `--testNamePattern`).
 *
 * Vitest calls such a run partial and writes a file's dependency record only
 * by merging into one it already has (`DependenciesCache.update`): cases the
 * filter skipped may import modules the record would then lack, which matters
 * to Vitest because it reuses the record for unfiltered runs. This runner
 * clears the depfile before recording, so without a seed a filtered run
 * recorded nothing and the real-Chrome suites, whose closures have
 * non-literal imports and therefore no floor key, never got an entry
 * (#16545). The memo does not share Vitest's concern: the filter is in the
 * key (`caseFilter`), so an entry only ever vouches for a run that skips the
 * same cases, and `recordTestMemo` stores a filtered record without digests,
 * so it never narrows related selection for another profile.
 *
 * A seed the run does not fill in stays empty, and `readVitestDependencies`
 * drops it. If Vitest moves or reshapes the file the seed is ignored and the
 * runner reports each suite as unrecorded; the runner tests pin both against
 * the installed Vitest.
 */
export function seedVitestDependencies(repoRoot, scope, tests) {
  const files = Object.fromEntries(tests.map((test) => [toWorkspacePath(scope, test), { at: 0, deps: [] }]));
  const path = vitestDependenciesPath(repoRoot, scope);
  nodeFs.mkdirSync(nodePath.dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 2, projects: Object.fromEntries(VITEST_PROJECT_NAMES.map((name) => [name, { modules: [], files }])) }));
}

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

/** Configuration listings one identity reads before it gives up: what git reads by itself, plus each conditional include. */
const GIT_CONFIG_SOURCES_LIMIT = 32;

/**
 * What a `test-memo: git-fixture` suite runs against besides its own
 * sources: the git it finds and everything a repository made on this machine
 * inherits. The first line of `git --version`, then a digest of:
 *
 * - the configuration git reads outside any repository: the system and
 *   global files and what the environment supplies (`GIT_CONFIG_COUNT`,
 *   `GIT_CONFIG_PARAMETERS`), includes followed;
 * - every file a conditional include (`includeIf`) names, whatever its
 *   condition: which of them a fixture repository meets depends on where and
 *   how the suite makes it, so each one counts;
 * - the global ignore and attributes files, at their default place and
 *   wherever any of that configuration puts them, and the system-wide
 *   attributes file, which no configuration names (`git var`, 2.42);
 * - every `GIT_*` environment variable.
 *
 * Only the digest leaves this function, so no setting or credential reaches
 * a log. What a setting points at beyond those files (a hooks or template
 * directory) is the machine's, as the rest of its userland is to every key.
 *
 * Null, which the analyzer never keys (`TEST_MEMO_REQUIRED_TOOLS`), wherever
 * this cannot be established. A failed probe is never read as an empty
 * answer: git cannot be run or is too old to say where a setting came from
 * (`--show-origin`, 2.8) or where its system-wide attributes are; the
 * configuration cannot be listed (malformed, unreadable, a probe that timed
 * out); a file it names cannot be placed (a path relative to each
 * repository, git's own `%(prefix)` interpolation) or read; the include
 * chain does not end; or the directory the fixtures are
 * made under is itself inside a repository, so git started in a fixture
 * directory that is no repository of its own would find that one, whose
 * state is in no key.
 */
function gitToolIdentity({ env, run, scratch, read }) {
  const git = (args) => run('git', args, { env, cwd: scratch, encoding: 'utf8', timeout: 15_000 });
  const version = git(['--version']);
  if (version.error || version.status !== 0) return null;
  const line = String(version.stdout).trim().split('\n')[0];
  const [, major, minor] = line.match(/(\d+)\.(\d+)/) ?? [];
  if (!(Number(major) > 2 || (Number(major) === 2 && Number(minor) >= 8))) return null;
  // Outside a repository git lists exactly what every new repository starts from, and exits 0 with no file at all.
  const enclosing = git(['rev-parse', '--git-dir']);
  if (enclosing.error || enclosing.status === 0) return null;

  const home = env.HOME || env.USERPROFILE || homedir();
  const defaults = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'git');
  // A file that is not there is an input like any other; one that cannot be read is no answer.
  const digestOf = (file) => {
    try { return sha256Hex(read(file)); } catch (error) { return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'absent' : null; }
  };
  const files = new Set([join(defaults, 'ignore'), join(defaults, 'attributes')]);
  // Only git knows where its system-wide attributes file is; `GIT_ATTR_NOSYSTEM` is the one way it has none.
  const systemAttributes = git(['var', 'GIT_ATTR_SYSTEM']);
  const attributesPath = systemAttributes.error || systemAttributes.status !== 0 ? '' : String(systemAttributes.stdout).trim();
  if (attributesPath !== '') files.add(attributesPath);
  else if (systemAttributes.error || systemAttributes.status !== 1 || !env.GIT_ATTR_NOSYSTEM) return null;
  const sources = [[]];
  const listings = [];
  for (let at = 0; at < sources.length; at += 1) {
    if (at >= GIT_CONFIG_SOURCES_LIMIT) return null;
    // git skips a conditional include whose file is missing; any other one has to be readable and listable.
    const target = sources[at].length ? digestOf(sources[at][1]) : '';
    if (target === null) return null;
    if (target === 'absent') { listings.push(`${sources[at][1]} absent`); continue; }
    const listed = git(['config', ...sources[at], '--includes', '--show-origin', '--null', '--list']);
    if (listed.error || listed.status !== 0) return null;
    const text = String(listed.stdout);
    listings.push(`${sources[at].join(' ')}\n${text}`);
    // `--show-origin --null` writes `origin\0key\nvalue\0` per setting.
    const fields = text.split('\0');
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const [key, ...rest] = fields[i + 1].split('\n');
      const include = /^includeif\..*\.path$/.test(key);
      if (!include && key !== 'core.excludesfile' && key !== 'core.attributesfile') continue;
      const value = rest.join('\n');
      // `~/` is the home directory. An include is otherwise read beside the file that names it; an
      // ignore or attributes file beside whichever repository reads the setting, which is no one place.
      const beside = include && fields[i].startsWith('file:') ? dirname(fields[i].slice('file:'.length)) : null;
      // `~user/` and git's own `%(prefix)/` are places this cannot name.
      const named = /^~[\\/]/.test(value) ? join(home, value.slice(2)) : isAbsolute(value) ? value : beside === null || /^(?:~|%\()/.test(value) ? null : join(beside, value);
      if (named === null) return null;
      if (!include) files.add(named);
      else if (!sources.some(([, file]) => file === named)) sources.push(['--file', named]);
    }
  }
  const fileDigests = [...files].sort().map((file) => [file, digestOf(file)]);
  if (fileDigests.some(([, digest]) => digest === null)) return null;
  const gitEnv = Object.keys(env).filter((name) => name.startsWith('GIT_')).sort().map((name) => `${name}=${env[name]}`);
  return `${line} settings ${sha256Hex([...listings, ...fileDigests.map((pair) => pair.join(' ')), ...gitEnv].join('\0')).slice(0, 16)}`;
}

/**
 * Version strings for `TEST_MEMO_TOOLS`, resolved once per process the way
 * the suites find the programs: `PORTOS_TEST_PYTHON` or `python3`, `ffmpeg`
 * on PATH, Chrome through the suites' own candidate list
 * (`resolveTestChrome`), and git with what its repositories inherit
 * (`gitToolIdentity`; `scratch` is the directory the suites' temp root is
 * made under, as `bootstrapVitestTempRoot` picks it, and `read` reads a
 * file). Null when the program cannot be run.
 */
export function createToolVersionResolver({ env = process.env, verifyAudioPair = false, run = spawnSync, scratch = env.PORTOS_TEST_TEMP_ROOT || tmpdir(), read = readFileSync } = {}) {
  const cache = new Map();
  const firstLine = (command, args) => {
    if (!command) return null;
    const result = run(command, args, { env, encoding: 'utf8', timeout: 15_000 });
    if (result.error || result.status !== 0) return null;
    return `${result.stdout}${result.stderr}`.trim().split('\n')[0] || null;
  };
  const audioVersion = () => {
    const version = firstLine('ffmpeg', ['-version']);
    if (!verifyAudioPair || !version) return version;
    // The suite needs the companion tool from the same package. Keep the
    // original ffmpeg line as the key so existing verified entries still hit.
    const probe = firstLine('ffprobe', ['-version']);
    const release = version.match(/^ffmpeg version (\S+)/)?.[1];
    return release && probe?.match(/^ffprobe version (\S+)/)?.[1] === release ? version : null;
  };
  return (tool) => {
    if (cache.has(tool)) return cache.get(tool);
    const version = tool === 'python' ? firstLine(env.PORTOS_TEST_PYTHON || 'python3', ['--version'])
      : tool === 'ffmpeg' ? audioVersion()
        : tool === 'chrome' ? firstLine(resolveTestChrome(env), ['--version'])
          : tool === 'git' ? gitToolIdentity({ env, run, scratch, read })
            : null;
    cache.set(tool, version);
    return version;
  };
}

/**
 * Every working-tree file git does not ignore, repo-relative: tracked files
 * plus untracked ones a commit would pick up. One `git ls-files`; null when
 * git cannot answer (not a checkout), which leaves an oversized directory
 * input failing closed. The analyzer hashes working-tree bytes of what this
 * names, so no repository state enters a key through it.
 */
export function listRepositoryFiles(repoRoot) {
  const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.error || result.status !== 0) return null;
  return result.stdout.split('\0').filter(Boolean);
}

/** Best-effort commit identity for the entry; never a reason to fail the run. */
export function currentCommit(repoRoot, env = process.env) {
  if (env.GITHUB_SHA) return env.GITHUB_SHA;
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

const DECLARED_NEVER = 'never memoized by declaration (tree guard or always-run test, TEST_MEMO_NEVER or the test-memo: never marker)';
const CHANGED_DURING_RUN = 'an input changed while the run was in flight';

/**
 * Record green results: a memo record and entries for every passed file the
 * plan knows. Each key is recomputed from the tree as it is after the run
 * and written only when it still equals the key computed before (floor) or
 * from the pre-run hashes (recorded): a file edited while Vitest ran is not
 * attributed to the verdict.
 *
 * `served` (`readServedFiles`, `browserServedFiles.js`) narrows a real-Chromium suite's recorded key
 * to what its fixture served, and is stored in its record.
 *
 * `unrecorded` names every passed file that got no entry under either key,
 * with why each key was refused, so a suite that re-runs forever says so in
 * the log instead of only lowering a count. `declared` marks the files that
 * are never memoized on purpose; the runner counts those and lists the rest.
 *
 * @returns {{ written: number, unrecorded: Array<{ test: string, reason: string, declared: boolean }> }}
 */
export function recordTestMemo({ scope, repoRoot, memoDir, plan, passed, dependencies, served = new Map(), source, commit, writeEntry = writeMemoEntry, writeRecord = writeMemoRecord }) {
  let written = 0;
  const unrecorded = [];
  for (const test of passed) {
    const info = plan.verdicts.get(test);
    if (!info) {
      const declared = plan.unmemoizable?.has(test) === true;
      unrecorded.push({ test, reason: declared ? DECLARED_NEVER : 'not analyzed by this plan', declared });
      continue;
    }
    const meta = { test, workspace: scope, source, commit };
    const modules = dependencies?.get(test) ?? null;
    const servedFiles = served.get(test) ?? null;
    // Re-read inputs only if the floor or recorded key could be written.
    // Still compute the recorded candidate from Vitest's actual modules.
    let after;
    const fresh = () => (after ??= plan.freshAnalyze(test, modules, servedFiles));
    const refused = [];
    if (!info.floor.memoizable) refused.push(`floor key: ${info.floor.reason}`);
    else if (fresh().floor.key !== info.floor.key) refused.push(`floor key: ${CHANGED_DURING_RUN}`);
    else { writeEntry(memoDir, info.floor.key, meta); written += 1; }
    const recorded = modules ? plan.analyze(test, modules, null, servedFiles).recorded : null;
    if (!modules) refused.push(`recorded key: ${dependencies ? 'Vitest recorded no modules for this file' : 'no readable Vitest dependency file'}`);
    else if (!recorded?.memoizable) refused.push(`recorded key: ${recorded?.reason ?? 'not computed'}`);
    else if (fresh().recorded?.key !== recorded.key) refused.push(`recorded key: ${CHANGED_DURING_RUN}`);
    else {
      // A case-filtered run loaded only what its cases reached: the list keys this
      // filter's entry, but digests would let it narrow selection for any other run.
      writeRecord(memoDir, scope, test, modules, plan.caseFiltered ? () => null : plan.moduleDigest, servedFiles);
      writeEntry(memoDir, recorded.key, meta);
      written += 1;
    }
    if (refused.length === 2) unrecorded.push({ test, reason: refused.join('; '), declared: info.floor.declared === true });
  }
  return { written, unrecorded };
}

/** How often the developer's shared store drops its expired entries (`pruneTestMemo`). */
export const LOCAL_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Bound the store at the end of a run that may publish it (`pruneMemoStore`).
 * A trusted CI job owns its store outright: drop expired entries, keep the
 * newest few per test and forget test files this checkout no longer has, so
 * the cache it saves stays the size of the suite rather than of its history.
 * The developer's store is shared by every worktree and branch, so only
 * expired entries go, and at most once per `LOCAL_PRUNE_INTERVAL_MS`
 * (a `pruned-at` stamp in the store). Returns the prune counts, or null
 * when nothing was pruned.
 */
export function pruneTestMemo({ memoDir, repoRoot, trustedCi, now = Date.now(), prune = pruneMemoStore }) {
  if (!memoDir) return null;
  if (trustedCi) {
    return prune(memoDir, { now, testExists: (_workspace, test) => nodeFs.existsSync(join(repoRoot, ...test.split('/'))) });
  }
  const [root] = memoDirs(memoDir);
  const stampPath = join(root, 'pruned-at');
  let last = Number.NaN;
  try { last = Date.parse(readFileSync(stampPath, 'utf8').trim()); } catch { /* never pruned */ }
  if (Number.isFinite(last) && last <= now && now - last < LOCAL_PRUNE_INTERVAL_MS) return null;
  const counts = prune(root, { now, maxEntriesPerTest: Number.POSITIVE_INFINITY });
  try {
    nodeFs.mkdirSync(root, { recursive: true });
    writeFileSync(stampPath, new Date(now).toISOString());
  } catch { /* the next run prunes again */ }
  return counts;
}

/** How many unrecorded files `memoUnrecordedLines` names before it counts the rest. */
export const MEMO_UNRECORDED_LINE_LIMIT = 40;

/**
 * The log lines for `recordTestMemo`'s `unrecorded` list: one per file,
 * capped, then one count for the overflow and one for the files that are
 * never memoized on purpose (a full run passes dozens of those every time;
 * listing them would bury the suites that should have been recorded).
 */
export function memoUnrecordedLines(unrecorded, limit = MEMO_UNRECORDED_LINE_LIMIT) {
  const listed = unrecorded.filter((entry) => !entry.declared);
  const declared = unrecorded.length - listed.length;
  const lines = listed.slice(0, limit).map(({ test, reason }) => `🧠   not recorded: ${test} (${reason})`);
  if (listed.length > limit) lines.push(`🧠   not recorded: ${listed.length - limit} more files not listed.`);
  if (declared > 0) lines.push(`🧠   not recorded: ${declared} files ${DECLARED_NEVER}.`);
  return lines;
}

/**
 * Vitest writes the depfile under its config-hashed cache directory
 * (`<workspace>/.cache/vitest[-db]/vitest/<hash>/dependencies.json`); the newest
 * one is this run's. Null when none exists.
 */
export function findVitestDependenciesFile(repoRoot, scope) {
  const root = join(repoRoot, workspaceOf(scope), TEST_SCOPES[scope]?.cacheDir ?? '.cache/vitest');
  let newest = null;
  const walk = (dir, depth) => {
    let entries;
    try { entries = nodeFs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) walk(path, depth + 1);
      else if (entry.isFile() && entry.name === 'dependencies.json') {
        const mtime = nodeFs.statSync(path).mtimeMs;
        if (!newest || mtime > newest.mtime) newest = { path, mtime };
      }
    }
  };
  walk(root, 0);
  return newest?.path ?? null;
}
