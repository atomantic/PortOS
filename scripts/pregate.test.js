/**
 * Contract for the local pre-push gate (`npm run pregate`).
 *
 * The value of this gate is that it runs exactly what CI runs, so the failures
 * worth pinning are the ones where it would quietly diverge: handing a runner a
 * scope CI skipped (or skipping one CI selected), passing the wrong selector
 * list, naming a downgraded test file that is not tracked, or reporting
 * "CI will also run: db" from a plan field that has since been renamed.
 */
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
} from './ci-test-plan.js';
import {
  collectPregateChangedFiles,
  resolvePlanStages,
  describeBrowserSelection,
  describeStageCommand,
  downgradeFullPlan,
  parseArgs,
  pregateWorkerEnv,
  stageSpawnEnv,
  suiteSelected,
  uncoveredSuites,
  UNCOVERED_SUITES,
  unmergedIndexPaths,
} from './pregate.js';
import { buildPregateReport, PREGATE_REPORT_PATH, validatedTreeHash } from './lib/pregateReport.js';
import { probeTestDatabase, TEST_DATABASE, testDatabaseStageEnv } from './lib/pregateResources.js';

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
  ...overrides,
});

const DEFAULT_OPTIONS = {
  base: null, full: false, skipLint: false, planOnly: false, help: false,
  skipDb: false, skipBrowser: false, skipBuild: false, skipSmoke: false,
};

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
    // No runners or test files: docs-only changes produce an empty test plan.
    for (const path of [
      'scripts/pregate.js', 'scripts/checkNodeVersion.js', 'scripts/scan-diff-hidden-content.js',
      'scripts/ci-test-plan.js', 'scripts/ci-base-sha.js', 'server/lib/staticImportGraph.js',
      'scripts/lib/directInvocation.js', 'scripts/lib/importReach.js', 'scripts/lib/workspaceTests.js', 'scripts/lib/browserFidelity.js', 'scripts/lib/browserTestProfiles.js', 'scripts/lib/githubOutput.js', 'scripts/lib/dbTestFiles.js',
      'scripts/lib/browserSuites.js', 'scripts/lib/workspaceDependencies.js', 'scripts/lib/pregateReport.js', 'scripts/lib/pregateAttestation.js',
      'scripts/migrations/shippedPromptHistory.js', 'server/lib/aiToolkit/internal/windowsSafeSpawn.js',
      'server/lib/diffHiddenContentScan.js', 'server/lib/modelAbuseGuard.js',
      'server/lib/textUtils.js',
    ]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      copyFileSync(join(REPO_ROOT, path), join(root, path));
    }
    write('package.json', '{"type":"module","scripts":{"pregate":"node scripts/pregate.js"}}\n');
    // The receipt lands under /.cache/, which the real repository ignores too.
    write('.gitignore', 'node_modules\n/.cache/\n');
    for (const workspace of ['', 'client', 'server', 'autofixer']) {
      mkdirSync(join(root, workspace, 'node_modules'), { recursive: true });
      write(join(workspace, 'package-lock.json'), JSON.stringify({ packages: { '': {} } }));
    }
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
  });

  afterEach(async () => {
    await destroyGitSandbox(scratch);
  });

  afterAll(async () => {
    if (template?.scratch) await destroyGitSandbox(template.scratch);
  });

  // This regression catches stale inherited packages before any lint/test child
  // can produce a misleading product failure or repair the shared source tree.
  it.each(['matching', 'stale', 'missing-package', 'unreadable-package', 'dangling'])(
    'checks %s linked dependencies read-only before executing stages', (state) => {
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
      symlinkSync(target, modules, process.platform === 'win32' ? 'junction' : 'dir');
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
        expect(result.stderr).toContain('server (linked node_modules)');
        expect(result.stderr).toContain('owning source checkout');
        expect(result.stderr).toContain('Never run npm install/ci through worktree links');
        const diagnostic = {
          stale: 'expected 5.3.0, installed 5.2.1',
          'missing-package': 'missing package.json (ENOENT)',
          'unreadable-package': 'unreadable package.json (invalid JSON)',
          dangling: 'linked target unavailable',
        }[state];
        expect(result.stderr).toContain(diagnostic);
        expect(existsSync(join(root, 'unexpected-stage'))).toBe(false);
      }
      expect(lstatSync(modules).isSymbolicLink()).toBe(true);
      expect(sourceSnapshot()).toEqual(before);
      expect(existsSync(join(root, 'unexpected-npm'))).toBe(false);
      expect(readFileSync(sourceReceipt, 'utf8')).toBe('{"server":"legacy"}');
      if (state === 'dangling') expect(existsSync(target)).toBe(false);
    },
  );

  it('diagnoses a production-only install before spawning development checks', () => {
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

  // #12641: a Ctrl-C reaches pregate from the terminal group AND from npm's
  // forwarding; the duplicate used to kill pregate before it signalled the
  // stage, orphaning the runner. The fixture stage mirrors run-ci-tests.js: a
  // launcher that settles its own separately grouped child on a signal, plus
  // an in-group descendant that ignores signals and keeps writing.
  it.skipIf(process.platform === 'win32').each(['SIGINT', 'SIGTERM'])('settles every owned stage process before a %s through npm finishes', async (signal) => {
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
        console.log('fixture-stage-ready ' + JSON.stringify([process.pid, straggler.pid, launched.pid]));
      }, 10);
      setInterval(() => {}, 1000);
    `);
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
    const npm = spawn('npm', ['run', 'pregate', '--', '--base', base, '--skip-lint'], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, FIXTURE_HEARTBEAT: heartbeat },
    });
    const alive = (pid) => {
      try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
    };
    let owned = [];
    let stdout = '';
    let stderr = '';
    npm.stderr.on('data', (data) => { stderr += data; });
    npm.stdout.on('data', (data) => {
      stdout += data;
      const ready = /fixture-stage-ready (\[[\d,]+\])/.exec(stdout);
      if (ready && owned.length === 0) {
        owned = JSON.parse(ready[1]);
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
      // Liveness at `exit` is the contract. Output is read after `close`, which
      // a surviving descendant holding the pipes would delay, hence the bound.
      expect(owned).toHaveLength(3);
      expect(owned.filter(alive)).toEqual([]);
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5000))]);
      expect(result.status === null ? result.signal : result.status).not.toBe(0);
      expect(stderr).toMatch(new RegExp(`stage="hidden-content scan" owner_pid=\\d+ child_pid=${owned[0]} received_signal=${signal}`));
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
      for (const pid of [npm.pid, unrelated.pid, ...owned]) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* not a live group */ }
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
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
    expect(result.stderr).toContain('Stage "hidden-content scan" exited with processes still running in its group; killed them.');
  });

  it.skipIf(process.platform === 'win32')('reports a stage child signal as incomplete rather than an ordinary assertion failure', () => {
    write('scripts/scan-diff-hidden-content.js', "process.kill(process.pid, 'SIGTERM');\n");
    const result = run('--skip-lint');
    expect(result.status).toBe(143);
    expect(result.stderr).toMatch(/Pregate incomplete: stage="hidden-content scan" owner_pid=\d+ child_pid=\d+ child_signal=SIGTERM/);
    expect(result.stderr).not.toContain('failed — fix it');
    expect(result.stdout).not.toContain('Pregate passed');
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

  it('plans the portos_test stages for a DB-only suite in a scoped working-tree plan', () => {
    mkdirSync(join(root, 'server/routes'), { recursive: true });
    write('server/routes/decks.db.test.js', "import { it } from 'vitest';\nit('db contract', () => {});\n");
    const result = run('--plan-only');
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
  it('bounds workers by default but honors an operator budget', () => {
    expect(pregateWorkerEnv({}).PORTOS_PREGATE_MAX_WORKERS).toBe('4');
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

  // `--base HEAD` rather than the default remote branch: CI clones at depth 2
  // with no `origin/main` ref, so the default would abort here on a fetch the
  // gate is right to demand of a human and wrong to demand of this test. HEAD
  // is its own merge base in any checkout, and the run still exercises every
  // stage — argument parsing, merge-base resolution, spawning the real planner,
  // mapping its plan to stages — on an empty diff.
  it('plans this checkout and names its stages without running them', () => {
    const output = execFileSync(
      process.execPath,
      [join(REPO_ROOT, 'scripts', 'pregate.js'), '--plan-only', '--base', 'HEAD'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    expect(output).toMatch(/Planning against HEAD/);
    expect(output).toMatch(/changed file/);
    // An empty diff still selects the always-run guards, so the gate must name
    // real work rather than reporting there is nothing to do.
    expect(output).toMatch(/server tests/);
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
        'scripts/pregate.js', 'scripts/checkNodeVersion.js', 'scripts/scan-diff-hidden-content.js',
        'scripts/ci-test-plan.js', 'scripts/ci-base-sha.js', 'server/lib/staticImportGraph.js',
        'scripts/lib/directInvocation.js', 'scripts/lib/importReach.js', 'scripts/lib/workspaceTests.js', 'scripts/lib/browserFidelity.js', 'scripts/lib/browserTestProfiles.js', 'scripts/lib/githubOutput.js', 'scripts/lib/dbTestFiles.js',
        'scripts/lib/browserSuites.js', 'scripts/lib/workspaceDependencies.js', 'scripts/lib/pregateReport.js', 'scripts/lib/pregateAttestation.js',
        'scripts/migrations/shippedPromptHistory.js', 'server/lib/aiToolkit/internal/windowsSafeSpawn.js',
        'server/lib/diffHiddenContentScan.js', 'server/lib/modelAbuseGuard.js',
        'server/lib/textUtils.js',
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

  it('shows the selection in --plan-only output', () => {
    const out = execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', 'pregate.js'), '--plan-only', '--skip-lint', '--base', 'HEAD'], {
      cwd: REPO_ROOT, encoding: 'utf8',
    });
    expect(out).toContain('Browser suites:');
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
      'client build', 'API Explorer bundle pin', 'boot smoke', 'browser suites',
      'DB provision (portos_test)', 'DB suite (portos_test)',
    ]);
    expect(stages.map(describeStageCommand)).toEqual([
      'node scripts/scan-diff-hidden-content.js --base base --worktree',
      'node scripts/run-ci-lint.js',
      'node scripts/run-ci-tests.js server',
      'node scripts/run-ci-tests.js client',
      'npm run build --prefix client',
      'npm run test --prefix client -- ApiExplorer.bundle',
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
    expect(names({})).toEqual(['scan', 'lint', 'server', 'client', 'build', 'build', 'smoke', 'browser', 'db', 'db']);
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
    expect(uncoveredSuites(planWith())).toEqual([]);
  });

  it('keeps a suite with CI for a flag, a downgraded full plan, or a failed probe — in that precedence', () => {
    const flagged = uncoveredSuites(selected, { options: { skipDb: true, skipBuild: true }, downgraded: true });
    expect(flagged.map(({ suite, reason }) => [suite, reason])).toEqual([
      ['build', 'skipped by --skip-build'],
      ['smoke', 'full plan downgraded; pass --full to run it'],
      ['browser', 'full plan downgraded; pass --full to run it'],
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
    expect(env).toEqual({ KEEP: 'x', PGDATABASE: 'portos_test', PORTOS_PREGATE_MAX_WORKERS: '4' });
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
    expect(report.version).toBe(2);
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
