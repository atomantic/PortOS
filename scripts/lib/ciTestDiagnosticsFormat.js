/** Format bounded Vitest run diagnostics and publish CI test timings. */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RUN_DIAGNOSTIC_MAX_BYTES, SUITE_ERROR_LIMIT, SUITE_ERROR_FIELD_LIMIT, replayDiagnostic, diagnosticTestFile, processExitDiagnostic } from '../ci-test-diagnostics.js';
import { writeStepSummary } from './githubOutput.js';

function readCollectionReport(path) {
  try {
    if (statSync(path).size > RUN_DIAGNOSTIC_MAX_BYTES) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch { return null; }
}

/** The run-level report `scripts/vitestRunDiagnostics.js` wrote: `{ reason, errorCount }`, or null. */
export function readRunReport(runReportPath) {
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
