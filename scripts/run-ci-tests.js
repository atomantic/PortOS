#!/usr/bin/env node

import { spawn } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { killProcessTree, prepareCliSpawn } from '../server/lib/bufferedSpawn.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { sweepStaleRunRoots, writeOwnerFile } from './lib/vitestStaleRunRoots.js';
import { formatErrorAnnotation, writeStepSummary } from './lib/githubOutput.js';
import { reportWindowsCrashDiagnostics } from './ci-windows-crash-diagnostics.js';
import { diagnosticTestFile, persistTestDiagnostic } from './ci-test-diagnostics.js';
import { browserTestProfileArgs, browserTestProfileFiles, assertBrowserProfileExecuted, BROWSER_FIDELITY_ONLY_FILES } from './lib/browserTestProfiles.js';

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
  if (path.startsWith(`${scope}/`)) return `./${path.slice(scope.length + 1)}`;
  return `../${path}`;
}

export function relatedInputs(sourceFiles, selectedFiles) {
  return [...new Set([...sourceFiles, ...selectedFiles])];
}

/**
 * Vitest selector flags for this runner's slice of the selected suite. `CI_SHARD` is
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
 * Recover diagnostics independently of the terminal reporter. Bound both the
 * input and rendered output; diagnostic failures never change the exit status.
 */
export function structuredFailureDiagnostics(reportPath, runReportPath) {
  const lines = [];
  if (runReportPath) {
    try {
      if (statSync(runReportPath).size > 160_000) throw new Error('run report exceeds limit');
      const run = JSON.parse(readFileSync(runReportPath, 'utf8'));
      if (!Array.isArray(run.errors) || !run.errors.every(error => typeof error === 'string')) {
        throw new Error('invalid run report schema');
      }
      lines.push(`Vitest run: reason=${run.reason}, exitCode=${run.exitCode}, unhandledErrors=${run.errorCount}`);
      if (run.teardownTimeout) lines.push('Vitest teardown timed out.');
      if (run.errors.length) lines.push(`Vitest unhandled errors (up to 10):\n${run.errors.slice(0, 10).map(error => error.slice(0, 8000)).join('\n')}`);
    } catch {
      lines.push('Vitest run diagnostics unavailable: report missing, malformed, or oversized.');
    }
  }
  try {
    if (statSync(reportPath).size > 32 * 1024 * 1024) throw new Error('report exceeds 32 MiB');
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    if (!Array.isArray(report?.testResults)) throw new Error('invalid report schema');
    const failures = [];
    for (const suite of report.testResults) {
      if (typeof suite?.name !== 'string' || !Array.isArray(suite.assertionResults)) {
        throw new Error('invalid suite schema');
      }
      for (const assertion of suite.assertionResults) {
        if (assertion.status !== 'failed') continue;
        if (typeof assertion.fullName !== 'string' || !Array.isArray(assertion.failureMessages)
          || !assertion.failureMessages.every(message => typeof message === 'string')) {
          throw new Error('invalid assertion schema');
        }
        failures.push(`FAIL ${suite.name} > ${assertion.fullName}\n${assertion.failureMessages.join('\n')}`.slice(0, 8000));
        if (failures.length === 10) break;
      }
      if (suite.status === 'failed' && suite.message) {
        failures.push(`FAIL ${suite.name}\n${String(suite.message)}`.slice(0, 8000));
      }
      if (failures.length >= 10) break;
    }
    lines.push(failures.length
      ? `Structured Vitest failure diagnostics (up to 10 failures):\n${failures.slice(0, 10).join('\n')}`
      : 'Inconclusive Vitest diagnostics: structured report contains no failed assertion or suite message.');
  } catch {
    lines.push('Inconclusive Vitest diagnostics: structured report is missing, malformed, or exceeds 32 MiB.');
  }
  return lines.join('\n');
}

/**
 * Run `npm run <script> --prefix <scope> [-- extraArgs]`, streaming stdout and
 * stderr live (so a long CI job keeps showing progress) while also retaining
 * a bounded tail of the combined output for post-run crash detection.
 *
 * @returns {Promise<{status: number, output: string, interrupted?: NodeJS.Signals, error?: Error, cleanupUnverified?: boolean, diagnosticsPath?: string}>}
 */
