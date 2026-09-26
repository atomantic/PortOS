#!/usr/bin/env node

import { spawn } from 'child_process';
import { stripVTControlCharacters } from 'node:util';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { prepareCliSpawn } from '../server/lib/bufferedSpawn.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { writeStepEnv, writeStepSummary } from './lib/githubOutput.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Vitest's own signature for a worker that never returned control at all — a
 * native process abort (Windows `STATUS_*` fail-fast codes such as
 * `0xC0000409`, exit code 3221226505) rather than an assertion failure. That
 * distinction matters: the crashed file printed no test-level output, so a
 * single-file retry tells us whether the crash reproduces or was a one-off
 * runner fault (issue 8152).
 */
const WORKER_CRASH_PATTERN = /Worker exited unexpectedly with exit code \d+.*?while running test file (\S+)/s;

/**
 * Retained tail of the child's combined output, bounded so a full-suite run
 * (thousands of one-line "✓ file.test.js" rows) can't grow this without limit.
 * The crash signature always lands in Vitest's end-of-run "Unhandled Errors"
 * section, so only the tail is ever needed.
 */
const MAX_CAPTURED_OUTPUT = 200_000;

export function extractCrashedTestFile(output) {
  const match = WORKER_CRASH_PATTERN.exec(stripVTControlCharacters(String(output || '')));
  return match ? match[1].trim() : null;
}

/**
 * Turn the absolute path Vitest prints (e.g.
 * `D:/a/PortOS/PortOS/server/services/sprites/importer.test.js` on the
 * Windows runner) into the repo-relative `<workspace>/...` path the rest of
 * this script works in, or `null` when it can't be matched to a workspace
 * this runner knows about.
 */
