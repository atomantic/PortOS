import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  structuredFailureDiagnostics,
  extractCrashedTestFile,
  hasOtherTestFailures,
  planCrashRetry,
  recordVitestDuration,
  repoRelativeFromCrashPath,
  parseShard,
  requiresSourceFiles,
  spawnNpm,
  toRunnerPath,
} from './run-ci-tests.js';
import { killProcessTree } from '../server/lib/bufferedSpawn.js';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { computeTestMemoKeys, createDiskFs, relatedTests } from './lib/testMemo.js';
import { vitestShardSlice } from './lib/testMemoRunner.js';
import { toWorkspacePath } from './lib/workspaceTests.js';
import { OWNER_FILE, STALE_ROOT_AGE_MS } from './lib/vitestStaleRunRoots.js';
import { workflowJobs } from './lib/workflowJobs.js';

// Synthetic crash/retry cases must not print a fabricated crash as a real
// Actions annotation. Duration/summary tests retain real I/O.
vi.mock('./lib/githubOutput.js', async (importOriginal) => ({
  ...await importOriginal(),
  formatErrorAnnotation: vi.fn((title, message) => `${title}: ${message}`),
}));

// Keep nested Vitest's own scratch under its separately owned pvt-* root,
// just like the workspace configs; reporter diagnostics stay outside it.
const FIXTURE_CONFIG = `
  import { bootstrapVitestTempRoot } from ${JSON.stringify(new URL('./lib/vitestTempRoot.js', import.meta.url).href)};
  // Beside the config, not in <fixture>/node_modules/.vite, so removing the fixture removes the cache.
  const cacheDir = import.meta.dirname + '/.vitest-cache';
  bootstrapVitestTempRoot();
  export default { cacheDir,
    test: { globals: true, maxWorkers: 1, testTimeout: 60000,
    globalSetup: [${JSON.stringify(new URL('./vitestTempRootSetup.js', import.meta.url).href)}] } };
`;

