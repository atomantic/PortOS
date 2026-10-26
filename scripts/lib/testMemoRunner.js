/**
 * Test memo orchestration for `scripts/run-ci-tests.js`: decide which of the
 * plan's selected files a trusted green run already verified, and record the
 * new green results afterwards. The same code runs under `npm run pregate`
 * and in CI, so there is one opinion about what the memo covers.
 *
 * Selection is closure-based (`testMemo.js`): in `related` mode a test is
 * selected when a changed source is in its module closure, or when its edges
 * could not all be resolved. The planner's explicit files are always added.
 * Vitest then receives the exact list through a selection file
 * (`vitestRunnerSelection` in `scripts/vitestCiPool.js`).
 *
 * Recording: Vitest's `experimental.recordDependencies` depfile names the
 * modules each test actually loaded. A passed file gets a memo record (that
 * list) and an entry under its recorded key, plus an entry under its floor
 * key when the static closure is fully resolvable — so the next run can hit
 * either. Entries come only from a run whose process exited 0 and whose
 * run-level report shows no unhandled error, and only when the inputs hash
 * the same after the run as before it.
 *
 * Sharding: a matrix shard takes its slice of the FULL selected list with
 * the runner's selected algorithm (Vitest by default) before the memo subtracts
 * anything, so every file lands in exactly one shard whatever each shard's
 * store holds. Vitest itself is never given `--shard`.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { join, relative, sep } from 'node:path';
import { resolveTestChrome } from './testChrome.js';
import { WORKSPACE_BASE_INPUTS, WORKSPACE_SETUP_ENTRIES, createDiskFs, createTestMemoAnalyzer, relatedTests } from './testMemo.js';
import { readMemoEntry, readMemoRecord, writeMemoEntry, writeMemoRecord } from './testMemoStore.js';
import { TEST_SCOPES, listWorkspaceTests, toRepoPath, toWorkspacePath, workspaceOf } from './workspaceTests.js';

const uniqueSorted = (values) => [...new Set(values)].sort();
const VIRTUAL_MODULE = /(?:^|\/)@vite\/|^\0|^virtual:/;

/**
 * The runner's selection and memo verdicts for one workspace.
 *
 * @param {object} options
 * @param {'server'|'client'|'db'} options.scope
 * @param {'full'|'files'|'related'} options.mode
 * @param {string[]} options.repoFiles planner-selected test files (repo-relative)
 * @param {string[]} options.repoSources changed sources for related mode (repo-relative)
 * @param {string|null} options.memoDir null when the memo is off
 * @returns {{ selected: string[], run: string[], skipped: Array<{test: string, via: 'recorded'|'floor'}>,
 *   reasons: Map<string, string>, analyze: (test: string, recorded: string[]) => object, verdicts: Map }}
 */
export function planTestMemo({ scope, mode, repoFiles, repoSources, memoDir, repoRoot, shard = null, env = process.env, platform, arch, nodeVersion, toolVersion = () => null, shardSlice = vitestShardSlice, listTests = listWorkspaceTests, readRecord = readMemoRecord, readEntry = readMemoEntry }) {
  const workspaceTests = listTests(scope, { repoRoot, platform, env }).map((rel) => toRepoPath(scope, rel));
  const candidates = mode === 'files' ? uniqueSorted(repoFiles) : uniqueSorted([...workspaceTests, ...repoFiles]);
  const options = { fs: createDiskFs(repoRoot, nodeFs, nodePath), workspaceRel: workspaceOf(scope), env, platform, arch, nodeVersion, toolVersion };
  const analyzer = createTestMemoAnalyzer(options);
  const baseClosure = analyzer.workspaceBase(WORKSPACE_BASE_INPUTS[scope], WORKSPACE_SETUP_ENTRIES[scope]);
  const analyze = (test, recorded) => analyzer.analyzeTest(test, { baseClosure, recorded });
  // A second analyzer with empty caches re-reads every input after the run,
  // so an entry is written only for inputs that did not change meanwhile.
  let fresh = null;
  const freshAnalyze = (test, recorded) => {
    if (!fresh) {
      const again = createTestMemoAnalyzer(options);
      fresh = { analyzer: again, baseClosure: again.workspaceBase(WORKSPACE_BASE_INPUTS[scope], WORKSPACE_SETUP_ENTRIES[scope]) };
    }
    return fresh.analyzer.analyzeTest(test, { baseClosure: fresh.baseClosure, recorded });
  };

  // Closures are needed to look up memo entries and to resolve a related
  // plan. With the memo off, a full or files plan is just its list — the
  // analysis of a whole workspace (~10s) must not sit in front of Vitest,
  // least of all for a launcher the browser supervisor holds to a deadline.
  const verdicts = new Map();
  if (memoDir || mode === 'related') {
    for (const test of candidates) verdicts.set(test, analyze(test, memoDir ? readRecord(memoDir, scope, test) : null));
  }

  const selected = mode === 'related'
    ? uniqueSorted([...relatedTests(verdicts, repoSources), ...repoFiles])
    : candidates;
  const slice = shard ? shardSlice(selected, { repoRoot, scope, ...shard }) : selected;

  const skipped = [];
  const reasons = new Map();
  const run = [];
  for (const test of slice) {
    const info = verdicts.get(test);
    const via = !memoDir || !info ? null
      : info.recorded?.memoizable && readEntry(memoDir, info.recorded.key, { test, workspace: scope }) ? 'recorded'
        : info.floor.memoizable && readEntry(memoDir, info.floor.key, { test, workspace: scope }) ? 'floor'
          : null;
    if (via) { skipped.push({ test, via }); continue; }
    run.push(test);
    if (info && !info.floor.memoizable) reasons.set(test, info.recorded?.memoizable ? 'no green entry yet (recorded key)' : info.recorded?.reason ?? info.floor.reason);
  }
  return { selected, slice, run, skipped, reasons, analyze, freshAnalyze, verdicts };
}