export function repoRelativeFromCrashPath(crashedPath) {
  const normalized = String(crashedPath || '').replace(/\\/g, '/');
  const match = /\/(server|client)\/(.+)$/.exec(normalized);
  return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * Decide what a nonzero exit from `runNpm` means and, when it's a native
 * Vitest worker crash, what a single-file retry should run — pulled out as a
 * pure function so the crash/retry decision has a real input matrix under
 * test without spawning a process (issue 8152).
 *
 * @returns {{retry: false}|{retry: true, relPath: string, selector: string}}
 */
export function planCrashRetry(scope, output) {
  const crashedPath = extractCrashedTestFile(output);
  if (!crashedPath) return { retry: false };
  const relPath = repoRelativeFromCrashPath(crashedPath);
  if (!relPath || !relPath.startsWith(`${scope}/`)) return { retry: false, crashedPath };
  return { retry: true, relPath, selector: toRunnerPath(scope, relPath) };
}

/**
 * Vitest's own end-of-run summary lines, e.g.:
 *   Test Files  1 failed | 797 passed | 2 skipped (800)
 *        Tests  3 failed | 15074 passed | 61 skipped (15145)
 *       Errors  1 error
 * The crashed file itself is never counted as "failed" (it errored, not
 * failed — see the fixture in run-ci-tests.test.js) and contributes exactly
 * one unhandled error, so a nonzero "failed" count in either summary, or more
 * than one unhandled error, means a REAL, unrelated problem shared the run.
 */
const TEST_FILES_SUMMARY_PATTERN = /Test Files\s+([^\n]+)/;
const TESTS_SUMMARY_PATTERN = /\bTests\s+([^\n]+)/;
const ERRORS_SUMMARY_PATTERN = /Errors\s+(\d+)\s+errors?/;

/**
 * True when the run had a genuine test failure, or more than one unhandled
 * error, alongside (or instead of) a worker crash. A missing summary line
 * fails closed (treated as "yes, there were other failures") so a parsing
 * miss can never mask a real regression.
 */
export function hasOtherTestFailures(output) {
  const text = stripVTControlCharacters(String(output || ''));
  const filesSummary = TEST_FILES_SUMMARY_PATTERN.exec(text);
  const testsSummary = TESTS_SUMMARY_PATTERN.exec(text);
  const errorsSummary = ERRORS_SUMMARY_PATTERN.exec(text);
  if (!filesSummary || !testsSummary || !errorsSummary) return true;
  if (/\d+\s+failed/.test(filesSummary[1])) return true;
  if (/\d+\s+failed/.test(testsSummary[1])) return true;
  return Number(errorsSummary[1]) !== 1;
}

export function requiresSourceFiles(mode, repoSources) {
  return mode === 'related' && repoSources.length === 0;
}

export function toRunnerPath(scope, path) {
  // Prefix in-root selectors so a contributor-controlled filename beginning
  // with "-" cannot be interpreted as another Vitest CLI option.
  if (scope === 'client') return `./${path.replace(/^client\//, '')}`;
  if (path.startsWith('server/')) return `./${path.replace(/^server\//, '')}`;
  return `../${path}`;
}

export function relatedInputs(sourceFiles, selectedFiles) {
  return [...new Set([...sourceFiles, ...selectedFiles])];
}

/**
 * Vitest selector flags for this runner's slice of a full suite. `CI_SHARD` is
 * `<index>/<count>` from the job matrix (ci.yml). A single shard passes nothing,
 * so the one-runner invocation stays identical to a local `npm run test:ci`.
 */
export function shardArgs(shard) {
  if (!shard) return [];
  const match = /^(\d+)\/(\d+)$/.exec(shard);
  if (!match) throw new Error(`CI_SHARD must look like <index>/<count>, got "${shard}"`);
  return match[2] === '1' ? [] : [`--shard=${shard}`];
}

export function recordVitestDuration(scope, label, startedAt) {
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const line = `⏱ ${scope} ${label}: ${seconds}s`;
  console.log(line);
  writeStepSummary(line);
}

/**
 * Run `npm run <script> --prefix <scope> [-- extraArgs]`, streaming stdout and
 * stderr live (so a long CI job keeps showing progress) while also retaining
 * a bounded tail of the combined output for post-run crash detection.
 *
 * @returns {Promise<{status: number, output: string, error?: Error}>}
 */
function runNpm(scope, script, extraArgs) {
  const args = ['run', script, '--prefix', scope];
  if (extraArgs.length > 0) args.push('--', ...extraArgs);
  // Wrapped, not a bare `npm.cmd`: Node refuses to spawn a `.cmd` under
  // `shell:false` and throws EINVAL, so this script could never run on a
  // Windows checkout. See server/lib/bufferedSpawn.js.
  const { command, args: spawnArgs } = prepareCliSpawn('npm', args);
  return new Promise((resolve) => {
    const child = spawn(command, spawnArgs, { env: process.env, cwd: repoRoot });
    let output = '';
    const tee = (stream, chunk) => {
      stream.write(chunk);
      output = (output + chunk).slice(-MAX_CAPTURED_OUTPUT);
    };
    child.stdout.on('data', (chunk) => tee(process.stdout, chunk));
    child.stderr.on('data', (chunk) => tee(process.stderr, chunk));
    child.on('error', (error) => resolve({ status: 1, output, error }));
    child.on('close', (code) => resolve({ status: code ?? 1, output }));
  });
}

async function spawnNpm(scope, script, extraArgs, label) {
  console.log(`Running ${scope} ${label}${extraArgs.length ? ` (${extraArgs.length} selector argument(s))` : ''}.`);
  const startedAt = Date.now();
  const result = await runNpm(scope, script, extraArgs);
  recordVitestDuration(scope, label, startedAt);
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  if (result.status === 0) return 0;

  const plan = planCrashRetry(scope, result.output);
  if (!plan.retry) {
    if (plan.crashedPath) writeStepEnv('CI_CRASHED_TEST_FILE', plan.crashedPath);
    return result.status;
  }
  const { relPath, selector } = plan;

  // A native fail-fast abort, not an assertion — every other file in this run
  // already passed (Vitest's own summary counts it separately from a real
  // failure), so one retry of just the crashed file tells us whether this
  // reproduces or was a one-off runner fault.
  console.warn(`⚠️ Vitest worker crashed natively on ${relPath} — retrying that file once`);
  const retryStartedAt = Date.now();
  const retry = await runNpm(scope, script, [selector]);
  recordVitestDuration(scope, `crash retry: ${relPath}`, retryStartedAt);
  if (!retry.error && retry.status === 0) {
    if (hasOtherTestFailures(result.output)) {
      // The crash retry only clears the crash itself — a real assertion
      // failure elsewhere in the same run must still fail the job.
      console.error(`❌ ${relPath}'s worker crash recovered on retry, but the run also has a real test failure — not masking it`);
      return result.status;
    }
    console.log(`✅ ${relPath} passed on retry — treating the original worker crash as a runner fault, not a regression`);
    return 0;
  }

  if (extractCrashedTestFile(retry.output)) {
    console.error(`❌ ${relPath} crashed again on retry — this reproduces, not a runner fluke`);
    writeStepEnv('CI_CRASHED_TEST_FILE', relPath);
  } else {
    // The retry failed for a different reason (an assertion, a real error) —
    // report it as an ordinary test failure, not a repeat native crash.
    console.error(`❌ ${relPath} failed on retry, but not with the same native crash — treating it as a real failure`);
  }
  return retry.status || result.status;
}

async function main() {
  const scope = process.argv[2];
  if (!['server', 'client'].includes(scope)) {
    console.error('Usage: node scripts/run-ci-tests.js <server|client>');
    process.exit(2);
  }

  const mode = process.env.CI_TEST_MODE || 'full';
  const repoFiles = JSON.parse(process.env.CI_TEST_FILES || '[]');
  const repoSources = JSON.parse(process.env.CI_TEST_SOURCES || '[]');
  const selectedFiles = repoFiles.map((path) => toRunnerPath(scope, path));
  const sourceFiles = repoSources.map((path) => toRunnerPath(scope, path));

  if (!['full', 'files', 'related'].includes(mode)) {
    console.error(`Unsupported CI test mode: ${mode}`);
    process.exit(2);
  }

  if (requiresSourceFiles(mode, repoSources)) {
    console.error('CI_TEST_SOURCES must name at least one changed source file in related-test mode.');
    process.exit(2);
  }

  if (mode === 'full') {
    const shard = shardArgs(process.env.CI_SHARD);
    const label = shard.length ? `full suite shard ${process.env.CI_SHARD}` : 'full suite';
    // process.exitCode, not process.exit(): the runner now streams the
    // child's output through this process's own stdout/stderr, and
    // process.exit() can terminate before those writes (and this function's
    // own diagnostic lines) finish flushing. Setting exitCode lets Node drain
    // normally once main() returns.
    process.exitCode = await spawnNpm(scope, 'test:ci', shard, label);
    return;
  }

  if (mode === 'files') {
    if (selectedFiles.length === 0) {
      console.log(`No ${scope} tests selected.`);
      process.exitCode = 0;
      return;
    }
    process.exitCode = await spawnNpm(scope, 'test:ci', selectedFiles, 'selected tests');
    return;
  }

  // Feed Vitest the actual changed source files instead of asking `list
  // --changed` to print every individual test name into a buffered subprocess.
  // The old discovery pass took 282 seconds on PR #5296, overflowed Node's
  // spawnSync buffer, discarded its work, then reran the same graph. `related`
  // builds that graph once and immediately executes it.
  // A test file passed to `vitest related` is itself selected, so changed tests
  // and structural guards can share the source graph's one Vitest invocation.
  // Running them in a second exact-file process repeated any changed test that
  // already imported the source; on PR #5299 that rebuilt the atlas twice and
  // added 27.5 seconds after the related run had already passed it.
  process.exitCode = await spawnNpm(
    scope,
    'test:ci:related',
    relatedInputs(sourceFiles, selectedFiles),
    'related and contract tests',
  );
}

if (isDirectlyInvoked(import.meta.url)) await main();
