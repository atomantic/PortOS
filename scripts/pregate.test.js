/** Local validation selection, stage execution, process ownership and receipt
 * contracts. Hosted CI owns the broader test-impact plan.
 */
import { cosWorkerBudget } from './lib/cosWorkerBudget.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, existsSync, lstatSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { cp } from 'fs/promises';
import { delimiter, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { destroyGitSandbox, makeGitSandbox } from '../server/lib/gitTestRepo.js';
import {
  buildCiTestPlan,
  collectPlanInputs,
  ALWAYS_RUN_TESTS,
  WINDOWS_CONTRACT_TESTS,
} from './ci-test-plan.js';
import {
  collectPregateChangedFiles,
  resolvePlanStages,
  describeBrowserSelection,
  describeStageCommand,
  downgradeFullPlan,
  focusedLocalPlan,
  parseArgs,
  pregateWorkerEnv,
  stageSpawnEnv,
  sweepStageGroup,
  suiteSelected,
  uncoveredSuites,
  UNCOVERED_SUITES,
  unmergedIndexPaths,
} from './pregate.js';
import { buildPregateReport, PREGATE_REPORT_PATH, validatedTreeHash } from './lib/pregateReport.js';
import { probeTestDatabase, TEST_DATABASE, uncreatableExtensions, testDatabaseStageEnv } from './lib/pregateResources.js';

import { BROWSER_SUITES } from './lib/browserSuites.js';
import { BROWSER_FIDELITY_FILES } from './lib/browserTestProfiles.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const planWith = (overrides = {}) => ({
  full: false,
  reason: 'test plan',
  server: { mode: 'files', files: ['server/lib/a.test.js'], sources: [] },
  client: { mode: 'skip', files: [], sources: [] },
  lint: { mode: 'skip', files: [] },
  browser: { files: [] },
  db: false,
  windows: false,
  build: false,
  smoke: false,
  promptHistory: false,
  linuxContainment: false,
  supercolliderLive: false,
  dockerContainmentLive: false,
  ...overrides,
});

const DEFAULT_OPTIONS = {
  base: null, full: false, skipLint: false, planOnly: false, help: false, guardsOnly: false, mergedWith: null,
  skipDb: false, skipBrowser: false, skipBuild: false, skipSmoke: false,
};

describe('owned stage group settlement', () => {
  const pgid = 424242;
  const fail = code => { throw Object.assign(new Error(code), { code }); };

  it('waits through a zombie-only EPERM until a fresh exact-group probe returns ESRCH', async () => {
    let elapsed = 0;
    const calls = [];
    const result = await sweepStageGroup(pgid, {
      kill: (pid, signal) => {
        calls.push([pid, signal]);
        // Reproduce the held-zombie -> reaped transition without timing sleeps.
        return fail(elapsed === 0 ? 'EPERM' : 'ESRCH');
      },
      now: () => elapsed,
      wait: async ms => { elapsed += ms; },
      inspect: group => { expect(group).toBe(pgid); return `${pgid}:Z`; },
    });
    expect(result).toEqual({ settled: true, lingered: true });
    expect(calls).toEqual([[-pgid, 'SIGKILL'], [-pgid, 0], [-pgid, 0]]);
    expect(elapsed).toBe(25);
  });

  it.each([
    ['live', 'present', '424242:S'],
    ['uninspectable', 'EPERM', 'unavailable (EACCES)'],
    ['zombie-only', 'EPERM', '424242:Z'],
    ['empty snapshot with denied probe', 'EPERM', 'none observed'],
    ['failed probe', 'EIO', 'unavailable (EIO)'],
  ])('refuses a %s group without a fresh ESRCH', async (_state, probe, members) => {
    let elapsed = 0;
    const signals = [];
    const result = await sweepStageGroup(pgid, {
      kill: (pid, signal) => {
        expect(pid).toBe(-pgid);
        signals.push(signal);
        if (signal === 'SIGKILL') return fail('EPERM');
        if (probe !== 'present') return fail(probe);
      },
      now: () => elapsed,
      wait: async ms => { elapsed += ms; },
      inspect: group => { expect(group).toBe(pgid); return members; },
    });
    expect(result).toEqual({ settled: false, reason: `group kill failed (EPERM); pgid=${pgid}; probe=${probe}; members=${members}` });
    expect(signals[0]).toBe('SIGKILL');
    expect(signals.slice(1).every(signal => signal === 0)).toBe(true);
    expect(elapsed).toBe(probe === 'EIO' ? 0 : 5000);
  });
});

describe('resolvePlanStages', () => {
  it('runs only the scopes the plan selected', () => {
    const stages = resolvePlanStages(planWith());
    expect(stages.map((stage) => stage.name)).toEqual(['hidden-content scan', 'server tests']);
  });

  it('hands each runner the plan\'s own selector lists', () => {
    const [, stage] = resolvePlanStages(planWith({
      server: { mode: 'related', files: ['server/lib/a.test.js'], sources: ['server/lib/a.js'] },
    }));
    expect(stage.script).toBe('run-ci-tests.js');
    expect(stage.args).toEqual(['server']);
    expect(stage.env).toEqual({
      PORTOS_CI_BROWSER_OWNER: 'unit',
      PORTOS_TEST_QUIET: '1',
      CI_TEST_MODE: 'related',
      CI_TEST_FILES: '["server/lib/a.test.js"]',
      CI_TEST_SOURCES: '["server/lib/a.js"]',
      PORTOS_PREGATE_GUARDS: '',
    });
  });

  it('scans hidden content before lint and tests using the resolved base', () => {
    const stages = resolvePlanStages(planWith({
      lint: { mode: 'files', files: ['client/src/App.jsx'] },
      client: { mode: 'files', files: ['client/src/App.test.jsx'], sources: [] },
    }), { baseSha: 'resolved-base' });
    expect(stages.map((stage) => stage.name)).toEqual(['hidden-content scan', 'client/server lint', 'server tests', 'client tests']);
    expect(stages[0]).toEqual({
      name: 'hidden-content scan', suite: 'scan', script: 'scan-diff-hidden-content.js',
      args: ['--base', 'resolved-base', '--worktree'], env: {},
    });
    expect(stages[1].env).toEqual({ CI_LINT_MODE: 'files', CI_LINT_FILES: '["client/src/App.jsx"]' });
    for (const stage of stages.filter((item) => item.script === 'run-ci-tests.js')) {
      expect(stage.env.CI_BASE_SHA).toBe('resolved-base');
    }
  });

  it('runs the shipped prompt-history guard right after the scan, only when the plan selects it', () => {
    expect(resolvePlanStages(planWith({ promptHistory: false })).map((stage) => stage.name))
      .not.toContain('shipped prompt history');
    const stages = resolvePlanStages(planWith({ promptHistory: true, lint: { mode: 'full', files: [] } }));
    expect(stages.map((stage) => stage.name)).toEqual(['hidden-content scan', 'shipped prompt history', 'client/server lint', 'server tests']);
    expect(stages[1]).toEqual({
      name: 'shipped prompt history', suite: 'prompt-history', script: 'migrations/check-shipped-prompt-history.js', args: [], env: {},
    });
  });

  it('drops the lint stage under --skip-lint but keeps the test stages', () => {
    const stages = resolvePlanStages(
      planWith({ lint: { mode: 'files', files: ['client/src/App.jsx'] } }),
      { skipLint: true },
    );
    expect(stages.map((stage) => stage.name)).toEqual(['hidden-content scan', 'server tests']);
  });

  it('runs each focused structural guard once while retaining direct regressions in both workspaces', () => {
    const plan = planWith({
      server: { mode: 'files', files: ['server/guard.test.js', 'server/service.test.js'], sources: [] },
      client: { mode: 'files', files: ['client/src/guard.test.js'], sources: [] }
    });
    const guardPlan = {
      server: { files: ['server/guard.test.js'] },
      client: { files: ['client/src/guard.test.js'] }
    };
    const stages = resolvePlanStages(plan, { guardPlan });
    expect(stages.map(stage => stage.name)).toEqual([
      'hidden-content scan', 'server structural guards', 'client structural guards', 'server tests'
    ]);
    for (const scope of ['server', 'client']) {
      const files = stages.filter(stage => stage.suite === scope).flatMap(stage => JSON.parse(stage.env.CI_TEST_FILES));
      expect(files).toEqual(plan[scope].files);
    }
    expect(plan.server.files).toEqual(['server/guard.test.js', 'server/service.test.js']);
  });

  it.each(['related', 'full'])('runs shared guards before every costly %s stage without changing the broad selection', (mode) => {
    const tracked = ['server/lib/index.test.js', ALWAYS_RUN_TESTS[0], 'client/src/fooConventions.test.js'];
    const plan = planWith({
      server: { mode, files: tracked.slice(0, 2), sources: ['server/lib/helper.js'] },
      client: { mode, files: tracked.slice(2), sources: [] },
      lint: { mode: 'full', files: [] },
      build: true, smoke: true, db: true, browser: { files: BROWSER_SUITES.slice(0, 1) },
    });
    const stages = resolvePlanStages(plan, { guardPlan: downgradeFullPlan(plan, tracked, ['server/lib/helper.js']) });
    expect(stages.map(stage => stage.name)).toEqual([
      'hidden-content scan', 'server structural guards', 'client structural guards',
      'client/server lint', 'server tests', 'client tests', 'client build',
      'boot smoke', 'browser suites', 'DB provision (portos_test)', 'DB suite (portos_test)',
    ]);
    for (const scope of ['server', 'client']) {
      expect(stages.find(stage => stage.name === `${scope} tests`).env).toMatchObject({
        CI_TEST_MODE: mode, CI_TEST_FILES: JSON.stringify(plan[scope].files), CI_TEST_SOURCES: JSON.stringify(plan[scope].sources),
      });
    }
    expect(stages.filter(stage => stage.guard).flatMap(stage => stage.files).sort()).toEqual(tracked.sort());
  });
});

