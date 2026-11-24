import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, dirname, join, relative } from 'path';
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
  shouldWarmTestChrome,
  spawnNpm,
  toRunnerPath,
} from './run-ci-tests.js';
import { killProcessTree } from '../server/lib/bufferedSpawn.js';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { computeTestMemoKeys, createDiskFs, relatedTests } from './lib/testMemo.js';
import { VITEST_PROJECT_NAMES, listRepositoryFiles, vitestDependenciesPath, vitestShardSlice } from './lib/testMemoRunner.js';
import { toWorkspacePath } from './lib/workspaceTests.js';
import { BROWSER_SUITES, browserShardSlice } from './lib/browserSuites.js';
import { staticImportClosure } from '../server/lib/staticImportGraph.js';
import { destroyGitSandbox, makeGitSandbox } from '../server/lib/gitTestRepo.js';
import { readTestProcesses } from './lib/testOwnedProcesses.js';
import { OWNER_FILE, STALE_ROOT_AGE_MS, sweepStaleRunRoots } from './lib/vitestStaleRunRoots.js';
import { readCiJobs } from './lib/ciWorkflowJobs.js';
import { workflowJobs } from './lib/workflowJobs.js';
import { getAlwaysRunTests } from './ci-test-plan.js';
import { REPORTING_NPM, installFakeNpm } from './lib/fakeNpmFixture.js';
import { mergeTestMemoDirs } from './merge-test-memo.js';

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

it('hands Vitest the selection as a file, sliced by the runner for the matrix shard, never as --shard', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'portos-related-shard-'));
  try {
    installFakeNpm(fixture, REPORTING_NPM);
    // The planner fans both scoped modes out (ci-test-plan.js fansOut), so
    // each must hand Vitest its slice rather than run the whole selection twice.
    // Related mode reaches this same handoff after planTestMemo widens the
    // selection; that union is pinned in lib/testMemoRunner.test.js and its
    // parity with `vitest related` on the fixture graph below, without walking
    // this whole repository's import graph here.
    const files = ['server/lib/example.test.js', 'scripts/example.test.js'];
    for (const [mode, shard, sources, expected] of [
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

it('runs the db scope through the server workspace\'s test:db:ci script with the same selection file', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'portos-db-scope-'));
  try {
    installFakeNpm(fixture, REPORTING_NPM);
    const result = spawnSync(process.execPath, [join(import.meta.dirname, 'run-ci-tests.js'), 'db'], {
      encoding: 'utf8', timeout: 120000,
      env: { ...process.env, PATH: `${fixture}${delimiter}${process.env.PATH}`,
        CI_TEST_MODE: 'files', CI_SHARD: '', PORTOS_TEST_MEMO: 'off',
        CI_TEST_FILES: JSON.stringify(['server/services/dbAdmin.db.test.js']),
        GITHUB_ENV: '', GITHUB_STEP_SUMMARY: '' },
    });
    expect(result.status, result.stderr).toBe(0);
    const { args, selection } = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('{"args"')));
    expect(args.slice(0, 5)).toEqual(['run', 'test:db:ci', '--prefix', 'server', '--']);
    expect(selection.include).toEqual(['services/dbAdmin.db.test.js']);
    expect(result.stdout).toMatch(/⏱ db files|⏱ db selected tests/);
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
        'process.stdout.write("ARGS " + JSON.stringify(process.argv.slice(2)) + "\\n");',
      ].join('\n'));
      const test = 'scripts/lib/releaseTitle.test.js';
      const run = (extraEnv = {}) => spawnSync(process.execPath, [join(import.meta.dirname, 'run-ci-tests.js'), 'server'], {
        encoding: 'utf8', timeout: 120000,
        env: { ...process.env, PATH: `${fixture}${delimiter}${process.env.PATH}`,
          CI_TEST_MODE: 'files', CI_TEST_FILES: JSON.stringify([test]), CI_TEST_SOURCES: '[]',
          // An inherited PORTOS_TEST_MEMO=off (a developer's shell, a recording run) must not turn this contract off,
          // and an inherited CI_SHARD (a matrix job) must not slice the one selected file away.
          PORTOS_TEST_MEMO: '', CI_SHARD: '', PORTOS_TEST_MEMO_DIR: memoDir, PORTOS_TEST_MEMO_VERBOSE: '1', GITHUB_ENV: '', GITHUB_STEP_SUMMARY: '', GITHUB_EVENT_NAME: 'push', ...extraEnv },
      });
      // A green-looking report with a run-level error records nothing.
      const tainted = run({ PORTOS_FAKE_LATE_ERROR: '1' });
      expect(tainted.status, tainted.stderr).toBe(0);
      expect(tainted.stdout).toContain('RAN ');
      expect(tainted.stdout).not.toContain('recorded');

      // Pull-request jobs restore trusted memos but never publish them. Their
      // green test result must not pay to compute a disposable replacement.
      const pullRequestMemo = join(fixture, 'pull-request-memo');
      for (let attempt = 0; attempt < 2; attempt++) {
        const pr = run({ GITHUB_EVENT_NAME: 'pull_request', PORTOS_TEST_MEMO_DIR: pullRequestMemo });
        expect(pr.status, pr.stderr).toBe(0);
        expect(pr.stdout).toContain('RAN ["../scripts/lib/releaseTitle.test.js"]');
        expect(pr.stdout).not.toContain('recorded');
        expect(pr.stdout).not.toContain('--experimental.recordDependencies');
        expect(existsSync(pullRequestMemo) && readdirSync(pullRequestMemo).length > 0).toBe(false);
      }

      const first = run();
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toContain('🧠 Test memo: skipped 0 of 1 selected files (closure unchanged); running 1.');
      expect(first.stdout).toContain('RAN ["../scripts/lib/releaseTitle.test.js"]');
      // Two entries when this checkout's Vitest cache already holds a depfile for the file (a recorded key), one otherwise.
      expect(first.stdout).toMatch(/recorded [12] green entries for 1 passed files/);
      expect(first.stdout).toContain('--experimental.recordDependencies');

      const second = run();
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toContain('🧠 Test memo: skipped 1 of 1 selected files (closure unchanged); running 0.');
      expect(second.stdout).toMatch(new RegExp(`skipped ${test.replace(/[./]/g, '\\$&')} \\((?:recorded|floor) key\\)`));
      expect(second.stdout).not.toContain('RAN ');

      const trustedPr = run({ GITHUB_EVENT_NAME: 'pull_request' });
      expect(trustedPr.status, trustedPr.stderr).toBe(0);
      expect(trustedPr.stdout).toContain('skipped 1 of 1 selected files');
      expect(trustedPr.stdout).not.toContain('RAN ');

      // A passed file that stores nothing says why on a trusted run (#16545). The
      // stuck file spawns git, so neither key exists (any other undeclared reason
      // serves equally). A declared guard is only counted.
      const stuck = 'scripts/check-import-case.test.js';
      const [guard] = getAlwaysRunTests();
      const unrecorded = { CI_TEST_FILES: JSON.stringify([stuck, guard]), PORTOS_TEST_MEMO_DIR: join(fixture, 'unrecorded-memo') };
      const trusted = run(unrecorded);
      expect(trusted.status, trusted.stderr).toBe(0);
      expect(trusted.stdout).toContain('recorded 0 green entries for 2 passed files');
      expect(trusted.stdout).toMatch(new RegExp(`🧠   not recorded: ${stuck.replace(/[./]/g, '\\$&')} \\(floor key: [^;]+; recorded key: [^)]+\\)\n`));
      expect(trusted.stdout).toContain('🧠   not recorded: 1 files never memoized by declaration (tree guard or always-run test, TEST_MEMO_NEVER or the test-memo: never marker).');
      expect(trusted.stdout.match(/not recorded:/g)).toHaveLength(2);
      const untrusted = run({ ...unrecorded, GITHUB_EVENT_NAME: 'pull_request' });
      expect(untrusted.status, untrusted.stderr).toBe(0);
      expect(untrusted.stdout).not.toContain('not recorded');

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

  it.each([
    ['server', 'scripts/lib/releaseTitle.test.js'],
    ['db', 'server/lib/db/schema/initDbSql.db.test.js'],
  ])('reports remaining %s tests via --check-remaining without running tests', (scope, test) => {
    const fixture = mkdtempSync(join(tmpdir(), 'portos-check-remaining-'));
    const memoDir = join(fixture, 'memo');
    const outputFile = join(fixture, 'github_output');
    try {
      installFakeNpm(fixture, [
        'const fs = require("fs");',
        'const selection = JSON.parse(fs.readFileSync(process.env.PORTOS_CI_TEST_SELECTION, "utf8"));',
        'const out = process.argv.find(a => a.startsWith("--outputFile.json=")).slice("--outputFile.json=".length);',
        `const repo = ${JSON.stringify(join(import.meta.dirname, '..'))};`,
        'const testResults = selection.include.map(rel => ({ name: require("path").resolve(repo, "server", rel), status: "passed", assertionResults: [{ status: "passed" }] }));',
        'fs.writeFileSync(out, JSON.stringify({ testResults }));',
        'fs.writeFileSync(process.env.PORTOS_CI_DIAGNOSTICS_PATH, JSON.stringify({ reason: "passed", errorCount: 0, errors: [] }));',
        'process.stdout.write("RAN " + JSON.stringify(selection.include) + "\\n");',
      ].join('\n'));
      const invoke = (args, extraEnv = {}) => spawnSync(process.execPath, [join(import.meta.dirname, 'run-ci-tests.js'), scope, ...args], {
        encoding: 'utf8', timeout: 120000,
        env: { ...process.env, PATH: `${fixture}${delimiter}${process.env.PATH}`,
          CI_TEST_MODE: 'files', CI_TEST_FILES: JSON.stringify([test]), CI_TEST_SOURCES: '[]',
          PORTOS_TEST_MEMO: '', CI_SHARD: '', PORTOS_TEST_MEMO_DIR: memoDir,
          ...(scope === 'db' ? { PGDATABASE: 'portos_test', PORTOS_REQUIRE_DB: '1' } : {}),
          GITHUB_ENV: '', GITHUB_STEP_SUMMARY: '', GITHUB_OUTPUT: outputFile, GITHUB_EVENT_NAME: 'push', ...extraEnv },
      });

      writeFileSync(outputFile, '');
      const coldPlan = invoke(['--check-remaining']);
      expect(coldPlan.status, coldPlan.stderr).toBe(0);
      expect(coldPlan.stdout).not.toContain('RAN ');
      expect(readFileSync(outputFile, 'utf8')).toBe('remaining=1\n');

      const record = invoke([]);
      expect(record.status, record.stderr).toBe(0);
      expect(record.stdout).toContain('RAN ');

      writeFileSync(outputFile, '');
      const warmPlan = invoke(['--check-remaining'], { GITHUB_EVENT_NAME: 'pull_request' });
      expect(warmPlan.status, warmPlan.stderr).toBe(0);
      expect(warmPlan.stdout).toContain('skipped 1 of 1 selected files');
      expect(warmPlan.stdout).toContain(`No ${scope} tests left to run.`);
      expect(warmPlan.stdout).not.toContain('RAN ');
      expect(readFileSync(outputFile, 'utf8')).toBe('remaining=0\n');

      if (scope === 'server') {
        writeFileSync(outputFile, '');
        const deferred = invoke(['--check-remaining'], {
          PORTOS_BROWSER_TEST_PROFILE: 'smoke',
          CI_TEST_FILES: JSON.stringify(['server/routes/musicVideoRichAuthoring.browser.test.js']),
        });
        expect(deferred.status, deferred.stderr).toBe(0);
        expect(deferred.stdout).toContain('Fidelity-only inputs require separate evidence.');
        expect(readFileSync(outputFile, 'utf8')).toBe('remaining=0\n');
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 150_000);

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

// Guard admission hashes tree/index/status/refs. Keep synthetic proofs off
// the shared checkout, where other real suites may create source fixtures.
async function createRunnerSandbox(files) {
  const sandbox = await makeGitSandbox({ prefix: 'portos-runner-proof-' });
  const { scratch, repo } = sandbox;
  try {
    const sourceRoot = join(import.meta.dirname, '..');
    for (const source of staticImportClosure(join(sourceRoot, 'scripts/run-ci-tests.js')).files) {
      const destination = join(repo, relative(sourceRoot, source));
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
    }
    writeFileSync(join(repo, 'package.json'), '{"type":"module"}');
    for (const path of files) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), '// synthetic runner selection fixture\n');
    }
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('config', 'core.hooksPath', join(scratch, 'empty-hooks'));
    git('add', '--all');
    git('commit', '-qm', 'runner selection fixture');
    // The nested CLI calls block this worker's event loop. Observe the idle
    // broker's exit first so a delayed IPC event cannot exceed its close budget.
    await globalThis.__portosGitSupervisorCleanup?.();
    return sandbox;
  } catch (error) {
    await destroyGitSandbox(scratch);
    throw error;
  }
}