export async function runNpm(scope, script, extraArgs, { env = process.env, signal, cancellationTimeoutMs = 10000 } = {}) {
  signal?.throwIfAborted();
  // Opt-in, job-owned storage survives an abruptly terminated launcher. Keep
  // separate roots for the initial attempt and the existing single retry.
  const durableRoot = env.PORTOS_CI_DIAGNOSTICS_DIR;
  let hostRoot = tmpdir();
  if (durableRoot) {
    try { mkdirSync(durableRoot, { recursive: true }); hostRoot = durableRoot; }
    catch { console.error('Durable CI test diagnostics unavailable; using temporary reports.'); }
  }
  const durable = hostRoot === durableRoot;
  if (!durable) sweepStaleRunRoots(hostRoot, { prefix: 'portos-vitest-' });
  const reportDir = mkdtempSync(join(hostRoot, 'portos-vitest-'));
  const reportPath = join(reportDir, 'failures.json');
  let cleanupUnverified = false;
  try {
    writeOwnerFile(reportDir);
    const result = await runNpmWithReport(scope, script, extraArgs, reportPath, env, signal, cancellationTimeoutMs);
    cleanupUnverified = result.cleanupUnverified === true;
    if (cleanupUnverified) {
      console.error(`Test launcher cleanup unverified; diagnostics retained at ${reportDir}`);
      return { ...result, diagnosticsPath: reportDir };
    }
    const profile = env.PORTOS_BROWSER_TEST_PROFILE;
    if (profile !== undefined && result.status === 0) {
      try {
        assertBrowserProfileExecuted(profile, JSON.parse(readFileSync(reportPath, 'utf8')));
      } catch (error) {
        console.error(`Browser profile evidence rejected: ${error.message}`);
        return { ...result, status: 1 };
      }
    }
    return result;
  } finally {
    if (!durable && !cleanupUnverified) rmSync(reportDir, { recursive: true, force: true });
  }
}

function runNpmWithReport(scope, script, extraArgs, reportPath, env, abortSignal, cancellationTimeoutMs) {
  const runReportPath = join(dirname(reportPath), 'run.json');
  const invocationPath = join(dirname(reportPath), 'invocation.json');
  const invocation = {
    startedAt: Date.now(), completed: false, scope, script,
    selectors: extraArgs.filter(arg => !arg.startsWith('-')).slice(0, 100)
      .map(arg => diagnosticTestFile(arg.startsWith('../') ? arg.slice(3) : `${scope}/${arg.replace(/^\.\//, '')}`)),
  };
  persistTestDiagnostic(invocationPath, invocation);
  const args = ['run', script, '--prefix', scope];
  args.push('--', ...extraArgs, '--reporter=json', `--outputFile.json=${reportPath}`,
    `--reporter=${join(repoRoot, 'scripts', 'vitestRunDiagnostics.js')}`);
  // Wrapped, not a bare `npm.cmd`: Node refuses to spawn a `.cmd` under
  // `shell:false` and throws EINVAL, so this script could never run on a
  // Windows checkout. See server/lib/bufferedSpawn.js.
  const { command, args: spawnArgs } = prepareCliSpawn('npm', args, env);
  return new Promise((resolve) => {
    // npm is a launcher, not the entire test tree. Give this invocation its
    // own POSIX group; Windows killProcessTree uses taskkill /T instead. The
    // browser supervisor instead owns the inherited group, so its independent
    // watchdog can retire npm even if this launcher's event loop is stopped.
    const processGroup = process.platform !== 'win32' && env.PORTOS_CI_TEST_SUPERVISED_GROUP !== '1';
    const childEnv = { ...env, PORTOS_CI_DIAGNOSTICS_PATH: runReportPath };
    // Only the workflow launcher owns durable attempts. Nested launcher
    // fixtures must not overwrite or add to the job's failure provenance.
    delete childEnv.PORTOS_CI_DIAGNOSTICS_DIR;
    delete childEnv.PORTOS_CI_TEST_SUPERVISED_GROUP;
    const child = spawn(command, spawnArgs, {
      env: childEnv, cwd: repoRoot, detached: processGroup,
    });
    let interrupted;
    let escalation;
    let spawnError;
    let cancellationDeadline;
    let settled = false;
    let cleanupUnverified = false;
    const cancel = (signal) => {
      if (interrupted) return;
      interrupted = signal;
      killProcessTree(child, signal, { processGroup });
      escalation = setTimeout(() => {
        killProcessTree(child, 'SIGKILL', { processGroup });
      }, 2000);
      if (abortSignal) cancellationDeadline = setTimeout(() => {
        cleanupUnverified = true;
        spawnError = new Error('Owned test launcher cleanup unverified after cancellation.');
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish(null, null);
      }, cancellationTimeoutMs);
    };
    const onSigint = () => cancel('SIGINT');
    const onSigterm = () => cancel('SIGTERM');
    const onAbort = () => cancel('SIGTERM');
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    if (abortSignal?.aborted) onAbort();
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    let output = '';
    const tee = (stream, chunk) => {
      stream.write(chunk);
      output = (output + chunk).slice(-MAX_CAPTURED_OUTPUT);
    };
    child.stdout.on('data', (chunk) => tee(process.stdout, chunk));
    child.stderr.on('data', (chunk) => tee(process.stderr, chunk));
    // A spawn error also emits close. Settle only there, after the pipes close.
    child.on('error', (error) => { spawnError = error; });
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(escalation);
      clearTimeout(cancellationDeadline);
      if (interrupted) {
        // npm may close before a descendant that detached its stdio. Finish
        // the owned group as well, including children that ignored SIGTERM.
        killProcessTree(child, 'SIGKILL', { processGroup });
      }
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      abortSignal?.removeEventListener('abort', onAbort);
      const status = interrupted ? (interrupted === 'SIGINT' ? 130 : 143) : code ?? 1;
      persistTestDiagnostic(invocationPath, { ...invocation, completed: !cleanupUnverified, status, signal: signal ?? interrupted ?? null });
      if (status !== 0) {
        console.error(`Test launcher exited: code=${code}, signal=${signal ?? 'none'}${interrupted ? `, interrupted=${interrupted}` : ''}`);
        console.error(structuredFailureDiagnostics(reportPath, runReportPath));
        // Also retain teardown/worker output emitted after the reporter's last
        // hook, including exit codes unavailable through the reporter API.
        console.error(`Vitest output tail (last 16000 characters):\n${stripVTControlCharacters(output).slice(-16_000)}`);
      }
      resolve({ status, output, ...(interrupted ? { interrupted } : {}), ...(spawnError ? { error: spawnError } : {}),
        ...(cleanupUnverified ? { cleanupUnverified: true } : {}) });
    };
    child.on('close', finish);
  });
}

