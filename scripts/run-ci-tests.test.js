import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
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
import { killProcessTree } from '../server/lib/bufferedSpawn.js';
import { OWNER_FILE, STALE_ROOT_AGE_MS } from './lib/vitestStaleRunRoots.js';
import { workflowJobs } from './lib/workflowJobs.js';

// Keep nested Vitest's own scratch under its separately owned pvt-* root,
// just like the workspace configs; reporter diagnostics stay outside it.
const FIXTURE_CONFIG = `
  import { bootstrapVitestTempRoot } from ${JSON.stringify(new URL('./lib/vitestTempRoot.js', import.meta.url).href)};
  bootstrapVitestTempRoot();
  export default { test: { globals: true, maxWorkers: 1, testTimeout: 60000,
    globalSetup: [${JSON.stringify(new URL('./vitestTempRootSetup.js', import.meta.url).href)}] } };
`;

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
    expect(toRunnerPath('client', 'server/lib/postScoring.js')).toBe('../server/lib/postScoring.js');
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
      const host = join(fixture, 'host');
      mkdirSync(host);
      const report = join(fixture, 'report.json');
      writeFileSync(join(fixture, 'fixture.test.js'),
        "test('synthetic assertion diagnostic', () => { expect(1, 'synthetic mismatch').toBe(2); });");
      writeFileSync(join(fixture, 'vitest.config.mjs'),
        FIXTURE_CONFIG);
      const runnerUrl = new URL('./run-ci-tests.js', import.meta.url).href;
      const args = ['--config', join(fixture, 'vitest.config.mjs'), '--root', fixture, './fixture.test.js'];
      const env = { ...process.env, NODE_ENV: 'test', TMPDIR: host, TMP: host, TEMP: host, NODE_DISABLE_COMPILE_CACHE: '1' };
      delete env.PORTOS_TEST_TEMP_ROOT;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import { runNpm } from ${JSON.stringify(runnerUrl)};
         const result = await runNpm('server', 'test:ci:related', ${JSON.stringify(args)});
         process.exitCode = result.status;`,
      ], { encoding: 'utf8', timeout: 30_000, env });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(readdirSync(host)).toEqual([]);
      expect(result.stdout).toContain('Test Files');
      expect(result.stdout).toContain('Tests');
      expect(result.stderr).toContain('Failed Tests');
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

describe('report launcher subprocess lifecycle (#9804)', () => {
  const runnerUrl = new URL('./run-ci-tests.js', import.meta.url).href;

  function launch(host, name, { blocking = false } = {}) {
    const fixture = join(host, name);
    mkdirSync(fixture);
    const ready = join(fixture, 'ready.json');
    writeFileSync(join(fixture, 'vitest.config.mjs'),
      FIXTURE_CONFIG);
    writeFileSync(join(fixture, 'fixture.test.js'), blocking ? `
      import { spawn, execFileSync } from 'node:child_process';
      import { renameSync, writeFileSync } from 'node:fs';
      test('blocking fixture', async () => {
        // A descendant that ignores graceful signals must be escalated too.
        const descendant = spawn(process.execPath, ['-e',
          "process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); setInterval(() => {}, 1000); process.send('ready');"],
          { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        await new Promise(resolve => descendant.once('message', resolve));
        writeFileSync(${JSON.stringify(ready + '.tmp')}, JSON.stringify({ worker: process.pid, descendant: descendant.pid,
          group: process.platform === 'win32' ? null : Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim()) }));
        renameSync(${JSON.stringify(ready + '.tmp')}, ${JSON.stringify(ready)});
        await new Promise(() => {});
      });` : "test('success fixture', () => { expect(true).toBe(true); });");
    const args = ['--config', join(fixture, 'vitest.config.mjs'), '--root', fixture, './fixture.test.js'];
    const env = { ...process.env, TMPDIR: host, TMP: host, TEMP: host, NODE_ENV: 'test', NODE_DISABLE_COMPILE_CACHE: '1' };
    delete env.PORTOS_TEST_TEMP_ROOT;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { runNpm } from ${JSON.stringify(runnerUrl)};
      const result = await runNpm('server', 'test:ci:related', ${JSON.stringify(args)});
      process.exitCode = result.status;`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const closed = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (existsSync(ready)) {
          const pids = JSON.parse(readFileSync(ready, 'utf8'));
          if (pids.group) killProcessTree({ pid: pids.group }, 'SIGKILL', { processGroup: true });
        }
        killProcessTree(child, 'SIGKILL');
        reject(Error('report launcher exceeded its subprocess budget'));
      }, 40000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('close', (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal, output });
      });
    });
    return { child, closed, ready };
  }

  async function waitFor(check, message) {
    const deadline = Date.now() + 15000;
    while (!check()) {
      if (Date.now() > deadline) throw Error(message);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  function ownedRoot(host, pid) {
    return readdirSync(host).filter(name => name.startsWith('portos-vitest-'))
      .map(name => join(host, name))
      .filter(root => existsSync(join(root, OWNER_FILE)))
      .find(root => readFileSync(join(root, OWNER_FILE), 'utf8').startsWith(`${pid} `));
  }

  function alive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  }

  // Windows cannot deliver POSIX SIGINT/SIGTERM to a Node process; ordinary
  // outcomes and recovery below still exercise its real npm.cmd boundary.
  describe.skipIf(process.platform === 'win32')('graceful signals', () => {
    for (const signal of ['SIGINT', 'SIGTERM']) {
      it(`${signal} fails the stage, stops descendants, and removes the report root`, async () => {
        const host = mkdtempSync(join(tmpdir(), 'rcl-'));
        let run;
        let pids;
        try {
          run = launch(host, 'cancel', { blocking: true });
          await waitFor(() => existsSync(run.ready), 'test worker did not start');
          pids = JSON.parse(readFileSync(run.ready, 'utf8'));
          expect(ownedRoot(host, run.child.pid)).toBeTruthy();
          run.child.kill(signal);
          const result = await run.closed;
          expect(result.code, result.output).toBe(signal === 'SIGINT' ? 130 : 143);
          expect(ownedRoot(host, run.child.pid)).toBeUndefined();
          await waitFor(() => !alive(pids.worker) && !alive(pids.descendant), 'owned test processes survived cancellation');
        } finally {
          run?.child.kill('SIGKILL');
          if (pids) {
            if (pids.group) killProcessTree({ pid: pids.group }, 'SIGKILL', { processGroup: true });
            else for (const pid of [pids.worker, pids.descendant]) killProcessTree({ pid }, 'SIGKILL');
          }
          rmSync(host, { recursive: true, force: true });
        }
      }, 35000);
    }
  });

  it('recovers a killed owner on the next successful launch while preserving a concurrent old live root and host entries', async () => {
    const host = mkdtempSync(join(tmpdir(), 'rcl-'));
    const runs = [];
    const descendants = [];
    try {
      const old = new Date(Date.now() - STALE_ROOT_AGE_MS * 2);
      for (const name of ['unrelated-old', 'portos-vitest-legacy-old', 'portos-vitest-legacy-fresh']) {
        mkdirSync(join(host, name));
        if (name.endsWith('-old')) utimesSync(join(host, name), old, old);
      }
      const live = launch(host, 'live', { blocking: true });
      runs.push(live);
      await waitFor(() => existsSync(live.ready), 'live worker did not start');
      const livePids = JSON.parse(readFileSync(live.ready, 'utf8'));
      descendants.push(livePids.worker, livePids.descendant);
      const liveRoot = ownedRoot(host, live.child.pid);
      expect(liveRoot).toBeTruthy();
      utimesSync(liveRoot, old, old);
      const doomed = launch(host, 'doomed', { blocking: true });
      runs.push(doomed);
      await waitFor(() => existsSync(doomed.ready), 'doomed worker did not start');
      const doomedPids = JSON.parse(readFileSync(doomed.ready, 'utf8'));
      descendants.push(doomedPids.worker, doomedPids.descendant);
      const deadRoot = ownedRoot(host, doomed.child.pid);
      expect(deadRoot).toBeTruthy();
      // Abruptly kill only this fixture's launcher/tree. Its finally cannot run.
      if (process.platform === 'win32') killProcessTree(doomed.child, 'SIGKILL');
      else {
        doomed.child.kill('SIGKILL');
        killProcessTree({ pid: doomedPids.group }, 'SIGKILL', { processGroup: true });
      }
      await doomed.closed;
      expect(existsSync(deadRoot)).toBe(true);
      const next = launch(host, 'success');
      runs.push(next);
      const result = await next.closed;
      expect(result.code, result.output).toBe(0);
      expect(ownedRoot(host, next.child.pid)).toBeUndefined();
      expect(existsSync(deadRoot)).toBe(false);
      expect(existsSync(liveRoot)).toBe(true);
      expect(alive(live.child.pid)).toBe(true);
      expect(existsSync(join(host, 'unrelated-old'))).toBe(true);
      expect(existsSync(join(host, 'portos-vitest-legacy-old'))).toBe(false);
      expect(existsSync(join(host, 'portos-vitest-legacy-fresh'))).toBe(true);
    } finally {
      for (const run of runs) {
        if (process.platform === 'win32') killProcessTree(run.child, 'SIGKILL');
        else run.child.kill('SIGTERM');
      }
      for (const pid of descendants) killProcessTree({ pid }, 'SIGKILL');
      await Promise.allSettled(runs.map(run => run.closed));
      rmSync(host, { recursive: true, force: true });
    }
  }, 65000);
});
