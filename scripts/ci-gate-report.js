#!/usr/bin/env node

/**
 * The CI gate's verdict, with CANCELLED told apart from FAILED.
 *
 * The gate used to collapse every non-`success`/`skipped` needs-result into
 * one "did not pass" line, so a run that GitHub cancelled out from under us
 * read exactly like a red test suite (#7437). That sends the next reader
 * hunting for a failing assertion that does not exist, and it hides the one
 * fact that decides what to do next: whether anything actually failed.
 *
 * Three verdicts, not two:
 *   - pass       — every selected job was `success` or `skipped`.
 *   - cancelled  — at least one job was `cancelled` and NOTHING failed. The
 *                  run was stopped externally (or superseded); there is no
 *                  test failure to chase. Still non-zero: a cancelled run
 *                  proves nothing and must not be merged.
 *   - failure    — at least one job genuinely failed. Cancelled siblings are
 *                  reported as collateral, because `Cancel sibling CI jobs
 *                  after failure` cancels them on purpose.
 *
 * Reads `CI_GATE_RESULT_<JOB>` out of the environment rather than taking
 * arguments, so adding a job to the gate is one workflow line and no code
 * change. Builtins only — the gate job checks out the repo but never installs
 * dependencies (scripts/pre-install-entrypoints.test.js enforces it).
 */

import { isDirectlyInvoked } from './lib/directInvocation.js';
import { writeStepSummary } from './lib/githubOutput.js';

const RESULT_ENV_PREFIX = 'CI_GATE_RESULT_';
/** GitHub's `needs.<job>.result` values that do not block the gate. */
const PASSING_RESULTS = new Set(['success', 'skipped']);
const TROUBLESHOOTING_ANCHOR = '"CI cancelled with no successor run" in docs/TROUBLESHOOTING.md';

/**
 * Read the `CI_GATE_RESULT_<JOB>` variables into `{ jobId: result }`.
 *
 * `CI_GATE_RESULT_WINDOWS_SERVER` names the `windows-server` job: GitHub
 * expression syntax cannot produce a hyphen in an env key, so the workflow
 * spells it with an underscore and the job id is restored here.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Array<{job: string, result: string}>} declaration order preserved
 */
export function collectGateResults(env = process.env) {
  return Object.entries(env)
    .filter(([key]) => key.startsWith(RESULT_ENV_PREFIX) && key.length > RESULT_ENV_PREFIX.length)
    .map(([key, value]) => ({
      job: key.slice(RESULT_ENV_PREFIX.length).toLowerCase().replace(/_/g, '-'),
      // An unset `needs.<job>.result` arrives as the empty string. Naming it
      // keeps it out of the "passed" bucket instead of silently vanishing.
      result: typeof value === 'string' && value.trim() ? value.trim() : 'unknown',
    }));
}

/**
 * Classify gate results into a verdict plus the lines to print.
 *
 * @param {Array<{job: string, result: string}>} results
 * @param {string} [label] - The gate's display name, for the message.
 * @returns {{verdict: 'pass'|'cancelled'|'failure', lines: string[],
 *   cancelled: string[], failed: string[]}}
 */
export function summarizeGateResults(results, label = 'CI Gate') {
  const passed = results.filter(({ result }) => PASSING_RESULTS.has(result));
  const cancelled = results.filter(({ result }) => result === 'cancelled').map(({ job }) => job);
  // Anything neither passing nor cancelled is a failure — `failure`, and also
  // the `unknown` above. Defaulting an unrecognised result to "failed" is the
  // safe direction: it blocks with a loud message instead of being waved
  // through as collateral of a cancel.
  const failed = results
    .filter(({ result }) => !PASSING_RESULTS.has(result) && result !== 'cancelled')
    .map(({ job, result }) => `${job}=${result}`);

  const finished = passed.length
    ? `Jobs that finished: ${passed.map(({ job, result }) => `${job}=${result}`).join(', ')}`
    : 'No job reached a conclusion.';

  if (failed.length) {
    return {
      verdict: 'failure',
      cancelled,
      failed,
      lines: [
        `❌ ${label}: selected CI jobs did not pass.`,
        `Failed jobs: ${failed.join(', ')}`,
        ...(cancelled.length
          ? [`Cancelled alongside the failure (expected — the fail-fast step stops siblings): ${cancelled.join(', ')}`]
          : []),
        finished,
      ],
    };
  }

  if (cancelled.length) {
    return {
      verdict: 'cancelled',
      cancelled,
      failed,
      lines: [
        `🚫 ${label}: this run was CANCELLED, not failed — no job reported a failure.`,
        `Cancelled jobs: ${cancelled.join(', ')}`,
        finished,
        'Do not go looking for a broken test. Either a newer push superseded this run'
          + ' (cancel-in-progress), or GitHub cancelled it externally while several runs'
          + ' were in flight.',
        `Telling those apart, and what to do about each: ${TROUBLESHOOTING_ANCHOR}`,
      ],
    };
  }

  return {
    verdict: 'pass',
    cancelled,
    failed,
    lines: [`✅ ${label} passed: ${results.map(({ job, result }) => `${job}=${result}`).join(', ') || 'no jobs selected'}`],
  };
}

/**
 * Print the verdict and report whether the gate passed.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {{log?: Function, error?: Function}} [options.logger]
 * @param {Function} [options.writeSummary] - injectable step-summary writer
 * @returns {{verdict: string, ok: boolean, lines: string[]}}
 */
export function reportGate({
  env = process.env,
  logger = console,
  writeSummary = writeStepSummary,
} = {}) {
  const label = typeof env.CI_GATE_LABEL === 'string' && env.CI_GATE_LABEL.trim()
    ? env.CI_GATE_LABEL.trim()
    : 'CI Gate';
  const summary = summarizeGateResults(collectGateResults(env), label);
  const write = summary.verdict === 'pass' ? logger.log : logger.error;
  for (const line of summary.lines) write?.call(logger, line);
  // Also on the run's summary page: the verdict has to be readable without
  // expanding a step's log, which is exactly what nobody does before
  // concluding "CI is red". Every value here is a job id or a GitHub result
  // string, never event payload text.
  writeSummary(`### ${summary.verdict === 'pass' ? '✅' : '🚫'} ${label}\n\n`
    + summary.lines.map((line) => `- ${line}`).join('\n'), env);
  return { verdict: summary.verdict, ok: summary.verdict === 'pass', lines: summary.lines };
}

if (isDirectlyInvoked(import.meta.url)) {
  if (!reportGate().ok) process.exitCode = 1;
}
