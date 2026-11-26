#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { killProcessTree, prepareCliSpawn } from '../server/lib/bufferedSpawn.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { sweepStaleRunRoots, writeOwnerFile } from './lib/vitestStaleRunRoots.js';
import { formatErrorAnnotation, formatWarningAnnotation, writeStepOutput, writeStepSummary } from './lib/githubOutput.js';
import { reportWindowsCrashDiagnostics } from './ci-windows-crash-diagnostics.js';
import { RUN_DIAGNOSTIC_MAX_BYTES, SUITE_ERROR_LIMIT, SUITE_ERROR_FIELD_LIMIT, replayContext, replayDiagnostic, diagnosticTestFile, persistTestDiagnostic, processExitDiagnostic } from './ci-test-diagnostics.js';
import { browserShardSlice } from './lib/browserSuites.js';
import { browserProfileAcceptedVerdicts, browserTestProfileArgs, browserTestProfileFiles, assertBrowserProfileExecuted, BROWSER_FIDELITY_ONLY_FILES } from './lib/browserTestProfiles.js';
import {
  clearVitestDependencies, createToolVersionResolver, currentCommit, fileResultsFromReport, findVitestDependenciesFile,
  memoSummaryLine, memoUnrecordedLines, passedTestFiles, planTestMemo, prepareMemoRun, pruneTestMemo, readVitestDependencies, recordTestMemo, seedVitestDependencies, sliceTestCandidates, writeSelectionFile,
} from './lib/testMemoRunner.js';
import { loadFactsCache, saveFactsCache } from './lib/testMemo/factsCache.js';
import { hasMemoEntries, memoDirs, resolveMemoDir } from './lib/testMemoStore.js';
import { SERVED_FILES_ENV, readServedFiles } from './lib/browserServedFiles.js';
import { browserOwnerExcludes, TEST_SCOPES, workspaceOf } from './lib/workspaceTests.js';
import { resolveDbTestFiles } from './lib/dbTestFiles.js';
import { CI_GUARD_BUDGET_MS, describeGuardDurations, guardDurations, overBudgetGuards, readGuardLoads } from './lib/guardBudget.js';
import { getAlwaysRunTests, PROMPT_STAGE_GUARD } from './lib/ciPlanRules.js';
import { isClientBrowserSuite } from './lib/importReach.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// The manifest scan is selected on relevant diffs and in the full suite.
// Give it the scheduled guard budget without making it run on unrelated PRs.

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
 * itself (scripts/lib/testMemoRunner.js serverShardSlice), never by Vitest:
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
  let suiteFailures = [];
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
      if (Array.isArray(run.suiteErrors)) {
        suiteFailures = run.suiteErrors.slice(0, SUITE_ERROR_LIMIT)
          .filter(record => typeof record?.file === 'string' && typeof record.suite === 'string' && typeof record.summary === 'string')
          .map(({ file, suite, summary }) => `FAIL ${diagnosticTestFile(file)} > ${suite.slice(0, SUITE_ERROR_FIELD_LIMIT)}\n${summary.slice(0, SUITE_ERROR_FIELD_LIMIT)}`);
      }
      if (suiteFailures.length) lines.push(`Structured Vitest suite errors (up to ${SUITE_ERROR_LIMIT}):\n${suiteFailures.join('\n')}`);
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
    if (failures.length) {
      lines.push(`Structured Vitest failure diagnostics (up to 10 failures):\n${failures.slice(0, 10).join('\n')}`);
    } else if (suiteFailures.length === 0) {
      lines.push('Inconclusive Vitest diagnostics: structured report contains no failed assertion or suite message.');
    }
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

let deadlineExpired = false;
export const DEADLINE_ENV = 'PORTOS_CI_TEST_DEADLINE_MINUTES';

/**
 * One wall-clock deadline for the whole launcher invocation, read from the
 * environment (#18636). The step timeout alone did not end a hung Windows run
 * and the log was lost; the process that owns the child's pipes can still
 * print the evidence. Returns null when unset or not a positive number.
 *
 * @returns {{ signal: AbortSignal, minutes: number } | null}
 */
export function launcherDeadline(env = process.env) {
  const minutes = Number(env[DEADLINE_ENV]);
  if (!(minutes > 0) || !Number.isFinite(minutes)) return null;
  return { signal: AbortSignal.timeout(Math.round(minutes * 60_000)), minutes };
}

