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
 *                  reported as collateral, because the fail-fast step in
 *                  ci.yml cancels them on purpose.
 *
 * The catch, and why this talks to the API at all: `needs.<job>.result` is the
 * job's CONCLUSION, and the fail-fast step cancels the run before GitHub writes
 * the failing job's `failure` conclusion. The culprit therefore arrives here as
 * `cancelled` like everything else, and the gate reported the cancelled verdict
 * on a run that really was red (issue 7574). A cancelled job keeps its STEPS'
 * conclusions, so when — and only when — the cancelled verdict is about to be
 * printed, the run's jobs are queried for a failed step. Best-effort by design:
 * an API failure falls back to today's wording rather than turning a cancelled
 * run red or green on a network blip.
 *
 * Scope, so the next reader is not misled: this runs only when the GATE job
 * itself runs. The two cancels differ here, and it matters. Our OWN fail-fast
 * cancel leaves the gate running — `if: always()` survives it, and the gate is
 * where a red run gets its verdict, which is why the culprit lookup above is
 * worth having. An EXTERNAL run-wide cancellation takes the gate with it, and
 * then the explanation comes from the recovery workflow instead — see
 * "External cancellation and one automatic retry" in docs/GITHUB_ACTIONS.md.
 *
 * Reads `CI_GATE_RESULT_<JOB>` out of the environment rather than taking
 * arguments, so adding a job to the gate is one workflow line and no code
 * change.
 */

import { isDirectlyInvoked } from './lib/directInvocation.js';
import {
  currentRunTargetFromEnv, fetchJobsWithFailedSteps, formatFailedJob,
} from './lib/githubActionsApi.js';
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
/**
 * The gate jobs' own display names, excluded from the culprit lookup. Both fail
 * downstream of any red run — by design, that is their job — so naming one as
 * the culprit would point every reader back at the gate they are already
 * looking at. Asserted against ci.yml's `name:` lines in the wiring test.
 */
const GATE_JOB_NAMES = new Set(['CI Gate', 'Full CI Gate']);
const CULPRIT_TIMEOUT_MS = 10_000;
const TROUBLESHOOTING_ANCHOR = '"CI red with every job \'cancelled\'" in docs/TROUBLESHOOTING.md';

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
 * @param {object} [options]
 * @param {boolean} [options.requireSuccess] - when true, `skipped` does not pass
 * @param {Array<{name: string, steps: string[]}>|null} [options.culprits] - jobs
 *   the Actions API reports with a FAILED STEP, consulted only for a run that
 *   would otherwise read as cancelled. THREE states, not two: a non-empty list
 *   is a red run; `[]` is "looked, nothing failed"; `null` is "could not look".
 *   The last two both stay cancelled, but they warrant different advice — see
 *   the cancelled branch.
 * @returns {{verdict: 'pass'|'cancelled'|'failure', lines: string[]}}
 */