it('keeps a green shard\'s memo entries when a later sequential shard fails and skips only that shard on the rerun', async () => {
  const files = ['server/lib/shardA.test.js', 'server/lib/shardB.test.js', 'server/lib/shardC.test.js', 'server/lib/shardD.test.js'];
  const sandbox = await createRunnerSandbox(files);
  const { scratch: fixture, repo: root } = sandbox;
  try {
    for (const [file, source] of Object.entries({
      'server/vitest.config.js': 'export default {};',
      'server/vitest.setup.js': 'export {};',
      'scripts/vitestCiPool.js': 'export const vitestCiPool = () => ({});',
      'server/package.json': '{"name":"server"}',
      'server/package-lock.json': '{}',
      'server/node_modules/vitest/package.json': '{"version":"5.0.5"}',
    })) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), source);
    }
    // PORTOS_FAKE_FAIL names the one selected file that fails; the fake npm
    // supplies only the process/report boundary, never selection or memo logic.
    installFakeNpm(fixture, [
      'const fs = require("fs"), path = require("path");',
      'const args = process.argv.slice(2);',
      'const selection = JSON.parse(fs.readFileSync(process.env.PORTOS_CI_TEST_SELECTION, "utf8"));',
      'const bad = process.env.PORTOS_FAKE_FAIL;',
      'const failed = selection.include.includes(bad);',
      'const report = args.find(a => a.startsWith("--outputFile.json=")).slice("--outputFile.json=".length);',
      'fs.writeFileSync(report, JSON.stringify({ numPassedTests: selection.include.length - (failed ? 1 : 0), numFailedTests: failed ? 1 : 0,',
      'testResults: selection.include.map(file => ({ name: path.resolve("server", file), status: file === bad ? "failed" : "passed", assertionResults: [{ status: file === bad ? "failed" : "passed" }] })) }));',
      'fs.writeFileSync(process.env.PORTOS_CI_DIAGNOSTICS_PATH, JSON.stringify({ reason: failed ? "failed" : "passed", errorCount: 0, errors: [] }));',
      'process.stdout.write("RAN " + JSON.stringify(selection.include) + "\\n");',
      'process.exitCode = failed ? 1 : 0;',
    ].join('\n'));
    const memoDir = join(fixture, 'memo');
    const run = (index, fail = '') => spawnSync(process.execPath, [join(root, 'scripts/run-ci-tests.js'), 'server'], {
      cwd: root, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, PATH: `${fixture}${delimiter}${process.env.PATH}`,
        CI_TEST_MODE: 'files', CI_TEST_FILES: JSON.stringify(files), CI_TEST_SOURCES: '[]', CI_SHARD: `${index}/2`,
        PORTOS_TEST_MEMO: '', PORTOS_TEST_MEMO_DIR: memoDir, PORTOS_FAKE_FAIL: fail,
        GITHUB_EVENT_NAME: 'push', GITHUB_ENV: '', GITHUB_STEP_SUMMARY: '' },
    });
    const slices = [1, 2].map(index => vitestShardSlice(files, { repoRoot: root, scope: 'server', index, count: 2 }));
    // The two shards partition the selection exactly: no omitted or duplicated file.
    expect(slices.flat().sort()).toEqual([...files].sort());
    const failing = toWorkspacePath('server', slices[1][0]);

    const first = run(1, failing);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toMatch(/recorded \d+ green entries/);

    const second = run(2, failing);
    expect(second.status).not.toBe(0);
    expect(second.stdout).not.toMatch(/recorded \d+ green entries/);

    // After the bounded fixture correction, shard 1 is skipped by the memo and shard 2 runs.
    const rerunFirst = run(1);
    expect(rerunFirst.status, rerunFirst.stderr).toBe(0);
    expect(rerunFirst.stdout).toContain(`skipped ${slices[0].length} of ${slices[0].length} selected files`);
    expect(rerunFirst.stdout).not.toContain('RAN ');
    const rerunSecond = run(2);
    expect(rerunSecond.status, rerunSecond.stderr).toBe(0);
    expect(rerunSecond.stdout).toContain('skipped 0 of');
    expect(rerunSecond.stdout).toContain('RAN ');
  } finally {
    await destroyGitSandbox(fixture);
  }
}, 150_000);