export async function spawnNpm(scope, script, extraArgs, label, {
  run = runNpm, diagnose = reportWindowsCrashDiagnostics,
} = {}) {
  console.log(`Running ${scope} ${label}${extraArgs.length ? ` (${extraArgs.length} selector argument(s))` : ''}.`);
  const startedAt = Date.now();
  const profileArgs = process.env.PORTOS_BROWSER_TEST_PROFILE !== undefined
    ? browserTestProfileArgs(process.env.PORTOS_BROWSER_TEST_PROFILE) : [];
  const result = await run(scope, script, [...extraArgs, ...profileArgs]);
  recordVitestDuration(scope, label, startedAt);
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  if (result.status === 0) return 0;
  if (result.interrupted) return result.status;

  if (extractCrashedTestFile(result.output)) await diagnose(startedAt);

  const plan = planCrashRetry(scope, result.output);
  if (!plan.retry) {
    if (plan.crashedPath) console.error(formatErrorAnnotation('Vitest worker crashed', `The worker crashed natively on ${plan.crashedPath}`));
    return result.status;
  }
  const { relPath, selector } = plan;

  // A native fail-fast abort, not an assertion — every other file in this run
  // already passed (Vitest's own summary counts it separately from a real
  // failure), so one retry of just the crashed file tells us whether this
  // reproduces or was a one-off runner fault.
  console.warn(`⚠️ Vitest worker crashed natively on ${relPath} — retrying that file once`);
  const retryStartedAt = Date.now();
  const retry = await run(scope, script, [selector, ...profileArgs]);
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
    await diagnose(retryStartedAt);
    console.error(`❌ ${relPath} crashed again on retry — this reproduces, not a runner fluke`);
    console.error(formatErrorAnnotation('Vitest worker crashed', `The worker crashed natively on ${relPath}, again on retry`));
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
  const inputFiles = JSON.parse(process.env.CI_TEST_FILES || '[]');
  const repoFiles = process.env.PORTOS_BROWSER_TEST_PROFILE !== undefined
    ? browserTestProfileFiles(process.env.PORTOS_BROWSER_TEST_PROFILE, inputFiles) : inputFiles;
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
      const profile = process.env.PORTOS_BROWSER_TEST_PROFILE;
      const deferredOnly = profile === 'smoke' && inputFiles.length > 0
        && inputFiles.every(file => BROWSER_FIDELITY_ONLY_FILES.includes(file));
      if (profile !== undefined && !deferredOnly) throw Error('Browser profile selected no executable cases.');
      console.log(`No ${scope} tests selected.${deferredOnly ? ' Fidelity-only inputs require separate evidence.' : ''}`);
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
    [...relatedInputs(sourceFiles, selectedFiles), ...shardArgs(process.env.CI_SHARD)],
    'related and contract tests',
  );
}

if (isDirectlyInvoked(import.meta.url)) await main();