const WORKFLOW = readFileSync(join(import.meta.dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');

describe('parseShard', () => {
  it('reads a slice only when the matrix actually split the suite', () => {
    expect(parseShard(undefined)).toBeNull();
    expect(parseShard('')).toBeNull();
    expect(parseShard('1/1')).toBeNull();
    expect(parseShard('2/3')).toEqual({ index: 2, count: 3 });
    expect(() => parseShard('2')).toThrow(/<index>\/<count>/);
  });
});

/** A fake `npm` on PATH that prints its arguments and the selection file it was handed. */
function installFakeNpm(fixture, body) {
  const npmScript = join(fixture, 'npm.js');
  writeFileSync(npmScript, body);
  writeFileSync(join(fixture, 'npm'), `#!${process.execPath}\n${body}`, { mode: 0o755 });
  writeFileSync(join(fixture, 'npm.cmd'), `@"${process.execPath}" "${npmScript}" %*\r\n`);
}

const REPORTING_NPM = 'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), '
  + 'selection: JSON.parse(require("fs").readFileSync(process.env.PORTOS_CI_TEST_SELECTION, "utf8")) }) + "\\n");';

it('hands Vitest the selection as a file, sliced by the runner for the matrix shard, never as --shard', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'portos-related-shard-'));
  try {
    installFakeNpm(fixture, REPORTING_NPM);
    // The planner fans both scoped modes out (ci-test-plan.js fansOut), so
    // each must hand Vitest its slice rather than run the whole selection twice.
    // Related selection is closure-based: this runner imports
    // scripts/lib/directInvocation.js, so the runner's own test is related to it.
    const files = ['server/lib/example.test.js', 'scripts/example.test.js'];
    for (const [mode, shard, sources, expected] of [
      ['related', '', ['scripts/lib/directInvocation.js'], ['../scripts/run-ci-tests.test.js', 'lib/example.test.js', '../scripts/example.test.js']],
      ['files', '', [], ['lib/example.test.js', '../scripts/example.test.js']],
      // Two explicit files split three ways: shard 2 of 3 gets exactly one of them.
      ['files', '2/3', [], [vitestShardSlice(files, { repoRoot: join(import.meta.dirname, '..'), scope: 'server', index: 2, count: 3 })].flat().map((rel) => toWorkspacePath('server', rel))],
    ]) {
      const result = spawnSync(process.execPath, [join(import.meta.dirname, 'run-ci-tests.js'), 'server'], {
        encoding: 'utf8', timeout: 120000,
        env: { ...process.env, PATH: `${fixture}${delimiter}${process.env.PATH}`,
          CI_TEST_MODE: mode, CI_SHARD: shard, PORTOS_TEST_MEMO: 'off',
          CI_TEST_SOURCES: JSON.stringify(sources),
          CI_TEST_FILES: JSON.stringify(files),
          GITHUB_ENV: '', GITHUB_STEP_SUMMARY: '' },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const { args, selection } = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('{"args"')));
      expect(args.slice(0, 5), mode).toEqual(['run', 'test:ci', '--prefix', 'server', '--']);
      expect(args.some(arg => arg.startsWith('--shard')), mode).toBe(false);
      expect(args, mode).not.toContain('--experimental.recordDependencies');
      expect(selection.exclude, mode).toEqual([]);
      expect(selection.include, `${mode} ${shard}`).toEqual(expect.arrayContaining(expected));
      if (mode === 'files') expect(selection.include, shard).toHaveLength(expected.length);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}, 150_000);

describe('test memo through the real runner', () => {
  it('runs a selected file once, then skips it while its inputs are unchanged, and runs it again when they change', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'portos-memo-e2e-'));
    const memoDir = join(fixture, 'memo');
    try {
      // A fake npm that reports every selected file as passed, so the contract
      // covers the runner's bookkeeping without a nested Vitest run.
      installFakeNpm(fixture, [
        'const fs = require("fs");',
        'const selection = JSON.parse(fs.readFileSync(process.env.PORTOS_CI_TEST_SELECTION, "utf8"));',
        'const out = process.argv.find(a => a.startsWith("--outputFile.json=")).slice("--outputFile.json=".length);',
        `const repo = ${JSON.stringify(join(import.meta.dirname, '..'))};`,
        'const testResults = selection.include.map(rel => ({ name: require("path").resolve(repo, "server", rel), status: "passed", assertionResults: [{ status: "passed" }] }));',
        'fs.writeFileSync(out, JSON.stringify({ testResults }));',
        // The run-level report scripts/vitestRunDiagnostics.js would write; PORTOS_FAKE_LATE_ERROR simulates a rejection after the last test.
        'fs.writeFileSync(process.env.PORTOS_CI_DIAGNOSTICS_PATH, JSON.stringify({ reason: "passed", errorCount: process.env.PORTOS_FAKE_LATE_ERROR ? 1 : 0, errors: [] }));',
        'process.stdout.write("RAN " + JSON.stringify(selection.include) + "\\n");',
      ].join('\n'));
      const test = 'scripts/lib/releaseTitle.test.js';
      const run = (extraEnv = {}) => spawnSync(process.execPath, [join(import.meta.dirname, 'run-ci-tests.js'), 'server'], {
        encoding: 'utf8', timeout: 120000,
        env: { ...process.env, PATH: `${fixture}${delimiter}${process.env.PATH}`,
          CI_TEST_MODE: 'files', CI_TEST_FILES: JSON.stringify([test]), CI_TEST_SOURCES: '[]',
          // An inherited PORTOS_TEST_MEMO=off (a developer's shell, a recording run) must not turn this contract off.
          PORTOS_TEST_MEMO: '', PORTOS_TEST_MEMO_DIR: memoDir, PORTOS_TEST_MEMO_VERBOSE: '1', GITHUB_ENV: '', GITHUB_STEP_SUMMARY: '', ...extraEnv },
      });
      // A green-looking report with a run-level error records nothing.
      const tainted = run({ PORTOS_FAKE_LATE_ERROR: '1' });
      expect(tainted.status, tainted.stderr).toBe(0);
      expect(tainted.stdout).toContain('RAN ');
      expect(tainted.stdout).not.toContain('recorded');

      const first = run();
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toContain('🧠 Test memo: skipped 0 of 1 selected files (closure unchanged); running 1.');
      expect(first.stdout).toContain('RAN ["../scripts/lib/releaseTitle.test.js"]');
      // Two entries when this checkout's Vitest cache already holds a depfile for the file (a recorded key), one otherwise.
      expect(first.stdout).toMatch(/recorded [12] green entries for 1 passed files/);

      const second = run();
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toContain('🧠 Test memo: skipped 1 of 1 selected files (closure unchanged); running 0.');
      expect(second.stdout).toMatch(new RegExp(`skipped ${test.replace(/[./]/g, '\\$&')} \\((?:recorded|floor) key\\)`));
      expect(second.stdout).not.toContain('RAN ');

      // A gating environment variable is part of the key.
      const other = run({ PORTOS_TEST_QUIET: process.env.PORTOS_TEST_QUIET === '1' ? '' : '1' });
      expect(other.stdout).toContain('skipped 0 of 1 selected files');
      // Off restores the pre-memo behavior: no summary, the file runs.
      const off = run({ PORTOS_TEST_MEMO: 'off' });
      expect(off.stdout).not.toContain('🧠');
      expect(off.stdout).toContain('RAN ');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 200_000);

  it('selects the same files as `vitest related` on a fixture graph with a dynamic import', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'portos-related-parity-'));
    try {
      const host = join(fixture, 'host');
      mkdirSync(host);
      writeFileSync(join(fixture, 'vitest.config.mjs'), FIXTURE_CONFIG);
      writeFileSync(join(fixture, 'a.js'), 'export const a = 1;\n');
      writeFileSync(join(fixture, 'b.js'), "export const load = () => import('./c.js');\n");
      writeFileSync(join(fixture, 'c.js'), 'export const c = 1;\n');
      writeFileSync(join(fixture, 'a.test.js'), "import { a } from './a.js';\ntest('a', () => { expect(a).toBe(1); });\n");
      writeFileSync(join(fixture, 'b.test.js'), "import { load } from './b.js';\ntest('b', async () => { expect((await load()).c).toBe(1); });\n");
      writeFileSync(join(fixture, 'plain.test.js'), "test('plain', () => { expect(1).toBe(1); });\n");
      // Vitest's JS entry through node: the .bin shim cannot be started by spawnSync on Windows.
      const vitest = join(import.meta.dirname, '..', 'server', 'node_modules', 'vitest', 'vitest.mjs');
      const env = { ...process.env, NODE_ENV: 'test', TMPDIR: host, TMP: host, TEMP: host, NODE_DISABLE_COMPILE_CACHE: '1', PORTOS_CI_TEST_SELECTION: '' };
      delete env.PORTOS_TEST_TEMP_ROOT;
      const viaVitest = (source) => {
        const report = join(fixture, `${source}.json`);
        const result = spawnSync(process.execPath, [vitest, 'related', `./${source}`, '--run', '--config', join(fixture, 'vitest.config.mjs'), '--root', fixture,
          '--reporter=json', `--outputFile=${report}`, '--passWithNoTests'], { cwd: fixture, encoding: 'utf8', env, timeout: 60000 });
        expect(result.error).toBeUndefined();
        return JSON.parse(readFileSync(report, 'utf8')).testResults.map(suite => suite.name.replace(/\\/g, '/').split('/').pop()).sort();
      };
      const keys = computeTestMemoKeys(['a.test.js', 'b.test.js', 'plain.test.js'], { fs: createDiskFs(fixture, nodeFs, nodePath), workspace: '.', env: {} });
      for (const source of ['a.js', 'b.js', 'c.js']) {
        expect(relatedTests(keys, [source]).sort(), source).toEqual(viaVitest(source));
      }
      expect(relatedTests(keys, ['c.js'])).toEqual(['b.test.js']);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 120_000);
});