it('partitions complete browser profiles before per-shard memo reuse and preserves scoped owners', async () => {
  const sandbox = await createRunnerSandbox(BROWSER_SUITES);
  const { scratch: fixture, repo: root } = sandbox;
  try {
    // A tiny, deterministic base lets the real runner persist genuine memo
    // entries; fake npm supplies only the process/report boundary, not selection.
    for (const [file, source] of Object.entries({
      'server/vitest.config.js': 'export default {};',
      'server/vitest.setup.js': 'export {};',
      'scripts/vitestCiPool.js': 'export const vitestCiPool = () => ({});',
      'server/package.json': '{"name":"server"}',
      'server/package-lock.json': '{}',
      'server/node_modules/vitest/package.json': '{"version":"5.0.5"}',
    })) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), source);
    }
    installFakeNpm(fixture, [
      'const fs = require("fs"), path = require("path");',
      'const args = process.argv.slice(2);',
      'const selection = JSON.parse(fs.readFileSync(process.env.PORTOS_CI_TEST_SELECTION, "utf8"));',
      'const report = args.find(a => a.startsWith("--outputFile.json=")).slice("--outputFile.json=".length);',
      'fs.writeFileSync(report, JSON.stringify({ numPassedTests: selection.include.length, numFailedTests: 0,',
      'testResults: selection.include.map(file => ({ name: path.resolve("server", file), status: "passed", assertionResults: [{ status: "passed" }] })) }));',
      'fs.writeFileSync(process.env.PORTOS_CI_DIAGNOSTICS_PATH, JSON.stringify({ reason: "passed", errorCount: 0 }));',
      // The depfile Vitest would merge into: which files the runner seeded, per project.
      `const depfile = ${JSON.stringify(vitestDependenciesPath(root, 'server'))};`,
      'const seeded = fs.existsSync(depfile) ? Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(depfile, "utf8")).projects).map(([name, project]) => [name, Object.keys(project.files).sort()])) : null;',
      // Then what Vitest does with a seeded file: merge the modules the run loaded into its record.
      'if (seeded && args.includes("--experimental.recordDependencies")) fs.writeFileSync(depfile, JSON.stringify({ version: 2, projects: { "": { modules: selection.include,',
      '  files: Object.fromEntries(selection.include.map((file, index) => [file, { at: 1, deps: [index] }])) } } }));',
      'process.stdout.write(JSON.stringify({ args, selection, seeded }) + "\\n");',
    ].join('\n'));
    const run = (index, { profile = 'full', files = BROWSER_SUITES, memo = null, event = 'push' } = {}) => {
      const result = spawnSync(process.execPath, [join(root, 'scripts/run-ci-tests.js'), 'server'], {
        cwd: root, encoding: 'utf8', timeout: 120000,
        env: { ...process.env, PATH: `${fixture}${delimiter}${process.env.PATH}`,
          CI_TEST_MODE: 'files', CI_TEST_FILES: JSON.stringify(files), CI_SHARD: `${index}/2`,
          PORTOS_CI_BROWSER_OWNER: 'browser', PORTOS_BROWSER_TEST_PROFILE: profile,
          PORTOS_TEST_MEMO: memo ? '' : 'off', PORTOS_TEST_MEMO_DIR: memo || '',
          GITHUB_EVENT_NAME: event, GITHUB_ENV: '', GITHUB_STEP_SUMMARY: '' },
      });
      const line = result.stdout.split('\n').find(line => line.startsWith('{"args"'));
      return { ...result, reported: line ? JSON.parse(line) : null };
    };
    // The listing a directory past the limit is keyed from: tracked files and
    // untracked ones a commit would pick up, never what git ignores; no answer outside a checkout.
    // The fixture states its own ignore rules: a runner has no global one for installs or caches.
    writeFileSync(join(root, '.gitignore'), 'ignored.log\nnode_modules\n/server/.cache/\n');
    writeFileSync(join(root, 'ignored.log'), 'local\n');
    writeFileSync(join(root, 'untracked.js'), 'export {};\n');
    const listed = listRepositoryFiles(root);
    expect(listed).toEqual(expect.arrayContaining(['.gitignore', 'untracked.js', 'scripts/run-ci-tests.js', ...BROWSER_SUITES]));
    expect(listed).not.toContain('ignored.log');
    expect(listed.some(file => file.startsWith('server/.cache/') || file.includes('node_modules/'))).toBe(false);
    expect(listRepositoryFiles(fixture)).toBeNull();
    const selections = {};
    for (const profile of ['full', 'smoke']) {
      const runs = [1, 2].map(index => run(index, { profile }));
      for (const result of runs) {
        expect(result.status, result.stderr).toBe(0);
        expect(result.reported.args.some(arg => arg.startsWith('--shard'))).toBe(false);
      }
      const slices = runs.map(result => result.reported.selection.include);
      const expected = BROWSER_SUITES.filter(file => profile !== 'smoke' || !file.endsWith('/musicVideoRichAuthoring.browser.test.js'))
        .map(file => toWorkspacePath('server', file)).sort();
      expect(slices.flat().sort()).toEqual(expected);
      expect(new Set(slices.flat()).size).toBe(expected.length);
      selections[profile] = slices;
    }
    const firstCount = selections.full[0].length;
    const owner = file => selections.full.findIndex(files => files.includes(file));
    expect(owner('services/musicVideo/documentRender.browser.test.js')).not.toBe(owner('services/htmlComposition/index.test.js'));
    // The serial capture and parallel parity suite share an owner so the other
    // runner can absorb the rich authoring and catalog capture workload.
    const animaticOwner = owner('services/musicVideo/animaticCapture.browser.test.js');
    expect(animaticOwner).toBe(owner('services/musicVideo/documentTemplateParity.browser.test.js'));
    expect(animaticOwner).not.toBe(owner('routes/musicVideoRichAuthoring.browser.test.js'));
    const gpu = 'lib/filmLookGpu.browser.test.js';
    expect(owner(gpu)).toBe(0);
    expect(selections.smoke[1]).toContain(gpu);
    expect(selections.smoke[0]).toContain('services/musicVideo/animaticCapture.browser.test.js');
    // A scoped list must retain the canonical owners rather than re-numbering
    // its entries. Memo entries in only one shard must not move another file.
    const subset = BROWSER_SUITES.filter(file => /documentRender|filmLookGpu|htmlComposition|RichAuthoring/.test(file));
    for (const [profile, slices] of Object.entries(selections)) {
      for (const index of [1, 2]) {
        const scoped = run(index, { files: subset, profile });
        expect(scoped.status, scoped.stderr).toBe(0);
        expect(scoped.reported.selection.include).toEqual(slices[index - 1].filter(file => subset.includes(`server/${file}`)));
      }
    }
    // Vitest records nothing for a name-filtered run unless each file has a record to merge
    // into (#16545): a recording run seeds one per file and project, and no other run does.
    for (const result of Object.values(selections).flat()) expect(result).not.toBeNull();
    const depfile = vitestDependenciesPath(root, 'server');
    const staleDepfile = JSON.stringify({ version: 2, projects: { '': { modules: [], files: { 'stale.test.js': { deps: [] } } } } });
    mkdirSync(dirname(depfile), { recursive: true });
    writeFileSync(depfile, staleDepfile);
    const otherDepfile = join(dirname(depfile), '..', 'old-project', 'dependencies.json');
    mkdirSync(dirname(otherDepfile), { recursive: true });
    writeFileSync(otherDepfile, staleDepfile);
    const readOnly = run(1, { memo: join(fixture, 'pull-request-memo'), event: 'pull_request' });
    expect(readOnly.status, readOnly.stderr).toBe(0);
    expect(readOnly.reported.args).not.toContain('--experimental.recordDependencies');
    expect(readFileSync(depfile, 'utf8')).toBe(staleDepfile);
    expect(readFileSync(otherDepfile, 'utf8')).toBe(staleDepfile);
    const memo = join(fixture, 'first-shard-memo');
    const seed = run(1, { memo });
    expect(seed.status, seed.stderr).toBe(0);
    expect(existsSync(otherDepfile)).toBe(false);
    expect(seed.stdout).toMatch(/recorded \d+ green entries/);
    expect(seed.reported.args).toEqual(expect.arrayContaining(['--experimental.recordDependencies', '--testNamePattern=^(?!.*\\[local-performance\\]).*$']));
    expect(seed.reported.seeded).toEqual(Object.fromEntries(VITEST_PROJECT_NAMES.map(name => [name, [...selections.full[0]].sort()])));
    // The filtered run's records feed its own recorded key and carry no digests, so they never narrow another profile's selection.
    const records = readdirSync(join(memo, 'records', 'server')).map(name => JSON.parse(readFileSync(join(memo, 'records', 'server', name), 'utf8')));
    expect(records.map(record => record.test).sort()).toEqual(selections.full[0].map(file => `server/${file}`).sort());
    for (const record of records) expect(record).toEqual({ test: record.test, modules: [record.test], recordedAt: expect.any(String) });
    const recordedDepfile = readFileSync(depfile, 'utf8');
    const reused = run(1, { memo });
    expect(readFileSync(depfile, 'utf8')).toBe(recordedDepfile);
    expect(reused.status, reused.stderr).toBe(0);
    expect(reused.stdout).toContain(`skipped ${firstCount} of ${firstCount} selected files`);
    expect(reused.reported).toBeNull();
    const secondMemo = join(fixture, 'second-shard-memo');
    const fresh = run(2, { memo: secondMemo });
    expect(fresh.status, fresh.stderr).toBe(0);
    expect(fresh.reported.selection.include).toEqual(selections.full[1]);
    const smoke = { profile: 'smoke', event: 'pull_request' };
    const withoutFormerOwner = run(2, { ...smoke, memo: secondMemo });
    expect(withoutFormerOwner.status, withoutFormerOwner.stderr).toBe(0);
    expect(withoutFormerOwner.reported.selection.include).toEqual([gpu]);
    expect(withoutFormerOwner.reported.args).not.toContain('--experimental.recordDependencies');

    const mergedMemo = join(fixture, 'merged-memo');
    expect(mergeTestMemoDirs(mergedMemo, [memo, secondMemo]).sources).toBe(2);
    const withFormerOwner = run(2, { ...smoke, memo: mergedMemo });
    expect(withFormerOwner.status, withFormerOwner.stderr).toBe(0);
    const smokeCount = selections.smoke[1].length;
    expect(withFormerOwner.stdout).toContain(`skipped ${smokeCount} of ${smokeCount} selected files`);
    expect(withFormerOwner.reported).toBeNull();

    writeFileSync(join(root, 'server', gpu), 'export const changed = true;\n');
    const changedInputs = run(2, { ...smoke, memo: mergedMemo });
    expect(changedInputs.status, changedInputs.stderr).toBe(0);
    expect(changedInputs.reported.selection.include).toEqual([gpu]);
    const mixed = run(1, { files: [...BROWSER_SUITES, 'server/lib/example.test.js'] });
    expect(mixed.status).not.toBe(0);
    expect(mixed.stderr).toContain('Unregistered browser shard inputs');
    expect(mixed.reported).toBeNull();
  } finally {
    await destroyGitSandbox(fixture);
  }
}, 150_000);