export function summarizeGateResults(
  results,
  label = DEFAULT_LABEL,
  { requireSuccess = false, culprits = null } = {},
) {
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
    if (culprits?.length) {
      return {
        verdict: 'failure',
        lines: [
          `❌ ${label}: a job FAILED. Its conclusion reads cancelled because the fail-fast`
            + ' step stopped the run before GitHub recorded the failure.',
          ...culprits.map((job) => `Failing job: ${formatFailedJob(job)}`),
          `Cancelled jobs: ${cancelled.join(', ')}`,
          finished(),
          'Open that job and read its log. `gh run view --log-failed` returns nothing'
            + ' for this shape of run, because no job concluded `failure`.',
        ],
      };
    }
    return {
      verdict: 'cancelled',
      lines: [
        `🚫 ${label}: this run was CANCELLED, not failed — no job REPORTED a failure.`,
        `Cancelled jobs: ${cancelled.join(', ')}`,
        finished(),
        // This distinction is load-bearing. The old line said "No test failed",
        // and twice (#7482, #7571) that sent a reader straight to the billing
        // dashboard while a real assertion sat unread in a job log: a job that
        // fails is cancelled by scripts/cancel-current-ci-run.js before its own
        // reporting step runs, so its conclusion is `cancelled` too and NOTHING
        // in the run metadata reads `failure`. That is now CHECKED rather than
        // guessed — but only when the lookup ran, so the two states say
        // different things instead of sharing the more alarming wording.
        ...(culprits
          ? ["Checked every job's STEP conclusions too, and none failed — so this"
            + ' is not the usual fail-fast cancel wearing a cancelled conclusion.']
          : ["This run's step conclusions could NOT be read, so a cancelled"
            + ' conclusion here does NOT mean no test failed: PortOS fail-fasts,'
            + ' the job that failed is cancelled out from under its own reporting'
            + ' step, and a real red build then looks exactly like this.'
            + ' READ THE JOB LOGS FIRST — and note that'
            + ' `gh run view --job <id> --log-failed` prints NOTHING here, because'
            + ' no step is marked failed. Use the full `--log` and grep for'
            + ' `🛑 Requested cancellation` (written only when a job really'
            + ' failed), `FAIL `, or `AssertionError`; the culprit is usually the'
            + ' job that completed EARLIEST.']),
        'Otherwise: a job that hits the 6-hour limit is'
          + ' recorded as `cancelled` rather than `timed_out` (check for a hang),'
          + ' a newer push superseded this run (cancel-in-progress leaves a NEWER'
          + ' run for the branch), or GitHub cancelled it externally — the Actions'
          + ' spending limit, which is the LAST hypothesis, not the first.',
        `Working through those in order: ${TROUBLESHOOTING_ANCHOR}`,
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
 * Jobs in THIS run that carry a failed step, the gate jobs excluded.
 *
 * `null` on an unusable environment or a failed lookup, kept distinct from the
 * empty array: both keep the cancelled verdict, but only "looked and found
 * none" earns the wording that rules a fail-fast cancel out. A failed lookup
 * must never invent a failure the run may not have, nor vouch for its absence.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<Array<{name: string, steps: string[]}>|null>}
 */
async function findCulprits(env, fetchImpl) {
  const target = currentRunTargetFromEnv(env);
  const jobs = await fetchJobsWithFailedSteps(fetchImpl, target && {
    ...target,
    timeoutMs: CULPRIT_TIMEOUT_MS,
  });
  return jobs && jobs.filter(({ name }) => !GATE_JOB_NAMES.has(name));
}

/**
 * Print the verdict — to the step log and to the run summary — and report
 * whether the gate passed.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {{log?: Function, error?: Function}} [options.logger]
 * @param {Function} [options.writeSummary] - injectable step-summary writer
 * @param {typeof fetch} [options.fetchImpl] - injectable fetch for tests
 * @returns {Promise<{verdict: string, ok: boolean, lines: string[]}>}
 */
export async function reportGate({
  env = process.env,
  logger = console,
  writeSummary = writeStepSummary,
  fetchImpl = globalThis.fetch,
} = {}) {
  const label = env.CI_GATE_LABEL?.trim() || DEFAULT_LABEL;
  const results = collectGateResults(env);
  const requireSuccess = env.CI_GATE_REQUIRE_SUCCESS === 'true';
  const provisional = summarizeGateResults(results, label, { requireSuccess });
  // The lookup runs ONLY for the cancelled verdict. Every other one already
  // names its cause, and a gate that queried the API on every green run would
  // spend a request per build to learn nothing. Re-summarizing is a second pass
  // over a handful of strings — cheaper than threading a lazy resolver through
  // a pure function for the sake of one rare branch.
  const { verdict, lines } = provisional.verdict === 'cancelled'
    ? summarizeGateResults(results, label, {
      requireSuccess,
      culprits: await findCulprits(env, fetchImpl),
    })
    : provisional;
  const ok = verdict === 'pass';

  for (const line of lines) (ok ? logger.log : logger.error)?.call(logger, line);
  // The summary page too: nobody expands a step log before concluding "CI is
  // red". Every value here is a job id or a GitHub result string, never event
  // payload text.
  writeSummary(`### ${ok ? '✅' : '🚫'} ${label}\n\n${lines.map((line) => `- ${line}`).join('\n')}`, env);
  return { verdict, ok, lines };
}

if (isDirectlyInvoked(import.meta.url)) {
  if (!(await reportGate()).ok) process.exitCode = 1;
}
