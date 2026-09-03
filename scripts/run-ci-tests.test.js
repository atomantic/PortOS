import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  recordVitestDuration,
  relatedInputs,
  requiresSourceFiles,
  shardArgs,
  toRunnerPath,
} from './run-ci-tests.js';
import { workflowJobs } from './lib/workflowJobs.js';

const WORKFLOW = readFileSync(join(import.meta.dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');

describe('shardArgs', () => {
  it('passes a slice selector only when the matrix actually split the suite', () => {
    expect(shardArgs(undefined)).toEqual([]);
    expect(shardArgs('')).toEqual([]);
    expect(shardArgs('1/1')).toEqual([]);
    expect(shardArgs('2/3')).toEqual(['--shard=2/3']);
    expect(() => shardArgs('2')).toThrow(/<index>\/<count>/);
  });
});

describe('ci.yml shard wiring', () => {
  const runners = Object.entries(workflowJobs(WORKFLOW)).filter(([, body]) => body.includes('run-ci-tests.js'));

  it('builds every test runner matrix from the planner and hands each slice to the runner', () => {
    expect(runners.map(([id]) => id).sort()).toEqual(['client', 'server', 'windows-server']);
    for (const [id, body] of runners) {
      // The fan-out is decided by the impact job, never hardcoded here: a
      // scoped plan must collapse to one runner, and a job-level `if` cannot
      // read `matrix` to skip the extra shards itself.
      expect(body, id).toMatch(/shard: \$\{\{ fromJSON\(needs\.impact\.outputs\.\w+_shards\) \}\}/);
      expect(body, id).toContain('CI_SHARD: ${{ matrix.shard }}/${{ strategy.job-total }}');
      // Shards race to save one immutable cache entry; without the shard in
      // the key the winner's 1/n of the transform artifacts is all that persists.
      expect(body, id).toMatch(/key: vitest-\w+-\$\{\{ runner\.os \}\}-\$\{\{ hashFiles\([^)]*\) \}\}-\$\{\{ matrix\.shard \}\}of\$\{\{ strategy\.job-total \}\}/);
    }
  });

  it('runs once-only steps on the first shard alone', () => {
    // Smoke boot, lint, the production build, and the bundle budget are not
    // sharded work; on every shard they would triple the cost for no coverage.
    for (const step of ['Smoke-boot server', 'Lint client', 'Build client', 'Check API Explorer bundle budget']) {
      const start = WORKFLOW.indexOf(`- name: ${step}\n`);
      expect(start, step).toBeGreaterThan(0);
      const condition = WORKFLOW.slice(start).match(/\n {8}if: (.*)\n/)[1];
      expect(condition, step).toMatch(/&& matrix\.shard == 1$/);
    }
  });
});

describe('toRunnerPath', () => {
  it('maps repo paths onto each workspace runner root', () => {
    expect(toRunnerPath('client', 'client/src/lib/index.test.js')).toBe('./src/lib/index.test.js');
    expect(toRunnerPath('server', 'server/lib/index.test.js')).toBe('./lib/index.test.js');
    expect(toRunnerPath('server', 'scripts/checkNodeVersion.test.js')).toBe('../scripts/checkNodeVersion.test.js');
  });
});

describe('recordVitestDuration', () => {
  const originalSummary = process.env.GITHUB_STEP_SUMMARY;
  let summaryDir;

  afterEach(() => {
    if (originalSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = originalSummary;
    if (summaryDir) {
      rmSync(summaryDir, { recursive: true, force: true });
      summaryDir = undefined;
    }
  });

  it('writes wall time to the GitHub step summary when one is configured', () => {
    summaryDir = mkdtempSync(join(tmpdir(), 'vitest-duration-'));
    const summaryPath = join(summaryDir, 'summary.md');
    process.env.GITHUB_STEP_SUMMARY = summaryPath;
    recordVitestDuration('server', 'full suite', Date.now() - 1500);
    expect(readFileSync(summaryPath, 'utf8')).toMatch(/^⏱ server full suite: 1\.\ds\n$/);
  });
});

describe('requiresSourceFiles', () => {
  it('fails closed only when related mode has no source selector', () => {
    expect(requiresSourceFiles('related', [])).toBe(true);
    expect(requiresSourceFiles('related', ['server/services/auth.js'])).toBe(false);
    expect(requiresSourceFiles('files', [])).toBe(false);
    expect(requiresSourceFiles('full', [])).toBe(false);
  });
});

describe('relatedInputs', () => {
  it('runs source-related tests and explicit guards in one deduplicated invocation', () => {
    expect(relatedInputs(
      ['./services/auth.js', './services/auth.test.js'],
      ['./services/auth.test.js', '../scripts/repo-scan-guards.test.js'],
    )).toEqual([
      './services/auth.js',
      './services/auth.test.js',
      '../scripts/repo-scan-guards.test.js',
    ]);
  });
});
