import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  structuredFailureDiagnostics,
  extractCrashedTestFile,
  hasOtherTestFailures,
  planCrashRetry,
  recordVitestDuration,
  relatedInputs,
  repoRelativeFromCrashPath,
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
    // Smoke boot, the production build, and the Scalar-removal pin are not
    // sharded work; on every shard they would triple the cost for no coverage.
    for (const step of ['Smoke-boot server', 'Build client', 'Check API Explorer bundle has no Scalar chunks']) {
      const start = WORKFLOW.indexOf(`- name: ${step}\n`);
      expect(start, step).toBeGreaterThan(0);
      const condition = WORKFLOW.slice(start).match(/\n {8}if: (.*)\n/)[1];
      expect(condition, step).toMatch(/&& matrix\.shard == 1$/);
    }
  });

  it('keeps client lint out of the sharded test jobs entirely', () => {
    // Lint used to be a shard-1 step on the client job, running in front of the
    // slowest shard's tests. Its own job runs it in parallel and keeps a
    // lint-only diff from starting a test job; the `lint` job's own comment
    // says why it cannot simply move to a different shard. Both halves are
    // pinned here: no runner job invokes the linter, and lint is not a matrix.
    const jobs = workflowJobs(WORKFLOW);
    for (const [id, body] of runners) expect(body, id).not.toContain('run-ci-lint.js');
    expect(jobs.lint).toBeTruthy();
    expect(jobs.lint).toContain('run: node scripts/run-ci-lint.js');
    expect(jobs.lint).not.toContain('strategy:');
    // Exactly one `matrix.shard`: the shared fail-fast step's CI_FAILED_SHARD,
    // which renders empty on an unsharded job. A second occurrence — a cache
    // key, a step name, above all a shard-pinned `if:` — is the regression.
    expect(jobs.lint.match(/matrix\.shard/g)).toHaveLength(1);
    expect(jobs.lint).toContain('CI_FAILED_SHARD: ${{ matrix.shard }}');
    // A scoped plan emits `client_shards: [1]`, so a later-shard pin would skip
    // lint on every impact-scoped pull request. Its gate is the plan's lint mode.
    expect(jobs.lint).toContain("if: needs.impact.outputs.lint_mode != 'skip'");
    // The aggregate gate is the single required check, so a job it does not
    // observe can fail without blocking a merge.
    expect(jobs.gate).toContain('CI_GATE_RESULT_LINT: ${{ needs.lint.result }}');
    expect(jobs.gate).toMatch(/needs: \[[^\]]*\blint\b/);
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

describe('extractCrashedTestFile', () => {
  // Verbatim shape of Vitest's own message for a forked worker that aborted
  // natively (issue 8152 — a Windows 0xC0000409 fail-fast), trimmed to the
  // two lines the regex actually needs.
  const CRASH_OUTPUT = [
    '⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯',
    'Error: [vitest-pool]: Worker forks emitted error.',
    'Caused by: Error: Worker exited unexpectedly with exit code 3221226505 during started state while running test file D:/a/PortOS/PortOS/server/services/sprites/importer.test.js',
    '  Test Files  798 passed | 2 skipped (801)',
  ].join('\n');

  it('pulls the crashed file out of a native worker-crash error', () => {
    expect(extractCrashedTestFile(CRASH_OUTPUT)).toBe(
      'D:/a/PortOS/PortOS/server/services/sprites/importer.test.js',
    );
  });

  it('finds nothing in an ordinary assertion failure or empty output', () => {
    expect(extractCrashedTestFile('FAIL server/lib/foo.test.js > bar\nExpected 1 to be 2')).toBeNull();
    expect(extractCrashedTestFile('')).toBeNull();
    expect(extractCrashedTestFile(undefined)).toBeNull();
  });
});

describe('repoRelativeFromCrashPath', () => {
  it('maps an absolute Windows or POSIX runner path onto its workspace', () => {
    expect(repoRelativeFromCrashPath('D:/a/PortOS/PortOS/server/services/sprites/importer.test.js'))
      .toBe('server/services/sprites/importer.test.js');
    expect(repoRelativeFromCrashPath('/home/runner/work/PortOS/PortOS/client/src/lib/foo.test.js'))
      .toBe('client/src/lib/foo.test.js');
  });

  it('returns null when the path names neither workspace', () => {
    expect(repoRelativeFromCrashPath('D:/a/PortOS/PortOS/scripts/foo.test.js')).toBeNull();
    expect(repoRelativeFromCrashPath('')).toBeNull();
  });
});

describe('planCrashRetry', () => {
  const CRASH_OUTPUT = 'Caused by: Error: Worker exited unexpectedly with exit code 3221226505 '
    + 'during started state while running test file D:/a/PortOS/PortOS/server/services/sprites/importer.test.js';

  it('plans a same-workspace single-file retry for a matching crash', () => {
    expect(planCrashRetry('server', CRASH_OUTPUT)).toEqual({
      retry: true,
      relPath: 'server/services/sprites/importer.test.js',
      selector: './services/sprites/importer.test.js',
    });
  });

  it('removes reporter color resets from the retry filename', () => {
    expect(planCrashRetry('server', '\u001b[31m' + CRASH_OUTPUT + '\u001b[39m')).toEqual({
      retry: true,
      relPath: 'server/services/sprites/importer.test.js',
      selector: './services/sprites/importer.test.js',
    });
  });

  it('declines to retry a crash reported in the other workspace', () => {
    // A server-shard crash never gets replayed as a client-scoped selector.
    expect(planCrashRetry('client', CRASH_OUTPUT)).toEqual({
      retry: false,
      crashedPath: 'D:/a/PortOS/PortOS/server/services/sprites/importer.test.js',
    });
  });

  it('declines to retry an ordinary test failure', () => {
    expect(planCrashRetry('server', 'FAIL server/lib/foo.test.js\nExpected true to be false')).toEqual({
      retry: false,
    });
  });
});

describe('hasOtherTestFailures', () => {
  // The real end-of-run summary block from the crash this fixes (issue 8152):
  // one crashed file counted in neither "Test Files" nor "Tests", and exactly
  // one unhandled error — the crash itself, nothing else.
  const CLEAN_RUN_SUMMARY = [
    'Test Files  798 passed | 2 skipped (801)',
    '     Tests  15077 passed | 61 skipped (15145)',
    '    Errors  1 error',
  ].join('\n');

  it('reads false from a summary with no failures and exactly one (the crash\'s own) unhandled error', () => {
    expect(hasOtherTestFailures(CLEAN_RUN_SUMMARY)).toBe(false);
  });

  it('reads true when either summary line reports a real failure, whichever order it lists the counts', () => {
    expect(hasOtherTestFailures(CLEAN_RUN_SUMMARY.replace(
      'Test Files  798 passed', 'Test Files  1 failed | 797 passed',
    ))).toBe(true);
    expect(hasOtherTestFailures(CLEAN_RUN_SUMMARY.replace(
      'Tests  15077 passed', 'Tests  15076 passed | 1 failed',
    ))).toBe(true);
  });

  it('parses colored summaries without masking assertion failures', () => {
    const colored = CLEAN_RUN_SUMMARY.replace(/(\d+ (?:passed|error))/g, '\u001b[32m$1\u001b[39m');
    expect(hasOtherTestFailures(colored)).toBe(false);
    expect(hasOtherTestFailures(colored.replace('798 passed', '797 passed | \u001b[31m1 failed'))).toBe(true);
  });

  it('reads true when a second, unrelated unhandled error shares the run with the crash', () => {
    expect(hasOtherTestFailures(CLEAN_RUN_SUMMARY.replace('1 error', '2 errors'))).toBe(true);
  });

  it('fails closed (assumes a real failure) when any summary line is missing', () => {
    expect(hasOtherTestFailures('')).toBe(true);
    expect(hasOtherTestFailures('Test Files  798 passed | 2 skipped (801)')).toBe(true);
    expect(hasOtherTestFailures('some unrelated crash output with no summary at all')).toBe(true);
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


describe('structured failure diagnostics', () => {
  it('recovers a real bail failure with default and GitHub reporters even if their summary is incomplete', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'portos-diagnostics-'));
    try {
      const report = join(fixture, 'report.json');
      writeFileSync(join(fixture, 'fixture.test.js'),
        "test('synthetic assertion diagnostic', () => { expect(1, 'synthetic mismatch').toBe(2); });");
      writeFileSync(join(fixture, 'vitest.config.mjs'),
        'export default { test: { globals: true, maxWorkers: 1 } };');
      const runnerUrl = new URL('./run-ci-tests.js', import.meta.url).href;
      const args = ['--config', join(fixture, 'vitest.config.mjs'), '--root', fixture, './fixture.test.js'];
      const result = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import { runNpm } from ${JSON.stringify(runnerUrl)};
         const result = await runNpm('server', 'test:ci:related', ${JSON.stringify(args)});
         process.exitCode = result.status;`,
      ], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, NODE_ENV: 'test' } });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      // Inspect only the structured fallback, independent of terminal summaries.
      const diagnostic = result.stderr.slice(result.stderr.indexOf('Structured Vitest'));
      expect(diagnostic).toContain('fixture.test.js > synthetic assertion diagnostic');
      expect(diagnostic).toContain('synthetic mismatch');
      expect(diagnostic).toContain('Structured Vitest failure diagnostics');
      writeFileSync(report, '{');
      expect(structuredFailureDiagnostics(report)).toContain('Inconclusive');
      writeFileSync(report, JSON.stringify({ testResults: [] }));
      expect(structuredFailureDiagnostics(report)).toContain('Inconclusive');
      expect(structuredFailureDiagnostics(join(fixture, 'missing.json'))).toContain('Inconclusive');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 35_000);
});