it('keeps explicit browser selectors with their owner', async () => {
  const browser = 'server/services/musicVideo/documentTemplates/shared/toonWorld.browser.test.js';
  const ordinary = 'scripts/example.test.js';
  const { scratch: fixture, repo: root } = await createRunnerSandbox([browser, ordinary]);
  const run = ({ owner, files }) => spawnSync(process.execPath, [join(root, 'scripts/run-ci-tests.js'), 'server'], {
    cwd: root, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PATH: `${fixture}${delimiter}${process.env.PATH}`, CI_SHARD: '',
      CI_TEST_MODE: 'files', CI_TEST_FILES: JSON.stringify(files), CI_TEST_SOURCES: '[]',
      CI: 'true', PORTOS_CI_BROWSER_OWNER: owner, PORTOS_BROWSER_TEST_PROFILE: undefined,
      PORTOS_TEST_MEMO: 'off', GITHUB_ENV: '', GITHUB_STEP_SUMMARY: '' },
  });
  try {
    expect(BROWSER_SUITES).toContain(browser);
    installFakeNpm(fixture, REPORTING_NPM);
    const unitOnly = run({ owner: 'unit', files: [browser] });
    expect(unitOnly.error).toBeUndefined();
    expect(unitOnly.status, unitOnly.stderr).toBe(0);
    expect(unitOnly.stdout).toContain('No server tests selected');
    expect(unitOnly.stdout).not.toContain('{"args"');

    // A mixed selection still runs its ordinary contract, and dedicated
    // browser / local / Windows callers keep explicitly selected coverage.
    const mixed = run({ owner: 'unit', files: [ordinary, browser] });
    expect(mixed.status, mixed.stderr).toBe(0);
    const selectionOf = (result) => JSON.parse(result.stdout.split('\n').find(line => line.startsWith('{"args"'))).selection.include;
    expect(selectionOf(mixed)).toEqual(['../scripts/example.test.js']);
    const owned = run({ owner: 'browser', files: [browser] });
    expect(owned.status, owned.stderr).toBe(0);
    expect(selectionOf(owned)).toEqual([toWorkspacePath('server', browser)]);
    const local = run({ owner: '', files: [browser] });
    expect(local.status, local.stderr).toBe(0);
    expect(selectionOf(local)).toEqual([toWorkspacePath('server', browser)]);
  } finally {
    await destroyGitSandbox(fixture);
  }
});