// `scope` here is the workspace npm runs in; `name` is only the runner scope shown on the duration line.
export async function spawnNpm(scope, script, extraArgs, label, {
  run = runNpm, diagnose = reportWindowsCrashDiagnostics, onResult = () => {}, name = scope, signal,
} = {}) {
  // An expired shared deadline between passes must not start another run (runNpm throws on an aborted signal).
  if (signal?.aborted) return 143;
  console.log(`Running ${scope} ${label}${extraArgs.length ? ` (${extraArgs.length} selector argument(s))` : ''}.`);
  const runOptions = signal ? [{ signal }] : [];
  const startedAt = Date.now();
  const profileArgs = browserProfileArgs();
  const result = await run(scope, script, [...extraArgs, ...profileArgs], ...runOptions);
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
  const retry = await run(scope, script, [selector, ...profileArgs, ...extraArgs.filter(arg => arg.startsWith('--'))], ...runOptions);
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
 * Reports the guards in `files` that ran over CI_GUARD_BUDGET_MS: each
 * structural guard runner's checks, and every other guard file whole.
 * With `enforce` (the scheduled hosted run) an over-budget guard returns 1,
 * naming each one; otherwise it is a warning annotation and returns 0. A guard
 * with no reading (it crashed, or ran nothing) is left to the test status,
 * which already fails that run.
 */
function guardBudgetStatus(files, results, loads, { enforce }) {
  const watched = new Set(files);
  const timed = guardDurations(results.filter(({ file }) => watched.has(file)), loads);
  if (enforce && Object.keys(timed).length > 0) console.log(`Guard timings (ms): ${JSON.stringify(timed)}`);
  const slowest = Object.entries(timed).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([file, durationMs]) => ({ file, durationMs }));
  if (slowest.length > 0) console.log(`⏱️ Guards, slowest of ${Object.keys(timed).length}: ${describeGuardDurations(slowest)} (budget ${(CI_GUARD_BUDGET_MS / 1000).toFixed(1)}s).`);
  const over = overBudgetGuards(timed, CI_GUARD_BUDGET_MS);
  if (over.length === 0) return 0;
  const title = 'Guard over its time budget';
  const detail = `${describeGuardDurations(over)} over the ${(CI_GUARD_BUDGET_MS / 1000).toFixed(1)}s per-guard budget. Speed the check up (read the tree through scripts/lib/guardCorpus.js, which lists and reads it once per runner) rather than raising the budget.`;
  if (!enforce) {
    console.log(`⚠️ ${title}, reported only on this run (the scheduled hosted run enforces it): ${detail}`);
    console.log(formatWarningAnnotation(title, detail));
    return 0;
  }
  console.error(`❌ ${title}: ${detail}`);
  console.error(formatErrorAnnotation(title, detail));
  return 1;
}

/**
 * Whether this run will launch the real browser, so CI warms Chrome's install
 * into the page cache only then (#17750). The client shards used to read ~450 MiB
 * on every push, including memo hits and happy-dom-only runs. The cross-workspace
 * browser job (`PORTOS_CI_BROWSER_OWNER=browser`) launches it for any suite it runs.
 */
export function shouldWarmTestChrome({ scope, run, env = process.env }) {
  if (!env.CI || run.length === 0) return false;
  return env.PORTOS_CI_BROWSER_OWNER === 'browser' || (scope === 'client' && run.some(isClientBrowserSuite));
}

// The script is best-effort by contract (never fails the job); a spawn error is ignored the same way.
function warmTestChrome() {
  spawnSync('bash', [join(repoRoot, 'scripts', 'ci-warm-test-chrome.sh')], { stdio: 'inherit' });
}

