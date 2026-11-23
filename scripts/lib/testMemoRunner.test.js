/**
 * Runner-side memo contract over a synthetic repository on disk: memoized
 * files leave the launch list, related selection follows the closure, and
 * entries are written only for files a run reported green.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MEMO_UNRECORDED_LINE_LIMIT, VITEST_PROJECT_NAMES,
  clearVitestDependencies, fileResultsFromReport, findVitestDependenciesFile, memoSummaryLine, memoUnrecordedLines, passedTestFiles, planTestMemo, readVitestDependencies,
  recordTestMemo, seedVitestDependencies, vitestDependenciesPath, vitestShardHashInput, vitestShardRange, vitestShardSlice, writeSelectionFile,
} from './testMemoRunner.js';
import { vitestCaptureProjects } from '../vitestCiPool.js';
import { readMemoEntry, readMemoRecord, writeMemoEntry } from './testMemoStore.js';
import { buildCiTestPlan } from '../ci-test-plan.js';
import { browserProfileAcceptedVerdicts, browserTestProfileArgs } from './browserTestProfiles.js';
import { BROWSER_SUITES, browserShardSlice } from './browserSuites.js';

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

  // #17616: a real-Chromium suite's record carries what its fixture served, so an
  // unrelated client page neither selects it nor misses its memo entry.
  it('records what a browser fixture served and narrows the suite to it', () => {
    root = mkdtempSync(join(tmpdir(), 'portos-served-memo-'));
    memoDir = mkdtempSync(join(tmpdir(), 'portos-served-memo-store-'));
    const view = 'server/lib/view.test.js';
    writeRepo(root, {
      ...FILES,
      'server/node_modules/playwright-core/package.json': '{"name":"playwright-core","version":"1.0.0"}',
      'client/package.json': '{"name":"client"}',
      'client/src/index.css': '@import "tailwindcss";\n',
      'client/src/Panel.jsx': 'export const Panel = 1;\n',
      'client/src/pages/HtmlPages.jsx': 'export const HtmlPages = 1;\n',
      [view]: ["import { it } from 'vitest';", "import { chromium } from 'playwright-core';",
        "const client = join(import.meta.dirname, '../../client');",
        'fixture = await startBrowserFixture({ createServer, chromium, viteConfig: () => ({ configFile: false, root: client }) });',
        "it('renders', () => {});"].join('\n'),
    });
    const tests = () => ['lib/view.test.js'];
    const full = plan({ listTests: tests, repoFiles: [view] });
    const served = new Map([[view, { roots: ['client'], files: ['client/src/Panel.jsx'] }]]);
    const { written } = recordTestMemo({ scope: 'server', repoRoot: root, memoDir, plan: full, passed: [view],
      dependencies: new Map([[view, [view]]]), served, source: 'ci', commit: 'abc' });
    expect(written).toBeGreaterThanOrEqual(1);
    expect(readMemoRecord(memoDir, 'server', view).served).toEqual(served.get(view));

    const related = (source) => plan({ mode: 'related', listTests: tests, repoFiles: [], repoSources: [source] });
    writeFileSync(join(root, 'client/src/pages/HtmlPages.jsx'), 'export const HtmlPages = 2;\n');
    expect(related('client/src/pages/HtmlPages.jsx').selected).toEqual([]);
    expect(plan({ listTests: tests, repoFiles: [view] }).skipped).toEqual([{ test: view, via: 'recorded' }]);
    for (const [rel, text] of [['client/src/Panel.jsx', 'export const Panel = 2;\n'], ['client/src/index.css', '@import "tailwindcss";\n.x {}\n']]) {
      writeFileSync(join(root, rel), text);
      expect(related(rel).selected, rel).toEqual([view]);
      expect(plan({ listTests: tests, repoFiles: [view] }).run, rel).toEqual([view]);
    }
  });

  it('keeps the layering guard selected and executable after a cached pass when an unrelated lib file gains an upward import', () => {
    root = mkdtempSync(join(tmpdir(), 'portos-layering-memo-'));
    memoDir = mkdtempSync(join(tmpdir(), 'portos-layering-memo-store-'));
    writeRepo(root, FILES);
    const guard = 'server/lib/layering.guard.test.js';
    const source = 'server/lib/unrelated.js';
    // Keep the real scanner and assertions; this standalone Vitest fixture
    // supplies globals instead of resolving its intentionally stubbed package,
    // and roots the check at the fixture instead of at this repository.
    const original = readFileSync(new URL('../../server/test/guards/modules/libLayering.test.js', import.meta.url), 'utf8');
    const scanner = original.replace(/^import \{ describe, it, expect \} from 'vitest';\n/m, '')
      .replace(/^import \{[^}]*\} from '[^']*guardCorpus\.js';\n/m, [
        "import { readFileSync as readFixtureText } from 'node:fs';",
        `const REPO_ROOT = ${JSON.stringify(root)};`,
        "const readText = (path) => readFixtureText(path, 'utf8');",
        '',
      ].join('\n'));
    writeRepo(root, { [guard]: scanner, [source]: 'export const unrelated = true;\n' });
    const config = join(root, 'vitest.config.mjs');
    writeFileSync(config, 'export default { test: { globals: true, include: ["server/lib/layering.guard.test.js"], maxWorkers: 1 } };\n');
    const planned = () => {
      const impact = buildCiTestPlan([source], { trackedFiles: [guard, source] });
      expect(impact.full).toBe(false);
      const memo = plan({ mode: impact.server.mode, repoFiles: impact.server.files, repoSources: impact.server.sources,
        listTests: () => ['lib/layering.guard.test.js'], readRecord: () => ({ modules: [guard], digests: null }), readEntry: () => true });
      expect(memo.selected).toContain(guard);
      expect(memo.skipped).toEqual([]);
      expect(memo.run).toContain(guard);
      return memo;
    };
    const run = (memo) => spawnSync(process.execPath, [join(import.meta.dirname, '../../server/node_modules/vitest/vitest.mjs'),
      'run', ...memo.run, '--root', root, '--config', config], {
      cwd: root, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, PORTOS_CI_TEST_SELECTION: '', PORTOS_TEST_MEMO: 'off' },
    });
    const clean = run(planned());
    expect(clean.status, clean.stderr).toBe(0);
    for (const statement of ["import { feature } from '../services/new-feature.js';", "const feature = () => import('../services/new-feature.js');", "import '../services/new-feature.js';"]) {
      writeFileSync(join(root, source), `${statement}\n`);
      const dirty = run(planned());
      expect(dirty.status, statement).toBe(1);
      expect(`${dirty.stdout}\n${dirty.stderr}`).toContain('unrelated.js');
      expect(`${dirty.stdout}\n${dirty.stderr}`).toContain('server/lib modules importing upward into services');
    }
  }, 120000);

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
    // Vitest 5.1 writes version 2: each file maps to `{ at, deps }`; an unknown version is no records at all.
    const v2 = join(root, 'v2.json');
    writeFileSync(v2, JSON.stringify({ version: 2, projects: { parallel: {
      modules: ['lib/x.test.js', 'lib/x.js'], config: { at: 1, deps: [] }, files: { 'lib/x.test.js': { at: 1, deps: [0, 1] } },
    } } }));
    expect(readVitestDependencies(v2, 'server').get('server/lib/x.test.js')).toEqual(['server/lib/x.js', 'server/lib/x.test.js']);
    writeFileSync(v2, JSON.stringify({ version: 3, projects: {} }));
    expect(readVitestDependencies(v2, 'server')).toBeNull();
    expect(dependencies.get('server/lib/a.test.js')).toEqual(['server/lib/a.js', 'server/lib/a.test.js']);

    const { written } = recordTestMemo({ scope: 'server', repoRoot: root, memoDir, plan: cold, passed, dependencies, source: 'local', commit: 'abc' });
    expect(written).toBe(2);
    // A v2 record: each loaded module's digest, so related selection can narrow it.
    expect(readMemoRecord(memoDir, 'server', 'server/lib/a.test.js')).toEqual({ modules: ['server/lib/a.js', 'server/lib/a.test.js'],
      digests: ['server/lib/a.js', 'server/lib/a.test.js'].map((rel) => createHash('sha256').update(FILES[rel]).digest('hex').slice(0, 16)), served: null });
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
    expect(recordTestMemo({ scope: 'server', repoRoot: root, memoDir, plan: midRun, passed: passedTestFiles(fileResultsFromReport(reportPath), clean), dependencies, source: 'local', commit: 'abc' }).written).toBe(0);
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
    // Sibling shards whose memo state selects different related lists still
    // own each test by the candidate set alone, so none falls between them.
    const related2 = (repoFiles, index) => plan({ mode: 'related', repoFiles, repoSources: [], shard: { index, count: 2 } });
    const all = TESTS.map((t) => `server/${t}`);
    const owners = [1, 2].map((index) => related2(all, index).slice);
    expect(owners.flat().sort()).toEqual(all);
    // Each one-test selection lands on the shard that owns it in the wide list.
    for (const test of all) {
      expect([1, 2].map((index) => related2([test], index).slice)).toEqual(owners.map((own) => (own.includes(test) ? [test] : [])));
    }

    // The memo off: nothing is read, nothing is skipped.
    writeMemoEntry(memoDir, plan().verdicts.get('server/lib/c.test.js').floor.key, { test: 'server/lib/c.test.js', workspace: 'server', source: 'local' });
    expect(plan().skipped).toEqual([{ test: 'server/lib/c.test.js', via: 'floor' }]);
    const off = plan({ memoDir: null });
    expect(off.skipped).toEqual([]);
    expect(off.run).toEqual(off.selected);
    // Nothing is analyzed for a files plan with the memo off: the list is the plan.
    expect(off.verdicts.size).toBe(0);
    expect(plan({ memoDir: null, mode: 'related', repoFiles: [], repoSources: ['server/lib/a.js'] }).selected).toEqual(['server/lib/a.test.js']);
  });

  // A gate-tooling test never earns a narrowing record, so its unresolved edge selects it on
  // every diff unless the runner narrows it (#16798). `dynamic.test.js` has the same shape
  // without being a tooling test, which pins that the narrowing is the list's doing.
  it('keeps a gate-tooling test out of a related plan until a changed source reaches its closure', () => {
    root = mkdtempSync(join(tmpdir(), 'portos-tooling-memo-repo-'));
    memoDir = mkdtempSync(join(tmpdir(), 'portos-tooling-memo-store-'));
    const tooling = 'scripts/pregate.test.js';
    const control = 'server/lib/dynamic.test.js';
    const failsClosed = "import { it } from 'vitest';\nimport { a } from '../server/lib/a.js';\nit('x', async () => { await import(process.env.LOAD); });\n";
    writeRepo(root, { ...FILES, [tooling]: failsClosed, [control]: failsClosed.replace('../server/lib/a.js', './a.js') });
    const related = (repoSources, repoFiles = []) => plan({
      mode: 'related', repoFiles, repoSources, listTests: () => [...TESTS, '../scripts/pregate.test.js', 'lib/dynamic.test.js'],
    }).selected;

    const unrelated = related(['server/lib/lazy.js']);
    expect(unrelated).toContain(control);
    expect(unrelated).not.toContain(tooling);
    expect(related(['server/lib/a.js'])).toContain(tooling);
    expect(related(['server/lib/lazy.js'], [tooling])).toContain(tooling);
  });

  it.each([
    { mode: 'full', partition: 'unit' },
    { mode: 'files', partition: 'unit' },
    { mode: 'full', partition: 'browser' },
    { mode: 'files', partition: 'browser' },
  ])('analyzes only owned files in a $partition $mode plan and still verifies green keys', ({ mode, partition }) => {
    root = mkdtempSync(join(tmpdir(), 'portos-shard-memo-'));
    memoDir = mkdtempSync(join(tmpdir(), 'portos-shard-memo-store-'));
    const candidates = (partition === 'browser' ? BROWSER_SUITES.slice(0, 4) : TESTS.map((test) => `server/${test}`)).sort();
    const explicit = candidates.at(-1);
    const listTests = () => candidates.slice(0, -1).map((test) => test.slice('server/'.length));
    const repoFiles = mode === 'full' ? [explicit] : candidates;
    writeRepo(root, { ...FILES, ...Object.fromEntries(candidates.map((test) => [test, FILES['server/lib/c.test.js']])) });
    const shardSlice = partition === 'browser' ? browserShardSlice : vitestShardSlice;

    for (const index of [1, 2]) {
      const shard = { index, count: 2 };
      const owned = shardSlice(candidates, { ...shard, repoRoot: root, scope: 'server' });
      const recordReads = [];
      const makePlan = () => plan({ mode, repoFiles, listTests, shard, shardSlice, readRecord: (dir, scope, test) => {
        recordReads.push(test);
        return readMemoRecord(dir, scope, test);
      } });
      const cold = makePlan();
      expect(cold.selected).toEqual(candidates);
      expect(recordReads).toEqual(owned);
      expect([...cold.verdicts.keys()]).toEqual(owned);
      expect(cold.run).toEqual(owned);
      expect(cold.skipped).toEqual([]);

      const [green] = owned;
      const dependencies = new Map([[green, [green]]]);
      expect(recordTestMemo({ scope: 'server', repoRoot: root, memoDir, plan: cold, passed: [green], dependencies, source: 'ci' }).written).toBe(2);

      recordReads.length = 0;
      const warm = makePlan();
      expect(recordReads).toEqual(owned);
      expect(warm.run).toEqual(owned.slice(1));
      expect(warm.skipped).toEqual([{ test: green, via: 'recorded' }]);

      // A changed owned file still cannot be recorded under its pre-run key.
      for (const test of warm.run) {
        writeFileSync(join(root, test), `${FILES['server/lib/c.test.js']}// changed during run\n`);
        expect(recordTestMemo({ scope: 'server', repoRoot: root, memoDir, plan: warm, passed: [test], dependencies: new Map([[test, [test]]]), source: 'ci' }).written).toBe(0);
      }
    }
  });

  // The #16424 probe: real Vitest records what each test loaded, the record
  // narrows related selection, and a deliberately broken lazily imported
  // module is still caught by the tests the narrowed plan selects.
  it('catches a broken lazily imported module through record-narrowed selection, from a real Vitest depfile', () => {
    // realpath: Vitest reports resolved paths, and macOS tmpdir is a symlink.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'portos-memo-probe-')));
    memoDir = mkdtempSync(join(tmpdir(), 'portos-memo-probe-store-'));
    const probe = {
      ...FILES,
      'server/lib/probeHub.js': "export const load = () => import('./probeLazy.js');\nexport const hub = 1;\n",
      'server/lib/probeLazy.js': 'export const answer = () => 42;\n',
      // Globals, not `import … from 'vitest'`: the fixture's vitest package is a stub.
      'server/lib/user.test.js': "import { load } from './probeHub.js';\nit('reads the lazy answer', async () => { expect((await load()).answer()).toBe(42); });\n",
      'server/lib/bystander.test.js': "import { hub } from './probeHub.js';\nit('never loads the lazy module', () => { expect(hub).toBe(1); });\n",
      'server/vitest.probe.config.mjs': "export default { cacheDir: '.cache/vitest', test: { globals: true, include: ['lib/**/*.test.js'], maxWorkers: 1 } };\n",
    };
    writeRepo(root, probe);
    const tests = ['lib/a.test.js', 'lib/b.test.js', 'lib/bystander.test.js', 'lib/c.test.js', 'lib/user.test.js'];
    const user = 'server/lib/user.test.js';
    const bystander = 'server/lib/bystander.test.js';
    const report = join(root, 'report.json');
    const vitest = (files, extra = []) => spawnSync(process.execPath, [join(import.meta.dirname, '../../server/node_modules/vitest/vitest.mjs'),
      'run', ...files.map((rel) => rel.replace(/^server\//, '')), '--config', 'vitest.probe.config.mjs', '--reporter=json', `--outputFile=${report}`, ...extra], {
      cwd: join(root, 'server'), encoding: 'utf8', timeout: 60000,
      env: { ...process.env, PORTOS_CI_TEST_SELECTION: '', PORTOS_TEST_MEMO: 'off' },
    });

    // A trusted green full run records both suites (v2 records, with digests).
    const full = plan({ listTests: () => tests, repoFiles: [user, bystander] });
    const green = vitest(full.run, ['--experimental.recordDependencies']);
    expect(green.status, green.stderr).toBe(0);
    const dependencies = readVitestDependencies(findVitestDependenciesFile(root, 'server'), 'server');
    expect(dependencies?.get(user)).toContain('server/lib/probeLazy.js');
    expect(dependencies.get(bystander)).not.toContain('server/lib/probeLazy.js');
    const passed = passedTestFiles(fileResultsFromReport(report), { repoRoot: root, status: 0, runReport: { reason: 'passed', errorCount: 0 } });
    expect(passed).toEqual(expect.arrayContaining([user, bystander]));
    recordTestMemo({ scope: 'server', repoRoot: root, memoDir, plan: full, passed, dependencies, source: 'ci', commit: 'abc' });
    expect(readMemoRecord(memoDir, 'server', bystander).digests).toHaveLength(dependencies.get(bystander).length);

    // Break the lazy module. Before #16424 the hub's lazy edge selected every importer.
    writeFileSync(join(root, 'server/lib/probeLazy.js'), 'export const answer = () => 41;\n');
    const related = (overrides = {}) => plan({ mode: 'related', listTests: () => tests, repoFiles: [], repoSources: ['server/lib/probeLazy.js'], ...overrides });
    const unnarrowed = related({ readRecord: (dir, scope, test) => ({ modules: readMemoRecord(dir, scope, test)?.modules ?? null, digests: null }) });
    expect(unnarrowed.selected).toEqual([bystander, user]);
    const narrowed = related();
    expect(narrowed.narrowed).toBeGreaterThanOrEqual(2);
    expect(narrowed.selected).toEqual([user]);
    expect(narrowed.run).toEqual([user]);

    // A restored narrowing record exists only on the bystander's shard.
    // Its absence on siblings cannot change ownership or drop an explicit file.
    const candidates = tests.map((test) => `server/${test}`);
    const count = candidates.length;
    const siblingPlans = (repoFiles) => Array.from({ length: count }, (_, i) => {
      const shard = { index: i + 1, count };
      const owned = vitestShardSlice(candidates, { ...shard, repoRoot: root, scope: 'server' });
      const reads = [];
      const result = related({ repoFiles, shard, readRecord: (dir, scope, test) => {
        reads.push(test);
        return owned.includes(bystander) ? readMemoRecord(dir, scope, test) : null;
      } });
      expect(reads).toEqual(owned);
      return { owned, result };
    });
    expect(siblingPlans([]).flatMap(({ result }) => result.run)).toEqual([user]);
    for (const { owned, result } of siblingPlans([bystander])) {
      expect(result.slice).toEqual(owned.filter((test) => test === user || test === bystander));
    }

    const red = vitest(narrowed.run);
    expect(red.status).toBe(1);
    expect(fileResultsFromReport(report)).toEqual([expect.objectContaining({ file: join(root, user), status: 'failed' })]);
  }, 120000);

  // #16545: a passed file that stores nothing re-runs on every trusted run,
  // and the only trace used to be a lower count in one summary line.
  it('names every passed file it could not record, with the reason each key was refused', () => {
    root = mkdtempSync(join(tmpdir(), 'portos-memo-unrecorded-'));
    memoDir = mkdtempSync(join(tmpdir(), 'portos-memo-unrecorded-store-'));
    const guard = 'server/lib/layering.guard.test.js'; // always-run guard: never analyzed in a files plan
    const dynamic = 'server/lib/dynamic.test.js';
    const marked = 'server/lib/markedMember.test.js';
    writeRepo(root, {
      ...FILES,
      [guard]: "import { it } from 'vitest';\nit('g', () => {});\n",
      [dynamic]: "import { it } from 'vitest';\nconst load = (name) => import(name);\nit('d', () => {});\n",
      'server/lib/markedMember.js': '// test-memo: never\nexport const m = 1;\n',
      [marked]: "import { it } from 'vitest';\nimport { m } from './markedMember.js';\nit('m', () => {});\n",
    });
    const a = 'server/lib/a.test.js';
    const c = 'server/lib/c.test.js';
    const files = [a, c, dynamic, guard, marked];
    const cold = plan({ repoFiles: files });
    // Vitest recorded modules for a.test.js and marked; c is edited during the run.
    const dependencies = new Map([[a, ['server/lib/a.js', a]], [marked, [marked, 'server/lib/markedMember.js']]]);
    const refreshed = [];
    const freshAnalyze = cold.freshAnalyze;
    cold.freshAnalyze = (test, modules) => {
      refreshed.push(test);
      return freshAnalyze(test, modules);
    };
    writeFileSync(join(root, c), `${FILES[c]}// edited mid-run\n`);
    const { written, unrecorded } = recordTestMemo({ scope: 'server', repoRoot: root, memoDir, plan: cold, passed: files, dependencies, source: 'ci', commit: 'abc' });
    expect(written).toBe(2);
    expect(refreshed).toEqual([a, c]);
    expect(unrecorded).toEqual([
      { test: c, declared: false, reason: 'floor key: an input changed while the run was in flight; recorded key: Vitest recorded no modules for this file' },
      { test: dynamic, declared: false, reason: `floor key: ${dynamic}: import() with a non-literal specifier; recorded key: Vitest recorded no modules for this file` },
      { test: guard, declared: true, reason: 'never memoized by declaration (tree guard or always-run test, TEST_MEMO_NEVER or the test-memo: never marker)' },
      { test: marked, declared: true, reason: 'floor key: test-memo: never marker; recorded key: test-memo: never marker' },
    ]);
    // No depfile at all (a Vitest that stopped writing one) is a different cause from a file missing in it.
    const none = recordTestMemo({ scope: 'server', repoRoot: root, memoDir, plan: plan({ repoFiles: [dynamic] }), passed: [dynamic], dependencies: null, source: 'ci' });
    expect(none).toEqual({ written: 0, unrecorded: [{ test: dynamic, declared: false, reason: `floor key: ${dynamic}: import() with a non-literal specifier; recorded key: no readable Vitest dependency file` }] });
    // A file stored under one key is recorded; the other key's refusal is not reported.
    const recordedOnly = recordTestMemo({ scope: 'server', repoRoot: root, memoDir, plan: plan({ repoFiles: [dynamic] }), passed: [dynamic], dependencies: new Map([[dynamic, [dynamic]]]), source: 'ci' });
    expect(recordedOnly).toEqual({ written: 1, unrecorded: [] });

    // One line per file the memo should have taken, then one count for the declared ones.
    expect(memoUnrecordedLines(unrecorded)).toEqual([
      `🧠   not recorded: ${c} (${unrecorded[0].reason})`,
      `🧠   not recorded: ${dynamic} (${unrecorded[1].reason})`,
      '🧠   not recorded: 2 files never memoized by declaration (tree guard or always-run test, TEST_MEMO_NEVER or the test-memo: never marker).',
    ]);
    expect(memoUnrecordedLines([])).toEqual([]);
    const many = Array.from({ length: MEMO_UNRECORDED_LINE_LIMIT + 3 }, (_, index) => ({ test: `server/lib/t${index}.test.js`, reason: 'floor key: x; recorded key: y', declared: false }));
    const lines = memoUnrecordedLines(many);
    expect(MEMO_UNRECORDED_LINE_LIMIT).toBe(40);
    expect(lines).toHaveLength(MEMO_UNRECORDED_LINE_LIMIT + 1);
    expect(lines.at(-1)).toBe('🧠   not recorded: 3 more files not listed.');
    expect(lines.at(-2)).toContain(`server/lib/t${MEMO_UNRECORDED_LINE_LIMIT - 1}.test.js`);
  });

  // The cause #16545 found: a browser profile runs under `--testNamePattern`,
  // Vitest calls that run partial and writes no dependency record for a file
  // without a previous one, and the runner clears the depfile before each run.
  // Pinned against the installed Vitest so a release that changes either side
  // fails here instead of silently stopping the records again.
  it('records a case-filtered run from a real Vitest depfile only when the files were seeded', () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'portos-memo-filtered-')));
    memoDir = mkdtempSync(join(tmpdir(), 'portos-memo-filtered-store-'));
    const filtered = 'server/lib/filtered.test.js';
    const idle = 'server/lib/idle.test.js';
    writeRepo(root, {
      ...FILES,
      'server/lib/onlyFast.js': 'export const fast = 1;\n',
      'server/lib/onlySlow.js': 'export const slow = 1;\n',
      // Globals, not `import … from 'vitest'`: the fixture's vitest package is a stub.
      [filtered]: [
        "it('fast case', async () => { expect((await import('./onlyFast.js')).fast).toBe(1); });",
        "it('[local-performance] slow case', async () => { expect((await import('./onlySlow.js')).slow).toBe(1); });",
      ].join('\n'),
      [idle]: "it('never selected', () => {});\n",
      'server/vitest.probe.config.mjs': "export default { cacheDir: '.cache/vitest', test: { globals: true, include: ['lib/**/*.test.js'], maxWorkers: 1 } };\n",
    });
    const caseFilter = ['--testNamePattern=^(?!.*\\[local-performance\\]).*$'];
    const report = join(root, 'report.json');
    const vitest = (files) => spawnSync(process.execPath, [join(import.meta.dirname, '../../server/node_modules/vitest/vitest.mjs'),
      'run', ...files.map((rel) => rel.replace(/^server\//, '')), '--config', 'vitest.probe.config.mjs', '--reporter=json', `--outputFile=${report}`,
      '--experimental.recordDependencies', ...caseFilter], {
      cwd: join(root, 'server'), encoding: 'utf8', timeout: 60000,
      env: { ...process.env, PORTOS_CI_TEST_SELECTION: '', PORTOS_TEST_MEMO: 'off' },
    });
    const filteredPlan = () => plan({ listTests: () => ['lib/filtered.test.js', 'lib/idle.test.js'], repoFiles: [filtered], caseFilter });
    const record = (planned) => recordTestMemo({ scope: 'server', repoRoot: root, memoDir, plan: planned, source: 'ci', commit: 'abc',
      passed: passedTestFiles(fileResultsFromReport(report), { repoRoot: root, namePattern: true, status: 0, runReport: { reason: 'passed', errorCount: 0 } }),
      dependencies: readVitestDependencies(findVitestDependenciesFile(root, 'server'), 'server') });

    // Unseeded: Vitest writes the depfile but no record for the file.
    const unseeded = filteredPlan();
    expect(vitest(unseeded.run).status).toBe(0);
    expect(findVitestDependenciesFile(root, 'server')).toBe(vitestDependenciesPath(root, 'server'));
    expect(readVitestDependencies(findVitestDependenciesFile(root, 'server'), 'server').get(filtered)).toBeUndefined();

    // Seeded: the record is what the cases that ran loaded. The seed for a file that never ran stays empty and is dropped.
    clearVitestDependencies(root, 'server');
    const seeded = filteredPlan();
    seedVitestDependencies(root, 'server', [...seeded.run, idle]);
    expect(vitest(seeded.run).status).toBe(0);
    const dependencies = readVitestDependencies(findVitestDependenciesFile(root, 'server'), 'server');
    expect(dependencies.get(filtered)).toEqual(['server/lib/filtered.test.js', 'server/lib/onlyFast.js']);
    expect(dependencies.has(idle)).toBe(false);
    expect(record(seeded)).toEqual({ written: 2, unrecorded: [] });
    // Stored without digests: a filtered record must never narrow related selection for a run that skips nothing.
    expect(readMemoRecord(memoDir, 'server', filtered)).toEqual({ modules: ['server/lib/filtered.test.js', 'server/lib/onlyFast.js'], digests: null, served: null });
    expect(filteredPlan().skipped).toEqual([{ test: filtered, via: 'recorded' }]);

    // The entry vouches for this filter only: no filter, or another one, runs the file.
    expect(plan({ listTests: () => ['lib/filtered.test.js'], repoFiles: [filtered] }).skipped).toEqual([]);
    expect(plan({ listTests: () => ['lib/filtered.test.js'], repoFiles: [filtered], caseFilter: ['--testNamePattern=\\[fidelity\\]'] }).skipped).toEqual([]);
    // A module only the skipped case loads is outside this filter's verdict; one a case that ran loads is inside it.
    writeFileSync(join(root, 'server/lib/onlySlow.js'), 'export const slow = 2;\n');
    expect(filteredPlan().skipped).toEqual([{ test: filtered, via: 'recorded' }]);
    writeFileSync(join(root, 'server/lib/onlyFast.js'), 'export const fast = 2;\n');
    expect(filteredPlan().skipped).toEqual([]);
  }, 120000);

  // Pull requests run the smoke profile and only trusted runs, on the full
  // profile, save the memo (#16546). Every key input but the profile's env value
  // and case filter must still match, and the reuse runs one way only.
  it('lets a smoke run skip a file on a trusted full-profile entry, never the reverse', () => {
    root = mkdtempSync(join(tmpdir(), 'portos-memo-profile-'));
    memoDir = mkdtempSync(join(tmpdir(), 'portos-memo-profile-store-'));
    writeRepo(root, FILES);
    const test = 'server/lib/a.test.js';
    const profilePlan = (profile, overrides = {}) => plan({
      repoFiles: [test], listTests: () => ['lib/a.test.js'],
      env: { NODE_ENV: 'test', PORTOS_BROWSER_TEST_PROFILE: profile }, caseFilter: browserTestProfileArgs(profile),
      acceptVerdictsFrom: browserProfileAcceptedVerdicts(profile), ...overrides,
    });
    const recordGreen = (planned) => recordTestMemo({ scope: 'server', repoRoot: root, memoDir, plan: planned, passed: [test], source: 'ci', commit: 'abc',
      dependencies: new Map([[test, [test, 'server/lib/a.js']]]) });

    expect(recordGreen(profilePlan('full'))).toEqual({ written: 2, unrecorded: [] });
    expect(profilePlan('full').skipped).toEqual([{ test, via: 'recorded' }]);
    expect(profilePlan('smoke').skipped).toEqual([{ test, via: 'recorded', from: 'full profile' }]);
    expect(profilePlan('smoke', { readRecord: () => null }).skipped).toEqual([{ test, via: 'floor', from: 'full profile' }]);
    // Without the accepted full verdict, the profile line alone keeps smoke from matching.
    expect(profilePlan('smoke', { acceptVerdictsFrom: [] }).skipped).toEqual([]);
    expect(profilePlan('fidelity').skipped).toEqual([]);
    // The rest of the key is this run's: Node, platform, another keyed env var, and the file's bytes.
    expect(profilePlan('smoke', { nodeVersion: '24.2.0' }).skipped).toEqual([]);
    expect(profilePlan('smoke', { platform: 'darwin' }).skipped).toEqual([]);
    expect(profilePlan('smoke', { env: { NODE_ENV: 'test', PORTOS_BROWSER_TEST_PROFILE: 'smoke', CI: 'true' } }).skipped).toEqual([]);
    writeFileSync(join(root, 'server/lib/a.js'), 'export const a = 2;\n');
    expect(profilePlan('smoke').skipped).toEqual([]);
    expect(profilePlan('smoke', { readRecord: () => null }).skipped).toEqual([]);

    // A smoke verdict skipped the fidelity cases, so it never vouches for a full run.
    rmSync(memoDir, { recursive: true, force: true });
    memoDir = mkdtempSync(join(tmpdir(), 'portos-memo-profile-store-'));
    expect(recordGreen(profilePlan('smoke'))).toEqual({ written: 2, unrecorded: [] });
    expect(profilePlan('smoke').skipped).toEqual([{ test, via: 'recorded' }]);
    expect(profilePlan('full').skipped).toEqual([]);
    expect(profilePlan('full', { readRecord: () => null }).skipped).toEqual([]);
  });

  it('seeds every project name the workspace configs run files under', () => {
    const projects = vitestCaptureProjects({ include: [], exclude: [] }, { cacheDir: 'x' }).map((project) => project.test.name);
    expect(VITEST_PROJECT_NAMES).toEqual(['', ...projects]);
  });

  it('skips closure analysis for a files plan member that can never be memoized but still memoizes ordinary suites', () => {
    root = mkdtempSync(join(tmpdir(), 'portos-memo-never-'));
    memoDir = mkdtempSync(join(tmpdir(), 'portos-memo-never-store-'));
    const guard = 'server/lib/layering.guard.test.js'; // always-run guard
    const listed = 'server/lib/moduleSummaries.test.js'; // TEST_MEMO_NEVER entry
    const marked = 'server/lib/marked.test.js';
    const ordinary = 'server/lib/c.test.js';
    writeRepo(root, {
      ...FILES,
      [guard]: "import { it } from 'vitest';\nit('g', () => {});\n",
      [listed]: "import { it } from 'vitest';\nit('l', () => {});\n",
      [marked]: "// test-memo: never\nimport { it } from 'vitest';\nit('m', () => {});\n",
    });
    const files = [guard, listed, marked, ordinary];
    const mixed = plan({ repoFiles: files });
    expect(mixed.unanalyzed).toBe(3);
    for (const test of [guard, listed, marked]) expect(mixed.verdicts.has(test)).toBe(false);
    expect(mixed.verdicts.has(ordinary)).toBe(true);
    expect(mixed.run).toEqual([guard, listed, marked, ordinary].sort());

    writeMemoEntry(memoDir, mixed.verdicts.get(ordinary).floor.key, { test: ordinary, workspace: 'server', source: 'local' });
    const warm = plan({ repoFiles: files });
    expect(warm.skipped).toEqual([{ test: ordinary, via: 'floor' }]);
    expect(warm.run).toEqual([guard, listed, marked].sort());

    // A plan made only of never-memoized files analyzes nothing and says so.
    const only = plan({ repoFiles: [guard, marked], listTests: () => { throw new Error('Files mode already has its inventory'); } });
    expect(only.verdicts.size).toBe(0);
    expect(only.run).toEqual([guard, marked].sort());
    expect(memoSummaryLine(only)).toContain('2 never-memoized guards not analyzed.');
    const listTests = () => [guard, listed, marked].map(test => test.slice('server/'.length));
    const full = plan({ mode: 'full', repoFiles: [], listTests, readRecord: () => { throw new Error('Declared never tests have no memo'); } });
    expect(full.run).toEqual([guard, listed, marked].sort());
    expect(full.verdicts.size).toBe(0);
    const recorded = recordTestMemo({ scope: 'server', repoRoot: root, memoDir, plan: full, passed: full.run, dependencies: null, source: 'ci' });
    expect(recorded.written).toBe(0);
    expect(recorded.unrecorded.map(({ test, declared }) => [test, declared])).toEqual(full.run.map(test => [test, true]));

    // Related mode still analyzes workspace tests it discovers to resolve reach.
    const related = plan({ mode: 'related', repoFiles: [], repoSources: ['server/lib/a.js'], listTests: () => ['lib/a.test.js', ...listTests()] });
    expect(related.selected).toContain('server/lib/a.test.js');
    expect(related.verdicts.has(marked)).toBe(true);
    expect(related.unanalyzed).toBe(0);
  });

  it('reuses a full-run shard memo in a scoped partition and reruns changed or unseeded files', () => {
    root = mkdtempSync(join(tmpdir(), 'portos-memo-repo-'));
    memoDir = mkdtempSync(join(tmpdir(), 'portos-memo-store-'));
    writeRepo(root, FILES);

    const seed = plan({ shard: { index: 1, count: 2 } });
    recordTestMemo({ scope: 'server', repoRoot: root, memoDir, plan: seed, passed: seed.slice, source: 'ci' });

    const scoped = plan({ shard: { index: 1, count: 1 } });
    expect(scoped.skipped.map(({ test }) => test).sort()).toEqual([...seed.slice].sort());
    expect(scoped.run).toEqual(scoped.selected.filter(test => !seed.slice.includes(test)));
    expect([...scoped.run, ...scoped.skipped.map(({ test }) => test)].sort()).toEqual(scoped.selected);
    expect(plan({ nodeVersion: '24.2.0' }).skipped).toEqual([]);

    const changed = seed.slice[0];
    writeFileSync(join(root, changed), `${FILES[changed]}\n// Changed after the trusted full run.\n`);
    const after = plan({ shard: { index: 1, count: 1 } });
    expect(after.run).toContain(changed);
    expect(after.skipped.map(({ test }) => test).sort()).toEqual(seed.slice.filter(test => test !== changed).sort());
  });

  it('hashes the forward-slashed root-relative path on every platform, like Vitest', () => {
    // pathe's resolve slashes before the slice, so a Windows root yields the same tail as a POSIX one.
    expect(vitestShardHashInput('server/lib/x.test.js', { repoRoot: '/repo', scope: 'server', path: posix })).toBe('/lib/x.test.js');
    expect(vitestShardHashInput('scripts/x.test.js', { repoRoot: '/repo', scope: 'server', path: posix })).toBe('s/x.test.js');
    expect(vitestShardHashInput('server/lib/x.test.js', { repoRoot: 'D:\\a\\repo', scope: 'server', path: win32 })).toBe('/lib/x.test.js');
    expect(vitestShardHashInput('scripts/x.test.js', { repoRoot: 'D:\\a\\repo', scope: 'server', path: win32 })).toBe('s/x.test.js');
    // So the partition is the same on both platforms for the same repository layout.
    const files = ['server/lib/a.test.js', 'server/lib/b.test.js', 'server/lib/c.test.js', 'scripts/d.test.js', 'scripts/e.test.js'];
    const slices = (path, repoRoot) => [1, 2].map((index) => vitestShardSlice(files, { repoRoot, scope: 'server', index, count: 2, path }));
    expect(slices(win32, 'D:\\a\\repo')).toEqual(slices(posix, '/repo'));
    expect(slices(posix, '/repo').flat().sort()).toEqual([...files].sort());
  });

  it('partitions all four Windows slices exactly like Vitest\'s sequencer', () => {
    expect([1, 2, 3].map((index) => vitestShardRange(7, index, 3))).toEqual([[0, 3], [3, 5], [5, 7]]);
    expect([1, 2].map((index) => vitestShardRange(1, index, 2))).toEqual([[0, 1], [1, 1]]);
    const fixture = mkdtempSync(join(tmpdir(), 'portos-shard-parity-'));
    try {
      const host = join(fixture, 'host');
      mkdirSync(host);
      const files = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta'].map((name) => `${name}.test.js`);
      for (const file of files) writeFileSync(join(fixture, file), "import { it } from 'vitest';\nit('x', () => {});\n");
      writeFileSync(join(fixture, 'vitest.config.mjs'), 'export default { test: { include: ["*.test.js"], maxWorkers: 1 } };');
      // Vitest's JS entry through node: the .bin shim cannot be started by execFileSync on Windows.
      const vitest = join(import.meta.dirname, '..', '..', 'server', 'node_modules', 'vitest', 'vitest.mjs');
      const env = { ...process.env, NODE_ENV: 'test', TMPDIR: host, TMP: host, TEMP: host, NODE_DISABLE_COMPILE_CACHE: '1', PORTOS_CI_TEST_SELECTION: '' };
      delete env.PORTOS_TEST_TEMP_ROOT;
      for (const index of [1, 2, 3, 4]) {
        const report = join(fixture, `shard${index}.json`);
        execFileSync(process.execPath, [vitest, 'run', `--shard=${index}/4`, '--config', join(fixture, 'vitest.config.mjs'), '--root', fixture, '--reporter=json', `--outputFile=${report}`], { cwd: fixture, env, encoding: 'utf8', timeout: 60_000 });
        const ran = JSON.parse(readFileSync(report, 'utf8')).testResults.map((suite) => suite.name.replace(/\\/g, '/').split('/').pop()).sort();
        expect(ran, `shard ${index}`).toEqual(vitestShardSlice(files, { repoRoot: fixture, scope: '.', index, count: 4 }).sort());
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
