/**
 * Contract for the local pre-push gate (`npm run pregate`).
 *
 * The value of this gate is that it runs exactly what CI runs, so the failures
 * worth pinning are the ones where it would quietly diverge: handing a runner a
 * scope CI skipped (or skipping one CI selected), passing the wrong selector
 * list, naming a downgraded test file that is not tracked, or reporting
 * "CI will also run: db" from a plan field that has since been renamed.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { buildCiTestPlan, ALWAYS_RUN_TESTS } from './ci-test-plan.js';
import { resolvePlanStages, downgradeFullPlan, parseArgs, UNCOVERED_SUITES } from './pregate.js';

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
    expect(stages.map((stage) => stage.name)).toEqual(['server tests']);
  });

  it('hands each runner the plan\'s own selector lists', () => {
    const [stage] = resolvePlanStages(planWith({
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

  it('puts lint first, so the one-second verdict is not queued behind Vitest', () => {
    const stages = resolvePlanStages(planWith({
      lint: { mode: 'files', files: ['client/src/App.jsx'] },
      client: { mode: 'files', files: ['client/src/App.test.jsx'], sources: [] },
    }));
    expect(stages.map((stage) => stage.name)).toEqual(['client lint', 'server tests', 'client tests']);
    expect(stages[0].env).toEqual({ CI_LINT_MODE: 'files', CI_LINT_FILES: '["client/src/App.jsx"]' });
  });

  it('drops the lint stage under --skip-lint but keeps the test stages', () => {
    const stages = resolvePlanStages(
      planWith({ lint: { mode: 'files', files: ['client/src/App.jsx'] } }),
      { skipLint: true },
    );
    expect(stages.map((stage) => stage.name)).toEqual(['server tests']);
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
  it('plans this checkout and names its stages without running them', () => {
    const output = execFileSync(
      process.execPath,
      [join(REPO_ROOT, 'scripts', 'pregate.js'), '--plan-only'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    expect(output).toMatch(/Planning against /);
    expect(output).toMatch(/changed file\(s\)/);
  });
});