function parseLauncherInput(cliArgs, env) {
  const preplannedPath = env.PORTOS_CI_PREPLANNED_RUN;
  delete env.PORTOS_CI_PREPLANNED_RUN;
  const checkRemaining = cliArgs.includes('--check-remaining');
  const checkCtc = cliArgs.includes('--check-ctc');
  const positionalArgs = cliArgs.filter(arg => arg !== '--check-remaining' && arg !== '--check-ctc');
  const scope = positionalArgs[0];
  if (positionalArgs.length !== 1 || !Object.hasOwn(TEST_SCOPES, scope) || (checkCtc && (scope !== 'server' || checkRemaining))) {
    console.error('Usage: node scripts/run-ci-tests.js <server|client|db> [--check-remaining] or server --check-ctc');
    process.exit(2);
  }
  const workspace = workspaceOf(scope);
  const { script } = TEST_SCOPES[scope];

  // Pregate's guard stage asks for per-file wall times for this runner only.
  const durationsPath = env.PORTOS_PREGATE_DURATIONS_PATH;
  delete env.PORTOS_PREGATE_DURATIONS_PATH;
  // Set by ci.yml's Linux server job only; a nested runner a test spawns must not inherit it.
  const enforceGuardBudget = env.CI_GUARD_BUDGET === 'enforce';
  delete env.CI_GUARD_BUDGET;
  // Same inheritance rule: a nested launcher a test spawns must not arm its own copy. The signal is created
  // once here so every pass and the crash retry spend the same budget.
  const deadline = launcherDeadline(env);
  delete env[DEADLINE_ENV];
  if (deadline) {
    deadline.signal.addEventListener('abort', () => {
      deadlineExpired = true;
      console.error(`⏱️ Test launcher deadline of ${deadline.minutes} minute(s) (${DEADLINE_ENV}) expired; ending the test process tree.`);
    }, { once: true });
  }
  const mode = env.CI_TEST_MODE || 'full';
  const inputFiles = JSON.parse(env.CI_TEST_FILES || '[]');
  // Explicit planner selectors must respect the same browser and DB ownership as
  // workspace discovery and Vitest.
  const browserExcludes = new Set(scope === 'server'
    ? browserOwnerExcludes({ env }).map(path => `server/${path}`) : []);
  const dbExcludes = new Set(scope === 'server'
    ? resolveDbTestFiles(inputFiles) : []);
  const profile = env.PORTOS_BROWSER_TEST_PROFILE;
  const profileFiles = profile !== undefined ? browserTestProfileFiles(profile, inputFiles) : inputFiles;
  const repoFiles = profileFiles.filter(path => !browserExcludes.has(path) && !dbExcludes.has(path));
  const repoSources = JSON.parse(env.CI_TEST_SOURCES || '[]');
  const selectedFiles = repoFiles.map((path) => toRunnerPath(workspace, path));

  if (!['full', 'files', 'related'].includes(mode)) {
    console.error(`Unsupported CI test mode: ${mode}`);
    process.exit(2);
  }

  if (requiresSourceFiles(mode, repoSources)) {
    console.error('CI_TEST_SOURCES must name at least one changed source file in related-test mode.');
    process.exit(2);
  }

  const browserJob = env.PORTOS_CI_BROWSER_OWNER === 'browser';
  const beforeAudioSetup = browserJob && checkRemaining && env.PORTOS_CI_BEFORE_AUDIO_SETUP === '1';
  const supportsPreplannedRun = scope === 'db' && mode === 'full'
    || browserJob && scope === 'server' && mode === 'files';
  if (preplannedPath && (!supportsPreplannedRun || checkCtc)) {
    throw new Error('Preplanned runs require the DB full suite or the browser files job.');
  }

  let emptySelectionMessage = null;
  if (mode === 'files' && selectedFiles.length === 0) {
    const deferredOnly = profile === 'smoke' && inputFiles.length > 0
      && inputFiles.every(file => BROWSER_FIDELITY_ONLY_FILES.includes(file));
    if (profile !== undefined && !deferredOnly) throw Error('Browser profile selected no executable cases.');
    emptySelectionMessage = `No ${scope} tests selected.${deferredOnly ? ' Fidelity-only inputs require separate evidence.' : ''}`;
  }

  const shardName = env.CI_SHARD;
  const shard = emptySelectionMessage === null ? parseShard(shardName) : null;
  const label = mode === 'full' ? (shard ? `full suite shard ${shardName}` : 'full suite')
    : mode === 'files' ? 'selected tests' : 'related and contract tests';
  return { scope, workspace, script, mode, repoFiles, repoSources, checkCtc, checkRemaining, browserJob,
    beforeAudioSetup, preplannedPath, profile, shard, shardName, label, deadline, durationsPath,
    enforceGuardBudget, emptySelectionMessage };
}

