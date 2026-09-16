#!/usr/bin/env node

/**
 * Re-dispatch a CI run that was cancelled with NO successor run — once.
 *
 * When several PRs build at the same time, GitHub cancels in-flight runs that
 * nothing in this repository asked it to cancel: no job failed, the in-workflow
 * `Cancel sibling CI jobs after failure` step never ran, and no newer run
 * exists for the branch. The PR is then blocked behind a gate that reports a
 * cancel as if the tests were red (issue 7437). The same SHA passes on the next
 * attempt once the queue drains, so one automatic re-dispatch clears it.
 *
 * Five guards keep that from becoming a retry loop or from re-running work
 * somebody deliberately stopped — the reasoning for each is the table under
 * "External cancellation and one automatic retry" in docs/GITHUB_ACTIONS.md.
 * The two least obvious, stated here because the code alone does not show them:
 *
 *   - `run_attempt === 1` IS the retry budget. `POST /rerun` re-runs the same
 *     run id as attempt 2, so attempt 2's cancel sees attempt 2 and stops.
 *   - No job may have concluded `failure`/`timed_out`. This repository cancels
 *     its own run from a failing job (scripts/cancel-current-ci-run.js), which
 *     makes the RUN read `cancelled` while a job really did fail.
 *
 * An API call that cannot be completed is NOT treated as "guard passed": every
 * lookup failure returns without re-dispatching, because the cost of missing a
 * retry is one manual re-run and the cost of a wrong retry is a runaway loop.
 *
 * The workflow that runs this is triggered by `workflow_run`, so it checks out
 * the DEFAULT branch — never the pull request's head. Nothing here executes,
 * imports, or interpolates repository content from the PR.
 */

import { isDirectlyInvoked } from './lib/directInvocation.js';
import { githubRequest, isSuccess, repoApiPath, trimmed } from './lib/githubActionsApi.js';
import { writeStepSummary } from './lib/githubOutput.js';

const REQUEST_TIMEOUT_MS = 15_000;
/** ~1500 jobs. A bound, not an expectation — CI runs about fifteen. */
const MAX_JOB_PAGES = 15;
const JOBS_PER_PAGE = 100;
/** Newest-first; a successor, if one exists, is within the first few. */
const SIBLING_RUNS_PER_PAGE = 5;
/** A conclusion that means something really broke, not that it was stopped. */
const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out']);

/**
 * True when this job carries a real failure.
 *
 * The job's own conclusion is not enough. `cancel-current-ci-run.js` cancels
 * the RUN from inside the failing job, and the cancel can land while that job
 * is still finishing its post-steps — GitHub then records the job as
 * `cancelled` even though one of its steps failed. Reading the steps too is
 * what keeps this guard failing CLOSED, which is the whole point of it.
 */
const jobFailed = (job) => FAILING_CONCLUSIONS.has(job?.conclusion)
  || (Array.isArray(job?.steps) && job.steps.some((step) => FAILING_CONCLUSIONS.has(step?.conclusion)));

/**
 * A job name for a log line. The name comes from the pull request's own
 * workflow file, and Actions parses `::` at the start of a line as a workflow
 * command — so newlines and `::` never reach stdout verbatim.
 */
const safeJobName = (job) => String(job?.name || 'unnamed job')
  .replace(/[\r\n]+/g, ' ')
  .replace(/::/g, ':')
  .slice(0, 80);

/**
 * Validate and normalise the run this invocation may retry.
 *
 * Every field comes from the `workflow_run` payload, and `headBranch` is
 * attacker-controlled on a fork PR — it is only ever used as an encoded query
 * parameter, never interpolated into a path or a shell.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {object|null}
 */