it('rejects empty browser coverage except explicitly deferred smoke-only inputs', () => {
  for (const [profile, files, expected] of [
    ['fidelity', [], 1], ['fidelity', ['server/lib/filmLook.browser.test.js'], 1],
    ['full', [], 1], ['smoke', [], 1],
    ['smoke', ['server/routes/musicVideoRichAuthoring.browser.test.js'], 0],
  ]) {
    const result = spawnSync(process.execPath, [join(import.meta.dirname, 'run-ci-tests.js'), 'server'], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, PORTOS_BROWSER_TEST_PROFILE: profile, CI_TEST_MODE: 'files',
        CI_TEST_FILES: JSON.stringify(files), GITHUB_ENV: '', GITHUB_STEP_SUMMARY: '' },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, `${profile}: ${result.stderr}`).toBe(expected);
  }
});

describe('ci.yml shard wiring', () => {
  const runners = Object.entries(workflowJobs(WORKFLOW)).filter(([, body]) => /(?:run|watch)-ci-tests\.js/.test(body));

  it('builds every test runner matrix from the planner and hands each slice to the runner', () => {
    expect(runners.map(([id]) => id).sort()).toEqual(['browser', 'client', 'server', 'windows-server']);
    // `browser` runs the planner's cross-workspace browser suites in `files`
    // mode (#10312): an exact file list has nothing to shard, so it is the one
    // runner without a matrix.
    for (const [id, body] of runners.filter(([id]) => id !== 'browser')) {
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

  it('runs the planner-selected browser suites on their own job with prerequisites required (#10312)', () => {
    const body = workflowJobs(WORKFLOW).browser;
    expect(body).toContain("if: needs.impact.outputs.browser_files != '[]'");
    const start = body.indexOf('- name: Run cross-workspace browser suites');
    expect(start).toBeGreaterThan(0);
    const step = body.slice(start, body.indexOf('- name:', start + 1));
    expect(step).toContain('CI_TEST_MODE: files');
    expect(step).toContain('CI_TEST_FILES: ${{ needs.impact.outputs.browser_files }}');
    expect(step).toContain("PORTOS_REQUIRE_BROWSER_SUITES: '1'");
    // The client workspace must be installed before the suites bundle it.
    expect(body.indexOf('npm ci --prefix client')).toBeGreaterThan(0);
    expect(body.indexOf('npm ci --prefix client')).toBeLessThan(start);
  });

  it('deduplicates only Linux browser ownership and runs PR browser suites as smoke', () => {
    const jobs = workflowJobs(WORKFLOW);
    expect(jobs.server).toContain('PORTOS_CI_BROWSER_OWNER: unit');
    expect(jobs['windows-server']).not.toContain('PORTOS_CI_BROWSER_OWNER');
    expect(jobs.browser).toContain("github.event_name == 'pull_request' && github.base_ref != 'release' && inputs.full != true && 'smoke' || 'full'");
    expect(jobs.database).not.toContain('Run cross-workspace browser suites');
    expect(jobs.gate).toContain('CI_GATE_RESULT_BROWSER: ${{ needs.browser.result }}');
    expect(jobs['full-gate']).toContain("(github.event_name != 'pull_request' || github.base_ref == 'release' || inputs.full == true)");
    expect(jobs.gate).toContain('CI_GATE_RESULT_LINUX_CONTAINMENT:');
    expect(jobs.gate).toContain('CI_GATE_RESULT_WINDOWS_SERVER:');
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
    // No `matrix.shard` at all: lint is not a matrix, so a cache key, a step
    // name, above all a shard-pinned `if:` naming it is the regression.
    expect(jobs.lint).not.toMatch(/matrix\.shard/);
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

describe('native crash diagnostics before retry/cancellation (#8152)', () => {
  const output = 'Worker exited unexpectedly with exit code 3221226505 during started state while running test file '
    + 'D:/a/PortOS/PortOS/server/services/sprites/walk.test.js\n'
    + 'Test Files  798 passed | 2 skipped (801)\nTests  15077 passed | 61 skipped (15145)\nErrors  1 error';

  it('captures each failed invocation before returning nonzero with the same one-retry ceiling', async () => {
    const order = [];
    const run = vi.fn(async () => {
      order.push('run');
      return { status: 1, output };
    });
    const diagnose = vi.fn(async () => { order.push('diagnose'); });
    expect(await spawnNpm('server', 'test:ci', ['--experimental.recordDependencies'], 'fixture', { run, diagnose })).toBe(1);
    expect(order).toEqual(['run', 'diagnose', 'run', 'diagnose']);
    // The retry narrows the selectors to the crashed file but keeps the run's flags, so its record is taken too.
    expect(run.mock.calls[1]).toEqual(['server', 'test:ci', ['./services/sprites/walk.test.js', '--experimental.recordDependencies']]);
  });

  it('refuses an explicitly empty browser profile before invoking tests', async () => {
    vi.stubEnv('PORTOS_BROWSER_TEST_PROFILE', '');
    const run = vi.fn();
    try {
      await expect(spawnNpm('server', 'test:ci', ['selected.browser.test.js'], 'invalid', { run }))
        .rejects.toThrow('Unknown browser test profile');
      expect(run).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it('keeps browser profile selection on a recovered worker retry', async () => {
    vi.stubEnv('PORTOS_BROWSER_TEST_PROFILE', 'smoke');
    try {
      const run = vi.fn().mockResolvedValueOnce({ status: 1, output })
        .mockResolvedValueOnce({ status: 0, output: 'passed' });
      expect(await spawnNpm('server', 'test:ci', ['selected.browser.test.js'], 'smoke', {
        run, diagnose: vi.fn(),
      })).toBe(0);
      const filter = '--testNamePattern=^(?!.*\\[fidelity\\]).*$';
      expect(run.mock.calls[0][2]).toEqual(['selected.browser.test.js', filter]);
      expect(run.mock.calls[1][2]).toEqual(['./services/sprites/walk.test.js', filter]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('retains diagnostic evidence for recovered crashes without clearing unrelated assertion failures', async () => {
    for (const [originalOutput, expected] of [[output, 0], [output.replace('798 passed', '797 passed | 1 failed'), 1]]) {
      const run = vi.fn().mockResolvedValueOnce({ status: 1, output: originalOutput })
        .mockResolvedValueOnce({ status: 0, output: 'passed' });
      const diagnose = vi.fn();
      expect(await spawnNpm('server', 'test:ci', [], 'fixture', { run, diagnose })).toBe(expected);
      expect(diagnose).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledTimes(2);
    }
  });

  it('leaves assertion failures and interrupted runs outside native diagnostics/retry', async () => {
    for (const result of [{ status: 1, output: 'FAIL assertion' }, { status: 143, output, interrupted: 'SIGTERM' }]) {
      const run = vi.fn().mockResolvedValue(result);
      const diagnose = vi.fn();
      expect(await spawnNpm('server', 'test:ci', [], 'fixture', { run, diagnose })).toBe(result.status);
      expect(run).toHaveBeenCalledTimes(1);
      expect(diagnose).not.toHaveBeenCalled();
    }
  });
});


describe('structured failure diagnostics', () => {
  it('reports a run-level rejection and worker cause when every test passed (#11244)', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'portos-diagnostics-'));
    try {
      const host = join(fixture, 'host');
      mkdirSync(host);
      writeFileSync(join(fixture, 'vitest.config.mjs'), FIXTURE_CONFIG);
      writeFileSync(join(fixture, 'fixture.test.js'), `
        test('passing assertion with unhandled rejection', async () => {
          Promise.reject(new Error('synthetic run-level rejection', {
            cause: new Error('Worker exited unexpectedly with exit code 3221226505'),
          }));
          await new Promise(resolve => setImmediate(resolve));
          expect(true).toBe(true);
        });`);
      const runnerUrl = new URL('./run-ci-tests.js', import.meta.url).href;
      const args = ['--config', join(fixture, 'vitest.config.mjs'), '--root', fixture, './fixture.test.js'];
      const env = { ...process.env, NODE_ENV: 'test', TMPDIR: host, TMP: host, TEMP: host, NODE_DISABLE_COMPILE_CACHE: '1' };
      delete env.PORTOS_TEST_TEMP_ROOT;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import { runNpm } from ${JSON.stringify(runnerUrl)};
         import { passedTestFiles } from ${JSON.stringify(new URL('./lib/testMemoRunner.js', import.meta.url).href)};
         const result = await runNpm('server', 'test:ci', ${JSON.stringify(args)});
         console.log('MEMO ' + JSON.stringify({ status: result.status, runReport: result.runReport, files: result.fileResults.map(f => f.status),
           passed: passedTestFiles(result.fileResults, { repoRoot: ${JSON.stringify(fixture)}, status: result.status, runReport: result.runReport }) }));
         process.exitCode = result.status;`,
      ], { encoding: 'utf8', timeout: 30_000, env });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(stripVTControlCharacters(result.stdout)).toMatch(/Test Files\s+1 passed/);
      // The JSON report calls the file passed; the process and run-level report say otherwise, and the memo believes them.
      const memo = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('MEMO ')).slice(5));
      expect(memo).toMatchObject({ status: 1, files: ['passed'], passed: [] });
      expect(memo.runReport.errorCount).toBe(1);
      const diagnostic = result.stderr.slice(result.stderr.indexOf('Test launcher exited:'));
      expect(diagnostic).toContain('code=1, signal=none');
      expect(diagnostic).toContain('unhandledErrors=1');
      const errors = diagnostic.slice(diagnostic.indexOf('Vitest unhandled errors'), diagnostic.indexOf('Inconclusive'));
      expect(errors).toContain('synthetic run-level rejection');
      expect(errors).toContain('fixture.test.js:');
      expect(errors).toContain('Worker exited unexpectedly with exit code 3221226505');
      expect(diagnostic).toContain('Vitest output tail');
      expect(readdirSync(host)).toEqual([]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 35_000);

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
      const durable = join(fixture, 'durable');
      const env = { ...process.env, NODE_ENV: 'test', TMPDIR: host, TMP: host, TEMP: host, NODE_DISABLE_COMPILE_CACHE: '1',
        PORTOS_CI_DIAGNOSTICS_DIR: durable };
      delete env.PORTOS_TEST_TEMP_ROOT;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import { runNpm } from ${JSON.stringify(runnerUrl)};
         const result = await runNpm('server', 'test:ci', ${JSON.stringify(args)});
         process.exitCode = result.status;`,
      ], { encoding: 'utf8', timeout: 30_000, env });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(readdirSync(host)).toEqual([]);
      const attempts = readdirSync(durable);
      expect(attempts).toHaveLength(1);
      const invocation = JSON.parse(readFileSync(join(durable, attempts[0], 'invocation.json'), 'utf8'));
      expect(invocation).toMatchObject({ completed: true, status: 1 });
      const progress = JSON.parse(readFileSync(join(durable, attempts[0], 'run.json'), 'utf8'));
      // Vitest reports bail=1 as an interrupted run, even with a failed suite.
      expect(progress).toMatchObject({ reason: 'interrupted', completedCount: 1, activeModules: [],
        completedModules: ['<outside-repository>/fixture.test.js'] });
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

  it('retains temporary diagnostics when cancellation cannot verify child cleanup', async () => {
    const host = mkdtempSync(join(tmpdir(), 'launcher-unverified-'));
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), unref: vi.fn(),
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    vi.doMock('child_process', () => ({ spawn: () => child }));
    vi.doMock('node:os', async importOriginal => ({ ...await importOriginal(), tmpdir: () => host }));
    vi.doMock('../server/lib/bufferedSpawn.js', async importOriginal => ({
      ...await importOriginal(), killProcessTree: vi.fn(),
    }));
    vi.resetModules();
    try {
      const { runNpm } = await import('./run-ci-tests.js');
      const controller = new AbortController();
      const pending = runNpm('server', 'test:ci', [], {
        env: { ...process.env, PORTOS_CI_DIAGNOSTICS_DIR: '' },
        signal: controller.signal, cancellationTimeoutMs: 100,
      });
      controller.abort();
      await vi.advanceTimersByTimeAsync(100);
      const result = await pending;
      expect(result).toMatchObject({ status: 143, interrupted: 'SIGTERM', cleanupUnverified: true });
      expect(result.error.message).toContain('cleanup unverified');
      expect(result.diagnosticsPath).toBe(join(host, readdirSync(host)[0]));
      expect(JSON.parse(readFileSync(join(result.diagnosticsPath, 'invocation.json'), 'utf8')))
        .toMatchObject({ completed: false, status: 143, signal: 'SIGTERM' });
      expect(errors).toHaveBeenCalledWith(expect.stringContaining(result.diagnosticsPath));
    } finally {
      vi.useRealTimers();
      vi.doUnmock('child_process');
      vi.doUnmock('node:os');
      vi.doUnmock('../server/lib/bufferedSpawn.js');
      vi.resetModules();
      errors.mockRestore();
      child.stdout.destroy();
      child.stderr.destroy();
      rmSync(host, { recursive: true, force: true });
    }
  });

  function launch(host, name, { blocking = false, abortOnSignal = false } = {}) {
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
      const controller = new AbortController();
      if (${abortOnSignal}) process.once('SIGUSR2', () => controller.abort());
      const result = await runNpm('server', 'test:ci', ${JSON.stringify(args)},
        ${abortOnSignal} ? { signal: controller.signal } : {});
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
    // Shared teardown: reads ready.json whenever present (even if the caller's
    // waitFor threw first), kills the detached process group plus worker and
    // descendant, and awaits the launcher's close before the caller removes host.
    async function cleanup() {
      killProcessTree(child, 'SIGKILL');
      if (existsSync(ready)) {
        const pids = JSON.parse(readFileSync(ready, 'utf8'));
        if (pids.group) killProcessTree({ pid: pids.group }, 'SIGKILL', { processGroup: true });
        for (const pid of [pids.worker, pids.descendant]) if (pid) killProcessTree({ pid }, 'SIGKILL');
      }
      await Promise.allSettled([closed]);
    }
    return { child, closed, ready, cleanup };
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
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGUSR2']) {
      it(`${signal} fails the stage, stops descendants, and removes the report root`, async () => {
        const host = mkdtempSync(join(tmpdir(), 'rcl-'));
        let run;
        let pids;
        try {
          run = launch(host, 'cancel', { blocking: true, abortOnSignal: signal === 'SIGUSR2' });
          await waitFor(() => existsSync(run.ready), 'test worker did not start');
          pids = JSON.parse(readFileSync(run.ready, 'utf8'));
          expect(ownedRoot(host, run.child.pid)).toBeTruthy();
          run.child.kill(signal);
          const result = await run.closed;
          expect(result.code, result.output).toBe(signal === 'SIGINT' ? 130 : 143);
          expect(ownedRoot(host, run.child.pid)).toBeUndefined();
          await waitFor(() => !alive(pids.worker) && !alive(pids.descendant), 'owned test processes survived cancellation');
        } finally {
          await run?.cleanup();
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
      await waitFor(() => !alive(doomed.child.pid), 'doomed launcher survived SIGKILL');
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
      // Windows has no process snapshot reader: dead-owner evidence permits
      // cleanup above, but age alone cannot prove a pid-less root is unused.
      expect(existsSync(join(host, 'portos-vitest-legacy-old'))).toBe(process.platform === 'win32');
      expect(existsSync(join(host, 'portos-vitest-legacy-fresh'))).toBe(true);
    } finally {
      await Promise.allSettled(runs.map(run => run.cleanup()));
      rmSync(host, { recursive: true, force: true });
    }
    // Nothing may outlive teardown to recreate host (or its pvt-* roots) later.
    await waitFor(() => descendants.every(pid => !alive(pid)), 'fixture processes survived teardown');
    expect(existsSync(host)).toBe(false);
  }, 65000);
});