function readPreplannedRun(path, selection, toolVersion) {
  const { run, ffmpeg } = JSON.parse(readFileSync(path, 'utf8')) ?? {};
  const { owned } = sliceTestCandidates(selection);
  const allowed = new Set(owned);
  if (!Array.isArray(run) || new Set(run).size !== run.length || run.some(test => !allowed.has(test))
    || (ffmpeg !== undefined && ffmpeg !== null && typeof ffmpeg !== 'string')) {
    throw new Error(`Invalid preplanned ${selection.scope === 'db' ? 'DB' : 'browser'} test selection for this shard.`);
  }
  // Setup can replace ffmpeg. A previous hit can turn into a miss as well as
  // a miss becoming a hit, so replan with the installed version in either case.
  return ffmpeg === undefined || ffmpeg === toolVersion('ffmpeg') ? run : null;
}

function planLauncherMemo({
  scope, mode, repoFiles, repoSources, shard, profile, browserJob, preplannedPath, checkRemaining, beforeAudioSetup,
}, { memoDir, readOnlyMemo }) {
  // PRs may reuse parsed facts within a job. Only trusted runs may update
  // the memo directory that Actions restores and publishes across jobs.
  const scratchFacts = readOnlyMemo && preplannedPath && process.env.RUNNER_TEMP
    ? join(process.env.RUNNER_TEMP, 'portos-facts-cache') : null;
  const factsDir = [scratchFacts, ...memoDirs(memoDir)].filter(Boolean);
  const caseFilter = browserProfileArgs();
  const acceptVerdictsFrom = profile !== undefined ? browserProfileAcceptedVerdicts(profile) : [];
  const toolVersion = createToolVersionResolver({ verifyAudioPair: browserJob });
  const analysisOptions = { scope, repoRoot, memoDir, caseFilter, toolVersion,
    ...(browserJob ? { requireToolVersions: true, freshToolVersion: createToolVersionResolver({ verifyAudioPair: true }) } : {}) };
  const selection = { scope, mode, repoFiles, repoRoot, shard,
    ...(browserJob ? { shardSlice: (files, shard) => browserShardSlice(files, shard, profile) } : {}) };
  let plan;
  const recheck = browserJob && checkRemaining && !beforeAudioSetup;
  if (preplannedPath && (!checkRemaining || recheck)) {
    const run = readPreplannedRun(preplannedPath, selection, toolVersion);
    if (run !== null) {
      console.log(`Using the preplanned selection of ${run.length} ${browserJob ? 'browser' : 'DB'} test files.`);
      plan = checkRemaining ? { run } : prepareMemoRun(run, { ...analysisOptions, memoDir: readOnlyMemo ? null : memoDir });
    }
  }
  let ffmpeg;
  if (!plan) {
    const beforeToolSetup = beforeAudioSetup || scope === 'db' && checkRemaining;
    const provisionableTool = beforeToolSetup && hasMemoEntries(memoDir) ? 'ffmpeg' : undefined;
    plan = planTestMemo({ ...analysisOptions, ...selection, repoSources, acceptVerdictsFrom,
      planBeforeClientSetup: browserJob && checkRemaining,
      provisionableTool, factsCache: memoDir ? loadFactsCache(factsDir, scope) : null });
    if (memoDir) {
      console.log(memoSummaryLine(plan));
      if (process.env.PORTOS_TEST_MEMO_VERBOSE === '1') {
        for (const { test, via, from } of plan.skipped) console.log(`🧠   skipped ${test} (${via} key${from ? `, ${from} verdict` : ''})`);
      }
    }
    if (preplannedPath && beforeToolSetup && (plan.unsettled > 0
      || plan.skipped.some(({ test, via }) => plan.verdicts.get(test)[via].tools?.has('ffmpeg')))) {
      ffmpeg = toolVersion('ffmpeg');
    }
  }
  if (plan.factsCache && (!readOnlyMemo || scratchFacts)) saveFactsCache(factsDir, scope, plan.factsCache);
  if (preplannedPath && checkRemaining) writeFileSync(preplannedPath, JSON.stringify({ run: plan.run, ffmpeg }));
  return { plan, caseFilter };
}

