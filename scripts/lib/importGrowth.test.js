/**
 * Base-relative import-growth contract (#7993).
 *
 * The live server suite is measured from importScoping.test.js. This file
 * pins the decision that measurement makes: ordinary leaf and new-suite
 * growth pass, the #6009 / #6156 heavy shapes fail, base and head share one
 * analyzer, and a missing base is an error rather than a zero delta.
 */

import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'url';
import { staticImportClosure, staticImportSpecifiers, staticImportSpecifiersFromSource } from '../../server/lib/staticImportGraph.js';
import {
  EXISTING_SUITE_GROWTH_LIMIT,
  HEAVY_REGRESSION_BAND,
  HISTORICAL_PROXY_TOTALS,
  REGRESSION_6009,
  REGRESSION_6156,
  basePathsToReadFromGit,
  benchmarkProxySplit,
  compareImportGrowth,
  evaluateWorkingTreeImportGrowth,
  formatImportGrowthReport,
  measureClosures,
  measureGitTree,
  measureWorkingTree,
  resolveImportGrowthBase,
  resolveRepoSpecifier,
} from './importGrowth.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function sourceMap(files) {
  const map = new Map(Object.entries(files));
  return (rel) => map.get(rel) ?? null;
}

function measure(files) {
  const tests = Object.keys(files).filter((rel) => rel.endsWith('.test.js')).sort();
  return measureClosures(tests, sourceMap(files));
}

/** `suites` existing tests each gain `extra` modules behind one heavy root. */
function fanOut({ suites, extra }) {
  const baseFiles = {};
  const headFiles = {};
  const children = [];
  for (let i = 0; i < extra; i += 1) {
    const name = `server/heavy/m${i}.js`;
    children.push(name);
    const prev = i === 0 ? '' : `import './m${i - 1}.js';\n`;
    baseFiles[name] = 'export const untouched = true;\n';
    headFiles[name] = `${prev}export const n = ${i};\n`;
  }
  const heavyImports = extra === 0 ? '' : `import './heavy/m${extra - 1}.js';\n`;
  baseFiles['server/wide.js'] = 'export const wide = 1;\n';
  headFiles['server/wide.js'] = `${heavyImports}export const wide = 1;\n`;
  for (let s = 0; s < suites; s += 1) {
    const file = `server/suite${s}.test.js`;
    const body = "import './wide.js';\n";
    baseFiles[file] = body;
    headFiles[file] = body;
  }
  return { base: measure(baseFiles), head: measure(headFiles) };
}

