#!/usr/bin/env node

/**
 * Re-dispatch a CI run that was cancelled with NO successor run — once.
 *
 * When several PRs build at the same time, GitHub cancels in-flight runs that
 * nothing in this repository asked it to cancel: no job failed, the in-workflow
 * `Cancel sibling CI jobs after failure` step never ran, and no newer run
 * exists for the branch. The PR is then blocked behind a gate that reports a
 * cancel as if the tests were red (#7437). The same SHA passes on the next
 * attempt once the queue drains, so one automatic re-dispatch clears it.
 *
 * Every guard below exists to keep that from becoming a retry loop or from
 * re-running work somebody deliberately stopped:
 *
 *   1. `cancelled` conclusion only — a failure is a failure.
 *   2. `pull_request` runs only — schedules and dispatches retry on their own
 *      terms, and a `workflow_dispatch` re-run would re-enter this path.
 *   3. `run_attempt == 1` only. `POST /rerun` re-runs the SAME run id as
 *      attempt 2, so this is the retry budget: attempt 2's cancel sees
 *      attempt 2 and stops. One retry per run, and a PR run is one run per
 *      head SHA, so one retry per SHA.
 *   4. No job may have concluded `failure`/`timed_out`. This repository
 *      cancels its own run from a failing job (scripts/cancel-current-ci-run.js),
 *      which makes the RUN read `cancelled` while a job really did fail —
 *      retrying that would re-run the whole suite on a genuine red.
 *   5. No newer run may exist for the same branch. That is what a legitimate
 *      `cancel-in-progress` supersession looks like, and the newer run is
 *      already testing the code this one would have tested.
 *
 * An API call that cannot be completed is NOT treated as "guard passed": every
 * lookup failure returns without re-dispatching, because the cost of missing a
 * retry is one manual re-run and the cost of a wrong retry is a runaway loop.
 *
 * The workflow that runs this is triggered by `workflow_run`, so it checks out
 * the DEFAULT branch — never the pull request's head. Nothing here executes,
 * imports, or interpolates repository content from the PR.
 *
 * Builtins only: the workflow runs it straight from a checkout with no
 * dependency install (scripts/pre-install-entrypoints.test.js enforces it).
 */

import { isDirectlyInvoked } from './lib/directInvocation.js';
import { writeStepSummary } from './lib/githubOutput.js';

const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_API_BASE = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 15_000;
/** ~1500 jobs. A bound, not an expectation — CI runs about fifteen. */
const MAX_JOB_PAGES = 15;
const JOBS_PER_PAGE = 100;
/** Newest-first; a successor, if one exists, is at the top of this list. */
const SIBLING_RUNS_PER_PAGE = 100;
/** A job conclusion that means something really broke, not that it was stopped. */
const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out']);

