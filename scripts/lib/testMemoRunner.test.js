/**
 * Runner-side memo contract over a synthetic repository on disk: memoized
 * files leave the launch list, related selection follows the closure, and
 * entries are written only for files a run reported green.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fileResultsFromReport, findVitestDependenciesFile, passedTestFiles, planTestMemo, readVitestDependencies, recordTestMemo,
  writeSelectionFile,
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
    env: { NODE_ENV: 'test' }, platform: 'linux', arch: 'x64', nodeMajor: 24, listTests: () => TESTS, ...overrides,
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
    const passed = passedTestFiles(fileResultsFromReport(reportPath), { repoRoot: root });
    expect(passed).toEqual(['server/lib/a.test.js']);
    expect(passedTestFiles(fileResultsFromReport(reportPath), { repoRoot: root, namePattern: true })).toEqual(['server/lib/a.test.js', 'server/lib/c.test.js']);

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
    expect(dependencies.get('server/lib/a.test.js')).toEqual(['server/lib/a.test.js', 'server/lib/a.js']);

    const written = recordTestMemo({ scope: 'server', repoRoot: root, memoDir, plan: cold, passed, dependencies, source: 'local', commit: 'abc' });
    expect(written).toBe(2);
    expect(readMemoRecord(memoDir, 'server', 'server/lib/a.test.js')).toEqual(['server/lib/a.js', 'server/lib/a.test.js']);
    expect(readMemoRecord(memoDir, 'server', 'server/lib/b.test.js')).toBeNull();
    expect(readMemoEntry(memoDir, cold.verdicts.get('server/lib/a.test.js').floor.key, { test: 'server/lib/a.test.js', workspace: 'server' })).toMatchObject({ source: 'local', commit: 'abc' });
    expect(readMemoEntry(memoDir, cold.verdicts.get('server/lib/b.test.js').floor.key, { test: 'server/lib/b.test.js', workspace: 'server' })).toBeNull();

    const warm = plan();
    expect(warm.skipped).toEqual([{ test: 'server/lib/a.test.js', via: 'recorded' }]);
    expect(warm.run).toEqual(['server/lib/b.test.js', 'server/lib/c.test.js']);

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
