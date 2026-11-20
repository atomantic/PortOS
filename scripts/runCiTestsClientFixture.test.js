// Real-tree half of the run-ci-tests contract: it plans over this repository's own client
// test dependency graph, so a client edit can break it with no import edge into the runner.
// It stays out of TOOLING_TESTS (scripts/ci-test-plan.js) and is selected by the memo walk as
// before; run-ci-tests.test.js keeps the fixture-only cases.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { expect, it } from 'vitest';

import { buildCiTestPlan, collectPlanInputs } from './ci-test-plan.js';
import { REPORTING_NPM, installFakeNpm } from './lib/fakeNpmFixture.js';
import { toWorkspacePath } from './lib/workspaceTests.js';

it('hands only real client fixture consumers to Vitest for a shared browser cleanup change', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'portos-client-helper-selection-'));
  try {
    installFakeNpm(fixture, REPORTING_NPM);
    const unused = 'scripts/lib/releaseTitle.js';
    const source = 'scripts/lib/ownedBrowserCleanup.js';
    // One whole-repository walk for both plans: the collected maps are keyed per
    // source/test/suite, so each single-source plan reads only its own entries.
    const inputs = collectPlanInputs({ baseSha: 'HEAD', changedFiles: [unused, source], cwd: join(import.meta.dirname, '..') });
    expect(buildCiTestPlan([unused], inputs)).toMatchObject({
      full: false, build: false, client: { mode: 'skip', files: [] },
    });
    const plan = buildCiTestPlan([source], inputs);
    expect(plan.full).toBe(false);
    expect(plan.build).toBe(false);
    expect(plan.server.mode).toBe('related');
    expect(plan.server.sources).toContain(source);
    expect(plan.browserFiles.length).toBeGreaterThan(0);
    expect(plan.client.mode).toBe('files');
    // Real comment-heavy consumers and fixture templates must resolve without
    // retaining hundreds of unrelated files in the actual runner handoff.
    for (const test of ['client/src/components/sprites/WalkWorkflow.test.jsx', 'client/src/components/sprites/TrackWorkflow.test.jsx',
      'client/src/services/apiRounds.test.js', 'client/src/a11y/controlNames.conventions.test.js']) {
      expect(inputs.clientTestDependencies[test], test).toEqual(expect.any(Array));
      expect(plan.client.files, test).not.toContain(test);
    }
    const result = spawnSync(process.execPath, [join(import.meta.dirname, 'run-ci-tests.js'), 'client'], {
      encoding: 'utf8', timeout: 120000,
      env: { ...process.env, PATH: `${fixture}${delimiter}${process.env.PATH}`,
        CI_TEST_MODE: plan.client.mode, CI_SHARD: '', PORTOS_TEST_MEMO: 'off',
        CI_TEST_SOURCES: JSON.stringify(plan.client.sources), CI_TEST_FILES: JSON.stringify(plan.client.files),
        GITHUB_ENV: '', GITHUB_STEP_SUMMARY: '' },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const { selection } = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('{"args"')));
    expect(selection.include).toEqual(expect.arrayContaining([
      'src/test/browserFixture.test.js',
      'src/components/ThemeSwitcher.browser.test.js',
      'src/components/goals/GoalsTreeView.browser.test.js',
      'src/components/ui/OverflowMenu.browser.test.js',
    ]));
    expect(selection.include.sort()).toEqual(plan.client.files.map(file => toWorkspacePath('client', file)).sort());
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}, 150_000);
