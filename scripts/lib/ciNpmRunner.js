/** Run npm test processes under supervision, with bounded output and a single native-crash retry. */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { killProcessTree, prepareCliSpawn } from '../../server/lib/bufferedSpawn.js';
import { reportWindowsCrashDiagnostics } from '../ci-windows-crash-diagnostics.js';
import { replayContext, diagnosticTestFile, persistTestDiagnostic } from '../ci-test-diagnostics.js';
import { assertBrowserProfileExecuted, browserTestProfileArgs } from './browserTestProfiles.js';
import { readRunReport, recordVitestDuration, structuredFailureDiagnostics } from './ciTestDiagnosticsFormat.js';
import { formatErrorAnnotation } from './githubOutput.js';
import { currentCommit, fileResultsFromReport } from './testMemoRunner.js';
import { sweepStaleRunRoots, writeOwnerFile } from './vitestStaleRunRoots.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

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

export function toRunnerPath(scope, path) {
  // Prefix in-root selectors so a contributor-controlled filename beginning
  // with "-" cannot be interpreted as another Vitest CLI option.
  if (path.startsWith(`${scope}/`)) return `./${path.slice(scope.length + 1)}`;
  return `../${path}`;
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
export const browserProfileArgs = () => (process.env.PORTOS_BROWSER_TEST_PROFILE !== undefined
  ? browserTestProfileArgs(process.env.PORTOS_BROWSER_TEST_PROFILE) : []);

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