describe('import-growth threshold (#6009, #6156)', () => {
  it('keeps the limit above ordinary leaf growth and below the known heavy regressions', () => {
    expect(REGRESSION_6009).toBe(HISTORICAL_PROXY_TOTALS.before6009 - HISTORICAL_PROXY_TOTALS.after6009);
    expect(REGRESSION_6156).toBe(HISTORICAL_PROXY_TOTALS.after6009 - HISTORICAL_PROXY_TOTALS.after6156);
    expect(REGRESSION_6009).toBe(19_286);
    expect(REGRESSION_6156).toBe(12_794);
    expect(EXISTING_SUITE_GROWTH_LIMIT).toBeGreaterThan(1_500);
    expect(EXISTING_SUITE_GROWTH_LIMIT).toBeLessThan(HEAVY_REGRESSION_BAND);
  });

  it('passes a wide leaf and a large new suite, and fails the heavy fan-out shapes', () => {
    // providerVendors.js was reached by 376 suites when this limit was chosen.
    // One new module in each of those closures is the ordinary shape.
    const leaf = fanOut({ suites: 376, extra: 1 });
    const leafReport = compareImportGrowth(leaf.base, leaf.head);
    expect(leafReport.ok).toBe(true);
    expect(leafReport.existingSuiteGrowth).toBe(376);

    const added = measure({ 'server/new.test.js': "import './paid.js';\n", 'server/paid.js': 'export const paid = 1;\n' });
    const empty = measure({});
    const addedReport = compareImportGrowth(empty, added);
    expect(addedReport.ok).toBe(true);
    expect(addedReport.existingSuiteGrowth).toBe(0);
    expect(addedReport.newSuiteContribution).toBe(2);
    expect(addedReport.newSuiteCount).toBe(1);

    // settings.js × userActions.js: 331 suites, 23-module closure, one #6156 edge.
    const settingsEdge = compareImportGrowth(...Object.values(fanOut({ suites: 331, extra: 23 })));
    expect(settingsEdge.ok).toBe(false);
    expect(settingsEdge.existingSuiteGrowth).toBe(331 * 23);
    expect(settingsEdge.largestNewDependencies[0].module).toBe('server/heavy/m22.js');
    expect(settingsEdge.largestNewDependencies[0].newReach).toBe(331);
    expect(settingsEdge.largestNewDependencies[0].closureSize).toBe(23);
    expect(settingsEdge.largestSuiteDeltas[0].growth).toBe(23);

    // validation.js reach × checkRegistry.js closure, the #6009 barrel shape.
    const barrel = compareImportGrowth(...Object.values(fanOut({ suites: 224, extra: 69 })));
    expect(barrel.ok).toBe(false);
    expect(barrel.existingSuiteGrowth).toBe(224 * 69);
  });

  it('does not let shrinkage on one suite cancel growth on another', () => {
    const base = measure({
      'server/a.test.js': "import './wide.js';\n",
      'server/b.test.js': "import './wide.js';\nimport './gone.js';\n",
      'server/wide.js': 'export const w = 1;\n',
      'server/gone.js': 'export const g = 1;\n',
    });
    const head = measure({
      'server/a.test.js': "import './wide.js';\nimport './heavy.js';\n",
      'server/b.test.js': "import './wide.js';\n",
      'server/wide.js': 'export const w = 1;\n',
      'server/heavy.js': `${Array.from({ length: 20 }, (_, i) => `import './h${i}.js';`).join('\n')}\n`,
      ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`server/h${i}.js`, `export const n = ${i};\n`])),
    });
    const report = compareImportGrowth(base, head, { limit: 10 });
    expect(report.existingSuiteShrink).toBeGreaterThan(0);
    expect(report.existingSuiteGrowth).toBeGreaterThan(10);
    expect(report.ok).toBe(false);
  });

  it('describes a failure as a proxy and names the suites and dependencies', () => {
    const report = compareImportGrowth(...Object.values(fanOut({ suites: 4, extra: 3 })), { limit: 1 });
    const text = formatImportGrowthReport(report);
    expect(text).toMatch(/proxy/);
    expect(text).toMatch(/not a count of observed module instantiations/);
    expect(text).toMatch(/server\/suite0\.test\.js/);
    expect(text).toMatch(/server\/heavy\/m2\.js/);
    expect(text).toMatch(/New-suite contribution/);
    expect(text).toMatch(/intentional-regression/);
    expect(report.timings).toBeUndefined();
  });
});

