#!/usr/bin/env node

/**
 * The CI gate's verdict, with CANCELLED told apart from FAILED.
 *
 * The gate used to collapse every non-`success`/`skipped` needs-result into
 * one "did not pass" line, so a job that GitHub cancelled out from under us
 * read exactly like a red test suite (issue 7437). That sends the next reader
 * hunting for a failing assertion that does not exist, and it hides the one
 * fact that decides what to do next: whether anything actually failed.
 *
 * Three verdicts, not two:
 *   - pass       — every selected job was `success` or `skipped`.
 *   - cancelled  — at least one job was `cancelled` and NOTHING failed. There
 *                  is no test failure to chase. Still non-zero: a cancelled
 *                  run proves nothing and must not be merged.
 *   - failure    — at least one job genuinely failed. Cancelled siblings are
 *                  reported as collateral, because `Cancel sibling CI jobs
 *                  after failure` cancels them on purpose.
 *
 * Scope, so the next reader is not misled: this runs only when the GATE job
 * itself runs. A run-wide cancellation takes the gate with it, and then the
 * explanation comes from the recovery workflow instead — see "External
 * cancellation and one automatic retry" in docs/GITHUB_ACTIONS.md.
 *
 * Reads `CI_GATE_RESULT_<JOB>` out of the environment rather than taking
 * arguments, so adding a job to the gate is one workflow line and no code
 * change.
 */

import { isDirectlyInvoked } from './lib/directInvocation.js';
import { writeStepSummary } from './lib/githubOutput.js';

const RESULT_ENV_PREFIX = 'CI_GATE_RESULT_';
/** GitHub's `needs.<job>.result` values that do not block the gate. */
const PASSING_RESULTS = new Set(['success', 'skipped']);
/**
 * `Full CI Gate` sets `CI_GATE_REQUIRE_SUCCESS`, because a `skipped` input
 * must NOT satisfy it. `scripts/verify-ci-status.js` lets a release skip the
 * complete suite on the strength of that check, so accepting anything short of
 * `success` there would ship an untested tree.
 */
const STRICT_PASSING_RESULTS = new Set(['success']);
const DEFAULT_LABEL = 'CI Gate';
const TROUBLESHOOTING_ANCHOR = '"CI cancelled with no successor run" in docs/TROUBLESHOOTING.md';

const pair = ({ job, result }) => `${job}=${result}`;

/**
 * Read the `CI_GATE_RESULT_<JOB>` variables into `[{ job, result }]`.
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
      result: (typeof value === 'string' && value.trim()) || 'unknown',
    }));
}

/**
 * Classify gate results into a verdict plus the lines to print.
 *
 * @param {Array<{job: string, result: string}>} results
 * @param {string} [label] - The gate's display name, for the message.
 * @param {boolean} [requireSuccess] - when true, `skipped` does not pass
 * @returns {{verdict: 'pass'|'cancelled'|'failure', lines: string[]}}
 */
export function summarizeGateResults(results, label = DEFAULT_LABEL, requireSuccess = false) {
  const passing = requireSuccess ? STRICT_PASSING_RESULTS : PASSING_RESULTS;
  const passed = results.filter(({ result }) => passing.has(result));
  const cancelled = results.filter(({ result }) => result === 'cancelled').map(({ job }) => job);
  // Anything neither passing nor cancelled is a failure — `failure`, and also
  // the `unknown` above. Defaulting an unrecognised result to "failed" is the
  // safe direction: it blocks with a loud message instead of being waved
  // through as collateral of a cancel.
  const failed = results
    .filter(({ result }) => !passing.has(result) && result !== 'cancelled')
    .map(pair);
  const finished = () => (passed.length
    ? `Jobs that finished: ${passed.map(pair).join(', ')}`
    : 'No job reached a conclusion.');

  if (failed.length) {
    return {
      verdict: 'failure',
      lines: [
        `❌ ${label}: selected CI jobs did not pass.`,
        `Failed jobs: ${failed.join(', ')}`,
        ...(cancelled.length
          ? [`Cancelled alongside the failure (expected — the fail-fast step stops siblings): ${cancelled.join(', ')}`]
          : []),
        finished(),
      ],
    };
  }

  if (cancelled.length) {
    return {
      verdict: 'cancelled',
      lines: [
        `🚫 ${label}: this run was CANCELLED, not failed — no job reported a failure.`,
        `Cancelled jobs: ${cancelled.join(', ')}`,
        finished(),
        'No test failed, so start with why the job STOPPED. A job that hits the'
          + ' 6-hour limit is recorded as `cancelled`, not `timed_out` — check the'
          + ' cancelled jobs for a hang first. Otherwise a newer push superseded this'
          + ' run (cancel-in-progress), or GitHub cancelled it externally while several'
          + ' runs were in flight.',
        `Telling those apart, and what to do about each: ${TROUBLESHOOTING_ANCHOR}`,
      ],
    };
  }

  if (!results.length) {
    // Fail closed. A green required check that examined nothing is worse
    // than a red one: it is indistinguishable from a real pass.
    return {
      verdict: 'failure',
      lines: [
        `❌ ${label}: no job results were supplied, so nothing was checked.`,
        "Every job in the gate's `needs:` list needs a CI_GATE_RESULT_<JOB>"
          + " environment entry in .github/workflows/ci.yml.",
      ],
    };
  }

  return {
    verdict: 'pass',
    lines: [`✅ ${label} passed: ${results.map(pair).join(', ')}`],
  };
}

/**
 * Print the verdict — to the step log and to the run summary — and report
 * whether the gate passed.
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
  const label = env.CI_GATE_LABEL?.trim() || DEFAULT_LABEL;
  const { verdict, lines } = summarizeGateResults(
    collectGateResults(env),
    label,
    env.CI_GATE_REQUIRE_SUCCESS === 'true',
  );
  const ok = verdict === 'pass';

  for (const line of lines) (ok ? logger.log : logger.error)?.call(logger, line);
  // The summary page too: nobody expands a step log before concluding "CI is
  // red". Every value here is a job id or a GitHub result string, never event
  // payload text.
  writeSummary(`### ${ok ? '✅' : '🚫'} ${label}\n\n${lines.map((line) => `- ${line}`).join('\n')}`, env);
  return { verdict, ok, lines };
}

if (isDirectlyInvoked(import.meta.url)) {
  if (!reportGate().ok) process.exitCode = 1;
}
