#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { killProcessTree, prepareCliSpawn } from '../server/lib/bufferedSpawn.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { sweepStaleRunRoots, writeOwnerFile } from './lib/vitestStaleRunRoots.js';
import { formatErrorAnnotation, formatWarningAnnotation, writeStepSummary } from './lib/githubOutput.js';
import { reportWindowsCrashDiagnostics } from './ci-windows-crash-diagnostics.js';
import { RUN_DIAGNOSTIC_MAX_BYTES, replayContext, replayDiagnostic, diagnosticTestFile, persistTestDiagnostic, processExitDiagnostic } from './ci-test-diagnostics.js';
import { browserShardSlice } from './lib/browserSuites.js';
import { browserProfileAcceptedVerdicts, browserTestProfileArgs, browserTestProfileFiles, assertBrowserProfileExecuted, BROWSER_FIDELITY_ONLY_FILES } from './lib/browserTestProfiles.js';
import {
  clearVitestDependencies, createToolVersionResolver, currentCommit, fileResultsFromReport, findVitestDependenciesFile,
  memoSummaryLine, memoUnrecordedLines, passedTestFiles, planTestMemo, readVitestDependencies, recordTestMemo, seedVitestDependencies, writeSelectionFile,
} from './lib/testMemoRunner.js';
import { resolveMemoDir } from './lib/testMemoStore.js';
import { browserOwnerExcludes, TEST_SCOPES, workspaceOf } from './lib/workspaceTests.js';
import { resolveDbTestFiles } from './lib/dbTestFiles.js';
import { CI_GUARD_BUDGET_MS, describeGuardDurations, overBudgetGuards } from './lib/guardBudget.js';
import { getAlwaysRunTests } from './lib/ciPlanRules.js';

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
  if (!relPath?.startsWith(`${scope}/`)) return { retry: false, crashedPath };
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

/**
 * This runner's slice of the job matrix. `CI_SHARD` is `<index>/<count>`
 * (ci.yml); a single shard is no shard, so the one-runner invocation stays
 * identical to a local `npm run test:ci`. The slice is taken by the runner
 * itself (scripts/lib/testMemoRunner.js vitestShardSlice), never by Vitest:
 * each shard subtracts a different memo state, and a `--shard` applied after
 * that subtraction could leave a file to no shard at all.
 */
export function parseShard(shard) {
  if (!shard) return null;
  const match = /^(\d+)\/(\d+)$/.exec(shard);
  if (!match) throw new Error(`CI_SHARD must look like <index>/<count>, got "${shard}"`);
  return match[2] === '1' ? null : { index: Number(match[1]), count: Number(match[2]) };
}

/** The run-level report `scripts/vitestRunDiagnostics.js` wrote: `{ reason, errorCount }`, or null. */
function readRunReport(runReportPath) {
  try {
    const run = readCollectionReport(runReportPath);
    return typeof run?.reason === 'string' && Number.isInteger(run.errorCount)
      ? { reason: run.reason, errorCount: run.errorCount } : null;
  } catch { return null; }
}

export function recordVitestDuration(scope, label, startedAt) {
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const line = `⏱ ${scope} ${label}: ${seconds}s`;
  console.log(line);
  writeStepSummary(line);
}

function readInvocation(reportPath) {
  return readCollectionReport(join(dirname(reportPath), 'invocation.json'));
}

/**
 * Recover diagnostics independently of the terminal reporter. Bound both the
 * input and rendered output; diagnostic failures never change the exit status.
 */