export function retryTargetFromEnv(env) {
  const str = (key) => trimmed(env[key]);
  const token = str('GITHUB_TOKEN');
  const runId = str('CI_RUN_ID');
  const runAttempt = str('CI_RUN_ATTEMPT');
  const runNumber = str('CI_RUN_NUMBER');
  const workflowId = str('CI_WORKFLOW_ID');
  const headBranch = str('CI_RUN_HEAD_BRANCH');
  // Optional: absent on an older payload, so it narrows the sibling lookup
  // when present rather than invalidating the target when it is not.
  const headRepositoryId = str('CI_RUN_HEAD_REPOSITORY_ID');
  const repoPath = repoApiPath(env);

  if (!repoPath || !token || !headBranch) return null;
  if (![runId, runAttempt, runNumber, workflowId].every((value) => /^\d+$/.test(value))) return null;

  return {
    token,
    repoPath,
    runId,
    runAttempt: Number(runAttempt),
    runNumber: Number(runNumber),
    workflowId,
    headBranch,
    headRepositoryId: /^\d+$/.test(headRepositoryId) ? headRepositoryId : '',
    headSha: str('CI_RUN_HEAD_SHA'),
    conclusion: str('CI_RUN_CONCLUSION'),
    event: str('CI_RUN_EVENT'),
  };
}

const request = (fetchImpl, url, token, init) =>
  githubRequest(fetchImpl, url, token, { timeoutMs: REQUEST_TIMEOUT_MS, ...init });

/** Parsed body, or null for any transport, status, or parse failure. */
async function readJson(fetchImpl, url, token, logger) {
  try {
    const response = await request(fetchImpl, url, token);
    if (!isSuccess(response)) return null;
    return await response.json();
  } catch (error) {
    logger?.error?.(`⚠️ GitHub API request failed: ${error?.message || 'network request failed'}`);
    return null;
  }
}

/**
 * Every job of the cancelled attempt, or null when the listing is incomplete.
 * Null is deliberately distinct from `[]`: "we could not see the jobs" must
 * never read as "no job failed".
 */
async function fetchAttemptJobs(fetchImpl, target, logger) {
  const jobs = [];
  for (let page = 1; page <= MAX_JOB_PAGES; page += 1) {
    const url = `${target.repoPath}/actions/runs/${target.runId}/attempts/${target.runAttempt}`
      + `/jobs?per_page=${JOBS_PER_PAGE}&page=${page}`;
    const body = await readJson(fetchImpl, url, target.token, logger);
    if (!body || !Array.isArray(body.jobs)) return null;
    jobs.push(...body.jobs);
    const total = Number(body.total_count);
    // Only a real total can certify that the listing is complete.
    if (!Number.isFinite(total)) return null;
    if (jobs.length >= total) return jobs;
    // Checked last, so `total: 0` still returns the legitimately empty list.
    if (body.jobs.length === 0) return null;
  }
  return null;
}

/**
 * The run number of the newest sibling run, or null when the listing failed.
 * `run_number` increases monotonically per workflow, so taking the maximum
 * orders runs without trusting either the page order or timestamps that can
 * tie at second resolution.
 */
async function fetchNewestSiblingRunNumber(fetchImpl, target, logger) {
  const url = `${target.repoPath}/actions/workflows/${encodeURIComponent(target.workflowId)}/runs`
    + `?event=pull_request&per_page=${SIBLING_RUNS_PER_PAGE}`
    + `&branch=${encodeURIComponent(target.headBranch)}`;
  const body = await readJson(fetchImpl, url, target.token, logger);
  if (!body || !Array.isArray(body.workflow_runs)) return null;
  return body.workflow_runs
    .filter((run) => String(run?.id) !== target.runId)
    // `branch=` matches head_branch alone, so two forks pushing `patch-1`
    // land in the same listing and one would read as the other's successor.
    // Only a missed retry, but the numeric repository id rules it out.
    .filter((run) => !target.headRepositoryId
      || String(run?.head_repository?.id ?? target.headRepositoryId) === target.headRepositoryId)
    .reduce((newest, run) => Math.max(newest, Number(run?.run_number) || 0), 0);
}

/**
 * Decide whether the cancelled run deserves one re-dispatch, and do it.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {{log?: Function, error?: Function}} [options.logger]
 * @param {Function} [options.writeSummary] - injectable step-summary writer
 * @returns {Promise<{outcome: 'requested'|'skipped'|'unavailable', reason?: string, status?: number}>}
 */
