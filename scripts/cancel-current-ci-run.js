#!/usr/bin/env node

/**
 * Report the failure, then cancel the workflow run executing this step.
 *
 * The workflow deliberately supplies no target arguments. The repository and
 * run id come only from GitHub Actions' environment, so a PR cannot redirect
 * this request to another run or repository through script arguments.
 *
 * REPORTING COMES FIRST, and it is the reason this script is not just a POST.
 * Cancelling the run stops the failing job before GitHub writes its `failure`
 * conclusion, so afterwards `gh pr checks`, `gh run view --json jobs` and
 * `gh run view --log-failed` all show a wall of `cancelled` with no cause —
 * three debugging sessions went looking for a billing problem instead of the
 * one-line assertion sitting in a job log (issue 7574). A workflow annotation
 * is written the instant it is printed and survives the cancellation, so the
 * run says what failed before it stops saying anything at all.
 *
 * This script runs after a real CI failure. NOTHING here may replace that
 * failure: every diagnostic and cancellation path returns normally after
 * emitting a single line, and the cancel is attempted even when the reporting
 * half throws.
 */

import { isDirectlyInvoked } from './lib/directInvocation.js';
import {
  currentRunTargetFromEnv, fetchJobsWithFailedSteps, formatFailedJob, githubRequest, isSuccess, trimmed,
} from './lib/githubActionsApi.js';
import { formatErrorAnnotation, safeWorkflowText, writeStepSummary } from './lib/githubOutput.js';

const CANCELLATION_TIMEOUT_MS = 10_000;
/**
 * Short, because this lookup sits between the failure and the cancel and every
 * second of it is a second ~13 doomed sibling legs keep billing (the Windows
 * shards at a 2x minute multiplier). Three seconds is ~40 runner-seconds in the
 * worst case and a few in the normal one.
 *
 * Running the lookup CONCURRENTLY with the cancel would cost nothing at all,
 * and is deliberately not done: once the cancel lands, Actions may kill this
 * job mid-step, and the enriched annotation — the entire point of issue 7574 —
 * would be lost to that race on exactly the runs it exists to explain.
 */
const DIAGNOSTIC_TIMEOUT_MS = 3_000;

/**
 * This job, as a human reads it in the Checks tab.
 *
 * `GITHUB_JOB` is the job ID (`windows-server`), not the rendered name, and
 * Actions exposes no variable for the matrix leg — so the workflow passes the
 * shard in. Together they identify the row without an API call, which is what
 * keeps the annotation useful when the lookup below is the thing that failed.
 */
function localJobLabel(env) {
  const job = safeWorkflowText(env.GITHUB_JOB, 'this job');
  const shard = trimmed(env.CI_FAILED_SHARD);
  return /^\d+$/.test(shard) ? `${job} (shard ${shard})` : job;
}

/**
 * Write the annotation and the run-summary block naming what failed.
 *
 * Never throws: it runs after a real CI failure, and a diagnostic that took the
 * cancel down with it would cost money on every red build.
 */
async function reportFailureBeforeCancel({ env, fetchImpl, logger, writeSummary, target }) {
  const label = localJobLabel(env);
  const found = await fetchJobsWithFailedSteps(fetchImpl, target && {
    ...target,
    timeoutMs: DIAGNOSTIC_TIMEOUT_MS,
  });
  // `scripts/run-ci-tests.js` sets this via $GITHUB_ENV when a Vitest worker
  // crashed natively (a Windows fail-fast abort, not an assertion) and the
  // crash reproduced on a same-file retry — the API lookup above can't see
  // this because it names FAILED STEPS, and the crash killed the step before
  // any per-test output named the file (issue 8152).
  const crashedFile = safeWorkflowText(env.CI_CRASHED_TEST_FILE);
  const lines = found?.length
    ? found.map(formatFailedJob)
    : [crashedFile
      ? `${label} — the failing step could not be read from the Actions API; the Vitest worker crashed natively on ${crashedFile} (see this job's log)`
      : `${label} — the failing step could not be read from the Actions API; open this job's log`];

  try {
    for (const line of lines) logger.log?.(formatErrorAnnotation(`CI failed: ${label}`, line));
    writeSummary(
      [
        `### ❌ CI failed in ${label}`,
        '',
        ...lines.map((line) => `- ${line}`),
        '',
        'Every other job was cancelled on purpose by the fail-fast step, so they are'
          + ' collateral and not the cause. `gh run view --log-failed` is empty for this'
          + ' run because the cancel lands before a `failure` conclusion is written —'
          + " open the job named above and read its log.",
      ].join('\n'),
      env,
    );
  } catch (error) {
    logger.error?.(`⚠️ Could not write the CI failure annotation: ${error?.message || 'unknown error'}`);
  }
}

/**
 * Report the failure, then ask GitHub to cancel the workflow run containing
 * this step.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env] - Actions environment to read.
 * @param {typeof fetch} [options.fetchImpl] - Injectable fetch for tests.
 * @param {{log?: Function, error?: Function}} [options.logger] - Injectable logger.
 * @param {Function} [options.writeSummary] - Injectable step-summary writer.
 * @returns {Promise<{outcome: string, status?: number, reason?: string}>}
 */
export async function cancelCurrentCiRun({
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
  writeSummary = writeStepSummary,
} = {}) {
  const target = currentRunTargetFromEnv(env);

  // Before the POST, and ahead of the early returns below: a job whose token or
  // repository is unusable still failed, and the annotation needs neither.
  await reportFailureBeforeCancel({ env, fetchImpl, logger, writeSummary, target });

  if (!target) {
    logger.error?.('⚠️ CI run cancellation skipped: required GitHub Actions environment is unavailable');
    return { outcome: 'skipped', reason: 'invalid-environment' };
  }

  if (typeof fetchImpl !== 'function') {
    logger.error?.('⚠️ CI run cancellation unavailable: fetch is not available');
    return { outcome: 'unavailable', reason: 'fetch-unavailable' };
  }

  try {
    const url = `${target.repoPath}/actions/runs/${target.runId}/cancel`;
    const response = await githubRequest(fetchImpl, url, target.token, {
      method: 'POST',
      timeoutMs: CANCELLATION_TIMEOUT_MS,
    });
    const status = Number(response?.status) || 0;

    if (isSuccess(response)) {
      logger.log?.('🛑 Requested cancellation of the current CI run');
      return { outcome: 'requested', status };
    }

    if (status === 409) {
      logger.log?.('ℹ️ Current CI run is already terminal; sibling cancellation was unnecessary');
      return { outcome: 'already-terminal', status };
    }

    logger.error?.(`⚠️ Could not cancel the current CI run: GitHub API returned ${status || 'an unknown status'}`);
    return { outcome: 'unavailable', status };
  } catch (error) {
    logger.error?.(`⚠️ Could not cancel the current CI run: ${error?.message || 'network request failed'}`);
    return { outcome: 'unavailable', reason: 'request-failed' };
  }
}

if (isDirectlyInvoked(import.meta.url)) {
  await cancelCurrentCiRun();
}