export function memoSummaryLine(plan) {
  return `🧠 Test memo: skipped ${plan.skipped.length} of ${plan.slice.length} selected files (closure unchanged); running ${plan.run.length}.`;
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
 * Per-file outcomes from Vitest's JSON report: `{ file, status, passed, failed, skipped }`.
 * Any read or schema problem yields an empty list — nothing gets memoized.
 */
export function fileResultsFromReport(reportPath) {
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    if (!Array.isArray(report?.testResults)) return [];
    return report.testResults.map((suite) => {
      const assertions = Array.isArray(suite.assertionResults) ? suite.assertionResults : [];
      const count = (status) => assertions.filter((assertion) => assertion?.status === status).length;
      return { file: String(suite.name ?? ''), status: suite.status, passed: count('passed'), failed: count('failed'), skipped: assertions.length - count('passed') - count('failed') };
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
 * entry can only widen a record. Null when absent or unreadable.
 */
export function readVitestDependencies(path, scope) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed?.version !== 1 || typeof parsed.projects !== 'object') return null;
    const out = new Map();
    for (const project of Object.values(parsed.projects)) {
      if (!Array.isArray(project?.modules) || typeof project.files !== 'object') continue;
      for (const [test, indexes] of Object.entries(project.files)) {
        if (!Array.isArray(indexes)) continue;
        // Vite's own virtual modules (`/@vite/client` under happy-dom) are not files.
        const modules = indexes.map((index) => project.modules[index])
          .filter((module) => typeof module === 'string' && !VIRTUAL_MODULE.test(module))
          .map((module) => toRepoPath(scope, module));
        const key = toRepoPath(scope, test);
        out.set(key, uniqueSorted([...(out.get(key) ?? []), ...modules]));
      }
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Remove every depfile under the workspace's Vitest cache before a run, so
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

/**
 * Version strings for `TEST_MEMO_TOOLS`, resolved once per process the way
 * the suites find the programs: `PORTOS_TEST_PYTHON` or `python3`, `ffmpeg`
 * on PATH, and Chrome through the suites' own candidate list
 * (`resolveTestChrome`). Null (keyed as `absent`) when the program cannot
 * be run.
 */
export function createToolVersionResolver({ env = process.env } = {}) {
  const cache = new Map();
  const firstLine = (command, args) => {
    if (!command) return null;
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15_000 });
    if (result.error || result.status !== 0) return null;
    return `${result.stdout}${result.stderr}`.trim().split('\n')[0] || null;
  };
  return (tool) => {
    if (cache.has(tool)) return cache.get(tool);
    const version = tool === 'python' ? firstLine(env.PORTOS_TEST_PYTHON || 'python3', ['--version'])
      : tool === 'ffmpeg' ? firstLine('ffmpeg', ['-version'])
        : tool === 'chrome' ? firstLine(resolveTestChrome(env), ['--version'])
          : null;
    cache.set(tool, version);
    return version;
  };
}

/** Best-effort commit identity for the entry; never a reason to fail the run. */
export function currentCommit(repoRoot, env = process.env) {
  if (env.GITHUB_SHA) return env.GITHUB_SHA;
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Record green results: a memo record and entries for every passed file the
 * plan knows. Each key is recomputed from the tree as it is after the run
 * and written only when it still equals the key computed before (floor) or
 * from the pre-run hashes (recorded): a file edited while Vitest ran is not
 * attributed to the verdict. Returns how many entries were written.
 */
export function recordTestMemo({ scope, repoRoot, memoDir, plan, passed, dependencies, source, commit, writeEntry = writeMemoEntry, writeRecord = writeMemoRecord }) {
  let written = 0;
  for (const test of passed) {
    const info = plan.verdicts.get(test);
    if (!info) continue;
    const meta = { test, workspace: scope, source, commit };
    const modules = dependencies?.get(test) ?? null;
    const after = plan.freshAnalyze(test, modules);
    if (info.floor.memoizable && after.floor.key === info.floor.key) { writeEntry(memoDir, info.floor.key, meta); written += 1; }
    if (!modules) continue;
    const recorded = plan.analyze(test, modules).recorded;
    if (!recorded?.memoizable || after.recorded?.key !== recorded.key) continue;
    writeRecord(memoDir, scope, test, modules);
    writeEntry(memoDir, recorded.key, meta);
    written += 1;
  }
  return written;
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