export async function retryCancelledCiRun({
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
  writeSummary = writeStepSummary,
} = {}) {
  const runLabel = /^\d+$/.test(String(env.CI_RUN_ID ?? '')) ? env.CI_RUN_ID : 'unidentified';
  // Every exit goes through here, so "why was my run not retried?" is
  // answerable from the recovery run's summary page. Fixed reason codes and
  // the numeric run id only — never the branch name or any other payload text.
  // `level` is a parameter rather than derived from `outcome`: an invalid
  // environment is a `skipped` outcome that still deserves stderr.
  const done = (level, message, result) => {
    logger[level]?.(message);
    writeSummary(`### CI cancel recovery: ${result.outcome}\n\n`
      + `- run: ${runLabel}\n`
      + `- reason: ${result.reason || 're-dispatched'}`, env);
    return result;
  };

  const target = retryTargetFromEnv(env);
  if (!target) {
    return done('error', '⚠️ CI retry skipped: the workflow_run environment is incomplete or malformed',
      { outcome: 'skipped', reason: 'invalid-environment' });
  }
  if (typeof fetchImpl !== 'function') {
    return done('error', '⚠️ CI retry unavailable: fetch is not available',
      { outcome: 'unavailable', reason: 'fetch-unavailable' });
  }

  if (target.conclusion !== 'cancelled') {
    return done('log', `ℹ️ CI retry skipped: run ${target.runId} concluded ${target.conclusion || 'unknown'}, not cancelled`,
      { outcome: 'skipped', reason: 'not-cancelled' });
  }
  if (target.event !== 'pull_request') {
    return done('log', `ℹ️ CI retry skipped: run ${target.runId} was triggered by ${target.event || 'an unknown event'}, not a pull request`,
      { outcome: 'skipped', reason: 'not-a-pull-request' });
  }
  if (target.runAttempt !== 1) {
    return done('log', `ℹ️ CI retry skipped: run ${target.runId} is already attempt ${target.runAttempt} — one retry per run`,
      { outcome: 'skipped', reason: 'retry-budget-exhausted' });
  }

  const jobs = await fetchAttemptJobs(fetchImpl, target, logger);
  if (!jobs) {
    return done('error', `⚠️ CI retry skipped: could not list the jobs of run ${target.runId}`,
      { outcome: 'unavailable', reason: 'jobs-unavailable' });
  }
  const failedJobs = jobs.filter(jobFailed).map(safeJobName);
  if (failedJobs.length) {
    return done('log', `ℹ️ CI retry skipped: run ${target.runId} cancelled after a real failure (${failedJobs.join(', ')})`,
      { outcome: 'skipped', reason: 'job-failed' });
  }

  const newestSibling = await fetchNewestSiblingRunNumber(fetchImpl, target, logger);
  if (newestSibling === null) {
    return done('error', `⚠️ CI retry skipped: could not list sibling runs for run ${target.runId}`,
      { outcome: 'unavailable', reason: 'sibling-runs-unavailable' });
  }
  if (newestSibling > target.runNumber) {
    return done('log', `ℹ️ CI retry skipped: run ${target.runId} was superseded by run #${newestSibling} on the same pull request`,
      { outcome: 'skipped', reason: 'superseded' });
  }

  const response = await request(
    fetchImpl,
    `${target.repoPath}/actions/runs/${target.runId}/rerun`,
    target.token,
    { method: 'POST' },
  ).catch((error) => {
    logger.error?.(`⚠️ CI retry request failed: ${error?.message || 'network request failed'}`);
    return null;
  });
  if (isSuccess(response)) {
    return done('log', `🔁 Re-dispatched CI run ${target.runId} (${target.headSha.slice(0, 7) || 'unknown sha'}): cancelled with no successor run and no failing job`,
      { outcome: 'requested', status: Number(response.status) || 0 });
  }
  const status = Number(response?.status) || 0;
  return done('error', `⚠️ Could not re-dispatch CI run ${target.runId}: GitHub API returned ${status || 'an unknown status'}`,
    { outcome: 'unavailable', status, reason: 'rerun-rejected' });
}

if (isDirectlyInvoked(import.meta.url)) {
  // Never fail the recovery workflow: a retry that could not happen must not
  // publish a red check of its own on top of the cancelled run.
  await retryCancelledCiRun();
}