function apiBaseFrom(configuredApiUrl) {
  if (!configuredApiUrl) return GITHUB_API_BASE;
  let parsed;
  try {
    parsed = new URL(configuredApiUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
    || parsed.search || parsed.hash) {
    return null;
  }
  return configuredApiUrl.replace(/\/+$/, '');
}

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
  const str = (key) => (typeof env[key] === 'string' ? env[key].trim() : '');
  const repository = str('GITHUB_REPOSITORY');
  const token = str('GITHUB_TOKEN');
  const runId = str('CI_RUN_ID');
  const runAttempt = str('CI_RUN_ATTEMPT');
  const runNumber = str('CI_RUN_NUMBER');
  const workflowId = str('CI_WORKFLOW_ID');
  const headBranch = str('CI_RUN_HEAD_BRANCH');

  if (!/^[^/\s]+\/[^/\s]+$/.test(repository) || !token) return null;
  if (![runId, runAttempt, runNumber, workflowId].every((value) => /^\d+$/.test(value))) return null;
  if (!headBranch) return null;

  const apiBase = apiBaseFrom(str('GITHUB_API_URL'));
  if (!apiBase) return null;

  const [owner, repo] = repository.split('/');
  return {
    token,
    repoPath: `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    runId,
    runAttempt: Number(runAttempt),
    runNumber: Number(runNumber),
    workflowId,
    headBranch,
    headSha: str('CI_RUN_HEAD_SHA'),
    conclusion: str('CI_RUN_CONCLUSION'),
    event: str('CI_RUN_EVENT'),
  };
}

function githubRequest(fetchImpl, url, token, init = {}) {
  return fetchImpl(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/** Parsed body, or null for any transport, status, or parse failure. */
async function readJson(fetchImpl, url, token, logger) {
  try {
    const response = await githubRequest(fetchImpl, url, token);
    if (!response?.ok) return null;
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
    // An absent/garbage total_count cannot certify completeness, so the only
    // way to finish is to have reached a real one. A short or empty page with
    // jobs still outstanding is a truncated listing, not the end.
    if (Number.isFinite(total) && jobs.length >= total) return jobs;
    if (body.jobs.length === 0) return null;
  }
  return null;
}

/**
 * The run number of the newest sibling run, or null when the listing failed.
 * `run_number` increases monotonically per workflow, so it orders runs without
 * trusting timestamps that can tie at second resolution.
 */
async function fetchNewestSiblingRunNumber(fetchImpl, target, logger) {
  const url = `${target.repoPath}/actions/workflows/${encodeURIComponent(target.workflowId)}/runs`
    + `?event=pull_request&per_page=${SIBLING_RUNS_PER_PAGE}`
    + `&branch=${encodeURIComponent(target.headBranch)}`;
  const body = await readJson(fetchImpl, url, target.token, logger);
  if (!body || !Array.isArray(body.workflow_runs)) return null;
  return body.workflow_runs
    .filter((run) => String(run?.id) !== target.runId)
    .reduce((newest, run) => Math.max(newest, Number(run?.run_number) || 0), 0);
}

/**
 * Decide whether the cancelled run deserves one re-dispatch, and do it.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {{log?: Function, error?: Function}} [options.logger]
 * @returns {Promise<{outcome: 'requested'|'skipped'|'unavailable', reason?: string, status?: number}>}
 */
export async function retryCancelledCiRun({
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
  writeSummary = writeStepSummary,
} = {}) {
  // Every return goes through here so "why was my run not retried?" is
  // answerable from the recovery run's summary page. Fixed reason codes and
  // the numeric run id only — never the branch name or any other payload text.
  const finish = (result) => {
    writeSummary(`### CI cancel recovery: ${result.outcome}\n\n`
      + `- run: ${/^\d+$/.test(String(env.CI_RUN_ID ?? '')) ? env.CI_RUN_ID : 'unidentified'}\n`
      + `- reason: ${result.reason || 're-dispatched'}`, env);
    return result;
  };
  const target = retryTargetFromEnv(env);
  if (!target) {
    logger.error?.('⚠️ CI retry skipped: the workflow_run environment is incomplete or malformed');
    return finish({ outcome: 'skipped', reason: 'invalid-environment' });
  }
  if (typeof fetchImpl !== 'function') {
    logger.error?.('⚠️ CI retry unavailable: fetch is not available');
    return finish({ outcome: 'unavailable', reason: 'fetch-unavailable' });
  }

  if (target.conclusion !== 'cancelled') {
    logger.log?.(`ℹ️ CI retry skipped: run ${target.runId} concluded ${target.conclusion || 'unknown'}, not cancelled`);
    return finish({ outcome: 'skipped', reason: 'not-cancelled' });
  }
  if (target.event !== 'pull_request') {
    logger.log?.(`ℹ️ CI retry skipped: run ${target.runId} was triggered by ${target.event || 'an unknown event'}, not a pull request`);
    return finish({ outcome: 'skipped', reason: 'not-a-pull-request' });
  }
  if (target.runAttempt !== 1) {
    logger.log?.(`ℹ️ CI retry skipped: run ${target.runId} is already attempt ${target.runAttempt} — one retry per run`);
    return finish({ outcome: 'skipped', reason: 'retry-budget-exhausted' });
  }

  const jobs = await fetchAttemptJobs(fetchImpl, target, logger);
  if (!jobs) {
    logger.error?.(`⚠️ CI retry skipped: could not list the jobs of run ${target.runId}`);
    return finish({ outcome: 'unavailable', reason: 'jobs-unavailable' });
  }
  const failedJobs = jobs
    .filter((job) => FAILING_CONCLUSIONS.has(job?.conclusion))
    .map((job) => job?.name || 'unnamed job');
  if (failedJobs.length) {
    logger.log?.(`ℹ️ CI retry skipped: run ${target.runId} cancelled after a real failure (${failedJobs.join(', ')})`);
    return finish({ outcome: 'skipped', reason: 'job-failed' });
  }

  const newestSibling = await fetchNewestSiblingRunNumber(fetchImpl, target, logger);
  if (newestSibling === null) {
    logger.error?.(`⚠️ CI retry skipped: could not list sibling runs for ${target.headBranch}`);
    return finish({ outcome: 'unavailable', reason: 'sibling-runs-unavailable' });
  }
  if (newestSibling > target.runNumber) {
    logger.log?.(`ℹ️ CI retry skipped: run ${target.runId} was superseded by run #${newestSibling} on the same pull request`);
    return finish({ outcome: 'skipped', reason: 'superseded' });
  }

  const response = await githubRequest(
    fetchImpl,
    `${target.repoPath}/actions/runs/${target.runId}/rerun`,
    target.token,
    { method: 'POST' },
  ).catch((error) => {
    logger.error?.(`⚠️ CI retry request failed: ${error?.message || 'network request failed'}`);
    return null;
  });
  const status = Number(response?.status) || 0;
  if (response && ((status >= 200 && status < 300) || response.ok === true)) {
    logger.log?.(`🔁 Re-dispatched CI run ${target.runId} (${target.headSha.slice(0, 7) || 'unknown sha'}): cancelled with no successor run and no failing job`);
    return finish({ outcome: 'requested', status });
  }
  logger.error?.(`⚠️ Could not re-dispatch CI run ${target.runId}: GitHub API returned ${status || 'an unknown status'}`);
  return finish({ outcome: 'unavailable', status, reason: 'rerun-rejected' });
}

if (isDirectlyInvoked(import.meta.url)) {
  // Never fail the recovery workflow: a retry that could not happen must not
  // publish a red check of its own on top of the cancelled run.
  await retryCancelledCiRun();
}
