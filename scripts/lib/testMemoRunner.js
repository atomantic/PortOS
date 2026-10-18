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
 * either.
 */

import { spawnSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { join, relative, sep } from 'node:path';
import { WORKSPACE_BASE_INPUTS, createDiskFs, createTestMemoAnalyzer, relatedTests } from './testMemo.js';
import { readMemoEntry, readMemoRecord, writeMemoEntry, writeMemoRecord } from './testMemoStore.js';
import { listWorkspaceTests, toRepoPath, toWorkspacePath } from './workspaceTests.js';

const uniqueSorted = (values) => [...new Set(values)].sort();
const VIRTUAL_MODULE = /(?:^|\/)@vite\/|^\0|^virtual:/;

/**
 * The runner's selection and memo verdicts for one workspace.
 *
 * @param {object} options
 * @param {'server'|'client'} options.scope
 * @param {'full'|'files'|'related'} options.mode
 * @param {string[]} options.repoFiles planner-selected test files (repo-relative)
 * @param {string[]} options.repoSources changed sources for related mode (repo-relative)
 * @param {string|null} options.memoDir null when the memo is off
 * @returns {{ selected: string[], run: string[], skipped: Array<{test: string, via: 'recorded'|'floor'}>,
 *   reasons: Map<string, string>, analyze: (test: string, recorded: string[]) => object, verdicts: Map }}
 */
export function planTestMemo({ scope, mode, repoFiles, repoSources, memoDir, repoRoot, env = process.env, platform, arch, nodeMajor, listTests = listWorkspaceTests, readRecord = readMemoRecord, readEntry = readMemoEntry }) {
  const workspaceTests = listTests(scope, { repoRoot, platform, env }).map((rel) => toRepoPath(scope, rel));
  const candidates = mode === 'files' ? uniqueSorted(repoFiles) : uniqueSorted([...workspaceTests, ...repoFiles]);
  const analyzer = createTestMemoAnalyzer({ fs: createDiskFs(repoRoot, nodeFs, nodePath), workspaceRel: scope, env, platform, arch, nodeMajor });
  const baseClosure = analyzer.workspaceBase(WORKSPACE_BASE_INPUTS[scope]);
  const analyze = (test, recorded) => analyzer.analyzeTest(test, { baseClosure, recorded });

  const verdicts = new Map();
  for (const test of candidates) verdicts.set(test, analyze(test, memoDir ? readRecord(memoDir, scope, test) : null));

  const selected = mode === 'related'
    ? uniqueSorted([...relatedTests(verdicts, repoSources), ...repoFiles])
    : candidates;

  const skipped = [];
  const reasons = new Map();
  const run = [];
  for (const test of selected) {
    const info = verdicts.get(test);
    const via = !memoDir ? null
      : info.recorded?.memoizable && readEntry(memoDir, info.recorded.key, { test, workspace: scope }) ? 'recorded'
        : info.floor.memoizable && readEntry(memoDir, info.floor.key, { test, workspace: scope }) ? 'floor'
          : null;
    if (via) { skipped.push({ test, via }); continue; }
    run.push(test);
    if (!info.floor.memoizable) reasons.set(test, info.recorded?.memoizable ? 'no green entry yet (recorded key)' : info.recorded?.reason ?? info.floor.reason);
  }
  return { selected, run, skipped, reasons, analyze, verdicts };
}

export function memoSummaryLine(plan) {
  return `🧠 Test memo: skipped ${plan.skipped.length} of ${plan.selected.length} selected files (closure unchanged); running ${plan.run.length}.`;
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
 * Files a run proved green: status passed, at least one passed case, no
 * failed case, and no skipped case unless a name pattern deliberately skips
 * cases (a browser profile). A capability-gated skip is otherwise invisible
 * to the key, so a file that skipped anything is not recorded.
 */
export function passedTestFiles(fileResults, { repoRoot, namePattern = false }) {
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
 * Vitest's recorded depfile (`<workspace>/.cache/vitest/dependencies.json`):
 * test -> modules it loaded, both repo-relative. Null when absent or unreadable.
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
          .filter((module) => typeof module === 'string' && !VIRTUAL_MODULE.test(module));
        out.set(toRepoPath(scope, test), modules.map((module) => toRepoPath(scope, module)));
      }
    }
    return out;
  } catch {
    return null;
  }
}

/** Best-effort commit identity for the entry; never a reason to fail the run. */
export function currentCommit(repoRoot, env = process.env) {
  if (env.GITHUB_SHA) return env.GITHUB_SHA;
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Record green results: a memo record and entries for every passed file the
 * plan knows. Returns how many entries were written.
 */
export function recordTestMemo({ scope, repoRoot, memoDir, plan, passed, dependencies, source, commit, writeEntry = writeMemoEntry, writeRecord = writeMemoRecord }) {
  let written = 0;
  for (const test of passed) {
    const info = plan.verdicts.get(test);
    if (!info) continue;
    const meta = { test, workspace: scope, source, commit };
    if (info.floor.memoizable) { writeEntry(memoDir, info.floor.key, meta); written += 1; }
    const modules = dependencies?.get(test);
    if (!modules) continue;
    const recorded = plan.analyze(test, modules).recorded;
    if (!recorded?.memoizable) continue;
    writeRecord(memoDir, scope, test, modules);
    writeEntry(memoDir, recorded.key, meta);
    written += 1;
  }
  return written;
}

/**
 * Vitest writes the depfile under its config-hashed cache directory
 * (`<workspace>/.cache/vitest/vitest/<hash>/dependencies.json`); the newest
 * one is this run's. Null when none exists.
 */
export function findVitestDependenciesFile(repoRoot, scope) {
  const root = join(repoRoot, scope, '.cache', 'vitest');
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
