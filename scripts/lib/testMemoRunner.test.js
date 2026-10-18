/**
 * Runner-side memo contract over a synthetic repository on disk: memoized
 * files leave the launch list, related selection follows the closure, and
 * entries are written only for files a run reported green.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearVitestDependencies, fileResultsFromReport, findVitestDependenciesFile, passedTestFiles, planTestMemo, readVitestDependencies,
  recordTestMemo, vitestShardRange, vitestShardSlice, writeSelectionFile,
} from './testMemoRunner.js';
import { readMemoEntry, readMemoRecord, writeMemoEntry } from './testMemoStore.js';

const FILES = {
  'server/vitest.config.js': 'export default {};\n',
  'server/vitest.setup.js': 'export const setup = true;\n',
  'scripts/vitestCiPool.js': 'export const vitestCiPool = () => ({});\n',
  'server/package.json': '{"name":"server"}',
  'server/package-lock.json': '{}',
  'server/node_modules/vitest/package.json': '{"name":"vitest","version":"5.0.4"}',
  'server/lib/a.js': 'export const a = 1;\n',
  'server/lib/b.js': "export const load = () => import('./lazy.js');\n",
  'server/lib/lazy.js': 'export const lazy = 1;\n',
  'server/lib/a.test.js': "import { it } from 'vitest';\nimport { a } from './a.js';\nit('a', () => {});\n",
  'server/lib/b.test.js': "import { it } from 'vitest';\nimport { load } from './b.js';\nit('b', () => {});\n",
  'server/lib/c.test.js': "import { it } from 'vitest';\nit('c', () => {});\n",
};
const TESTS = ['lib/a.test.js', 'lib/b.test.js', 'lib/c.test.js'];

function writeRepo(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
}

describe('planTestMemo and recordTestMemo', () => {
  let root;
  let memoDir;
  afterEach(() => { for (const dir of [root, memoDir]) if (dir) rmSync(dir, { recursive: true, force: true }); });

  const plan = (overrides = {}) => planTestMemo({
    scope: 'server', mode: 'files', repoFiles: TESTS.map((t) => `server/${t}`), repoSources: [], memoDir, repoRoot: root,
    env: { NODE_ENV: 'test' }, platform: 'linux', arch: 'x64', nodeVersion: '24.1.0', listTests: () => TESTS, ...overrides,
  });

  it('subtracts memoized files, selects related files from the closure, and records only passed files', () => {
    root = mkdtempSync(join(tmpdir(), 'portos-memo-repo-'));
    memoDir = mkdtempSync(join(tmpdir(), 'portos-memo-store-'));
    writeRepo(root, FILES);

    const cold = plan();
    expect(cold.selected).toEqual(['server/lib/a.test.js', 'server/lib/b.test.js', 'server/lib/c.test.js']);
    expect(cold.run).toEqual(cold.selected);
    expect(cold.skipped).toEqual([]);

    const passedReport = {
      testResults: [
        { name: join(root, 'server/lib/a.test.js'), status: 'passed', assertionResults: [{ status: 'passed' }] },
        { name: join(root, 'server/lib/b.test.js'), status: 'failed', assertionResults: [{ status: 'failed' }] },
        { name: join(root, 'server/lib/c.test.js'), status: 'passed', assertionResults: [{ status: 'passed' }, { status: 'skipped' }] },
      ],
    };
    const reportPath = join(root, 'report.json');
    writeFileSync(reportPath, JSON.stringify(passedReport));
    const clean = { repoRoot: root, status: 0, runReport: { reason: 'passed', errorCount: 0 } };
    const passed = passedTestFiles(fileResultsFromReport(reportPath), clean);
    expect(passed).toEqual(['server/lib/a.test.js']);
    expect(passedTestFiles(fileResultsFromReport(reportPath), { ...clean, namePattern: true })).toEqual(['server/lib/a.test.js', 'server/lib/c.test.js']);
    // A red process, a late unhandled error, or a missing run report proves nothing for any file.
    expect(passedTestFiles(fileResultsFromReport(reportPath), { ...clean, status: 1 })).toEqual([]);
    expect(passedTestFiles(fileResultsFromReport(reportPath), { ...clean, runReport: { reason: 'passed', errorCount: 1 } })).toEqual([]);
    expect(passedTestFiles(fileResultsFromReport(reportPath), { ...clean, runReport: null })).toEqual([]);

    expect(findVitestDependenciesFile(root, 'server')).toBeNull();
    const dependenciesPath = join(root, 'server', '.cache', 'vitest', 'vitest', 'confighash', 'dependencies.json');
    mkdirSync(join(dependenciesPath, '..'), { recursive: true });
    writeFileSync(dependenciesPath, JSON.stringify({ version: 1, projects: { parallel: {
      modules: ['lib/a.test.js', 'lib/a.js', 'lib/b.test.js', 'lib/b.js'], globalSetup: [],
      files: { 'lib/a.test.js': [0, 1], 'lib/b.test.js': [2, 3] },
    } } }));
    expect(findVitestDependenciesFile(root, 'server')).toBe(dependenciesPath);
    const dependencies = readVitestDependencies(dependenciesPath, 'server');
    expect(readVitestDependencies(null, 'server')).toBeNull();
    // Two projects recording one file (a stale entry from the other group) union rather than overwrite.
    const twice = join(root, 'twice.json');
    writeFileSync(twice, JSON.stringify({ version: 1, projects: {
      capture: { modules: ['lib/x.test.js', 'lib/x.js', 'lib/newDep.js'], files: { 'lib/x.test.js': [0, 1, 2] } },
      parallel: { modules: ['lib/x.test.js', 'lib/x.js'], files: { 'lib/x.test.js': [0, 1] } },
    } }));
    expect(readVitestDependencies(twice, 'server').get('server/lib/x.test.js')).toEqual(['server/lib/newDep.js', 'server/lib/x.js', 'server/lib/x.test.js']);
    expect(dependencies.get('server/lib/a.test.js')).toEqual(['server/lib/a.js', 'server/lib/a.test.js']);

    const written = recordTestMemo({ scope: 'server', repoRoot: root, memoDir, plan: cold, passed, dependencies, source: 'local', commit: 'abc' });
    expect(written).toBe(2);
    expect(readMemoRecord(memoDir, 'server', 'server/lib/a.test.js')).toEqual(['server/lib/a.js', 'server/lib/a.test.js']);
    expect(readMemoRecord(memoDir, 'server', 'server/lib/b.test.js')).toBeNull();
    expect(readMemoEntry(memoDir, cold.verdicts.get('server/lib/a.test.js').floor.key, { test: 'server/lib/a.test.js', workspace: 'server' })).toMatchObject({ source: 'local', commit: 'abc' });
    expect(readMemoEntry(memoDir, cold.verdicts.get('server/lib/b.test.js').floor.key, { test: 'server/lib/b.test.js', workspace: 'server' })).toBeNull();

    const warm = plan();
    expect(warm.skipped).toEqual([{ test: 'server/lib/a.test.js', via: 'recorded' }]);
    expect(warm.run).toEqual(['server/lib/b.test.js', 'server/lib/c.test.js']);

    // A file edited while the run was in flight is not attributed to its verdict.
    const midRun = plan();
    writeFileSync(join(root, 'server/lib/b.js'), "export const load = () => import('./lazy.js'); // edited mid-run\n");
    const bPassed = { testResults: [{ name: join(root, 'server/lib/b.test.js'), status: 'passed', assertionResults: [{ status: 'passed' }] }] };
    writeFileSync(reportPath, JSON.stringify(bPassed));
    expect(recordTestMemo({ scope: 'server', repoRoot: root, memoDir, plan: midRun, passed: passedTestFiles(fileResultsFromReport(reportPath), clean), dependencies, source: 'local', commit: 'abc' })).toBe(0);
    expect(readMemoRecord(memoDir, 'server', 'server/lib/b.test.js')).toBeNull();
    clearVitestDependencies(root, 'server');
    expect(findVitestDependenciesFile(root, 'server')).toBeNull();

    // A shard takes its slice of the full selection before the memo subtracts anything.
    const shards = [1, 2].map((index) => plan({ shard: { index, count: 2 } }));
    expect(shards.flatMap((s) => s.slice).sort()).toEqual(TESTS.map((t) => `server/${t}`));
    expect(shards.every((s) => s.selected.length === 3)).toBe(true);
    expect(shards.flatMap((s) => [...s.run, ...s.skipped.map((x) => x.test)]).sort()).toEqual(TESTS.map((t) => `server/${t}`));

    // The recorded key survives a change to a module the green run never loaded.
    writeFileSync(join(root, 'server/lib/lazy.js'), 'export const lazy = 2;\n');
    expect(plan().skipped).toEqual([{ test: 'server/lib/a.test.js', via: 'recorded' }]);
    // A change to a loaded module invalidates it.
    writeFileSync(join(root, 'server/lib/a.js'), 'export const a = 2;\n');
    expect(plan().skipped).toEqual([]);

    // Related selection follows static and dynamic edges; explicit files are always kept.
    const related = plan({ mode: 'related', repoFiles: ['server/lib/c.test.js'], repoSources: ['server/lib/lazy.js'] });
    expect(related.selected).toEqual(['server/lib/b.test.js', 'server/lib/c.test.js']);
    expect(plan({ mode: 'related', repoFiles: [], repoSources: ['server/lib/a.js'] }).selected).toEqual(['server/lib/a.test.js']);

    // The memo off: nothing is read, nothing is skipped.
    writeMemoEntry(memoDir, plan().verdicts.get('server/lib/c.test.js').floor.key, { test: 'server/lib/c.test.js', workspace: 'server', source: 'local' });
    expect(plan().skipped).toEqual([{ test: 'server/lib/c.test.js', via: 'floor' }]);
    expect(plan({ memoDir: null }).skipped).toEqual([]);
  });

  it('slices shards exactly like Vitest\'s sequencer', () => {
    expect([1, 2, 3].map((index) => vitestShardRange(7, index, 3))).toEqual([[0, 3], [3, 5], [5, 7]]);
    expect([1, 2].map((index) => vitestShardRange(1, index, 2))).toEqual([[0, 1], [1, 1]]);
    const fixture = mkdtempSync(join(tmpdir(), 'portos-shard-parity-'));
    try {
      const host = join(fixture, 'host');
      mkdirSync(host);
      const files = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta'].map((name) => `${name}.test.js`);
      for (const file of files) writeFileSync(join(fixture, file), "import { it } from 'vitest';\nit('x', () => {});\n");
      writeFileSync(join(fixture, 'vitest.config.mjs'), 'export default { test: { include: ["*.test.js"], maxWorkers: 1 } };');
      const vitest = join(import.meta.dirname, '..', '..', 'server', 'node_modules', '.bin', 'vitest');
      const env = { ...process.env, NODE_ENV: 'test', TMPDIR: host, TMP: host, TEMP: host, NODE_DISABLE_COMPILE_CACHE: '1', PORTOS_CI_TEST_SELECTION: '' };
      delete env.PORTOS_TEST_TEMP_ROOT;
      for (const index of [1, 2, 3]) {
        const report = join(fixture, `shard${index}.json`);
        execFileSync(vitest, ['run', `--shard=${index}/3`, '--config', join(fixture, 'vitest.config.mjs'), '--root', fixture, '--reporter=json', `--outputFile=${report}`], { cwd: fixture, env, encoding: 'utf8', timeout: 60_000 });
        const ran = JSON.parse(readFileSync(report, 'utf8')).testResults.map((suite) => suite.name.replace(/\\/g, '/').split('/').pop()).sort();
        expect(ran, `shard ${index}`).toEqual(vitestShardSlice(files, { repoRoot: fixture, scope: '.', index, count: 3 }).sort());
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 120_000);

  it('writes the selection Vitest reads as workspace-relative paths', () => {
    const selection = writeSelectionFile({ scope: 'server', include: ['server/lib/a.test.js', 'scripts/x.test.js'], exclude: [] });
    try {
      expect(JSON.parse(readFileSync(selection.path, 'utf8'))).toEqual({ include: ['lib/a.test.js', '../scripts/x.test.js'], exclude: [] });
    } finally {
      rmSync(selection.dir, { recursive: true, force: true });
    }
    const full = writeSelectionFile({ scope: 'client', include: null, exclude: ['client/src/a.test.jsx'] });
    try {
      expect(JSON.parse(readFileSync(full.path, 'utf8'))).toEqual({ include: null, exclude: ['src/a.test.jsx'] });
    } finally {
      rmSync(full.dir, { recursive: true, force: true });
    }
  });
});