export function structuredFailureDiagnostics(reportPath, runReportPath) {
  const lines = [];
  if (runReportPath) {
    try {
      if (statSync(runReportPath).size > RUN_DIAGNOSTIC_MAX_BYTES) throw new Error('run report exceeds limit');
      const run = JSON.parse(readFileSync(runReportPath, 'utf8'));
      if (!Array.isArray(run.errors) || !run.errors.every(error => typeof error === 'string')) {
        throw new Error('invalid run report schema');
      }
      lines.push(replayDiagnostic(readInvocation(reportPath), run));
      lines.push(`Vitest run: reason=${run.reason}, exitCode=${run.exitCode}, unhandledErrors=${run.errorCount}`);
      lines.push(processExitDiagnostic(run));
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
  let processEvidence = false;
  try {
    writeOwnerFile(reportDir);
    const launched = await runNpmWithReport(scope, script, extraArgs, reportPath, env, signal, cancellationTimeoutMs);
    processEvidence = existsSync(join(reportDir, 'processes.json'));
    cleanupUnverified = launched.cleanupUnverified === true;
    if (cleanupUnverified) {
      console.error(`Test launcher cleanup unverified; diagnostics retained at ${reportDir}`);
      return { ...launched, diagnosticsPath: reportDir };
    }
    // Per-file outcomes and the run-level verdict feed the test memo; an interrupted run proves nothing.
    const result = {
      ...launched,
      ...(processEvidence ? { diagnosticsPath: reportDir } : {}),
      fileResults: launched.interrupted ? [] : fileResultsFromReport(reportPath),
      runReport: launched.interrupted ? null : readRunReport(join(reportDir, 'run.json')),
    };
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
    if (!durable && !cleanupUnverified && !processEvidence) rmSync(reportDir, { recursive: true, force: true });
  }
}

function readCollectionReport(path) {
  try {
    if (statSync(path).size > RUN_DIAGNOSTIC_MAX_BYTES) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch { return null; }
}

function runNpmWithReport(scope, script, extraArgs, reportPath, env, abortSignal, cancellationTimeoutMs) {
  const runReportPath = join(dirname(reportPath), 'run.json');
  const invocationPath = join(dirname(reportPath), 'invocation.json');
  const invocation = {
    startedAt: Date.now(), completed: false, scope, script,
    replay: replayContext({ env, scope, script, extraArgs, head: currentCommit(repoRoot, env) }),
    selectors: extraArgs.filter(arg => !arg.startsWith('-')).slice(0, 100)
      .map(arg => diagnosticTestFile(arg.startsWith('../') ? arg.slice(3) : `${scope}/${arg.replace(/^\.\//, '')}`)),
  };
  const args = ['run', script, '--prefix', scope];
  args.push('--', ...extraArgs, '--reporter=json', `--outputFile.json=${reportPath}`,
    `--reporter=${join(repoRoot, 'scripts', 'vitestRunDiagnostics.js')}`);
  // Wrapped, not a bare `npm.cmd`: Node refuses to spawn a `.cmd` under
  // `shell:false` and throws EINVAL, so this script could never run on a
  // Windows checkout. See server/lib/bufferedSpawn.js.
  const { command, args: spawnArgs } = prepareCliSpawn('npm', args, env);
  invocation.commandBoundary = command === 'cmd.exe' ? 'cmd.exe -> npm.cmd' : 'direct npm process';
  persistTestDiagnostic(invocationPath, invocation);
  return new Promise((resolve) => {
    // npm is a launcher, not the entire test tree. Give this invocation its
    // own POSIX group; Windows killProcessTree uses taskkill /T instead. A
    // supervisor (the browser watchdog, or pregate's stage group) instead owns
    // the inherited group, so it can retire npm and Vitest even after this
    // launcher's event loop stopped or the launcher itself was killed.
    const processGroup = process.platform !== 'win32' && env.PORTOS_CI_TEST_SUPERVISED_GROUP !== '1';
    const childEnv = { ...env, PORTOS_CI_DIAGNOSTICS_PATH: runReportPath, PORTOS_TEST_PROCESS_DIAGNOSTICS_PATH: join(dirname(reportPath), 'processes.json') };
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
    let childExit = null;
    let childClose = null;
    child.on('exit', (code, signal) => { childExit = { code, signal }; });
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
      persistTestDiagnostic(invocationPath, { ...invocation, completed: !cleanupUnverified, status, signal: signal ?? interrupted ?? null,
        childExit, childClose });
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
    child.on('close', (code, signal) => {
      childClose = { code, signal };
      finish(code, signal);
    });
  });
}

/** The case-selecting Vitest arguments of the active browser profile; they are also a test-memo key input. */
const browserProfileArgs = () => (process.env.PORTOS_BROWSER_TEST_PROFILE !== undefined
  ? browserTestProfileArgs(process.env.PORTOS_BROWSER_TEST_PROFILE) : []);

// `scope` here is the workspace npm runs in; `name` is only the runner scope shown on the duration line.
export async function spawnNpm(scope, script, extraArgs, label, {
  run = runNpm, diagnose = reportWindowsCrashDiagnostics, onResult = () => {}, name = scope,
} = {}) {
  console.log(`Running ${scope} ${label}${extraArgs.length ? ` (${extraArgs.length} selector argument(s))` : ''}.`);
  const startedAt = Date.now();
  const profileArgs = browserProfileArgs();
  const result = await run(scope, script, [...extraArgs, ...profileArgs]);
  recordVitestDuration(name, label, startedAt);
  onResult(result);
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

  // A native fail-fast abort, not an assertion (Vitest's own summary counts it
  // separately from a real failure), so one retry of just the crashed file tells
  // us whether this reproduces or was a one-off runner fault. The run does not
  // bail, so other files may also have failed; hasOtherTestFailures below keeps
  // a recovered crash from masking those.
  console.warn(`⚠️ Vitest worker crashed natively on ${relPath} — retrying that file once`);
  const retryStartedAt = Date.now();
  // The retry keeps the run's flags (recording, pass-with-no-tests); only the selectors shrink to the crashed file.
  const retry = await run(scope, script, [selector, ...profileArgs, ...extraArgs.filter(arg => arg.startsWith('--'))]);
  recordVitestDuration(name, `crash retry: ${relPath}`, retryStartedAt);
  onResult(retry);
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

/**
 * Reports the always-run guards in `files` that ran over CI_GUARD_BUDGET_MS.
 * With `enforce` (the scheduled hosted run) an over-budget guard returns 1,
 * naming each one; otherwise it is a warning annotation and returns 0. A guard
 * with no reading (it crashed, or ran nothing) is left to the test status,
 * which already fails that run.
 */
function guardBudgetStatus(files, durations, { enforce }) {
  const timed = Object.fromEntries(files.filter(file => typeof durations[file] === 'number').map(file => [file, durations[file]]));
  const slowest = Object.entries(timed).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([file, durationMs]) => ({ file, durationMs }));
  if (slowest.length > 0) console.log(`⏱️ Always-run guards, slowest of ${Object.keys(timed).length}: ${describeGuardDurations(slowest)} (budget ${(CI_GUARD_BUDGET_MS / 1000).toFixed(1)}s).`);
  const over = overBudgetGuards(timed, CI_GUARD_BUDGET_MS);
  if (over.length === 0) return 0;
  const title = 'Always-run guard over its time budget';
  const detail = `${describeGuardDurations(over)} over the ${(CI_GUARD_BUDGET_MS / 1000).toFixed(1)}s per-file budget. Speed the guard up (share one tracked-file listing and one read per source file) rather than raising the budget.`;
  if (!enforce) {
    console.log(`⚠️ ${title}, reported only on this run (the scheduled hosted run enforces it): ${detail}`);
    console.log(formatWarningAnnotation(title, detail));
    return 0;
  }
  console.error(`❌ ${title}: ${detail}`);
  console.error(formatErrorAnnotation(title, detail));
  return 1;
}

async function main() {
  const scope = process.argv[2];
  if (!Object.hasOwn(TEST_SCOPES, scope)) {
    console.error('Usage: node scripts/run-ci-tests.js <server|client|db>');
    process.exit(2);
  }
  const workspace = workspaceOf(scope);
  const { script } = TEST_SCOPES[scope];

  // Pregate's guard stage asks for per-file wall times for this runner only.
  const durationsPath = process.env.PORTOS_PREGATE_DURATIONS_PATH;
  delete process.env.PORTOS_PREGATE_DURATIONS_PATH;
  // Set by ci.yml's Linux server job only; a nested runner a test spawns must not inherit it.
  const enforceGuardBudget = process.env.CI_GUARD_BUDGET === 'enforce';
  delete process.env.CI_GUARD_BUDGET;
  const mode = process.env.CI_TEST_MODE || 'full';
  const inputFiles = JSON.parse(process.env.CI_TEST_FILES || '[]');
  // Explicit planner selectors must respect the same browser and DB ownership as
  // workspace discovery and Vitest.
  const browserExcludes = new Set(scope === 'server'
    ? browserOwnerExcludes().map(path => `server/${path}`) : []);
  const dbExcludes = new Set(scope === 'server'
    ? resolveDbTestFiles(inputFiles) : []);
  const profileFiles = process.env.PORTOS_BROWSER_TEST_PROFILE !== undefined
    ? browserTestProfileFiles(process.env.PORTOS_BROWSER_TEST_PROFILE, inputFiles) : inputFiles;
  const repoFiles = profileFiles.filter(path => !browserExcludes.has(path) && !dbExcludes.has(path));
  const repoSources = JSON.parse(process.env.CI_TEST_SOURCES || '[]');
  const selectedFiles = repoFiles.map((path) => toRunnerPath(workspace, path));

  if (!['full', 'files', 'related'].includes(mode)) {
    console.error(`Unsupported CI test mode: ${mode}`);
    process.exit(2);
  }

  if (requiresSourceFiles(mode, repoSources)) {
    console.error('CI_TEST_SOURCES must name at least one changed source file in related-test mode.');
    process.exit(2);
  }

  if (mode === 'files' && selectedFiles.length === 0) {
    const profile = process.env.PORTOS_BROWSER_TEST_PROFILE;
    const deferredOnly = profile === 'smoke' && inputFiles.length > 0
      && inputFiles.every(file => BROWSER_FIDELITY_ONLY_FILES.includes(file));
    if (profile !== undefined && !deferredOnly) throw Error('Browser profile selected no executable cases.');
    console.log(`No ${scope} tests selected.${deferredOnly ? ' Fidelity-only inputs require separate evidence.' : ''}`);
    process.exitCode = 0;
    return;
  }

  const shard = parseShard(process.env.CI_SHARD);
  const label = mode === 'full' ? (shard ? `full suite shard ${process.env.CI_SHARD}` : 'full suite')
    : mode === 'files' ? 'selected tests' : 'related and contract tests';
  // process.exitCode, not process.exit(): the runner streams the child's
  // output through this process's own stdout/stderr, and process.exit() can
  // terminate before those writes (and this function's own diagnostic lines)
  // finish flushing. Setting exitCode lets Node drain normally once main()
  // returns.
  const memoDir = resolveMemoDir();
  const readOnlyMemo = process.env.GITHUB_EVENT_NAME === 'pull_request';
  if (mode === 'full' && !memoDir && !shard) {
    process.exitCode = await spawnNpm(workspace, script, [], label, { name: scope });
    return;
  }

  // The selection is closure-based (scripts/lib/testMemo.js): in related
  // mode a test is selected when a changed source is in its module closure
  // or inputs, or that walk fails closed on an unresolved edge or unbounded
  // read. The selection also includes the planner's explicit files.
  // Vitest used to resolve `related` itself from CI_TEST_SOURCES; computing
  // the set here is what lets the memo subtract the files a trusted green
  // run already verified, and the list reaches Vitest as a file because a
  // related set can exceed the Windows command-line limit.
  const caseFilter = browserProfileArgs();
  const acceptVerdictsFrom = process.env.PORTOS_BROWSER_TEST_PROFILE !== undefined
    ? browserProfileAcceptedVerdicts(process.env.PORTOS_BROWSER_TEST_PROFILE) : [];
  const plan = planTestMemo({ scope, mode, repoFiles, repoSources, memoDir, repoRoot, shard, caseFilter, acceptVerdictsFrom,
    ...(process.env.PORTOS_CI_BROWSER_OWNER === 'browser' ? { shardSlice: browserShardSlice } : {}),
    toolVersion: createToolVersionResolver() });
  if (memoDir) {
    console.log(memoSummaryLine(plan));
    if (process.env.PORTOS_TEST_MEMO_VERBOSE === '1') {
      for (const { test, via, from } of plan.skipped) console.log(`🧠   skipped ${test} (${via} key${from ? `, ${from} verdict` : ''})`);
    }
  }
  if (plan.run.length === 0) {
    console.log(`No ${scope} tests left to run${shard ? ' in this shard' : ''}.`);
    process.exitCode = 0;
    return;
  }
  // The always-run guards' per-file budget (#16551, #16810). Only the scheduled
  // hosted run enforces it, and only there do the guards run first as their own
  // Vitest pass, so a related or full selection's heavy suites do not stretch
  // their wall times. Every other run keeps them in the one pass with the rest
  // of the selection and reports an over-budget guard as a warning.
  const alwaysRun = new Set(getAlwaysRunTests());
  const guardRun = enforceGuardBudget ? plan.run.filter(test => alwaysRun.has(test)) : [];
  const budgetWatched = enforceGuardBudget ? guardRun : plan.run.filter(test => alwaysRun.has(test));
  const rest = plan.run.filter(test => !guardRun.includes(test));
  const passes = guardRun.length > 0 && rest.length > 0
    ? [[guardRun, `${label}: always-run guards`], [rest, label]] : [[plan.run, label]];
  const extraArgs = memoDir && !readOnlyMemo ? ['--experimental.recordDependencies'] : [];
  if (extraArgs.length) {
    clearVitestDependencies(repoRoot, scope);
    // Vitest records nothing for a case-filtered run unless each file already has a record to merge into.
    if (caseFilter.length) seedVitestDependencies(repoRoot, scope, plan.run);
  }
  const passed = [];
  const durations = {};
  let interrupted = false;
  const onResult = (result) => {
    if (result.interrupted) interrupted = true;
    for (const { file, durationMs } of result.fileResults ?? []) {
      if (durationMs !== null) durations[relative(repoRoot, file).split(sep).join('/')] = durationMs;
    }
    passed.push(...passedTestFiles(result.fileResults ?? [], {
      repoRoot, namePattern: process.env.PORTOS_BROWSER_TEST_PROFILE !== undefined, status: result.status, runReport: result.runReport,
    }));
  };
  let status = 0;
  try {
    for (const [index, [include, passLabel]] of passes.entries()) {
      if (interrupted) break;
      const selection = writeSelectionFile({ scope, include, exclude: [] });
      process.env.PORTOS_CI_TEST_SELECTION = selection.path;
      try {
        status = (await spawnNpm(workspace, script, extraArgs, passLabel, { name: scope, onResult })) || status;
      } finally {
        rmSync(selection.dir, { recursive: true, force: true });
      }
      if (index === 0 && budgetWatched.length > 0) status = guardBudgetStatus(budgetWatched, durations, { enforce: enforceGuardBudget }) || status;
    }
  } finally {
    if (durationsPath) writeFileSync(durationsPath, JSON.stringify(durations));
  }
  process.exitCode = status;
  if (!memoDir || passed.length === 0) return;
  // PR jobs restore trusted memos, but ci.yml never saves their new entries.
  // Avoid expensive post-success closure hashing/writes that cannot be reused
  // and can consume the Windows step deadline after every test already passed.
  if (readOnlyMemo) {
    console.log('🧠 Test memo: read-only for pull requests; no cache publication.');
    return;
  }
  const { written, unrecorded } = recordTestMemo({
    scope, repoRoot, memoDir, plan, passed: [...new Set(passed)],
    dependencies: readVitestDependencies(findVitestDependenciesFile(repoRoot, scope), scope),
    source: process.env.CI ? 'ci' : 'local', commit: currentCommit(repoRoot),
  });
  console.log(`🧠 Test memo: recorded ${written} green entries for ${new Set(passed).size} passed files.`);
  // A passed file that stores nothing re-runs on every trusted run; say which and why.
  for (const line of memoUnrecordedLines(unrecorded)) console.log(line);
}

if (isDirectlyInvoked(import.meta.url)) await main();