function buildExecutionPasses(runFiles, label, enforceGuardBudget) {
  // The scheduled run budgets the always-run guard pass and the prompt-stage
  // scan separately. The scan parses the server tree and competes for CPU
  // with the other scanners even when isolated from the broad test shard.
  const alwaysRun = new Set(getAlwaysRunTests());
  const guardRun = runFiles.filter(test => alwaysRun.has(test));
  const promptStageRun = runFiles.includes(PROMPT_STAGE_GUARD) ? [PROMPT_STAGE_GUARD] : [];
  return enforceGuardBudget
    ? [
      [guardRun, `${label}: always-run guards`, guardRun],
      [promptStageRun, `${label}: prompt-stage guard`, promptStageRun],
      [runFiles.filter(test => !alwaysRun.has(test) && test !== PROMPT_STAGE_GUARD), label, []],
    ]
    : [[runFiles, label, guardRun]];
}

async function executeTestPasses(passes, {
  scope, workspace, script, enforceGuardBudget, deadline, durationsPath,
}, { recordDependencies, caseFilter, runFiles }) {
  const extraArgs = recordDependencies ? ['--experimental.recordDependencies'] : [];
  // What each real-Chromium fixture's Vite server served, for the records written below (#17616).
  let servedDir = null;
  if (extraArgs.length) {
    clearVitestDependencies(repoRoot, scope);
    // Vitest records nothing for a case-filtered run unless each file already has a record to merge into.
    if (caseFilter.length) seedVitestDependencies(repoRoot, scope, runFiles);
    servedDir = mkdtempSync(join(tmpdir(), 'portos-served-files-'));
    process.env[SERVED_FILES_ENV] = servedDir;
  }
  let served = new Map();
  const passed = [];
  const results = [];
  // Each structural guard runner logs its checks' load times here (registerGuardChecks).
  const loads = [];
  let interrupted = false;
  const onResult = (result) => {
    if (result.interrupted) interrupted = true;
    for (const { file, durationMs, checks } of result.fileResults ?? []) {
      results.push({ file: relative(repoRoot, file).split(sep).join('/'), durationMs, checks });
    }
    passed.push(...passedTestFiles(result.fileResults ?? [], {
      repoRoot, namePattern: process.env.PORTOS_BROWSER_TEST_PROFILE !== undefined, status: result.status, runReport: result.runReport,
    }));
  };
  let status = 0;
  try {
    for (const [include, passLabel, budgetWatched] of passes) {
      if (interrupted) break;
      if (include.length === 0) continue;
      const selection = writeSelectionFile({ scope, include, exclude: [] });
      process.env.PORTOS_CI_TEST_SELECTION = selection.path;
      const loadLog = join(selection.dir, 'guard-loads.jsonl');
      process.env.PORTOS_GUARD_LOAD_LOG = loadLog;
      try {
        status = (await spawnNpm(workspace, script, extraArgs, passLabel, { name: scope, onResult, signal: deadline?.signal })) || status;
      } finally {
        loads.push(...readGuardLoads(loadLog));
        rmSync(selection.dir, { recursive: true, force: true });
      }
      if (budgetWatched.length > 0) status = guardBudgetStatus(budgetWatched, results, loads, { enforce: enforceGuardBudget }) || status;
    }
  } finally {
    delete process.env.PORTOS_GUARD_LOAD_LOG;
    delete process.env[SERVED_FILES_ENV];
    if (servedDir) {
      served = readServedFiles(servedDir, repoRoot);
      rmSync(servedDir, { recursive: true, force: true });
    }
    if (durationsPath) writeFileSync(durationsPath, JSON.stringify(guardDurations(results, loads)));
  }
  return { status, passed, served };
}

function finalizeTestMemo({ scope, plan, browserJob, memoDir, readOnlyMemo }, { status, passed, served }) {
  // A run that may save its store bounds it first (the cache save follows a green step).
  const pruneMemo = () => {
    if (!memoDir || readOnlyMemo) return;
    const pruned = pruneTestMemo({ memoDir, repoRoot, trustedCi: Boolean(process.env.CI) });
    if (pruned) console.log(`🧠 Test memo: pruned ${pruned.removedEntries} entries and ${pruned.removedRecords} records; kept ${pruned.entries} entries and ${pruned.records} records.`);
  };
  if (!memoDir || passed.length === 0) {
    if (status === 0) pruneMemo();
    return;
  }
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
    served,
    source: process.env.CI ? 'ci' : 'local', commit: currentCommit(repoRoot),
  });
  console.log(`🧠 Test memo: recorded ${written} green entries for ${new Set(passed).size} passed files.`);
  if (browserJob && status === 0 && written > 0) writeStepOutput('memo-written', 'true');
  // A passed file that stores nothing re-runs on every trusted run; say which and why.
  for (const line of memoUnrecordedLines(unrecorded)) console.log(line);
  if (status === 0) pruneMemo();
}