it('keeps explicit DB selectors with the DB runner (#13455)', async () => {
  const dbTest = 'server/services/githubNotifications.db.test.js';
  const ordinary = 'scripts/example.test.js';
  const { scratch: fixture, repo: root } = await createRunnerSandbox([dbTest, ordinary]);
  const run = ({ files }) => spawnSync(process.execPath, [join(root, 'scripts/run-ci-tests.js'), 'server'], {
    cwd: root, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PATH: `${fixture}${delimiter}${process.env.PATH}`, CI_SHARD: '',
      CI_TEST_MODE: 'files', CI_TEST_FILES: JSON.stringify(files), CI_TEST_SOURCES: '[]',
      CI: 'true',
      PORTOS_TEST_MEMO: 'off', GITHUB_ENV: '', GITHUB_STEP_SUMMARY: '' },
  });
  try {
    installFakeNpm(fixture, REPORTING_NPM);
    // A mixed selection runs only the ordinary non-DB server contract.
    const mixed = run({ files: [ordinary, dbTest] });
    expect(mixed.status, mixed.stderr).toBe(0);
    const selectionOf = (res) => JSON.parse(res.stdout.split('\n').find(line => line.startsWith('{"args"'))).selection.include;
    expect(selectionOf(mixed)).toEqual(['../scripts/example.test.js']);

    // A DB-only selection prints "No server tests selected" and exits 0 without invoking Vitest.
    const soleDb = run({ files: [dbTest] });
    expect(soleDb.status, soleDb.stderr).toBe(0);
    expect(soleDb.stdout).toContain('No server tests selected');
    expect(soleDb.stdout).not.toContain('{"args"');
  } finally {
    await destroyGitSandbox(fixture);
  }
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

describe('always-run guard time budget through the real runner (#16551, #16996)', () => {
  it('fails the run on a guard or a runner check over budget only when enforced, timed in its own pass, and warns otherwise', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'portos-guard-budget-'));
    try {
      // Every selected file passes. The standalone guard reports a wall time over the CI
      // budget; the runner's total is long, but only its slow check is over, and one more
      // check is over only by the load time the runner logs for it.
      installFakeNpm(fixture, [
        'const fs = require("fs");',
        'const selection = JSON.parse(fs.readFileSync(process.env.PORTOS_CI_TEST_SELECTION, "utf8"));',
        'const out = process.argv.find(a => a.startsWith("--outputFile.json=")).slice("--outputFile.json=".length);',
        `const repo = ${JSON.stringify(join(import.meta.dirname, '..'))};`,
        'const slow = process.env.FAKE_SLOW_GUARD;',
        'const testResults = selection.include.map(rel => rel.endsWith("repo.guard.test.js")',
        '  ? { name: require("path").resolve(repo, "server", rel), status: "passed", startTime: 0, endTime: 9000, assertionResults: [',
        '    { status: "passed", ancestorTitles: ["slowCheck", "case"], duration: slow === "no-such-file" ? 5 : 4500 },',
        '    { status: "passed", ancestorTitles: ["fastCheck", "case"], duration: 5 }] }',
        '  : { name: require("path").resolve(repo, "server", rel), status: "passed", startTime: 0,',
        '    endTime: rel.endsWith(slow) ? 6500 : 10, assertionResults: [{ status: "passed" }] });',
        'if (selection.include.some(rel => rel.endsWith("repo.guard.test.js")) && process.env.PORTOS_GUARD_LOAD_LOG) {',
        '  fs.appendFileSync(process.env.PORTOS_GUARD_LOAD_LOG, JSON.stringify({ runner: "server/test/guards/repo.guard.test.js", check: "fastCheck", ms: slow === "no-such-file" ? 1 : 4600 }) + "\\n");',
        '}',
        'fs.writeFileSync(out, JSON.stringify({ testResults }));',
        'fs.writeFileSync(process.env.PORTOS_CI_DIAGNOSTICS_PATH, JSON.stringify({ reason: "passed", errorCount: 0, errors: [] }));',
        'process.stdout.write("RAN " + JSON.stringify(selection.include) + "\\n");',
      ].join('\n'));
      const guard = 'scripts/node-version-drift.guard.test.js';
      const runner = 'server/test/guards/repo.guard.test.js';
      const scheduled = 'scripts/generate-prompt-stage-call-sites.test.js';
      const other = 'scripts/lib/releaseTitle.test.js';
      const run = (extraEnv) => spawnSync(process.execPath, [join(import.meta.dirname, 'run-ci-tests.js'), 'server'], {
        encoding: 'utf8', timeout: 120000,
        env: { ...process.env, PATH: `${fixture}${delimiter}${process.env.PATH}`, FAKE_SLOW_GUARD: guard,
          CI_TEST_MODE: 'files', CI_TEST_FILES: JSON.stringify([other, guard, runner, scheduled]), CI_TEST_SOURCES: '[]',
          PORTOS_TEST_MEMO: 'off', CI_SHARD: '', CI_GUARD_BUDGET: '', GITHUB_ENV: '', GITHUB_STEP_SUMMARY: '', ...extraEnv },
      });
      const over = `${guard} 6.5s; ${runner} > fastCheck 4.6s; ${runner} > slowCheck 4.5s over the 4.0s per-guard budget.`;
      const ranSets = (stdout) => (stdout.match(/^RAN .*$/gm) ?? []).map((line) => JSON.parse(line.slice(4)).sort());

      const enforced = run({ CI_GUARD_BUDGET: 'enforce' });
      expect(enforced.status).toBe(1);
      expect(enforced.stderr).toContain(`❌ Guard over its time budget: ${over}`);
      expect(ranSets(enforced.stdout)).toEqual([[`../${guard}`, 'test/guards/repo.guard.test.js'], [`../${scheduled}`], [`../${other}`]]);

      const slowScheduled = run({ CI_GUARD_BUDGET: 'enforce', FAKE_SLOW_GUARD: scheduled });
      expect(slowScheduled.status).toBe(1);
      expect(slowScheduled.stderr).toContain(`❌ Guard over its time budget: ${scheduled} 6.5s over the 4.0s per-guard budget.`);

      // Without enforcement (PR, push, release, local pregate, Windows, browser) an over-budget guard only warns:
      // it stays in the one normal pass with the rest of the selection and never fails the run.
      for (const extraEnv of [{}, { CI_GUARD_BUDGET: 'report' }]) {
        const reported = run(extraEnv);
        expect(reported.status, reported.stderr).toBe(0);
        expect(ranSets(reported.stdout)).toEqual([[`../${guard}`, `../${other}`, `../${scheduled}`, 'test/guards/repo.guard.test.js'].sort()]);
        expect(reported.stdout).toContain(`::warning title=Guard over its time budget::${over}`);
        expect(reported.stderr).not.toContain('Guard over its time budget');
      }

      const fast = run({ CI_GUARD_BUDGET: 'enforce', FAKE_SLOW_GUARD: 'no-such-file' });
      expect(fast.status, fast.stderr).toBe(0);
      expect(fast.stdout).toContain(`⏱️ Guards, slowest of 3: ${guard} 0.0s; ${runner} > fastCheck 0.0s; ${runner} > slowCheck 0.0s (budget 4.0s).`);
      expect(fast.stdout).toContain(`⏱️ Guards, slowest of 1: ${scheduled} 0.0s (budget 4.0s).`);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 120_000);

  it('enforces it on the scheduled Linux server run only, and reports it everywhere else', () => {
    const jobs = readCiJobs();
    const expression = "CI_GUARD_BUDGET: ${{ github.event_name == 'schedule' && 'enforce' || 'report' }}";
    expect(Object.entries(jobs).filter(([, body]) => body.includes('CI_GUARD_BUDGET:')).map(([id]) => id)).toEqual(['server']);
    expect(jobs.server).toContain(expression);
  });
});

