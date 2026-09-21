/**
 * Contract for the local pre-push gate (`npm run pregate`).
 *
 * The value of this gate is that it runs exactly what CI runs, so the failures
 * worth pinning are the ones where it would quietly diverge: handing a runner a
 * scope CI skipped (or skipping one CI selected), passing the wrong selector
 * list, naming a downgraded test file that is not tracked, or reporting
 * "CI will also run: db" from a plan field that has since been renamed.
 */
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
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
  downgradeFullPlan,
  parseArgs,
  UNCOVERED_SUITES,
} from './pregate.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const planWith = (overrides = {}) => ({
  full: false,
  reason: 'test plan',
  server: { mode: 'files', files: ['server/lib/a.test.js'], sources: [] },
  client: { mode: 'skip', files: [], sources: [] },
  lint: { mode: 'skip', files: [] },
  db: false,
  windows: false,
  build: false,
  smoke: false,
  ...overrides,
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
    expect(stages.map((stage) => stage.name)).toEqual(['hidden-content scan', 'client lint', 'server tests', 'client tests']);
    expect(stages[0]).toEqual({
      name: 'hidden-content scan', script: 'scan-diff-hidden-content.js',
      args: ['--base', 'resolved-base', '--worktree'], env: {},
    });
    expect(stages[1].env).toEqual({ CI_LINT_MODE: 'files', CI_LINT_FILES: '["client/src/App.jsx"]' });
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
  const trackedPath = 'docs/tracked note.md';
  const clean = '# Example\n';
  const hidden = `${clean}hidden: \u200B\n`;
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const write = (path, content) => writeFileSync(join(root, path), content);
  const run = (...args) => spawnSync(process.execPath, ['scripts/pregate.js', '--base', base, ...args], {
    cwd: root, encoding: 'utf8',
  });
  const snapshot = () => ({
    status: git('--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
    index: readFileSync(join(root, '.git', 'index')),
  });

  beforeEach(async () => {
    ({ scratch, repo: root } = await makeGitSandbox({ prefix: 'portos-pregate-cli-' }));
    git('config', 'core.hooksPath', join(scratch, 'empty-hooks'));
    // Copy the real builtin-only entrypoints so REPO_ROOT targets this fixture.
    // No runners or test files: docs-only changes produce an empty test plan.
    for (const path of [
      'scripts/pregate.js', 'scripts/scan-diff-hidden-content.js',
      'scripts/ci-test-plan.js', 'scripts/ci-base-sha.js',
      'scripts/lib/directInvocation.js', 'scripts/lib/githubOutput.js',
      'server/lib/diffHiddenContentScan.js', 'server/lib/modelAbuseGuard.js',
      'server/lib/textUtils.js',
    ]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      copyFileSync(join(REPO_ROOT, path), join(root, path));
    }
    write('package.json', '{"type":"module"}\n');
    mkdirSync(join(root, 'docs'));
    write(trackedPath, clean);
    git('add', '--all');
    git('commit', '-qm', 'pregate fixture');
    base = git('rev-parse', 'HEAD');
  });

  afterEach(async () => {
    await destroyGitSandbox(scratch);
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

  it('passes clean uncommitted changes even when the plan selects no lint or tests', () => {
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
    expect(result.stdout).toContain(`hidden-content scan: scan-diff-hidden-content.js --base ${base} --worktree`);
    expect(result.stdout).not.toContain('▶️');
    expect(result.stderr).toBe('');
    expect(snapshot()).toEqual(before);
  });

  it('preserves binary and empty-file path findings for untracked additions', () => {
    const emptyPath = 'docs/empty\u200B.md';
    write(emptyPath, '');
    write('docs/payload.bin', Buffer.from([0, 1, 2]));
    const before = snapshot();
    const result = run('--skip-lint');
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(`${emptyPath}:1 — hidden-unicode: filename`);
    expect(result.stderr).toContain('docs/payload.bin:1 — opaque-binary:');
    expect(snapshot()).toEqual(before);
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

describe('downgradeFullPlan', () => {
  it('replaces the full suite with the tracked always-run guards', () => {
    const tracked = ALWAYS_RUN_TESTS.slice(0, 3);
    const downgraded = downgradeFullPlan(planWith({ full: true }), tracked);
    expect(downgraded.full).toBe(false);
    expect(downgraded.server).toEqual({ mode: 'files', files: tracked, sources: [] });
    expect(downgraded.client.mode).toBe('skip');
  });

  it('drops a guard this checkout does not track, so Vitest is never given a missing path', () => {
    // A fork that deleted a guard, or a branch predating one, still has it in
    // ALWAYS_RUN_TESTS; passing that path to Vitest is an error, not a skip.
    const downgraded = downgradeFullPlan(planWith({ full: true }), []);
    expect(downgraded.server.files).toEqual([]);
  });
});

describe('parseArgs', () => {
  it('reads --base as a value, not a boolean', () => {
    expect(parseArgs(['--base', 'origin/release', '--full'])).toEqual({
      base: 'origin/release', full: true, skipLint: false, planOnly: false,
    });
  });

  it('defaults to a null base so the caller resolves the remote default branch', () => {
    expect(parseArgs([])).toEqual({ base: null, full: false, skipLint: false, planOnly: false });
  });
});

describe('UNCOVERED_SUITES', () => {
  /**
   * The gate reports these by reading `plan[key]`. A rename in ci-test-plan.js
   * would make every one of them read `undefined` — the warnings would just
   * stop appearing, and a DB-risk diff would leave here looking fully covered.
   */
  it('names plan fields the planner actually emits', () => {
    const plan = buildCiTestPlan([], { trackedFiles: [], forceFull: true, forceFullReason: 'test' });
    Object.keys(UNCOVERED_SUITES).forEach((key) => {
      expect(plan, `plan has no '${key}' field`).toHaveProperty(key);
      expect(typeof plan[key]).toBe('boolean');
    });
  });
});

describe('the gate end to end', () => {
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
});