async function main() {
  const input = parseLauncherInput(process.argv.slice(2), process.env);
  const { scope, workspace, script, mode, repoFiles, checkCtc, checkRemaining, beforeAudioSetup,
    preplannedPath, shard, shardName, label, deadline, enforceGuardBudget, browserJob, emptySelectionMessage } = input;
  if (emptySelectionMessage !== null) {
    console.log(emptySelectionMessage);
    if (checkRemaining) {
      if (preplannedPath) writeFileSync(preplannedPath, JSON.stringify({ run: [] }));
      writeStepOutput('remaining', '0');
    }
    if (checkCtc) writeStepOutput('required', 'false');
    process.exitCode = 0;
    return;
  }
  if (checkCtc) {
    // Related mode can reach beyond CI_TEST_FILES. Use its full candidate
    // inventory, which the runner partitions before checking related reach.
    const { owned } = sliceTestCandidates({ scope, mode, repoFiles, repoRoot, shard });
    writeStepOutput('required', String(owned.includes('scripts/ml/align_lyrics_ctc.test.js')));
    return;
  }
  // process.exitCode, not process.exit(): the runner streams the child's
  // output through this process's own stdout/stderr, and process.exit() can
  // terminate before those writes (and this function's own diagnostic lines)
  // finish flushing. Setting exitCode lets Node drain normally once main()
  // returns.
  const memoDir = resolveMemoDir();
  const readOnlyMemo = process.env.GITHUB_EVENT_NAME === 'pull_request';
  if (mode === 'full' && !memoDir && !shard && !checkRemaining && !preplannedPath) {
    process.exitCode = await spawnNpm(workspace, script, [], label, { name: scope, signal: deadline?.signal });
    return;
  }

  const { plan, caseFilter } = planLauncherMemo(input, { memoDir, readOnlyMemo });
  const noTestsMessage = `No ${scope} tests left to run${shard ? ' in this shard' : ''}.`;
  if (checkRemaining) {
    console.log(plan.run.length === 0
      ? noTestsMessage
      : `Remaining ${scope} tests${shard ? ` (shard ${shardName})` : ''}: ${plan.run.length}.`);
    writeStepOutput('remaining', String(plan.run.length));
    // Only a potentially empty shard needs a separate check before client setup.
    if (beforeAudioSetup && plan.unsettled > 0 && plan.unsettled === plan.run.length) {
      console.log('Recheck after audio setup: all remaining memo verdicts may depend on ffmpeg.');
      writeStepOutput('recheck', 'true');
    }
    process.exitCode = 0;
    return;
  }

  const memo = { scope, plan, browserJob, memoDir, readOnlyMemo };
  if (plan.run.length === 0) {
    console.log(noTestsMessage);
    finalizeTestMemo(memo, { status: 0, passed: [] });
    process.exitCode = 0;
    return;
  }
  if (shouldWarmTestChrome({ scope, run: plan.run })) warmTestChrome();
  const passes = buildExecutionPasses(plan.run, label, enforceGuardBudget);
  const execution = await executeTestPasses(passes, input, {
    recordDependencies: Boolean(memoDir) && !readOnlyMemo,
    caseFilter,
    runFiles: plan.run,
  });
  process.exitCode = execution.status;
  finalizeTestMemo(memo, execution);
}

if (isDirectlyInvoked(import.meta.url)) {
  await main();
  // After an expired deadline a detached descendant may still hold a handle (cleanup unverified), which would keep
  // this process alive and the step hanging. Exit once the diagnostics written above have flushed.
  if (deadlineExpired) {
    const code = process.exitCode || 1;
    process.stderr.write('', () => process.stdout.write('', () => process.exit(code)));
  }
}