describe('one analyzer for base and head', () => {
  it('reports zero growth when both sides read the same sources', () => {
    const files = {
      'server/a.test.js': "import './leaf.js';\n",
      'server/leaf.js': 'export const leaf = 1;\n',
    };
    const report = compareImportGrowth(measure(files), measure(files));
    expect(report.ok).toBe(true);
    expect(report.existingSuiteGrowth).toBe(0);
    expect(report.baseTotal).toBe(report.headTotal);
  });

  it('attributes a head-only edge to growth rather than to the analyzer', () => {
    const base = measure({ 'server/a.test.js': 'export const t = 1;\n' });
    const head = measure({
      'server/a.test.js': "import './added.js';\n",
      'server/added.js': 'export const a = 1;\n',
    });
    const report = compareImportGrowth(base, head);
    expect(report.existingSuiteGrowth).toBe(1);
    expect(report.newSuiteContribution).toBe(0);
  });

  it('resolves specifiers the same way staticImportClosure walks them', () => {
    const root = mkdtempSync(join(tmpdir(), 'portos-import-walk-'));
    try {
      mkdirSync(join(root, 'server', 'nested'), { recursive: true });
      writeFileSync(join(root, 'server', 'a.test.js'), "import './nested/b.js';\n");
      writeFileSync(join(root, 'server', 'nested', 'b.js'), "import '../c.js';\n");
      writeFileSync(join(root, 'server', 'c.js'), 'export const c = 1;\n');
      const read = (rel) => {
        try { return readFileSync(join(root, ...rel.split('/')), 'utf8'); } catch { return null; }
      };
      const measured = measureClosures(['server/a.test.js'], read);
      expect([...measured.tests.get('server/a.test.js')].sort()).toEqual([
        'server/a.test.js', 'server/c.js', 'server/nested/b.js',
      ]);
      expect(measured.total).toBe(staticImportClosure(join(root, 'server', 'a.test.js')).files.size);
      const source = readFileSync(join(root, 'server', 'nested', 'b.js'), 'utf8');
      expect(staticImportSpecifiersFromSource(source)).toEqual(staticImportSpecifiers(join(root, 'server', 'nested', 'b.js')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('missing base history', () => {
  it('does not fall through when CI_BASE_SHA is set and does not resolve', () => {
    expect(() => resolveImportGrowthBase({
      repoRoot: REPO_ROOT,
      env: { CI_BASE_SHA: 'not-a-commit' },
      revParse: () => null,
      mergeBase: () => 'should-not-be-used',
    })).toThrow(/does not pass/);
  });

  it('does not replace a missing Actions base with the remote default branch', () => {
    expect(() => resolveImportGrowthBase({
      repoRoot: REPO_ROOT,
      env: { GITHUB_ACTIONS: 'true' },
      revParse: () => null,
      mergeBase: () => 'origin-main',
    })).toThrow(/HEAD\^1/);
  });

  it('fails a local run whose merge-base cannot be resolved', () => {
    expect(() => resolveImportGrowthBase({
      repoRoot: REPO_ROOT,
      env: {},
      revParse: () => null,
      mergeBase: () => null,
      defaultRef: 'origin/main',
    })).toThrow(/merge-base/);
  });

  it('uses CI_BASE_SHA when it resolves, including on Actions', () => {
    expect(resolveImportGrowthBase({
      repoRoot: REPO_ROOT,
      env: { CI_BASE_SHA: 'abc', GITHUB_ACTIONS: 'true' },
      revParse: (_root, rev) => (rev === 'abc' ? 'abcabc' : null),
      mergeBase: () => null,
    })).toEqual({ sha: 'abcabc', source: 'CI_BASE_SHA' });
  });
});

describe('git base versus worktree head', () => {
  const roots = [];
  afterEach(() => {
    while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
  });

  function repo() {
    const root = mkdtempSync(join(tmpdir(), 'portos-import-git-'));
    roots.push(root);
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    git('init', '-q');
    mkdirSync(join(root, 'empty-hooks'));
    git('config', 'core.hooksPath', join(root, 'empty-hooks'));
    git('config', 'user.email', 'agent@example.com');
    git('config', 'user.name', 'Example Agent');
    git('config', 'commit.gpgsign', 'false');
    const write = (rel, body) => {
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), body);
    };
    const commit = () => {
      git('add', '-A');
      git('commit', '-qm', 'fixture');
      return git('rev-parse', 'HEAD').trim();
    };
    return { root, git, write, commit };
  }

  it('reads the base blob for a dirty file and counts a new test file separately', () => {
    const { root, write, commit } = repo();
    write('server/wide.js', 'export const wide = 1;\n');
    write('server/keep.test.js', "import './wide.js';\n");
    const sha = commit();

    write('server/wide.js', "import './heavy.js';\nexport const wide = 1;\n");
    write('server/heavy.js', 'export const heavy = 1;\n');
    write('server/new.test.js', "import './heavy.js';\n");

    const base = measureGitTree(root, sha);
    const head = measureWorkingTree(root);
    expect(base.tests.get('server/keep.test.js').has('server/heavy.js')).toBe(false);
    expect(head.tests.get('server/keep.test.js').has('server/heavy.js')).toBe(true);
    const report = compareImportGrowth(base, head);
    expect(report.existingSuiteGrowth).toBe(1);
    expect(report.newSuiteCount).toBe(1);
    expect(report.newSuiteContribution).toBe(2);
    expect(report.ok).toBe(true);
    expect(report.largestNewDependencies[0]).toMatchObject({ module: 'server/heavy.js', newReach: 1, closureSize: 1 });
  });

  it('fails closed when the base commit cannot be listed', () => {
    const { root, write, commit } = repo();
    write('server/a.test.js', 'export const a = 1;\n');
    commit();
    expect(() => measureGitTree(root, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toThrow(/does not pass/);
  });

  it('treats a rename as a wash when the closure does not gain modules', () => {
    const { root, git, write, commit } = repo();
    write('server/old.js', 'export const leaf = 1;\n');
    write('server/keep.test.js', "import './old.js';\n");
    const sha = commit();
    git('mv', 'server/old.js', 'server/renamed.js');
    write('server/keep.test.js', "import './renamed.js';\n");
    const report = compareImportGrowth(measureGitTree(root, sha), measureWorkingTree(root));
    expect(report.existingSuiteGrowth).toBe(0);
    expect(report.ok).toBe(true);
  });
});

describe('benchmark timings stay out of the gate', () => {
  it('reports collection and execution separately on synthetic data', () => {
    const benchmark = benchmarkProxySplit({ modules: 12 });
    expect(benchmark.collectionMs).toEqual(expect.any(Number));
    expect(benchmark.executionMs).toEqual(expect.any(Number));
    expect(benchmark.executed).toBe(13);
    expect(benchmark.environment.synthetic).toBe(true);
    expect(benchmark.limitations.join('\n')).toMatch(/CI pass\/fail threshold/);
    expect(benchmark.limitations.join('\n')).toMatch(/not Vitest transforming/);
    expect(benchmark.limitations.join('\n')).toMatch(/not test bodies/);
    const passing = compareImportGrowth(...Object.values(fanOut({ suites: 2, extra: 1 })));
    expect(passing.ok).toBe(true);
    expect(passing.timings).toBeUndefined();
  });
});

describe('name-status parsing', () => {
  it('asks git for the pre-image of edits, deletions, and renames, not additions', () => {
    expect(basePathsToReadFromGit('M\0server/a.js\0A\0server/new.js\0D\0server/gone.js\0R100\0server/old.js\0server/renamed.js\0')).toEqual([
      'server/a.js', 'server/gone.js', 'server/old.js',
    ]);
  });

  it('rejects a truncated rename record instead of guessing a path', () => {
    expect(() => basePathsToReadFromGit('R90\0server/old.js')).toThrow(/rename/);
  });
});

describe('specifier resolution', () => {
  it('keeps in-repo relative specifiers and drops ones that leave the repo', () => {
    expect(resolveRepoSpecifier('server/lib/a.js', '../services/b.js')).toBe('server/services/b.js');
    expect(resolveRepoSpecifier('server/a.js', '../../outside.js')).toBeNull();
    expect(resolveRepoSpecifier('server/a.js', 'vitest')).toBeNull();
  });
});

describe('evaluateWorkingTreeImportGrowth on a repo that is not the suite', () => {
  it('refuses a partial measurement instead of reporting success', () => {
    const root = mkdtempSync(join(tmpdir(), 'portos-import-partial-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: root });
      mkdirSync(join(root, 'empty-hooks'));
      execFileSync('git', ['config', 'core.hooksPath', join(root, 'empty-hooks')], { cwd: root });
      execFileSync('git', ['config', 'user.email', 'agent@example.com'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 'Example Agent'], { cwd: root });
      execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
      mkdirSync(join(root, 'server'));
      writeFileSync(join(root, 'server', 'a.test.js'), 'export const a = 1;\n');
      execFileSync('git', ['add', '-A'], { cwd: root });
      execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
      expect(() => evaluateWorkingTreeImportGrowth({
        repoRoot: root,
        env: { CI_BASE_SHA: sha },
      })).toThrow(/does not pass/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