describe('ci.yml shard wiring', () => {
  // Composite actions expanded: these contracts hold for the steps GitHub runs.
  const CI_JOBS = readCiJobs();
  const runners = Object.entries(CI_JOBS).filter(([, body]) => /(?:run|watch)-ci-tests\.js/.test(body));

  it('uses one server shard selection for both CTC NumPy setup steps', () => {
    const steps = workflowJobs(WORKFLOW).server.split(/^ {6}- name: /m).slice(1);
    const ctc = steps.filter(step => /^(Check CTC test selection|Cache CTC numpy virtualenv|Provide numpy for the CTC Viterbi tests)\n/.test(step));
    expect(ctc).toHaveLength(3);
    expect(ctc[0]).toContain('id: ctc-selection\n        run: node scripts/run-ci-tests.js server --check-ctc');
    for (const step of ctc.slice(1)) expect(step).toContain("if: steps.ctc-selection.outputs.required == 'true'");
    expect(ctc[2]).toContain("-I -c 'import numpy'");
    expect(ctc[2]).toContain('CI_EXPECT_NUMPY_PYTHON=true');
  });

  it('requires NumPy for CTC in related, explicit and full plans on its owning shard', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'portos-check-ctc-'));
    const output = join(fixture, 'github_output');
    const ctc = 'scripts/align_lyrics_ctc.test.js';
    try {
      const related = JSON.parse(execFileSync(process.execPath, [join(import.meta.dirname, 'ci-test-plan.js')], {
        cwd: join(import.meta.dirname, '..'),
        encoding: 'utf8', env: { ...process.env, CI_FORCE_FULL: 'false', CI_BASE_REF: 'main', CI_BASE_SHA: 'HEAD',
          CI_CHANGED_FILES: '["server/lib/testHelper.js"]', GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' },
      }));
      expect(related.server_mode).toBe('related');
      expect(related.server_files).toContain(ctc);
      const requiresNumpy = (mode, files, sources = [], shard = '1/1') => {
        writeFileSync(output, '');
        execFileSync(process.execPath, [join(import.meta.dirname, 'run-ci-tests.js'), 'server', '--check-ctc'], {
          env: { ...process.env, CI_TEST_MODE: mode, CI_TEST_FILES: JSON.stringify(files), CI_TEST_SOURCES: JSON.stringify(sources),
            CI_SHARD: shard, GITHUB_OUTPUT: output, PORTOS_CI_BROWSER_OWNER: 'unit', PORTOS_BROWSER_TEST_PROFILE: undefined },
        });
        return readFileSync(output, 'utf8').trim();
      };
      expect(requiresNumpy(related.server_mode, related.server_files, related.server_sources)).toBe('required=true');
      expect(requiresNumpy('related', [], related.server_sources)).toBe('required=true');
      expect(requiresNumpy('files', [ctc])).toBe('required=true');
      expect(requiresNumpy('files', ['scripts/run-ci-tests.test.js'])).toBe('required=false');
      expect(['1/2', '2/2'].map(shard => requiresNumpy('full', [], [], shard)).sort())
        .toEqual(['required=false', 'required=true']);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('builds every test runner matrix from the planner and hands each slice to the runner', () => {
    expect(runners.map(([id]) => id).sort()).toEqual(['browser', 'client', 'database', 'server', 'windows-server']);
    // Browser ownership has its own balanced canonical partition below.
    // `database` is one serial job (a single `portos_test`), also without a matrix.
    for (const [id, body] of runners.filter(([id]) => id !== 'browser' && id !== 'database')) {
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

  it('memoizes the serial database job through the db scope', () => {
    const body = workflowJobs(WORKFLOW).database;
    const steps = body.split(/^ {6}- name: /m).slice(1);
    const names = steps.map(step => step.split('\n')[0]);
    expect(names).toEqual([
      'Restore the test memo', 'Check remaining DB tests', 'Provision test database (portos_test)',
      'Install PostgreSQL client and audio verification tools', 'Restore a real pg_dump into a scratch database',
      'Run DB-backed tests (portos_test)', 'Save the test memo',
    ]);
    const [memo, plan, provision, tools, restore, run, save] = steps;
    expect(memo).toContain('uses: ./.github/actions/test-memo');
    expect(memo).toContain('partition: db');
    expect(CI_JOBS.database).toMatch(/key: test-memo-[^\n]*-db-\$\{\{ github\.run_id \}\}/);
    expect(plan).toContain('id: db-plan');
    expect(plan).toContain('run: node scripts/run-ci-tests.js db --check-remaining\n');
    expect(run).toContain('run: node scripts/run-ci-tests.js db\n');
    for (const step of [plan, run]) {
      expect(step).toContain('CI_TEST_MODE: full');
      expect(step).toContain('PGDATABASE: portos_test');
      expect(step).toContain('PORTOS_TEST_MEMO_DIR: ${{ runner.temp }}/portos-test-memo');
    }
    const liveRestore = 'fromJSON(needs.impact.outputs.plan).db_live_restore';
    const dbGate = `if: fromJSON(steps.db-plan.outputs.remaining) > 0 || ${liveRestore}\n`;
    for (const step of [provision, tools, run]) expect(step).toContain(dbGate);
    expect(restore).toContain(`if: ${liveRestore}\n`);
    expect(save).toContain('key: ${{ steps.test-memo.outputs.key }}');
    expect(body).toContain("steps.db-tests.outcome == 'success' && github.event_name != 'pull_request'");
  });

  it('runs the planner-selected browser suites on their own job with prerequisites required (#10312)', () => {
    const body = CI_JOBS.browser;
    expect(body).toContain('if: fromJSON(needs.impact.outputs.plan).browser\n');
    const start = body.indexOf('- name: Run cross-workspace browser suites');
    expect(start).toBeGreaterThan(0);
    const step = body.slice(start, body.indexOf('- name:', start + 1));
    expect(body).toContain('shard: ${{ fromJSON(needs.impact.outputs.browser_shards) }}');
    expect(body).toContain('fail-fast: false');
    expect(step).toContain('CI_TEST_MODE: files');
    expect(step).toContain('CI_SHARD: ${{ matrix.shard }}/${{ strategy.job-total }}');
    expect(step).toContain('PORTOS_CI_BROWSER_OWNER: browser');
    expect(body).toContain('-browser-${{ matrix.shard }}of${{ strategy.job-total }}');
    expect(body).toContain('name: animatic-capture-diagnostics-${{ matrix.shard }}of${{ strategy.job-total }}');
    expect(step).toContain('CI_TEST_FILES: ${{ toJSON(fromJSON(needs.impact.outputs.plan).browser_files) }}');
    expect(step).toContain("PORTOS_REQUIRE_BROWSER_SUITES: '1'");
    // The client workspace must be installed before the suites bundle it.
    expect(body.indexOf('npm ci --prefix client')).toBeGreaterThan(0);
    expect(body.indexOf('npm ci --prefix client')).toBeLessThan(start);
    // Restore the test memo and check remaining suites before paying for db-tools or setup-client.
    const memoIndex = body.indexOf('- name: Restore the test memo');
    const planIndex = body.indexOf('- name: Check remaining browser suites');
    const toolsIndex = body.indexOf('- name: Install audio verification tools');
    const recheckIndex = body.indexOf('- name: Recheck browser suites after audio setup');
    const clientIndex = body.indexOf('uses: ./.github/actions/setup-client');
    expect(memoIndex).toBeGreaterThan(0);
    expect(memoIndex).toBeLessThan(planIndex);
    expect(planIndex).toBeLessThan(toolsIndex);
    expect(toolsIndex).toBeLessThan(recheckIndex);
    expect(recheckIndex).toBeLessThan(clientIndex);
    expect(clientIndex).toBeLessThan(start);
    const planStep = body.slice(planIndex, toolsIndex);
    expect(planStep).toContain('id: browser-plan');
    expect(planStep).toContain('run: node scripts/run-ci-tests.js server --check-remaining');
    expect(planStep).toContain("PORTOS_CI_BEFORE_AUDIO_SETUP: '1'");
    expect(body.slice(toolsIndex, recheckIndex)).toContain('if: fromJSON(steps.browser-plan.outputs.remaining) > 0');
    const recheckStep = body.slice(recheckIndex, clientIndex);
    expect(recheckStep).toContain("if: steps.browser-plan.outputs.recheck == 'true'");
    expect(recheckStep).toContain('run: node scripts/run-ci-tests.js server --check-remaining');
    for (const name of ['PORTOS_TEST_MEMO_DIR', 'CI_TEST_MODE', 'CI_SHARD', 'PORTOS_CI_BROWSER_OWNER',
      'CI_TEST_FILES', 'PORTOS_REQUIRE_BROWSER_SUITES', 'PORTOS_TEST_QUIET']) {
      const envLine = step.match(new RegExp(`^ +${name}: .+$`, 'm'))?.[0];
      expect(envLine).toBeDefined();
      expect(planStep).toContain(envLine);
      expect(recheckStep).toContain(envLine);
    }
    const gate = 'if: fromJSON(steps.browser-recheck.outputs.remaining || steps.browser-plan.outputs.remaining) > 0';
    expect(body.slice(clientIndex, start)).toContain(gate);
    expect(step).toContain(gate);
  });

  it('uploads every failed synthetic template comparison without including arbitrary diagnostics', () => {
    const body = CI_JOBS.browser;
    const start = body.indexOf('- name: Retain synthetic template parity pixels and media state');
    expect(start).toBeGreaterThan(0);
    const step = body.slice(start, body.indexOf('- name:', start + 1));
    expect(step).toContain('if: failure()');
    expect(step).toContain('name: template-parity-diagnostics-${{ matrix.shard }}of${{ strategy.job-total }}');
    for (const file of ['native.png', 'engine.png', 'parity.json']) {
      expect(step).toContain('${{ runner.temp }}/portos-ci-diagnostics/portos-vitest-*/template-parity/case-*/' + file);
    }
    expect(step).toContain('retention-days: 7');
    expect(step).not.toContain('/**');
  });

  it('deduplicates only Linux browser ownership and runs PR browser suites as smoke', () => {
    const jobs = CI_JOBS;
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
    // Smoke boot and the production build are not
    // sharded work; on every shard they would triple the cost for no coverage.
    for (const step of ['Smoke-boot server', 'Build client']) {
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
    const jobs = CI_JOBS;
    for (const [id, body] of runners) expect(body, id).not.toContain('run-ci-lint.js');
    expect(jobs.lint).toBeTruthy();
    expect(jobs.lint).toContain('run: node scripts/run-ci-lint.js');
    expect(jobs.lint).not.toContain('strategy:');
    // No `matrix.shard` at all: lint is not a matrix, so a cache key, a step
    // name, above all a shard-pinned `if:` naming it is the regression.
    expect(jobs.lint).not.toMatch(/matrix\.shard/);
    // A scoped plan emits `client_shards: [1]`, so a later-shard pin would skip
    // lint on every impact-scoped pull request. Its gate is the plan's lint mode.
    expect(jobs.lint).toContain("if: fromJSON(needs.impact.outputs.plan).lint_mode != 'skip'");
    // The aggregate gate is the single required check, so a job it does not
    // observe can fail without blocking a merge.
    expect(jobs.gate).toContain('CI_GATE_RESULT_LINT: ${{ needs.lint.result }}');
    expect(jobs.gate).toMatch(/needs: \[[^\]]*\blint\b/);
  });
});

describe('toRunnerPath', () => {
  it('maps repo paths onto each workspace runner root', () => {
    expect(toRunnerPath('client', 'client/src/lib/moduleSummaries.test.js')).toBe('./src/lib/moduleSummaries.test.js');
    expect(toRunnerPath('server', 'server/lib/moduleSummaries.test.js')).toBe('./lib/moduleSummaries.test.js');
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
  // This uniquely pins shutdown after the ordinary reporter snapshot through
  // real Vitest assertions, npm, and the launcher's durable collection boundary.
  it('retains passing assertions and late process exit provenance without changing status (#12536)', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'portos-final-exit-'));
    try {
      writeFileSync(join(fixture, 'fixture.test.js'), "test('passing control', () => expect(true).toBe(true));");
      const lateReporter = join(fixture, 'late-reporter.mjs');
      writeFileSync(lateReporter, `export default function () { return {
        onInit(vitest) { vitest.onClose(() => { process.once('beforeExit', () => { process.exitCode = Number(process.env.FIXTURE_FINAL_CODE); }); }); }
      }; }`);
      writeFileSync(join(fixture, 'vitest.config.mjs'), FIXTURE_CONFIG);
      for (const code of [17, 0]) {
        const durable = join(fixture, 'durable-' + code);
        const args = ['--config', join(fixture, 'vitest.config.mjs'), '--root', fixture, './fixture.test.js', '--reporter=default', '--reporter=' + lateReporter];
        const env = { ...process.env, NODE_ENV: 'test', NODE_DISABLE_COMPILE_CACHE: '1',
          PORTOS_CI_DIAGNOSTICS_DIR: durable, FIXTURE_FINAL_CODE: String(code) };
        delete env.PORTOS_TEST_TEMP_ROOT;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
          import { runNpm } from ${JSON.stringify(new URL('./run-ci-tests.js', import.meta.url).href)};
          process.exitCode = (await runNpm('server', 'test:ci', ${JSON.stringify(args)})).status;
        `], { encoding: 'utf8', timeout: 30_000, env });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(code);
        expect(stripVTControlCharacters(result.stdout)).toMatch(/Test Files\s+1 passed/);
        const attempt = join(durable, readdirSync(durable)[0]);
        const run = JSON.parse(readFileSync(join(attempt, 'run.json'), 'utf8'));
        expect(run).toMatchObject({ reason: 'passed', errorCount: 0,
          processExit: { eventCode: code, exitCode: code } });
        // The diagnostic reporter's close callback ran before the late callback.
        expect(run.exitCode ?? 0).toBe(0);
        const invocation = JSON.parse(readFileSync(join(attempt, 'invocation.json'), 'utf8'));
        expect(invocation).toMatchObject({ completed: true, status: code,
          childExit: { code, signal: null }, childClose: { code, signal: null } });
        expect(['direct npm process', 'cmd.exe -> npm.cmd']).toContain(invocation.commandBoundary);
        expect(invocation.replay).toMatchObject({ scope: 'server', script: 'test:ci', node: process.version, silent: false });
        expect(Number.isInteger(run.workers) && run.workers > 0).toBe(true);
        const { collectTestDiagnostics } = await import('./ci-test-diagnostics.js');
        const lines = await collectTestDiagnostics(durable, { logger: { warn() {} }, diagnose: async () => {}, writeSummary() {} });
        expect(lines.join('\n')).toContain(`Vitest process exit event: code=${code}; exitCode=${code}.`);
        expect(lines.join('\n')).toMatch(new RegExp(`Replay context: head=[a-f0-9]{40}; node=${process.version.replace(/\./g, '\\.')}; scope=server; script=test:ci;.* workers=\\d+;`));
      }
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }, 65_000);

  it('reports a run-level rejection and worker cause when every test passed (#11244)', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'portos-diagnostics-'));
    try {
      const host = join(fixture, 'host');
      mkdirSync(host);
      writeFileSync(join(host, 'host-cache'), 'preserve');
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
      // Host/tool caches are not launcher-owned report roots.
      expect(readdirSync(host).filter(name => /^(?:portos-vitest-|pvt-)/.test(name))).toEqual([]);
      expect(readFileSync(join(host, 'host-cache'), 'utf8')).toBe('preserve');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 35_000);

  it('reports every failing file in one run, with default and GitHub reporters even if their summary is incomplete', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'portos-diagnostics-'));
    try {
      const host = join(fixture, 'host');
      mkdirSync(host);
      writeFileSync(join(host, 'host-cache'), 'preserve');
      const report = join(fixture, 'report.json');
      writeFileSync(join(fixture, 'fixture.test.js'),
        "test('synthetic assertion diagnostic', () => { expect(1, 'synthetic mismatch').toBe(2); });");
      writeFileSync(join(fixture, 'second.test.js'),
        "test('second assertion diagnostic', () => { expect(3, 'second mismatch').toBe(4); });");
      writeFileSync(join(fixture, 'vitest.config.mjs'),
        FIXTURE_CONFIG);
      const runnerUrl = new URL('./run-ci-tests.js', import.meta.url).href;
      const args = ['--config', join(fixture, 'vitest.config.mjs'), '--root', fixture, './fixture.test.js', './second.test.js'];
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
      // Host/tool caches are not launcher-owned report roots.
      expect(readdirSync(host).filter(name => /^(?:portos-vitest-|pvt-)/.test(name))).toEqual([]);
      expect(readFileSync(join(host, 'host-cache'), 'utf8')).toBe('preserve');
      const attempts = readdirSync(durable);
      expect(attempts).toHaveLength(1);
      const invocation = JSON.parse(readFileSync(join(durable, attempts[0], 'invocation.json'), 'utf8'));
      expect(invocation).toMatchObject({ completed: true, status: 1 });
      const progress = JSON.parse(readFileSync(join(durable, attempts[0], 'run.json'), 'utf8'));
      // No bail: the run finishes both files rather than stopping at the first failure.
      expect(progress).toMatchObject({ reason: 'failed', completedCount: 2, activeModules: [] });
      expect(progress.completedModules.sort()).toEqual(['<outside-repository>/fixture.test.js', '<outside-repository>/second.test.js']);
      expect(result.stdout).toContain('Test Files');
      expect(result.stdout).toContain('Tests');
      expect(result.stderr).toContain('Failed Tests');
      // Inspect only the structured fallback, independent of terminal summaries.
      const diagnostic = result.stderr.slice(result.stderr.indexOf('Structured Vitest'));
      expect(diagnostic).toContain('fixture.test.js > synthetic assertion diagnostic');
      expect(diagnostic).toContain('synthetic mismatch');
      expect(diagnostic).toContain('second.test.js > second assertion diagnostic');
      expect(diagnostic).toContain('second mismatch');
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

// A containment report written after the ordinary reporter snapshot must survive
// the launcher's nondurable-attempt cleanup, including otherwise green runs.
it('retains process settlement evidence from a completed launcher attempt', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'process-report-launcher-'));
  let diagnosticsPath;
  try {
    installFakeNpm(fixture, `require('node:fs').writeFileSync(process.env.PORTOS_TEST_PROCESS_DIAGNOSTICS_PATH,
      JSON.stringify({ version: 1, total: 1, terminated: 1, unsettled: 0, processes: [] }));`);
    const { runNpm } = await import('./run-ci-tests.js');
    const result = await runNpm('server', 'test:ci', [], {
      env: { ...process.env, PORTOS_CI_DIAGNOSTICS_DIR: '', PATH: `${fixture}${delimiter}${process.env.PATH}` },
    });
    diagnosticsPath = result.diagnosticsPath;
    expect(result.status).toBe(0);
    expect(diagnosticsPath).toBeTruthy();
    expect(JSON.parse(readFileSync(join(diagnosticsPath, 'processes.json'), 'utf8'))).toMatchObject({ total: 1, terminated: 1 });
  } finally {
    if (diagnosticsPath) rmSync(diagnosticsPath, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
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
    vi.doMock('child_process', async importOriginal => ({ ...await importOriginal(), spawn: () => child }));
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
        .toMatchObject({ completed: false, status: 143, signal: 'SIGTERM', childExit: null, childClose: null });
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
    // SIGTERM shares cancel('SIGTERM') and its 143 status with the SIGUSR2
    // abort case (and the runNpm abort contract above), so it is not repeated.
    for (const signal of ['SIGINT', 'SIGUSR2']) {
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
      // Unreadable unrelated host processes now make automatic reclamation
      // conservative. Prove retirement against the complete fixture inventory.
      sweepStaleRunRoots(host, { prefix: 'portos-vitest-',
        read: ids => readTestProcesses(ids ?? [process.pid, process.ppid, ...descendants, ...runs.map(run => run.child.pid)]) });
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

describe('shouldWarmTestChrome (#17750)', () => {
  const browser = 'client/src/pages/PageLayout.browser.test.js';
  const happy = 'client/src/lib/format.test.js';
  it('skips the warm-up when no browser suite will launch', () => {
    expect(shouldWarmTestChrome({ scope: 'client', run: [happy], env: { CI: 'true' } })).toBe(false);
    expect(shouldWarmTestChrome({ scope: 'client', run: [], env: { CI: 'true' } })).toBe(false);
    expect(shouldWarmTestChrome({ scope: 'server', run: ['server/a.test.js'], env: { CI: 'true' } })).toBe(false);
  });
  it('warms when a client shard runs at least one browser suite', () => {
    expect(shouldWarmTestChrome({ scope: 'client', run: [happy, browser], env: { CI: 'true' } })).toBe(true);
  });
  it('warms for the cross-workspace browser owner only when it has files to run', () => {
    const env = { CI: 'true', PORTOS_CI_BROWSER_OWNER: 'browser' };
    expect(shouldWarmTestChrome({ scope: 'server', run: ['server/a.test.js'], env })).toBe(true);
    expect(shouldWarmTestChrome({ scope: 'server', run: [], env })).toBe(false);
  });
  it('never warms outside CI', () => {
    expect(shouldWarmTestChrome({ scope: 'client', run: [browser], env: {} })).toBe(false);
  });
});

describe('browser shard ownership', () => {
  it.each([1, 2, 3, 4])('covers every registered suite exactly once across %i shards', (count) => {
    for (const profile of ['full', 'smoke']) {
      const slices = Array.from({ length: count }, (_, i) => browserShardSlice(BROWSER_SUITES, { index: i + 1, count }, profile));
      expect(slices.flat().toSorted()).toEqual([...BROWSER_SUITES].toSorted());
    }
  });

  it('gives document render its own runner in both four-shard profiles', () => {
    for (const profile of ['full', 'smoke']) {
      const shard = index => browserShardSlice(BROWSER_SUITES, { index, count: 4 }, profile);
      expect(shard(1)).toEqual(['server/services/musicVideo/documentRender.browser.test.js']);
      expect(shard(3)).toContain('server/services/musicVideo/documentTemplateParity.browser.test.js');
      expect(shard(4)).toContain('server/services/musicVideo/documentRenderGeneration.browser.test.js');
    }
  });

  it('keeps the four heaviest serial capture suites on separate four-shard runners', () => {
    const heavy = [
      'server/services/musicVideo/documentRender.browser.test.js',
      'server/services/htmlComposition/index.test.js',
      'server/services/musicVideo/animaticCapture.browser.test.js',
      'server/lib/filmLookGpu.browser.test.js',
    ];
    const shardOf = (file) => [1, 2, 3, 4].find(index => browserShardSlice(BROWSER_SUITES, { index, count: 4 }, 'smoke').includes(file));
    expect(heavy.map(shardOf)).toEqual([1, 2, 3, 4]);
  });
});