// These regressions need the actual CLI and Git, not mocked stage dispatch:
// a later Git state can hide an earlier addition, no-index uses exit 1 for
// success, and even a read-only `git status` can refresh the caller's index.
describe('pregate hidden-content invocation', () => {
  let scratch;
  let root;
  let base;
  let template;
  const trackedPath = 'docs/tracked note.md';
  const clean = '# Example\n';
  const hidden = `${clean}hidden: \u200B\n`;
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const write = (path, content) => writeFileSync(join(root, path), content);
  const run = (...args) => spawnSync(process.execPath, ['scripts/pregate.js', '--base', base, ...args], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, PATH: `${join(scratch, 'fake-bin')}${delimiter}${process.env.PATH}` },
  });
  const snapshot = () => ({
    status: git('--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
    index: readFileSync(join(root, '.git', 'index')),
  });

  beforeAll(async () => {
    template = await makeGitSandbox({ prefix: 'portos-pregate-template-' });
    root = template.repo;
    scratch = template.scratch;
    git('config', 'core.hooksPath', join(scratch, 'empty-hooks'));
    git('config', 'core.excludesFile', join(scratch, 'empty-excludes'));
    // Copy the real builtin-only entrypoints so REPO_ROOT targets this fixture.
    // Docs-only changes select no test owners; full plans still have a native inventory.
    for (const path of [
      'lib/gitMergeTree.js', 'scripts/pregate.js', 'scripts/checkNodeVersion.js', 'scripts/scan-diff-hidden-content.js',
      'scripts/ci-test-plan.js', 'scripts/ci-base-sha.js', 'server/lib/staticImportGraph.js',
      'scripts/lib/directInvocation.js', 'scripts/lib/importReach.js', 'scripts/lib/workspaceTests.js', 'scripts/lib/browserFidelity.js', 'scripts/lib/browserTestProfiles.js', 'scripts/lib/githubOutput.js', 'scripts/lib/dbTestFiles.js',
      'scripts/lib/browserSuites.js', 'scripts/lib/sourceTokens.js', 'scripts/lib/workspaceDependencies.js', 'scripts/lib/pregateReport.js', 'scripts/lib/cosWorkerBudget.js',
      'scripts/migrations/shippedPromptHistory.js', 'server/lib/aiToolkit/internal/windowsSafeSpawn.js',
      'server/lib/diffHiddenContentScan.js', 'server/lib/modelAbuseGuard.js',
      'server/lib/textUtils.js',
      'server/lib/workspaceTestCacheRoots.js',
    ]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      copyFileSync(join(REPO_ROOT, path), join(root, path));
    }
    // The real npm script and its Windows shim, so the harness exercises what `npm run pregate` runs.
    write('package.json', JSON.stringify({ type: 'module', scripts: { pregate: JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).scripts.pregate } }) + '\n');
    copyFileSync(join(REPO_ROOT, 'exec.cmd'), join(root, 'exec.cmd'));
    // The receipt lands under /.cache/, which the real repository ignores too.
    write('.gitignore', 'node_modules\n/.cache/\n');
    for (const workspace of ['', 'client', 'server', 'autofixer']) {
      mkdirSync(join(root, workspace, 'node_modules'), { recursive: true });
      write(join(workspace, 'package-lock.json'), JSON.stringify({ packages: { '': {} } }));
    }
    write('server/lib/bufferedSpawn.test.js', '// Native inventory fixture\n');
    mkdirSync(join(root, 'docs'));
    write(trackedPath, clean);
    git('add', '--all');
    git('commit', '-qm', 'pregate fixture');
    base = git('rev-parse', 'HEAD');
  });

  beforeEach(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'portos-pregate-cli-'));
    root = join(scratch, 'primary');
    // Clone the fully committed fixture, not the raw git template. Windows
    // otherwise repeats source copies, git add and git commit for every case.
    await cp(template.repo, root, { recursive: true });
    // The copied index still holds the template files' stat data. Refresh it
    // before the test snapshots its bytes, or the CLI's ordinary Git reads
    // appear to mutate the index even when they only notice the copy.
    git('update-index', '--refresh');
    base = git('rev-parse', 'HEAD');
  });

  afterEach(async () => {
    await destroyGitSandbox(scratch);
  });

  afterAll(async () => {
    if (template?.scratch) await destroyGitSandbox(template.scratch);
  });

  // Only cases that select Windows need its complete tracked inventory.
  // Putting it in the common template would also select unrelated guards.
  function prepareWindowsInventory() {
    for (const path of WINDOWS_CONTRACT_TESTS) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      write(path, '// Native inventory fixture\n');
    }
    git('add', '--all');
    git('commit', '-qm', 'native contract inventory fixture');
    base = git('rev-parse', 'HEAD');
  }

  function prepareGuardFixture({ browser = false } = {}) {
    write('server/lib/index.js', 'export {};\n');
    write('server/lib/README.md', '# Shared helpers\n');
    // This fixture guard pins the catalog failure at the CLI boundary; the real
    // catalog suite separately owns the complete barrel/README contract.
    write('server/lib/index.test.js', `
      import { appendFileSync, existsSync, readFileSync } from 'fs';
      appendFileSync('.cache/events', 'catalog\\n');
      if (existsSync('server/lib/helper.js') &&
          (!readFileSync('server/lib/index.js', 'utf8').includes('helper') ||
           !readFileSync('server/lib/README.md', 'utf8').includes('helper'))) {
        throw new Error('Missing helper barrel/catalog registration');
      }
    `);
    write('server/lib/expensive.test.js', 'export {};\n');
    write('scripts/run-ci-tests.js', `
      import { appendFileSync } from 'fs';
      import { resolve } from 'path';
      import { pathToFileURL } from 'url';
      const files = JSON.parse(process.env.CI_TEST_FILES);
      const excluded = JSON.parse(process.env.PORTOS_PREGATE_GUARDS || '{}').files || [];
      const broad = process.env.CI_TEST_MODE !== 'files' || files.includes('server/lib/expensive.test.js');
      appendFileSync('.cache/events', JSON.stringify({ broad, excluded }) + '\\n');
      if (files.includes('server/lib/index.test.js') && !excluded.includes('server/lib/index.test.js')) {
        await import(pathToFileURL(resolve('server/lib/index.test.js')));
      }
    `);
    write('scripts/run-ci-lint.js', `
      import { appendFileSync, existsSync, writeFileSync } from 'fs';
      appendFileSync('.cache/events', 'lint\\n');
      if (existsSync('.cache/mutate')) writeFileSync('server/lib/helper.js', 'export const helper = 2;\\n');
    `);
    write('scripts/smoke-boot.js', `
      import { appendFileSync } from 'fs';
      appendFileSync('.cache/events', 'smoke\\n');
    `);
    if (browser) {
      write(BROWSER_SUITES[0], 'export {};\n');
      write('scripts/lib/pregateResources.js', `
        import { writeFileSync } from 'fs';
        writeFileSync('.cache/probe-started', 'unexpected probe');
        throw new Error('Resource probe ran before structural refusal');
      `);
    }
    git('add', '--all');
    git('commit', '-qm', 'structural gate fixture');
    base = git('rev-parse', 'HEAD');
    mkdirSync(join(root, '.cache'), { recursive: true });
    write('.cache/events', '');
    write('server/lib/helper.js', 'export const helper = 1;\n');
    if (browser) write(BROWSER_SUITES[0], 'export const changed = true;\n');
  }

  it('prints the selected guard, broad and browser stages without starting any process', () => {
    prepareGuardFixture({ browser: true });
    const result = run('--plan-only', '--full');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Planning against');
    expect(result.stdout).toContain('changed file');
    expect(result.stdout).toContain('server structural guards');
    expect(result.stdout).toContain('server tests');
    expect(result.stdout).toContain('Browser suites: 1 selected');
    expect(readFileSync(join(root, '.cache/events'), 'utf8')).toBe('');
    expect(existsSync(join(root, '.cache/probe-started'))).toBe(false);
    expect(existsSync(join(root, PREGATE_REPORT_PATH))).toBe(false);
  });

  // A structural refusal must precede both related-test dispatch and Chrome's
  // prerequisite probe, with the unfinished broad stages preserved in the receipt.
  it('refuses a missing helper catalog registration before broad tests or browser probes start', () => {
    prepareGuardFixture({ browser: true });
    const result = run('--skip-lint', '--full');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Missing helper barrel/catalog registration');
    const events = readFileSync(join(root, '.cache/events'), 'utf8');
    expect(events).not.toContain('"broad":true');
    expect(existsSync(join(root, '.cache/probe-started'))).toBe(false);
    const report = JSON.parse(readFileSync(join(root, PREGATE_REPORT_PATH), 'utf8'));
    expect(report.passed).toBe(false);
    expect(report.stages.find(stage => stage.guard)).toMatchObject({ status: 'failed', files: ['server/lib/index.test.js'] });
    expect(report.stages.filter(stage => ['server tests', 'browser suites'].includes(stage.name)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'server tests', status: 'not-run' }),
        expect.objectContaining({ name: 'browser suites', status: 'not-run' }),
      ]));
  });

  // Unlike the persistent module memo, this reuse includes tree scanners. A
  // modification between stages invalidates it even when the test file is stable.
  it.each([false, true])('rechecks guard inputs before broad dispatch (changed: %s)', (changed) => {
    prepareGuardFixture();
    write('server/lib/index.js', "export { helper } from './helper.js';\n");
    write('server/lib/README.md', '# Shared helpers\nhelper\n');
    if (changed) write('.cache/mutate', 'mutate during lint');
    const result = run('--full');
    expect(result.status, result.stderr).toBe(0);
    const events = readFileSync(join(root, '.cache/events'), 'utf8').trim().split('\n');
    expect(events.filter(event => event === 'catalog')).toHaveLength(changed ? 2 : 1);
    expect(events.indexOf('catalog')).toBeLessThan(events.indexOf('lint'));
    expect(events.at(-1)).toBe('smoke');
    const broad = events.filter(event => event.startsWith('{')).map(event => JSON.parse(event)).find(event => event.broad);
    expect(broad.excluded).toEqual(changed ? [] : ['server/lib/index.test.js']);
    const report = JSON.parse(readFileSync(join(root, PREGATE_REPORT_PATH), 'utf8'));
    expect(report.stages.every(stage => stage.status === 'passed')).toBe(true);
    expect(report.treeStable).toBe(!changed);
    expect(report.stages.find(stage => stage.name === 'server tests').guardReuse?.files)
      .toEqual(changed ? undefined : ['server/lib/index.test.js']);
  });

  // A branch and base can each be green while their combined route inventory fails.
  it('runs guards against the checked base on the exact merged tree, propagates failure, and preserves caller state and receipt', () => {
    git('config', 'core.autocrlf', 'true');
    mkdirSync(join(root, 'server/routes'), { recursive: true });
    write('server/routes/universe-builder.js', 'export const mutation = false;\n');
    write('server/lib/strict.js', 'export const strict = false;\n');
    write('server/lib/hostControlRoutes.test.js', `
      import { readFileSync } from 'fs';
      import { strict } from './strict.js';
      if (strict && readFileSync('server/routes/universe-builder.js', 'utf8').includes('mutation = true')) {
        throw new Error('hostControlRoutes.test.js: unclassified Universe Builder mutation');
      }
    `);
    write('scripts/run-ci-tests.js', `
      import { resolve } from 'path';
      import { pathToFileURL } from 'url';
      if (process.env.PORTOS_TEST_MEMO !== 'off') throw new Error('merged guards reused memo');
      if (process.env.CI_BASE_SHA !== process.env.PREGATE_FIXTURE_BASE) {
        throw new Error('guard stages received a different base from the checked merge target');
      }
      for (const file of JSON.parse(process.env.CI_TEST_FILES)) {
        if (file.endsWith('hostControlRoutes.test.js')) await import(pathToFileURL(resolve(file)));
      }
    `);
    git('add', '--all');
    git('commit', '-qm', 'green common guard');
    const common = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'new-base');
    write('docs/tracked note.md', '# Unrelated base move\n');
    git('add', '--all'); git('commit', '-qm', 'base move');
    const movedBase = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'feature', common);
    const invoke = (...flags) => spawnSync(process.execPath, ['scripts/pregate.js', ...flags], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PORTOS_TEST_MEMO: 'on', PREGATE_FIXTURE_BASE: flags.at(-1) },
    });
    mkdirSync(join(root, '.cache/pregate'), { recursive: true });
    write(PREGATE_REPORT_PATH, 'original attestation receipt');
    const original = { ...snapshot(), refs: git('show-ref'), worktrees: git('worktree', 'list', '--porcelain') };
    const green = invoke('--guards-only', '--merged-with', movedBase);
    expect(green.status, green.stderr).toBe(0);
    expect(green.stdout).toContain('Merged-tree guards: HEAD');
    expect(green.stdout).not.toContain('hidden-content scan');
    expect(green.stdout).not.toContain('client/server lint');
    expect({ ...snapshot(), refs: git('show-ref'), worktrees: git('worktree', 'list', '--porcelain') }).toEqual(original);
    expect(readFileSync(join(root, PREGATE_REPORT_PATH), 'utf8')).toBe('original attestation receipt');

    // The base tightens its guard independently; feature remains green in its own tree.
    write('server/routes/universe-builder.js', 'export const mutation = true;\n');
    git('add', '--all'); git('commit', '-qm', 'feature mutation before stricter guard');
    const branchOnly = invoke('--guards-only', '--base', common);
    expect(branchOnly.status, branchOnly.stderr).toBe(0);
    // The stricter base policy and feature route change do not conflict textually.
    git('checkout', 'new-base');
    write('server/lib/strict.js', 'export const strict = true;\n');
    git('add', '--all'); git('commit', '-qm', 'strict inventory');
    const strictBase = git('rev-parse', 'HEAD');
    git('checkout', 'feature');
    const before = { ...snapshot(), refs: git('show-ref'), worktrees: git('worktree', 'list', '--porcelain') };
    const failed = invoke('--guards-only', '--merged-with', strictBase);
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('hostControlRoutes.test.js: unclassified Universe Builder mutation');
    expect(failed.stdout).not.toContain('Pregate passed');
    expect({ ...snapshot(), refs: git('show-ref'), worktrees: git('worktree', 'list', '--porcelain') }).toEqual(before);
    expect(readFileSync(join(root, PREGATE_REPORT_PATH), 'utf8')).toBe('original attestation receipt');

    const originalDocBytes = readFileSync(join(root, 'docs/tracked note.md'));
    write('docs/tracked note.md', '# Pending local work\n');
    const dirty = snapshot();
    const refused = invoke('--guards-only', '--merged-with', strictBase);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('requires a clean committed checkout');
    expect(snapshot()).toEqual(dirty);
    writeFileSync(join(root, 'docs/tracked note.md'), originalDocBytes);

    git('checkout', 'new-base');
    write('server/routes/universe-builder.js', 'export const mutation = "conflicting";\n');
    git('add', '--all'); git('commit', '-qm', 'conflicting mutation');
    const conflictBase = git('rev-parse', 'HEAD');
    git('checkout', 'feature');
    const preConflict = snapshot();
    const conflict = invoke('--guards-only', '--merged-with', conflictBase);
    expect(conflict.status).not.toBe(0);
    expect(conflict.stderr).toContain('Cannot construct merged guard tree');
    expect(conflict.stdout).not.toContain('Pregate passed');
    expect(snapshot()).toEqual(preConflict);
  });

  it.each(['shallow', 'partial'])('merges a remote-only base from a %s source and still reports real conflicts', (kind) => {
    write('scripts/run-ci-tests.js', `
      import { readFileSync } from 'fs';
      if (readFileSync('docs/tracked note.md', 'utf8').trim() !== '# Base update'
        || readFileSync('docs/feature.md', 'utf8').trim() !== '# Independent feature') {
        throw new Error('guard did not receive both merge inputs');
      }
    `);
    git('add', '--all'); git('commit', '-qm', 'merged guard fixture');
    const upstream = root;
    const shallow = join(scratch, 'shallow');
    git('config', 'uploadpack.allowFilter', 'true');
    git('clone', '--quiet', '--no-local', ...(kind === 'shallow' ? ['--depth', '1'] : ['--filter=blob:none']), '--', upstream, shallow);
    write(trackedPath, '# Base update\n');
    git('add', '--all'); git('commit', '-qm', 'base update');
    const movedBase = git('rev-parse', 'HEAD');

    root = shallow;
    for (const workspace of ['', 'client', 'server', 'autofixer']) {
      mkdirSync(join(root, workspace, 'node_modules'), { recursive: true });
    }
    git('config', 'user.name', 'Example Agent');
    git('config', 'user.email', 'agent@example.com');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.hooksPath', join(scratch, 'empty-hooks'));
    git('checkout', '-qb', 'feature');
    write('docs/feature.md', '# Independent feature\n');
    git('add', '--all'); git('commit', '-qm', 'feature update');
    git('fetch', '--quiet', 'origin', 'main:refs/remotes/origin/main');
    expect(git('rev-parse', '--is-shallow-repository')).toBe(String(kind === 'shallow'));
    expect(git('rev-parse', 'origin/main')).toBe(movedBase);
    expect(git('for-each-ref', '--format=%(refname)', '--points-at', movedBase, 'refs/heads')).toBe('');
    if (kind === 'partial') {
      expect(git('config', '--get', 'remote.origin.promisor')).toBe('true');
      expect(git('rev-list', '--objects', '--no-object-names', '--missing=print', movedBase)).toMatch(/^\?/m);
    }
    const tree = git('merge-tree', '--write-tree', 'HEAD', 'origin/main').split('\n')[0];
    const invoke = () => spawnSync(process.execPath, ['scripts/pregate.js', '--guards-only', '--merged-with', 'origin/main'], {
      cwd: root, encoding: 'utf8',
    });
    const sourceState = () => ({ ...snapshot(), refs: git('show-ref'), ...(kind === 'shallow' ? { shallow: readFileSync(join(root, '.git/shallow')) } : {}) });
    const before = sourceState();
    if (kind === 'partial') {
      git('remote', 'set-url', 'origin', join(scratch, 'unavailable-promisor'));
      const unavailable = invoke();
      expect(unavailable.status).not.toBe(0);
      expect(unavailable.stdout).not.toContain('▶️ server tests');
      expect(sourceState()).toEqual(before);
      git('remote', 'set-url', 'origin', upstream);
    }
    const merged = invoke();
    expect(merged.status, merged.stderr).toBe(0);
    expect(merged.stdout).toContain(`= tree ${tree.slice(0, 12)}.`);
    expect(sourceState()).toEqual(before);

    write(trackedPath, '# Conflicting feature update\n');
    git('add', '--all'); git('commit', '-qm', 'conflicting feature update');
    const preConflict = sourceState();
    const conflict = invoke();
    expect(conflict.status).not.toBe(0);
    expect(conflict.stderr).toContain('Cannot construct merged guard tree');
    expect(conflict.stderr).toContain('CONFLICT (content)');
    expect(conflict.stdout).not.toContain('Pregate passed');
    expect(sourceState()).toEqual(preConflict);
  });

  // This regression catches stale inherited packages before any lint/test child
  // can produce a misleading product failure or repair the shared source tree.
  it.each(['matching', 'stale', 'missing-package', 'unreadable-package', 'dangling', 'missing-link', 'unlinked'])(
    'checks %s linked dependencies read-only before executing stages', (state) => {
      // The server lockfile selects the native Windows job.
      prepareWindowsInventory();
      const worktree = join(scratch, 'linked-worktree');
      git('worktree', 'add', '--detach', worktree, base);
      root = worktree;
      for (const workspace of ['', 'client', 'server', 'autofixer']) mkdirSync(join(root, workspace, 'node_modules'), { recursive: true });
      const shared = join(scratch, 'source', 'server', 'node_modules');
      const installed = join(shared, 'express', 'package.json');
      const modules = join(root, 'server', 'node_modules');
      mkdirSync(dirname(installed), { recursive: true });
      writeFileSync(installed, state === 'unreadable-package' ? '{broken' : JSON.stringify({ version: state === 'stale' ? '5.2.1' : '5.3.0' }));
      if (state === 'missing-package') rmSync(installed);
      const sourceReceipt = join(scratch, 'source', 'deps-hashes.json');
      writeFileSync(sourceReceipt, '{"server":"legacy"}');
      writeFileSync(join(shared, '.package-lock.json'), '{"packages":{"node_modules/express":{"version":"5.3.0"}}}');
      const sourceSnapshot = () => Object.fromEntries(readdirSync(join(scratch, 'source'), { recursive: true })
        .filter(path => lstatSync(join(scratch, 'source', path)).isFile())
        .map(path => [path, readFileSync(join(scratch, 'source', path), 'utf8')]));
      const before = sourceSnapshot();
      const fakeBin = join(scratch, 'fake-bin');
      mkdirSync(fakeBin);
      writeFileSync(join(fakeBin, 'npm'), '#!/usr/bin/env node\nrequire("fs").writeFileSync("unexpected-npm", "called");', { mode: 0o755 });
      writeFileSync(join(fakeBin, 'npm.cmd'), '@node "%~dp0npm" %*\r\n');
      rmSync(modules, { recursive: true });
      const target = state === 'dangling' ? join(scratch, 'absent-deps') : shared;
      if (state === 'unlinked') mkdirSync(modules);
      else if (state !== 'missing-link') symlinkSync(target, modules, process.platform === 'win32' ? 'junction' : 'dir');
      write('server/package-lock.json', JSON.stringify({ packages: {
        '': {}, 'node_modules/express': { version: '5.3.0' },
        'node_modules/optional-platform-package': { version: '1.0.0', optional: true },
      } }));
      // Changing scripts selects full lint; any accidental stage run leaves a
      // durable marker. Startup/package-manager repair is a separate trap.
      for (const name of ['run-ci-lint.js', 'run-ci-tests.js', 'ensure-deps.js']) {
        write(`scripts/${name}`, `import { writeFileSync } from 'fs'; writeFileSync('unexpected-stage', '${name}');`);
      }
      const result = run();
      if (state === 'matching') {
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain('Dependency consistency preflight passed');
        expect(existsSync(join(root, 'unexpected-stage'))).toBe(true);
      } else {
        expect(result.status).toBe(1);
        const needsLink = ['dangling', 'missing-link', 'unlinked'].includes(state);
        expect(result.stderr).toContain(`server (${['missing-link', 'unlinked'].includes(state) ? 'owned' : 'linked'} node_modules)`);
        if (needsLink) expect(result.stderr).toContain('Re-link with: node scripts/link-worktree-deps.js');
        else {
          expect(result.stderr).toContain('owning source checkout');
          expect(result.stderr).toContain('separate clone with its own locked installs');
          expect(result.stderr).toContain('Never run npm install/ci through worktree links');
          expect(result.stderr).not.toContain('missing or unlinked');
          expect(result.stderr).not.toContain('Re-link with:');
        }
        const diagnostic = {
          stale: 'expected 5.3.0, installed 5.2.1',
          'missing-package': 'missing package.json (ENOENT)',
          'unreadable-package': 'unreadable package.json (invalid JSON)',
          dangling: 'linked target unavailable',
          'missing-link': 'node_modules missing',
          unlinked: 'missing package.json',
        }[state];
        expect(result.stderr).toContain(diagnostic);
        expect(existsSync(join(root, 'unexpected-stage'))).toBe(false);
      }
      if (state === 'missing-link') expect(existsSync(modules)).toBe(false);
      else expect(lstatSync(modules).isSymbolicLink()).toBe(state !== 'unlinked');
      expect(sourceSnapshot()).toEqual(before);
      expect(existsSync(join(root, 'unexpected-npm'))).toBe(false);
      expect(readFileSync(sourceReceipt, 'utf8')).toBe('{"server":"legacy"}');
      if (state === 'dangling') expect(existsSync(target)).toBe(false);
    },
  );

  it('diagnoses a production-only install before spawning development checks', () => {
    prepareWindowsInventory();
    write('server/package-lock.json', JSON.stringify({ packages: {
      '': {}, 'node_modules/vitest': { version: '5.0.4', dev: true },
    } }));
    write('scripts/run-ci-tests.js', 'throw new Error("unexpected test stage");');
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('node_modules/vitest: missing package.json');
    expect(result.stderr).toContain('pregate requires development dependencies (--include=dev)');
    expect(result.stderr).not.toContain('unexpected test stage');
  });

  it('refuses missing and unreadable lock evidence rather than calling it a match', () => {
    rmSync(join(root, 'client', 'package-lock.json'));
    write('autofixer/package-lock.json', '{invalid');
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('client (owned node_modules)');
    expect(result.stderr).toContain('package-lock.json missing (ENOENT)');
    expect(result.stderr).toContain('autofixer (owned node_modules)');
    expect(result.stderr).toContain('package-lock.json unreadable (invalid JSON)');
  });

  it.each(['committed', 'staged', 'unstaged', 'untracked'])(
    'rejects %s hidden content without changing files or staging state', (state) => {
      const path = state === 'untracked' ? 'docs/untracked note.md' : trackedPath;
      write(path, hidden);
      if (state === 'committed' || state === 'staged') git('add', '--', path);
      if (state === 'committed') git('commit', '-qm', 'hidden fixture');
      // A clean worktree must not conceal the staged or committed addition.
      if (state === 'committed' || state === 'staged') write(path, clean);
      const before = snapshot();
      const contents = readFileSync(join(root, path));
      const result = run('--skip-lint');
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(`${path}:2 — hidden-unicode:`);
      expect(result.stdout).not.toContain('Pregate passed');
      expect(snapshot()).toEqual(before);
      expect(readFileSync(join(root, path))).toEqual(contents);

      if (state === 'committed') {
        const ci = spawnSync(process.execPath, ['scripts/scan-diff-hidden-content.js', '--base', base], {
          cwd: root, encoding: 'utf8',
        });
        expect(ci.status).toBe(1);
        expect(result.stderr).toContain(ci.stderr.trim());
      }
    },
  );

  // Only the fixture-owned scan process is signaled; no real test runner starts.
  it.skipIf(process.platform === 'win32')('attributes owner cancellation to its active stage and preserves SIGTERM', async () => {
    write('scripts/scan-diff-hidden-content.js', `
      console.log('fixture-stage-ready');
      setInterval(() => {}, 1000);
    `);
    const runner = spawn(process.execPath, ['scripts/pregate.js', '--base', base, '--skip-lint'], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    runner.stderr.on('data', (data) => { stderr += data; });
    runner.stdout.on('data', (data) => {
      stdout += data;
      if (stdout.includes('fixture-stage-ready')) runner.kill('SIGTERM');
    });
    try {
      const result = await new Promise((resolve, reject) => {
        runner.once('error', reject);
        runner.once('close', (status, signal) => resolve({ status, signal }));
      });
      expect(result).toEqual({ status: null, signal: 'SIGTERM' });
      expect(stderr).toContain(`Pregate incomplete: stage="hidden-content scan" owner_pid=${runner.pid}`);
      expect(stderr).toMatch(/child_pid=\d+ received_signal=SIGTERM/);
      expect(stdout).not.toContain('Pregate passed');
    } finally {
      runner.kill('SIGKILL');
    }
  });

  // #12641/#12670: a Ctrl-C reaches pregate from the terminal group AND from
  // npm's forwarding; the duplicate used to kill pregate before it signalled the
  // stage, orphaning the runner. A group SIGTERM also kills the `sh -c` wrapper
  // npm runs the script under (dash on Linux does not always exec its last
  // command), and npm exits the moment that wrapper dies. The simulated shell
  // below never execs on its own, so only the script's own `exec` keeps the
  // wrapper out of the way. The fixture stage mirrors run-ci-tests.js: a
  // launcher that settles its own separately grouped child on a signal, plus
  // an in-group descendant that ignores signals and keeps writing.
  it.skipIf(process.platform === 'win32').each(['SIGINT', 'SIGTERM'])('settles every owned stage process before npm exits on a group %s', async (signal) => {
    const heartbeat = join(scratch, 'heartbeat');
    write('scripts/scan-diff-hidden-content.js', `
      import { spawn } from 'child_process';
      import { existsSync } from 'fs';
      const straggler = spawn(process.execPath, ['-e', "process.on('SIGINT', () => {}); process.on('SIGTERM', () => {});"
        + " setInterval(() => require('fs').appendFileSync(process.env.FIXTURE_HEARTBEAT, '.'), 10);"], { stdio: 'ignore' });
      const launched = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
      const settle = () => {
        process.kill(-launched.pid, 'SIGKILL');
        launched.once('exit', () => setTimeout(() => process.exit(1), 100));
      };
      process.on('SIGINT', settle);
      process.on('SIGTERM', settle);
      // Ready only once the straggler is provably writing.
      const ready = setInterval(() => {
        if (!existsSync(process.env.FIXTURE_HEARTBEAT)) return;
        clearInterval(ready);
        console.log('fixture-stage-ready ' + JSON.stringify([process.ppid, process.pid, straggler.pid, launched.pid]));
      }, 10);
      setInterval(() => {}, 1000);
    `);
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
    const nonExecShell = join(scratch, 'non-exec-shell');
    writeFileSync(nonExecShell, '#!/bin/sh\nexec /bin/sh "$1" "$2 ; :"\n', { mode: 0o755 });
    const npm = spawn('npm', ['run', 'pregate', '--', '--base', base, '--skip-lint'], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
      env: { ...process.env, FIXTURE_HEARTBEAT: heartbeat, npm_config_script_shell: nonExecShell },
    });
    const alive = (pid) => {
      try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
    };
    let pregatePid = null;
    let owned = [];
    let stdout = '';
    let stderr = '';
    npm.stderr.on('data', (data) => { stderr += data; });
    npm.stdout.on('data', (data) => {
      stdout += data;
      const ready = /fixture-stage-ready (\[[\d,]+\])/.exec(stdout);
      if (ready && owned.length === 0) {
        [pregatePid, ...owned] = JSON.parse(ready[1]);
        // Ctrl-C reaches the whole foreground group: npm and pregate alike.
        process.kill(-npm.pid, signal);
      }
    });
    try {
      const closed = new Promise((resolve) => npm.once('close', resolve));
      const result = await new Promise((resolve, reject) => {
        npm.once('error', reject);
        npm.once('exit', (status, exitSignal) => resolve({ status, signal: exitSignal }));
      });
      // The boundary is npm's own exit: nothing pregate owns may outlive it.
      expect(alive(pregatePid)).toBe(false);
      expect(owned).toHaveLength(3);
      expect(owned.filter(alive)).toEqual([]);
      // Output is read after `close`, which a survivor holding the pipes would delay.
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5000))]);
      expect(result.status === null ? result.signal : result.status).not.toBe(0);
      expect(stderr).toMatch(new RegExp(`stage="hidden-content scan" owner_pid=${pregatePid} child_pid=${owned[0]} received_signal=${signal}`));
      expect(stderr).toContain(`stage="hidden-content scan" cancelled by ${signal}; its process group has exited.`);
      expect(stdout).not.toContain('Pregate passed');
      const report = JSON.parse(readFileSync(join(root, PREGATE_REPORT_PATH), 'utf8'));
      expect(report.passed).toBe(false);
      expect(report.stages[0]).toMatchObject({ name: 'hidden-content scan', status: 'failed', signal });
      const written = readFileSync(heartbeat, 'utf8').length;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(readFileSync(heartbeat, 'utf8').length).toBe(written);
      expect(alive(unrelated.pid)).toBe(true);
    } finally {
      for (const pid of [npm.pid, unrelated.pid, ...owned].filter(Boolean)) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* not a live group */ }
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
  });

  // #13458: replay the kernel's exit/signal crossing at the CLI boundary.
  // Only an actually absent group gets the injected refusal; the subsequent
  // probe must still go to the kernel, and the receipt must remain truthful.
  it.skipIf(process.platform === 'win32')('verifies exact group absence after an exit-crossing EPERM', () => {
    const preload = join(scratch, 'exit-crossing.cjs');
    writeFileSync(preload, `
      const kill = process.kill.bind(process);
      process.kill = (pid, signal) => {
        if (pid < 0 && signal === 'SIGKILL') {
          try { kill(pid, 0); } catch (error) {
            if (error.code !== 'ESRCH') throw error;
            console.log('fixture-exit-crossing pgid=' + -pid);
            throw Object.assign(new Error('exit crossing'), { code: 'EPERM' });
          }
        }
        return kill(pid, signal);
      };
    `);
    write(trackedPath, `${clean}updated\n`);
    const result = spawnSync(process.execPath, ['--require', preload, 'scripts/pregate.js', '--base', base, '--skip-lint'], {
      cwd: root, encoding: 'utf8',
    });
    expect(result.stdout).toMatch(/fixture-exit-crossing pgid=\d+/);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Pregate passed');
    const report = JSON.parse(readFileSync(join(root, PREGATE_REPORT_PATH), 'utf8'));
    expect(report.passed).toBe(true);
    expect(report.stages[0]).toMatchObject({ name: 'hidden-content scan', status: 'passed' });
  });

  // run-ci-tests.js leaves npm and Vitest in pregate's stage group, so pregate
  // owns them on every exit path, not only on cancellation.
  it.skipIf(process.platform === 'win32')('kills a descendant still running in the stage group after the stage exits', () => {
    const marker = join(scratch, 'straggler-pid');
    write('scripts/scan-diff-hidden-content.js', `
      import { spawn } from 'child_process';
      import { writeFileSync } from 'fs';
      const straggler = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: 'ignore' });
      writeFileSync(${JSON.stringify(marker)}, String(straggler.pid));
      setTimeout(() => process.exit(0), 200);
    `);
    const result = run('--skip-lint');
    const pid = Number(readFileSync(marker, 'utf8'));
    let alive = true;
    try { process.kill(pid, 0); } catch (error) { alive = error.code !== 'ESRCH'; }
    if (alive) process.kill(pid, 'SIGKILL');
    expect(alive).toBe(false);
    // Later stages are not fixtures here; only the scan stage's outcome matters.
    expect(result.stdout).toContain('hidden-content scan passed');
    expect(result.stderr).toContain('Stage "hidden-content scan" exited before its process group settled; verified group exit.');
  });

  // #12833: a stage's exit status is its only verdict; a failing provisioning
  // command must never be recorded as `passed` in the receipt.
  it('records a stage that exits non-zero as failed and ends with its status', () => {
    write('scripts/scan-diff-hidden-content.js', "console.error('fixture provisioning failure'); process.exit(3);\n");
    const result = run('--skip-lint');
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('hidden-content scan failed after');
    expect(result.stdout).not.toContain('Pregate passed');
    const report = JSON.parse(readFileSync(join(root, PREGATE_REPORT_PATH), 'utf8'));
    expect(report.stages[0]).toMatchObject({ name: 'hidden-content scan', status: 'failed', exitCode: 3 });
  });

  it.skipIf(process.platform === 'win32')('reports a stage child signal as incomplete rather than an ordinary assertion failure', () => {
    write('scripts/scan-diff-hidden-content.js', "process.kill(process.pid, 'SIGTERM');\n");
    const result = run('--skip-lint');
    expect(result.status).toBe(143);
    expect(result.stderr).toMatch(/Pregate incomplete: stage="hidden-content scan" owner_pid=\d+ child_pid=\d+ child_signal=SIGTERM/);
    expect(result.stderr).not.toContain('failed — fix it');
    expect(result.stdout).not.toContain('Pregate passed');
  });

  it.skipIf(process.platform === 'win32')('reports a stage that cannot be spawned as failed with exit 1', () => {
    const preload = join(scratch, 'spawn-error.cjs');
    writeFileSync(preload, `
      const cp = require('child_process');
      const spawn = cp.spawn;
      cp.spawn = (command, args, options) => spawn('/nonexistent/pregate-fixture-binary', [], options);
    `);
    const result = spawnSync(process.execPath, ['--require', preload, 'scripts/pregate.js', '--base', base, '--skip-lint'], {
      cwd: root, encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/❌ hidden-content scan could not start: spawn \/nonexistent\/pregate-fixture-binary ENOENT/);
    expect(result.stdout).not.toContain('Pregate passed');
    const report = JSON.parse(readFileSync(join(root, PREGATE_REPORT_PATH), 'utf8'));
    expect(report.stages[0]).toMatchObject({ name: 'hidden-content scan', status: 'failed' });
  });

  it.skipIf(process.platform === 'win32')('reports a stage group that cannot be stopped as failed with exit 1', () => {
    const preload = join(scratch, 'unsettled-group.cjs');
    writeFileSync(preload, `
      const kill = process.kill.bind(process);
      process.kill = (pid, signal) => {
        if (pid < 0 && signal === 'SIGKILL') throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return kill(pid, signal);
      };
    `);
    const result = spawnSync(process.execPath, ['--require', preload, 'scripts/pregate.js', '--base', base, '--skip-lint'], {
      cwd: root, encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/❌ hidden-content scan left processes in its group that could not be stopped \(group kill failed \(EACCES\); pgid=\d+;/);
    expect(result.stdout).not.toContain('Pregate passed');
    const report = JSON.parse(readFileSync(join(root, PREGATE_REPORT_PATH), 'utf8'));
    expect(report.stages[0]).toMatchObject({ name: 'hidden-content scan', status: 'failed' });
  });

  it('passes clean uncommitted changes even when the plan selects no lint or tests', () => {
    git('config', 'core.autocrlf', 'true');
    write(trackedPath, `${clean}staged\n`);
    git('add', '--', trackedPath);
    write(trackedPath, `${clean}unstaged\n`);
    write('docs/new note.md', 'ordinary text\n');
    const before = snapshot();
    const result = run('--skip-lint');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Pregate passed: hidden-content scan.');
    expect(snapshot()).toEqual(before);
  });

  it('lists the mandatory scan in plan-only mode without scanning hidden content', () => {
    write('docs/new note.md', hidden);
    const before = snapshot();
    const result = run('--plan-only', '--skip-lint');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`hidden-content scan: node scripts/scan-diff-hidden-content.js --base ${base} --worktree`);
    expect(result.stdout).not.toContain('▶️');
    expect(result.stderr).toBe('');
    expect(snapshot()).toEqual(before);
  });

  it('leaves DB-only changes to hosted CI by default and plans portos_test only with explicit full validation', () => {
    mkdirSync(join(root, 'server/routes'), { recursive: true });
    write('server/routes/decks.db.test.js', "import { it } from 'vitest';\nit('db contract', () => {});\n");
    const focused = run('--plan-only');
    expect(focused.status, focused.stderr).toBe(0);
    expect(focused.stdout).toContain('CI will also run: db');
    expect(focused.stdout).not.toContain('• DB suite');
    const result = run('--plan-only', '--full');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('• DB provision (portos_test): npm run setup:db:test --prefix server');
    expect(result.stdout).toContain('• DB suite (portos_test): npm run test:db:ci --prefix server');
    expect(result.stdout).not.toContain('CI will also run: db');
    expect(result.stdout).not.toContain('FULL suite');

    const skipped = run('--plan-only', '--skip-db');
    expect(skipped.status, skipped.stderr).toBe(0);
    expect(skipped.stdout).toContain('CI will also run: db — not run here (skipped by --skip-db)');
    expect(skipped.stdout).not.toContain('DB suite (portos_test)');
  });

  it('writes a receipt whose tree hash matches a commit of the validated state', () => {
    write(trackedPath, `${clean}edited\n`);
    write('docs/new note.md', 'untracked addition\n');
    const result = run('--skip-lint');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Receipt: ${PREGATE_REPORT_PATH}`);
    const report = JSON.parse(readFileSync(join(root, PREGATE_REPORT_PATH), 'utf8'));
    expect(report.passed).toBe(true);
    expect(report.treeStable).toBe(true);
    expect(report.head.sha).toBe(git('rev-parse', 'HEAD'));
    expect(report.base.sha).toBe(base);
    expect(report.stages.map((stage) => [stage.name, stage.status])).toEqual([['hidden-content scan', 'passed']]);
    expect(report.stages[0]).not.toHaveProperty('env');
    expect(report.skipped).toEqual([]);
    expect(report.runtime).toMatchObject({ node: process.version, platform: process.platform });
    // The receipt itself is ignored, so committing exactly what was validated
    // reproduces the hashed tree.
    git('add', '--all');
    git('-c', 'user.name=Example Contributor', '-c', 'user.email=contributor@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'validated state');
    expect(git('rev-parse', 'HEAD^{tree}')).toBe(report.tree);
  });

  it('preserves binary, empty-file, and stdin-like path findings for untracked additions', () => {
    prepareWindowsInventory();
    const emptyPath = 'docs/empty\u200B.md';
    write(emptyPath, '');
    write('docs/payload.bin', Buffer.from([0, 1, 2]));
    write('-', hidden);
    const before = snapshot();
    const result = run('--skip-lint');
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(`${emptyPath}:1 — hidden-unicode: filename`);
    expect(result.stderr).toContain('docs/payload.bin:1 — opaque-binary:');
    expect(result.stderr).toContain('./-:2 — hidden-unicode:');
    expect(snapshot()).toEqual(before);
  });

  it('rejects a no-index read error even when Git reports the difference exit code', () => {
    // Git lists an untracked nested repository as a directory. Comparing that
    // path with /dev/null fails with exit 1 and no patch, rather than exit 2.
    git('init', '-q', 'docs/nested');
    write('docs/nested/example.md', clean);
    const result = run('--skip-lint');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Cannot read untracked diff for docs/nested/');
    expect(result.stdout).not.toContain('Pregate passed');
  });

  it('fails closed when Git cannot read a blob in the requested committed diff', () => {
    const blob = git('rev-parse', `HEAD:${trackedPath}`);
    write(trackedPath, `${clean}ordinary addition\n`);
    git('add', '--', trackedPath);
    git('commit', '-qm', 'changed fixture');
    rmSync(join(root, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    const result = run('--skip-lint');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Hidden-content scan failed:');
    expect(result.stdout).not.toContain('Pregate passed');
  });
});

describe('pregateWorkerEnv', () => {
  it('derives the budget from the CoS settings but honors an explicit handoff', () => {
    expect(pregateWorkerEnv({}).PORTOS_PREGATE_MAX_WORKERS).toBe(String(cosWorkerBudget()));
    expect(pregateWorkerEnv({ PORTOS_PREGATE_MAX_WORKERS: '2' }).PORTOS_PREGATE_MAX_WORKERS).toBe('2');
  });
});

describe('downgradeFullPlan', () => {
  it('replaces the full suite with the tracked always-run guards', () => {
    const serverGuards = ALWAYS_RUN_TESTS.slice(0, 3);
    const clientGuards = [
      'client/src/asyncEffectDisposalConventions.test.js',
      'client/src/fooConventions.test.js',
      'client/src/hooks/mountedRefConventions.test.js',
    ];
    const tracked = [...serverGuards, ...clientGuards,
      'client/src/App.test.jsx', 'client/src/fooConventions.js',
      'server/fooConventions.test.js',
    ];
    const downgraded = downgradeFullPlan(planWith({ full: true }), tracked);
    expect(downgraded.full).toBe(false);
    expect(downgraded.server).toEqual({ mode: 'files', files: serverGuards, sources: [] });
    expect(downgraded.client).toEqual({ mode: 'files', files: clientGuards, sources: [] });
    const stages = resolvePlanStages(downgraded);
    expect(stages.map((stage) => stage.name)).toContain('client tests');
    expect(stages.find((stage) => stage.name === 'client tests').env).toMatchObject({
      CI_TEST_MODE: 'files', CI_TEST_FILES: JSON.stringify(clientGuards), CI_TEST_SOURCES: '[]',
    });
  });

  it('drops a guard this checkout does not track, so Vitest is never given a missing path', () => {
    // A fork that deleted a guard, or a branch predating one, still has it in
    // ALWAYS_RUN_TESTS; passing that path to Vitest is an error, not a skip.
    const downgraded = downgradeFullPlan(planWith({ full: true }), []);
    expect(downgraded.server.files).toEqual([]);
  });

  it('keeps structural guards selected by a large diff when downgrading a full plan', () => {
    const tracked = [...ALWAYS_RUN_TESTS, 'server/lib/index.test.js'];
    const changedFiles = Array.from({ length: 31 }, (_, index) => `server/lib/module-${index}.js`);
    const downgraded = downgradeFullPlan(planWith({ full: true }), tracked, changedFiles);

    expect(downgraded.server.files).toContain('server/lib/index.test.js');
  });
});

describe('parseArgs', () => {
  it('reads --base as a value, not a boolean', () => {
    expect(parseArgs(['--base', 'origin/release', '--full'])).toEqual({
      ...DEFAULT_OPTIONS, base: 'origin/release', full: true,
    });
  });

  it('accepts guard-only merged validation and rejects combinations that can skip it', () => {
    expect(parseArgs(['--guards-only', '--merged-with', 'origin/main'])).toMatchObject({ guardsOnly: true, mergedWith: 'origin/main' });
    expect(() => parseArgs(['--merged-with', 'origin/main'])).toThrow('requires --guards-only');
    expect(() => parseArgs(['--guards-only', '--merged-with'])).toThrow('requires a value');
    expect(() => parseArgs(['--guards-only', '--full'])).toThrow('cannot be combined');
    expect(() => parseArgs(['--guards-only', '--skip-lint'])).toThrow('cannot be combined');
    expect(() => parseArgs(['--guards-only', '--merged-with', 'origin/main', '--base', 'HEAD'])).toThrow('cannot be combined');
  });

  it('accepts one skip flag per resource suite', () => {
    expect(parseArgs(['--skip-db', '--skip-browser', '--skip-build', '--skip-smoke'])).toEqual({
      ...DEFAULT_OPTIONS, skipDb: true, skipBrowser: true, skipBuild: true, skipSmoke: true,
    });
  });

  it('keeps the first --base when the option is repeated', () => {
    expect(parseArgs(['--base', 'origin/release', '--base', 'origin/main']).base).toBe('origin/release');
  });

  it('defaults to a null base so the caller resolves the remote default branch', () => {
    expect(parseArgs([])).toEqual(DEFAULT_OPTIONS);
  });

  it('recognizes both help flags and rejects unknown flags or a missing base value', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
    expect(() => parseArgs(['--unexpected'])).toThrow('Unknown option: --unexpected.');
    expect(() => parseArgs(['--base'])).toThrow('--base requires a value.');
    expect(() => parseArgs(['--base', '--full'])).toThrow('--base requires a value.');
  });
});

describe('unmergedIndexPaths', () => {
  it('returns each repo-relative path from NUL-delimited index stages', () => {
    expect(unmergedIndexPaths([
      '100644 abc 1\tconflict name.md',
      '100644 def 2\tconflict name.md',
      '100644 ghi 3\tother.md',
      '',
    ].join('\0')))
      .toEqual(['conflict name.md', 'other.md']);
  });
});

describe('UNCOVERED_SUITES', () => {
  /**
   * The gate reports these by reading `plan[key]`. A rename in ci-test-plan.js
   * would make every one of them read `undefined` — the warnings would just
   * stop appearing, and a DB-risk diff would leave here looking fully covered.
   */
  it('names plan fields the planner actually emits', () => {
    const plan = buildCiTestPlan([], { trackedFiles: BROWSER_SUITES, forceFull: true, forceFullReason: 'test' });
    Object.keys(UNCOVERED_SUITES).forEach((key) => {
      if (key === 'browser') {
        expect(Array.isArray(plan.browserFiles)).toBe(true);
        return;
      }
      expect(plan, `plan has no '${key}' field`).toHaveProperty(key);
      expect(typeof plan[key]).toBe('boolean');
    });
    const normalized = { ...plan, browser: { files: plan.browserFiles } };
    expect(Object.keys(UNCOVERED_SUITES).every((key) => suiteSelected(normalized, key))).toBe(true);
  });
});

describe('the gate end to end', () => {
  it.each([
    { args: ['--help'], status: 0, expected: 'Usage: node scripts/pregate.js', stderr: false },
    { args: ['-h'], status: 0, expected: 'Usage: node scripts/pregate.js', stderr: false },
    { args: ['--unknown'], status: 2, expected: 'Unknown option: --unknown.', stderr: true },
    { args: ['--base'], status: 2, expected: '--base requires a value.', stderr: true },
    { args: ['--base', '--full'], status: 2, expected: '--base requires a value.', stderr: true },
  ])('handles $args before starting any subprocess', ({ args, status, expected, stderr }) => {
    const preload = `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const unexpectedSubprocess = () => { throw new Error('Subprocess started before argument validation'); };
      childProcess.spawn = unexpectedSubprocess;
      childProcess.exec = unexpectedSubprocess;
      childProcess.execFile = unexpectedSubprocess;
      childProcess.fork = unexpectedSubprocess;
      childProcess.execSync = unexpectedSubprocess;
      childProcess.spawnSync = unexpectedSubprocess;
      childProcess.execFileSync = unexpectedSubprocess;
      syncBuiltinESMExports();
    `;
    const result = spawnSync(process.execPath, [
      '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
      join(REPO_ROOT, 'scripts', 'pregate.js'), ...args,
    ], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(status);
    expect(stderr ? result.stderr : result.stdout).toContain(expected);
    expect(`${result.stdout}\n${result.stderr}`).toContain('Usage: node scripts/pregate.js');
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('Subprocess started before argument validation');
    expect(result.stdout).not.toContain('Planning against');
  });

  // This catches validation deferred until after Git/planning, even when no
  // expensive check would run (plan-only). Every subprocess is a tripwire.
  it.each([{ flags: [] }, { flags: ['--full'] }, { flags: ['--plan-only'] }])('rejects unsupported Node before any subprocess with flags $flags', ({ flags }) => {
    const preload = `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      Object.defineProperty(process.versions, 'node', { value: '24.14.1' });
      const unexpectedSubprocess = () => { throw new Error('Subprocess started before runtime validation'); };
      childProcess.spawnSync = unexpectedSubprocess;
      childProcess.execFileSync = unexpectedSubprocess;
      syncBuiltinESMExports();
    `;
    const result = spawnSync(process.execPath, [
      '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
      join(REPO_ROOT, 'scripts', 'pregate.js'), ...flags,
    ], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('required (found v24.14.1)');
    expect(result.stderr).toContain('see .nvmrc');
    expect(result.stderr).not.toContain('Subprocess started');
    expect(result.stdout).toBe('');
  });

  it('refuses unsupported Git before planning or writing a receipt', () => {
    const receipt = join(REPO_ROOT, PREGATE_REPORT_PATH);
    const before = existsSync(receipt) ? readFileSync(receipt) : null;
    const preload = `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      childProcess.spawnSync = (command, args) => {
        if (command === 'git' && args.join(' ') === 'merge-tree -h') {
          return { status: 129, stdout: '--write-tree', stderr: 'private subprocess output' };
        }
        throw new Error('Unexpected subprocess after capability refusal');
      };
      syncBuiltinESMExports();
    `;
    const result = spawnSync(process.execPath, [
      '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
      join(REPO_ROOT, 'scripts', 'pregate.js'),
    ], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Install Git 2.40 or newer');
    expect(result.stderr).not.toContain('private subprocess output');
    expect(result.stderr).not.toContain('Unexpected subprocess');
    expect(result.stdout).not.toContain('Planning against');
    expect(existsSync(receipt) ? readFileSync(receipt) : null).toEqual(before);
  });

  it('passes an uncommitted new test through the planner override', () => {
    const root = mkdtempSync(join(tmpdir(), 'portos-pregate-'));
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const test = 'server/services/example/newBehavior.test.js';
    try {
      git('init', '-q');
      git('config', 'core.hooksPath', join(root, 'empty-hooks'));
      writeFileSync(join(root, 'README.md'), 'fixture\n');
      git('add', '--all');
      git('-c', 'user.name=Example Contributor', '-c', 'user.email=contributor@example.com',
        '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
      const base = git('rev-parse', 'HEAD');
      mkdirSync(dirname(join(root, test)), { recursive: true });
      writeFileSync(join(root, test), "import { it } from 'vitest';\nit('works', () => {});\n");

      const { changedFiles, workingTreeFiles } = collectPregateChangedFiles(base, { cwd: root });
      const inputs = collectPlanInputs({ baseSha: base, changedFiles, cwd: root });
      const plan = buildCiTestPlan(inputs.changedFiles, {
        trackedFiles: inputs.trackedFiles,
        appRouteOnly: false,
        pathContractTests: inputs.pathContractTests,
      });

      expect(workingTreeFiles).toContain(test);
      expect(plan.server.files).toContain(test);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a base this checkout cannot resolve instead of planning against nothing', () => {
    const run = () => execFileSync(
      process.execPath,
      [join(REPO_ROOT, 'scripts', 'pregate.js'), '--plan-only', '--base', 'origin/no-such-branch-for-tests'],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' },
    );
    // Exit 2, not 0: an unresolvable base is a broken invocation. Planning an
    // empty diff instead would report a green gate that checked nothing —
    // exactly the false green this whole script exists to prevent.
    expect(run).toThrow(/Cannot resolve a merge base/);
  });

  it('refuses an actual unresolved merge before planning or running checks', () => {
    const root = mkdtempSync(join(tmpdir(), 'portos-pregate-conflict-'));
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const run = () => spawnSync(process.execPath, [join(root, 'scripts', 'pregate.js'), '--plan-only', '--base', 'HEAD'], {
      cwd: root, encoding: 'utf8',
    });
    try {
      git('init', '-q', '-b', 'main');
      git('config', 'core.hooksPath', join(root, 'empty-hooks'));
      git('config', 'user.name', 'Example Contributor');
      git('config', 'user.email', 'contributor@example.com');
      for (const path of [
        'lib/gitMergeTree.js', 'scripts/pregate.js', 'scripts/checkNodeVersion.js', 'scripts/scan-diff-hidden-content.js',
        'scripts/ci-test-plan.js', 'scripts/ci-base-sha.js', 'server/lib/staticImportGraph.js',
        'scripts/lib/directInvocation.js', 'scripts/lib/importReach.js', 'scripts/lib/workspaceTests.js', 'scripts/lib/browserFidelity.js', 'scripts/lib/browserTestProfiles.js', 'scripts/lib/githubOutput.js', 'scripts/lib/dbTestFiles.js',
        'scripts/lib/browserSuites.js', 'scripts/lib/sourceTokens.js', 'scripts/lib/workspaceDependencies.js', 'scripts/lib/pregateReport.js', 'scripts/lib/cosWorkerBudget.js',
        'scripts/migrations/shippedPromptHistory.js', 'server/lib/aiToolkit/internal/windowsSafeSpawn.js',
        'server/lib/diffHiddenContentScan.js', 'server/lib/modelAbuseGuard.js',
        'server/lib/textUtils.js', 'server/lib/workspaceTestCacheRoots.js',
      ]) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        copyFileSync(join(REPO_ROOT, path), join(root, path));
      }
      writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
      writeFileSync(join(root, 'conflict.txt'), 'base\n');
      git('add', 'conflict.txt');
      git('commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD');
      git('checkout', '-qb', 'other');
      writeFileSync(join(root, 'conflict.txt'), 'other\n');
      git('commit', '-qam', 'other change');
      git('checkout', '-q', 'main');
      writeFileSync(join(root, 'conflict.txt'), 'main\n');
      git('commit', '-qam', 'main change');
      const merge = spawnSync('git', ['merge', 'other'], { cwd: root, encoding: 'utf8' });
      expect(merge.status).not.toBe(0);
      writeFileSync(join(root, 'staged.txt'), 'staged\n');
      git('add', 'staged.txt');
      writeFileSync(join(root, 'ordinary.txt'), 'unstaged\n');
      git('add', 'ordinary.txt');
      writeFileSync(join(root, 'ordinary.txt'), 'staged and unstaged\n');
      writeFileSync(join(root, 'untracked.txt'), 'untracked\n');

      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('unresolved Git conflicts:');
      expect(result.stderr).toContain('  conflict.txt');
      expect(result.stdout).not.toContain('Planning against');
      expect(result.stdout).not.toContain('Pregate passed');
      expect(git('--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'))
        .toContain('staged.txt');
      expect(git('rev-parse', 'HEAD')).not.toBe(base);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('describeBrowserSelection', () => {
  const selected = BROWSER_SUITES.slice(0, 10);
  const fidelity = BROWSER_FIDELITY_FILES[0];

  it('distinguishes no selection from a selection with fidelity cases', () => {
    expect(describeBrowserSelection([]).join('\n')).toContain('none selected');
    const some = describeBrowserSelection([fidelity, ...selected]).join('\n');
    expect(some).toContain('selected');
    expect(some).toContain('nightly and on the release PR');
    expect(describeBrowserSelection(selected.filter((file) => !BROWSER_FIDELITY_FILES.includes(file))).join('\n'))
      .not.toContain('Fidelity cases');
  });


});

describe('resource suite stages', () => {
  const fullPlan = planWith({
    lint: { mode: 'full', files: [] },
    client: { mode: 'files', files: ['client/src/App.test.jsx'], sources: [] },
    browser: { files: BROWSER_SUITES.slice(0, 2) },
    db: true, build: true, smoke: true, windows: true,
  });
  const databaseEnv = { PGDATABASE: TEST_DATABASE, TEST_DB_OK: undefined };

  it('orders every selected stage the way CI depends on them, DB suite last', () => {
    const stages = resolvePlanStages(fullPlan, { baseSha: 'base', databaseEnv });
    expect(stages.map((stage) => stage.name)).toEqual([
      'hidden-content scan', 'client/server lint', 'server tests', 'client tests',
      'client build', 'boot smoke', 'browser suites',
      'DB provision (portos_test)', 'DB suite (portos_test)',
    ]);
    expect(stages.map(describeStageCommand)).toEqual([
      'node scripts/scan-diff-hidden-content.js --base base --worktree',
      'node scripts/run-ci-lint.js',
      'node scripts/run-ci-tests.js server',
      'node scripts/run-ci-tests.js client',
      'npm run build --prefix client',
      'node scripts/smoke-boot.js',
      'node scripts/run-ci-tests.js server',
      'npm run setup:db:test --prefix server',
      'npm run test:db:ci --prefix server',
    ]);
  });

  it('gives the browser stage the exact env CI\'s browser job sets', () => {
    const browser = resolvePlanStages(fullPlan, { baseSha: 'base' }).find((stage) => stage.name === 'browser suites');
    expect(browser.env).toEqual({
      CI_TEST_MODE: 'files',
      CI_TEST_FILES: JSON.stringify(BROWSER_SUITES.slice(0, 2)),
      CI_TEST_SOURCES: '[]',
      PORTOS_BROWSER_TEST_PROFILE: 'smoke',
      PORTOS_REQUIRE_BROWSER_SUITES: '1',
      PORTOS_TEST_QUIET: '1',
      CI_BASE_SHA: 'base',
    });
  });

  it('hands both DB stages the pinned portos_test environment', () => {
    const dbStages = resolvePlanStages(fullPlan, { databaseEnv }).filter((stage) => stage.suite === 'db');
    expect(dbStages).toHaveLength(2);
    for (const stage of dbStages) {
      expect(stage.env).toBe(databaseEnv);
      expect(stage.npm).toContain('server');
    }
  });

  it('drops each skipped suite\'s stages and nothing else', () => {
    const names = (skip) => resolvePlanStages(fullPlan, { skip }).map((stage) => stage.suite);
    expect(names({ db: true })).not.toContain('db');
    expect(names({ browser: true })).not.toContain('browser');
    expect(names({ build: true })).not.toContain('build');
    expect(names({ smoke: true })).not.toContain('smoke');
    expect(names({ db: true, browser: true, build: true, smoke: true })).toEqual(['scan', 'lint', 'server', 'client']);
    expect(names({})).toEqual(['scan', 'lint', 'server', 'client', 'build', 'smoke', 'browser', 'db', 'db']);
  });

  it('plans no resource stage the planner did not select', () => {
    expect(resolvePlanStages(planWith(), { databaseEnv }).map((stage) => stage.suite)).toEqual(['scan', 'server']);
  });
});

describe('uncoveredSuites', () => {
  const selected = planWith({ browser: { files: [BROWSER_SUITES[0]] }, db: true, build: true, smoke: true, windows: true });

  it('reports only the CI-only jobs when every selected suite can run', () => {
    expect(uncoveredSuites(selected, { prerequisites: { db: { ok: true }, browser: { ok: true } } }))
      .toEqual([{ suite: 'windows', reason: 'a Windows runner has no local equivalent', remedy: UNCOVERED_SUITES.windows }]);
    expect(uncoveredSuites(planWith({ linuxContainment: true })))
      .toEqual([{ suite: 'linuxContainment', reason: 'needs a Linux host with bubblewrap namespaces', remedy: UNCOVERED_SUITES.linuxContainment }]);
    expect(uncoveredSuites(planWith({ supercolliderLive: true })))
      .toEqual([{ suite: 'supercolliderLive', reason: 'needs a native Linux Docker engine on amd64 and arm64', remedy: UNCOVERED_SUITES.supercolliderLive }]);
    expect(uncoveredSuites(planWith({ dockerContainmentLive: true })))
      .toEqual([{ suite: 'dockerContainmentLive', reason: 'needs a real Docker engine and pulls the pinned Node image', remedy: UNCOVERED_SUITES.dockerContainmentLive }]);
    expect(uncoveredSuites(planWith())).toEqual([]);
  });

  it('keeps a suite with CI for a flag, a downgraded full plan, or a failed probe — in that precedence', () => {
    const flagged = uncoveredSuites(selected, { options: { skipDb: true, skipBuild: true }, downgraded: true });
    expect(flagged.map(({ suite, reason }) => [suite, reason])).toEqual([
      ['build', 'skipped by --skip-build'],
      ['smoke', 'local focused mode; hosted CI runs it (opt in locally with --full)'],
      ['browser', 'local focused mode; hosted CI runs it (opt in locally with --full)'],
      ['db', 'skipped by --skip-db'],
      ['windows', 'a Windows runner has no local equivalent'],
    ]);
    const probed = uncoveredSuites(selected, {
      prerequisites: {
        db: { ok: false, reason: 'Postgres not reachable (ECONNREFUSED)' },
        browser: { ok: false, reason: 'missing ffmpeg' },
      },
    });
    expect(probed.map(({ suite, reason }) => [suite, reason])).toEqual([
      ['browser', 'prerequisite missing: missing ffmpeg'],
      ['db', 'prerequisite missing: Postgres not reachable (ECONNREFUSED)'],
      ['windows', 'a Windows runner has no local equivalent'],
    ]);
    expect(probed.find(({ suite }) => suite === 'db').remedy).toBe(UNCOVERED_SUITES.db);
  });

  it('reports a probe lifecycle failure apart from a missing prerequisite and keeps browser uncovered', () => {
    const probeFailed = uncoveredSuites(selected, {
      prerequisites: { browser: { ok: false, reason: 'Chrome with H.264 probe failed (teardown-failed)', category: 'probe-failed' } },
    }).find(({ suite }) => suite === 'browser');
    expect(probeFailed.reason).toBe('probe failed: Chrome with H.264 probe failed (teardown-failed)');
    expect(probeFailed.category).toBe('probe-failed');
    expect(probeFailed.remedy).not.toBe(UNCOVERED_SUITES.browser);
    expect(probeFailed.remedy).not.toMatch(/installed/);

    const missing = uncoveredSuites(selected, {
      prerequisites: { browser: { ok: false, reason: 'missing ffmpeg', category: 'missing' } },
    }).find(({ suite }) => suite === 'browser');
    expect(missing).toMatchObject({ reason: 'prerequisite missing: missing ffmpeg', category: 'missing', remedy: UNCOVERED_SUITES.browser });

    const skip = Object.fromEntries([probeFailed].map(({ suite }) => [suite, true]));
    expect(resolvePlanStages(selected, { skip }).some((stage) => stage.suite === 'browser')).toBe(false);
  });

  it('turns a failed probe into a skipped stage and a receipt that names it, never a green claim', () => {
    const prerequisites = { db: { ok: false, reason: 'Postgres not reachable (ECONNREFUSED)' } };
    const uncovered = uncoveredSuites(selected, { prerequisites, options: { skipBrowser: true, skipBuild: true, skipSmoke: true } });
    const skip = Object.fromEntries(uncovered.map(({ suite }) => [suite, true]));
    const stages = resolvePlanStages(selected, { skip });
    expect(stages.map((stage) => stage.suite)).toEqual(['scan', 'server']);
    const report = buildPregateReport({
      plan: selected, options: {}, base: { ref: 'origin/main', sha: 'b' }, head: { sha: 'h' }, tree: 't',
      stages: stages.map((stage) => ({ ...stage, command: describeStageCommand(stage), status: 'passed', durationMs: 1 })),
      skipped: uncovered, runtime: {}, startedAt: 's', finishedAt: 'f',
    });
    expect(report.passed).toBe(true);
    expect(report.skipped.map(({ suite }) => suite)).toEqual(['build', 'smoke', 'browser', 'db', 'windows']);
    expect(report.skipped.find(({ suite }) => suite === 'db').reason).toBe('prerequisite missing: Postgres not reachable (ECONNREFUSED)');
  });
});

describe('stageSpawnEnv', () => {
  it('applies stage values and removes the variables a stage sets to undefined', () => {
    const env = stageSpawnEnv({ TEST_DB_OK: '1', PGDATABASE: 'portos', KEEP: 'x' }, { TEST_DB_OK: undefined, PGDATABASE: 'portos_test' }, { ownsGroup: false });
    expect(env).toEqual({ KEEP: 'x', PGDATABASE: 'portos_test', PORTOS_PREGATE_MAX_WORKERS: String(cosWorkerBudget()) });
    expect('TEST_DB_OK' in env).toBe(false);
  });

  it('keeps the test runner\'s npm and Vitest inside the stage group pregate owns', () => {
    expect(stageSpawnEnv({}, {}, { ownsGroup: true }).PORTOS_CI_TEST_SUPERVISED_GROUP).toBe('1');
  });
});

describe('testDatabaseStageEnv', () => {
  it('pins both database names to portos_test and strips the escape hatch and libpq routing', () => {
    const env = testDatabaseStageEnv({
      env: { PGDATABASE: 'portos', PGTESTDATABASE: 'other_test', TEST_DB_OK: '1', PGHOSTADDR: '192.0.2.10', PGSERVICE: 'x' },
    });
    expect(env.PGDATABASE).toBe('portos_test');
    expect(env.PGTESTDATABASE).toBe('portos_test');
    expect(env.PORTOS_REQUIRE_DB).toBe('1');
    expect(env).toHaveProperty('TEST_DB_OK', undefined);
    expect(env).toHaveProperty('PGHOSTADDR', undefined);
    expect(env).toHaveProperty('PGSERVICE', undefined);
    expect(env).toHaveProperty('PGSERVICEFILE', undefined);
    expect(env).toHaveProperty('PGOPTIONS', undefined);
  });

  it('resolves the endpoint like setup-db.js: exported env, then the saved .env, then defaults', () => {
    expect(testDatabaseStageEnv({})).toMatchObject({ PGHOST: 'localhost', PGPORT: '5432', PGUSER: 'portos', PGPASSWORD: 'portos' });
    expect(testDatabaseStageEnv({ env: { PGPORT: '6543' }, saved: { PGPORT: '7000', PGHOST: 'db.example.com' } }))
      .toMatchObject({ PGHOST: 'db.example.com', PGPORT: '6543' });
    // A declared Docker mode selects the Docker port; an undeclared mode keeps
    // the native port the plain `npm run test:db` already connects to.
    expect(testDatabaseStageEnv({ saved: { PGMODE: 'docker' } }).PGPORT).toBe('5561');
    expect(testDatabaseStageEnv({ saved: { PGMODE: 'docker', PGPORT_DOCKER: '5599' } }).PGPORT).toBe('5599');
    expect(testDatabaseStageEnv({ saved: { PGMODE: 'native', PGPORT: '5433' } }).PGPORT).toBe('5433');
  });
});

describe('uncreatableExtensions', () => {
  it('flags a missing extension a non-superuser cannot create, and nothing else', () => {
    expect(uncreatableExtensions({ installed: ['pgcrypto'], trusted: [], superuser: false })).toEqual(['vector']);
    expect(uncreatableExtensions({ installed: [], trusted: ['vector', 'pgcrypto'], superuser: false })).toEqual([]);
    expect(uncreatableExtensions({ installed: ['vector', 'pgcrypto'], trusted: [], superuser: false })).toEqual([]);
    expect(uncreatableExtensions({ installed: [], trusted: [], superuser: true })).toEqual([]);
  });
});

describe('probeTestDatabase', () => {
  it('reports an unreachable server as a missing prerequisite without the endpoint in the reason', async () => {
    const { createServer } = await import('node:net');
    // Bind then close a port so nothing answers there.
    const port = await new Promise((resolve) => {
      const server = createServer();
      server.listen(0, '127.0.0.1', () => {
        const { port: bound } = server.address();
        server.close(() => resolve(bound));
      });
    });
    const result = await probeTestDatabase(
      { PGHOST: '127.0.0.1', PGPORT: String(port), PGUSER: 'portos', PGPASSWORD: 'portos' },
      { repoRoot: REPO_ROOT },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/^Postgres not reachable \(/);
    expect(result.reason).not.toContain(String(port));
    expect(result.endpoint).toBe(`127.0.0.1:${port}/portos_test`);
  });

  // A single pg connection queues overlapping queries (and pg@9 drops that), so the probe must await them in turn.
  const fakeClient = ({ installed = [], trusted = [], superuser = true }) => {
    let inFlight = false;
    const respond = (sql) => {
      if (sql.includes('pg_extension')) return { rows: installed.map((extname) => ({ extname })) };
      if (sql.includes('pg_available_extension_versions')) return { rows: trusted.map((name) => ({ name })) };
      if (sql.includes('pg_roles')) return { rows: [{ rolsuper: superuser }] };
      return { rows: [] };
    };
    return {
      connect: async () => {},
      end: async () => {},
      query(sql) {
        if (inFlight) throw new Error('overlapping query on one client');
        inFlight = true;
        return Promise.resolve().then(() => {
          inFlight = false;
          return respond(sql);
        });
      },
    };
  };
  const probeWith = (opts) => probeTestDatabase(
    { PGHOST: '127.0.0.1', PGPORT: '5432', PGUSER: 'portos', PGPASSWORD: 'portos' },
    { repoRoot: REPO_ROOT, createClient: () => fakeClient(opts) },
  );

  it('awaits its extension and role probes in turn on the single client', async () => {
    const result = await probeWith({ installed: ['vector', 'pgcrypto'] });
    expect(result).toEqual({ ok: true, endpoint: `127.0.0.1:5432/${TEST_DATABASE}`, provision: false });
  });

  it('still names a missing extension a non-superuser cannot create', async () => {
    const result = await probeWith({ installed: ['pgcrypto'], superuser: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/^Postgres extension\(s\) vector missing/);
  });
});

describe('buildPregateReport', () => {
  const stage = (name, status, extra = {}) => ({ name, suite: 'server', command: 'node scripts/x.js', status, durationMs: 5, env: { SECRET: 'no' }, ...extra });

  it('keeps stage outcomes and skips, drops stage env, and derives passed/treeStable', () => {
    const report = buildPregateReport({
      plan: planWith({ suiteReasons: { server: 'why' } }),
      options: { full: false },
      base: { ref: 'origin/main', sha: 'b' },
      head: { sha: 'h' },
      tree: 'tree-a',
      treeAfterRun: 'tree-b',
      stages: [stage('a', 'passed', { exitCode: 0 }), stage('b', 'failed', { exitCode: 1 }), stage('c', 'not-run')],
      skipped: [{ suite: 'windows', reason: 'no local equivalent', remedy: 'CI', extra: 'dropped' }],
      runtime: { node: 'v1', platform: 'linux', arch: 'x64', maxWorkers: '3' },
      startedAt: 's',
      finishedAt: 'f',
    });
    expect(report.version).toBe(3);
    expect(report.plan.downgraded).toBe(false);
    expect(report.passed).toBe(false);
    expect(report.treeStable).toBe(false);
    expect(report.stages).toEqual([
      { name: 'a', suite: 'server', command: 'node scripts/x.js', status: 'passed', durationMs: 5, exitCode: 0, signal: null },
      { name: 'b', suite: 'server', command: 'node scripts/x.js', status: 'failed', durationMs: 5, exitCode: 1, signal: null },
      { name: 'c', suite: 'server', command: 'node scripts/x.js', status: 'not-run', durationMs: 5, exitCode: null, signal: null },
    ]);
    expect(JSON.stringify(report)).not.toContain('SECRET');
    expect(report.skipped).toEqual([{ suite: 'windows', reason: 'no local equivalent', remedy: 'CI' }]);
    expect(report.plan.suiteReasons).toEqual({ server: 'why' });
    expect(report.plan.browser).toEqual({ files: [] });
    expect(report).toMatchObject({ base: { ref: 'origin/main', sha: 'b' }, head: { sha: 'h' }, tree: 'tree-a', treeAfterRun: 'tree-b', startedAt: 's', finishedAt: 'f' });
  });

  it('never passes an empty run and defaults the post-run tree to the validated one', () => {
    const report = buildPregateReport({
      plan: planWith(), options: {}, base: {}, head: {}, tree: 't', stages: [], skipped: [], runtime: {}, startedAt: 's', finishedAt: 'f',
    });
    expect(report.passed).toBe(false);
    expect(report.treeStable).toBe(true);
    expect(buildPregateReport({
      plan: planWith(), options: {}, base: {}, head: {}, tree: 't', stages: [], skipped: [], runtime: {}, startedAt: 's', finishedAt: 'f', downgraded: true,
    }).plan.downgraded).toBe(true);
  });
});

describe('validatedTreeHash', () => {
  it('hashes the working tree — modified, deleted, untracked, not ignored — exactly as a commit of it would', () => {
    const root = mkdtempSync(join(tmpdir(), 'portos-pregate-tree-'));
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    try {
      git('init', '-q');
      git('config', 'core.hooksPath', join(root, 'empty-hooks'));
      git('config', 'user.name', 'Example Contributor');
      git('config', 'user.email', 'contributor@example.com');
      git('config', 'commit.gpgsign', 'false');
      writeFileSync(join(root, '.gitignore'), '/.cache/\n*.log\n');
      writeFileSync(join(root, 'kept.txt'), 'kept\n');
      writeFileSync(join(root, 'edited.txt'), 'before\n');
      writeFileSync(join(root, 'removed.txt'), 'gone\n');
      git('add', '--all');
      git('commit', '-qm', 'base');
      const committedTree = git('rev-parse', 'HEAD^{tree}');

      writeFileSync(join(root, 'edited.txt'), 'after\n');
      rmSync(join(root, 'removed.txt'));
      mkdirSync(join(root, 'nested'));
      writeFileSync(join(root, 'nested', 'added.txt'), 'new\n');
      writeFileSync(join(root, 'noise.log'), 'ignored\n');
      mkdirSync(join(root, '.cache'));
      writeFileSync(join(root, '.cache', 'report.json'), '{}');
      const indexBefore = readFileSync(join(root, '.git', 'index'));
      const statusBefore = git('status', '--porcelain=v1', '--untracked-files=all');

      const hash = validatedTreeHash(root);

      expect(hash).not.toBe(committedTree);
      expect(readFileSync(join(root, '.git', 'index'))).toEqual(indexBefore);
      expect(git('status', '--porcelain=v1', '--untracked-files=all')).toBe(statusBefore);
      expect(validatedTreeHash(root)).toBe(hash);

      git('add', '--all');
      git('commit', '-qm', 'validated state');
      expect(git('rev-parse', 'HEAD^{tree}')).toBe(hash);
      expect(git('ls-tree', '-r', '--name-only', 'HEAD').split('\n')).toEqual(['.gitignore', 'edited.txt', 'kept.txt', 'nested/added.txt']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('focused local policy', () => {
  it('runs direct behavior owners and edited unit tests without transitive or resource suites', () => {
    const tracked = ['server/lib/a.js', 'server/lib/a.test.js', 'server/lib/unrelated.test.js', 'server/lib/a.db.test.js', 'server/lib/a.browser.test.js', 'client/src/Card.jsx', 'client/src/Card.test.jsx', 'scripts/tool.test.js', 'server/services/htmlComposition/index.test.js'];
    const changed = ['server/lib/a.js', 'client/src/Card.jsx', 'scripts/tool.test.js', 'server/lib/a.db.test.js', 'server/lib/a.browser.test.js', 'docs/README.md', 'server/services/htmlComposition/index.test.js'];
    const local = focusedLocalPlan(planWith({ browser: { files: ['server/services/htmlComposition/index.test.js'] }, server: { mode: 'related', files: ['server/lib/unrelated.test.js'], sources: ['server/lib/a.js'] } }), tracked, changed);
    expect(local.server).toEqual({ mode: 'files', files: ['server/lib/a.test.js', 'scripts/tool.test.js'], sources: [] });
    expect(local.client.files).toContain('client/src/Card.test.jsx');
    expect(resolvePlanStages(local, { skip: { db: true, browser: true, build: true, smoke: true } }).every(stage => !['db', 'browser', 'build', 'smoke'].includes(stage.suite))).toBe(true);
  });
});
